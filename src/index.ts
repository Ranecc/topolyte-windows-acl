/**
 * 独立 Windows ACL 沙箱 provider（@topolyte/windows-acl）。
 *
 * 本包把"Windows ACL 受限令牌沙箱"做成一个独立插件，供官方 DeepSeek
 * Harness（无需 fork）通过 bundle patch 替换 `ctx.sandbox` 使用。它在官方
 * `@deepseek-ai/dsh-sandbox-windows-acl` 后端之上叠加了**非阻塞授权**：
 *
 * - workspace 的 standing write ACE 传播（大型目录树上的继承式 ACL 遍历可达
 *   分钟级）运行在独立的 grant-cli 子进程里，主事件循环永远不被阻塞；
 * - `confine()` 内部在需要 workspace-write 时 kick off 异步授权（同 workspace
 *   并发合并）；**授权确认前命令不启动**（invariant #2 的 fail-closed 拒绝，
 *   preparing 时抛 SandboxUnavailableError，Agent 重试直到授权落地），授权
 *   落地后每条命令命中 exact-ACE skip（O(1)）；
 * - 每个 session/workspace 对获得一个随机私有 temp 目录及其独立 capability
 *   SID（temp ACE 随 provider dispose 撤销；workspace ACE 是跨 session 的
 *   standing 复用缓存，永不撤销）。
 *
 * 官方 npm 的 `SandboxProvider` 基类没有 `ensureWorkspaceGrant` 抽象（fork
 * 才加的），因此本 provider 把它作为自有公开方法提供（非 override）：官方
 * executor 不调用它也能工作——`confine()` 内部已内聚异步授权，首次命令在
 * 授权落地前被 fail-closed 拒绝（Agent 重试即可）；需要平滑首次体验的部署
 * 可用 bundle 配置 prewarm 在 boot 预热，或显式 `await ensureWorkspaceGrant()`。
 * @module @topolyte/windows-acl
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SandboxProvider, SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type {
  ConfinedArgv,
  RunnerFailureRule,
  SandboxEnforcement,
  SandboxPolicy,
} from '@deepseek-ai/dsh-sandbox'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  AclWriteGrant,
  assertTempRootOutsideWorkspace,
  tempWriteSid,
  workspaceWriteSid,
} from '@deepseek-ai/dsh-sandbox-windows-acl'

/** Plugin config. All optional — `static Config` supplies the defaults. */
export interface Config {
  /**
   * Workspace roots whose standing write grant is pre-warmed at provider boot
   * (fire-and-forget — the walk runs in the grant-cli child process, never on
   * this event loop). A large workspace's first grant takes minutes, so
   * starting it at boot shrinks the fail-closed write-denial window before the
   * first confined command lands.
   */
  prewarm?: string[]
  /**
   * Max consecutive failed grant-cli materializations per workspace before the
   * workspace is pinned to the `failed` state (bounded retry, invariant #8:
   * "Agent gets bounded retry"). Once failed, automatic retries stop — the
   * workspace stays fail-closed (writes denied) until an operator or agent
   * calls {@link TopolyteWindowsAclProvider.retryWorkspaceGrant} to reset the
   * counter. Default 3; 0 disables automatic retries entirely.
   */
  maxGrantRetries?: number
}

/**
 * Default async grant-cli spawn: run the grant CLI as a NON-BLOCKING child
 * process and settle on its exit. The helper's whole job is the eager
 * inheritable-ACE propagation that on a large workspace takes minutes — it
 * MUST run outside the harness event loop (spawn, not spawnSync). A non-zero
 * exit (the helper's failure contract is exit 127) or a spawn error rejects
 * with the captured stderr so an awaiting caller can observe the failure.
 * @param argv - the grant-cli invocation (`[node, grant.js, <workspaceRoot>]`).
 * @param workspaceRoot - the workspace the helper grants (for the error text).
 * @returns a promise resolving on exit 0, rejecting on spawn error or non-zero exit.
 */
function defaultSpawnGrant(argv: string[], workspaceRoot: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0] as string, argv.slice(1), { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', error => reject(error))
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      const detail = stderr.trim()
      reject(new Error(
        `windows-acl grant helper failed for ${workspaceRoot}`
        + (code === null ? ': process never spawned cleanly' : `: exit ${code}`)
        + (detail.length === 0 ? '' : `; ${detail}`),
      ))
    })
  })
}

/**
 * Canonicalize one workspace root for SID derivation and map keys
 * (invariants #3/#6): converge case / alias / trailing-separator spellings of
 * ONE directory onto ONE key, so a workspace's standing grant, in-flight
 * promise, failure counter, and write SID all agree. The official
 * `workspaceWriteSid` contract requires the canonical path
 * (`realpathSync.native` on Windows); an as-spelled fallback would mint a
 * SECOND identity for one directory (one extra tree propagation) and defeat
 * same-path dedup.
 * @param root - the workspace root as the caller spelled it.
 * @returns the canonical absolute form (realpath when it exists, else the
 *   trailing-separator-normalized spelling so a not-yet-checked-out path is
 *   still stable as a map key; the grant helper fails closed if the path
 *   still does not exist at materialization time).
 */
function canonicalWorkspaceRootSync(root: string): string {
  try {
    const real = realpathSync.native(root)
    // realpathSync.native returns the \\?\ long-path form on Windows; strip
    // the prefix so keys and SIDs stay in the plain form the runner and
    // workspaceWriteSid expect.
    return real.startsWith('\\\\?\\') ? real.slice(4) : real
  } catch {
    return root.replace(/[\\/]+$/u, '')
  }
}

/** Test hook: inject probe verdicts / a fake grant spawn / a fake runner. */
export interface WindowsAclInternals {
  /** Replaces `process.platform` for the win32 chain selection (exercise the chain from any host). */
  platform?: string
  /** Replaces the resolved windows-acl runner argv prefix (a fake runner). */
  windowsAclRunnerArgs?: string[]
  /** Replaces the resolved windows-acl runner built entry path (a fake lib/runner.js location). */
  windowsAclRunnerEntry?: string
  /** Replaces the resolved windows-acl grant-cli argv prefix (a fake grant helper). */
  grantCliArgs?: string[]
  /** Replaces the async grant-cli spawn (a fake that avoids a real child process). */
  spawnGrant?: (argv: string[], workspaceRoot: string) => Promise<void>
  /** Replaces the private-temp-directory removal at provider dispose (a throwing fake exercises the cleanup-failure path). */
  rmTempDir?: (path: string) => void
}

/** The runner's verdict: how completely it enforces. */
type SelectedRunner = { runner: 'windows-acl'; enforcement: SandboxEnforcement }

/** One live session/workspace pair's private temp directory and capability. */
interface AclTempCapability {
  dir: string
  writeSid: string
  grant: AclWriteGrant
}

/**
 * Enforcement completeness the windows-acl rung claims (a chain of one, selected
 * without a probe). WRITE_RESTRICTED needs Everyone in both restricting lists
 * for process initialization, so an external object that grants Everyone write
 * access remains writable, and NTFS hard links can alias a granted workspace
 * file to a path outside it — the backend enforces the remaining
 * ACL-addressable surface but must not advertise the absolute promise.
 */
const STATIC_ENFORCEMENT: Record<SelectedRunner['runner'], SandboxEnforcement> = {
  'windows-acl': 'partial',
}

/** The denial dialect the windows-acl runner's kernel speaks. */
const DENIAL_SIGNATURES: Record<SelectedRunner['runner'], readonly string[]> = {
  // pwsh/.NET: "Access to the path '...' is denied."; cmd: "Access is denied.";
  // node EACCES: "permission denied".
  'windows-acl': ['access is denied', 'access to the path', 'permission denied'],
}

/** The windows-acl runner's documented failure exit (its own RUNNER_FAILURE_EXIT contract). */
const WINDOWS_ACL_RUNNER_FAILURE_EXIT = 127

/**
 * Runner-owned fatal diagnostics: the runner prints `windows-acl-run: <detail>`
 * on every runner-side failure and exits 127 — the rule is exit-gated on that
 * status so a confined command that merely PRINTS the signature is never
 * misclassified as "the command did not run".
 */
const RUNNER_FAILURE_RULES: Record<SelectedRunner['runner'], readonly RunnerFailureRule[]> = {
  'windows-acl': [{ allowedExitCodes: [WINDOWS_ACL_RUNNER_FAILURE_EXIT], fatalSignatures: ['windows-acl-run: '] }],
}

/**
 * Windows ACL sandbox provider. Registers as `ctx.sandbox`. Caches the write
 * grants: the standing workspace-root grant per workspace and the revocable
 * private-temp grant per live session/workspace pair (revoked on provider
 * dispose). The workspace grant is materialized OUT-OF-BAND by the grant-cli
 * child process — `confine()` never blocks on the tree walk.
 */
export class TopolyteWindowsAclProvider extends SandboxProvider {
  // Inline schema call: the config catalog walks `static Config` statically.
  static Config: z<Config> = z.object({
    prewarm: z.array(z.string()).default([]),
    maxGrantRetries: z.number().min(0).step(1).default(3),
  })

  /** Test hook (mirrors the official executors' `internals`). */
  internals: WindowsAclInternals = {}

  /** Workspace roots pre-warmed at boot via {@link kickOffWorkspaceGrant} (fire-and-forget). */
  private readonly prewarmWorkspaces: string[]
  /** Consecutive grant failures that pin a workspace to the `failed` state (bounded retry, invariant #8). */
  private readonly maxGrantRetries: number
  /**
   * Server-lifetime write grants: the STANDING workspace-root grant per
   * workspace (its ACE is the cross-session reuse cache and outlives the
   * provider — never revoked) and the REVOCABLE private-temp grant per live
   * session/workspace pair (revoked on provider dispose).
   */
  private readonly workspaceGrants = new Map<string, AclWriteGrant>()
  private readonly tempCapabilities = new Map<string, AclTempCapability>()
  /**
   * In-flight async workspace-grant materializations keyed by workspace root
   * ({@link kickOffWorkspaceGrant} coalesces concurrent first-time calls onto
   * one grant-cli spawn). Entries are removed when the underlying promise
   * settles, so a FAILED materialization leaves no residue and the next call
   * retries the helper (a failed walk NEVER re-propagates synchronously — the
   * workspace simply stays fail-closed until a retry lands).
   */
  private readonly workspaceGrantInflight = new Map<string, Promise<void>>()
  /**
   * Consecutive failed grant-cli materializations per workspace (bounded
   * retry, invariant #8). Once a workspace reaches {@link Config.maxGrantRetries},
   * it is pinned to the `failed` state: automatic retries stop and writes stay
   * fail-closed until {@link retryWorkspaceGrant} resets the counter.
   */
  private readonly workspaceGrantFailures = new Map<string, number>()
  /**
   * Canonicalized workspace-root cache (invariant #3/#6): every map key and
   * every `workspaceWriteSid` input go through {@link canonicalWorkspaceRoot}
   * so one directory has ONE key even when callers spell it differently
   * (case / alias / trailing separator). Keyed by the as-spelled input.
   */
  private readonly canonicalRoots = new Map<string, string>()

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.prewarmWorkspaces = config.prewarm as string[]
    this.maxGrantRetries = config.maxGrantRetries as number
    // The temp grants are revoked with the provider: a clean server shutdown
    // leaves no temp ACEs behind (workspace ACEs stand by design — the reuse
    // cache; an unclean shutdown leaves them for the next provision's
    // exact-ACE skip). Shutdown also OBSERVES any in-flight grant-cli helper
    // (invariant #7): an async disposer waits for every spawned helper to
    // settle before revoking — a helper that is still walking must neither be
    // orphaned nor revoked mid-flight (its standing ACE is never revoked, but
    // its SID record in `workspaceGrants` is only valid after the helper
    // succeeded, so revoking before settlement would dispose a half-recorded
    // grant).
    ctx.effect(() => async () => {
      await Promise.allSettled([...this.workspaceGrantInflight.values()])
      this.revokeAclGrants()
    })
    // Pre-warm the configured workspaces' standing grants out-of-band at boot
    // (fire-and-forget): the walk runs in the grant-cli child process, never on
    // this event loop.
    for (const root of this.prewarmWorkspaces) this.kickOffWorkspaceGrant(root)
  }

  /**
   * Wrap `argv` in the windows-acl runner's invocation for `policy`. Fails
   * closed (throws {@link SandboxUnavailableError}) on any non-Windows host —
   * this provider is Windows-only by construction.
   * @param argv - the exact argv the caller is about to spawn.
   * @param policy - the file-effect policy this execution runs under.
   * @returns the wrapped argv plus the enforcement completeness, denial
   *   signatures, and structured runner-failure rules.
   */
  override confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv {
    const selected = this.selectRunner()
    const runnerArgv = this.windowsAclRunnerArgv(policy)
    return {
      argv: [...runnerArgv, '--', ...argv],
      enforcement: selected.enforcement,
      denialSignatures: DENIAL_SIGNATURES[selected.runner],
      runnerFailureRules: RUNNER_FAILURE_RULES[selected.runner],
    }
  }

  /**
   * Canonicalize one workspace root (cached): every map key and every
   * `workspaceWriteSid` input MUST agree on one spelling per directory
   * (invariant #3: "one in-flight grant per path"; #6: "moved path gets new
   * SID" — renaming derives a new SID, while re-spelling does not). The
   * result is what reaches the grant-cli child and the runner's `--workspace`
   * flag, so the ACE the helper lays down matches the SID the runner carries.
   * @param workspaceRoot - the workspace root as the caller spelled it.
   */
  private canonicalWorkspaceRoot(workspaceRoot: string): string {
    const cached = this.canonicalRoots.get(workspaceRoot)
    if (cached !== undefined) return cached
    const canonical = canonicalWorkspaceRootSync(workspaceRoot)
    this.canonicalRoots.set(workspaceRoot, canonical)
    return canonical
  }

  /**
   * Whether a workspace's consecutive-failure counter has pinned it to the
   * `failed` state (invariant #8): strictly MORE than zero consecutive
   * failures AND at or above {@link maxGrantRetries}. A never-failed
   * workspace is never `failed` even when `maxGrantRetries` is 0 (which
   * disables automatic RETRIES, not the first attempt).
   * @param root - the canonical workspace root.
   */
  private grantFailed(root: string): boolean {
    const failures = this.workspaceGrantFailures.get(root) ?? 0
    return failures > 0 && failures >= this.maxGrantRetries
  }

  /**
   * The workspace-grant lifecycle state for one workspace root (invariant #5's
   * "Ready state is explicit", exposed as a query so agents/executors can
   * distinguish preparing / ready / failed instead of guessing).
   * @param workspaceRoot - the workspace root (any spelling of it).
   */
  workspaceGrantState(workspaceRoot: string): 'preparing' | 'ready' | 'failed' {
    const root = this.canonicalWorkspaceRoot(workspaceRoot)
    if (this.workspaceGrants.has(root)) return 'ready'
    if (this.workspaceGrantInflight.has(root)) return 'preparing'
    return this.grantFailed(root) ? 'failed' : 'preparing'
  }

  /**
   * Reset a workspace's consecutive-failure counter and kick off the grant
   * again (invariant #8's bounded-retry escape hatch: after `failed`, automatic
   * retries stop; an operator or agent calls this to explicitly retry).
   * @param workspaceRoot - the absolute workspace root to re-grant (any spelling).
   * @returns the in-flight grant promise (see {@link ensureWorkspaceGrant}).
   */
  retryWorkspaceGrant(workspaceRoot: string): Promise<void> {
    const root = this.canonicalWorkspaceRoot(workspaceRoot)
    this.workspaceGrantFailures.delete(root)
    this.kickOffWorkspaceGrant(root)
    return this.workspaceGrantInflight.get(root) ?? Promise.resolve()
  }

  /**
   * Start (or join) the out-of-band materialization of one workspace's
   * standing write grant. Coalesces concurrent first-time calls for one
   * workspace onto ONE grant-cli spawn (invariant #3); a standing grant or an
   * already in-flight materialization is a no-op. On grant-cli success the
   * workspace grant is recorded so {@link confine}'s provision hits the
   * exact-ACE skip (O(1)); on failure the entry is dropped (so the next call
   * retries) and the failure is LOGGED — it never rejects, so fire-and-forget
   * callers stay unblocked and the workspace simply stays unprovisioned until
   * a retry lands. The event loop is NEVER blocked.
   *
   * Bounded retry (invariant #8): after {@link Config.maxGrantRetries}
   * consecutive failures the workspace is pinned to `failed` and automatic
   * retries stop — {@link workspaceGrantState} reports `failed` and
   * {@link confine} refuses to start commands until
   * {@link retryWorkspaceGrant} resets the counter.
   * @param workspaceRoot - the absolute workspace root to grant (any spelling).
   */
  private kickOffWorkspaceGrant(workspaceRoot: string): void {
    const root = this.canonicalWorkspaceRoot(workspaceRoot)
    if (this.workspaceGrants.has(root)) return
    if (this.workspaceGrantInflight.has(root)) return
    // Bounded retry (invariant #8): a workspace pinned to `failed` stops
    // automatic retries; the FIRST attempt is always allowed even when
    // maxGrantRetries is 0 (it caps retries, not the first grant).
    if (this.grantFailed(root)) return
    const pending = this.materializeWorkspaceGrantAsync(root).finally(() => {
      this.workspaceGrantInflight.delete(root)
    })
    this.workspaceGrantInflight.set(root, pending)
    // Attach a handler so the returned promise never trips an unhandled
    // rejection for fire-and-forget callers; awaiting callers still observe
    // the rejection through the same promise. Success clears the failure
    // counter; failure increments it (bounded by maxGrantRetries).
    pending.then(
      () => {
        this.workspaceGrantFailures.delete(root)
      },
      () => {
        this.workspaceGrantFailures.set(root, (this.workspaceGrantFailures.get(root) ?? 0) + 1)
      },
    )
    pending.catch((error) => {
      this.ctx.logger.warn(`windows-acl: out-of-band workspace grant failed for ${root}: ${String(error)}`)
    })
  }

  /**
   * Ensure the workspace's standing write grant is (being) materialized
   * OUTSIDE the event loop — the async grant-cli child process owns the eager
   * inheritable-ACE propagation that on a large workspace takes minutes, and
   * the walk NEVER runs on the calling tick. Coalesces concurrent first-time
   * calls (invariant #3); already-granted workspaces resolve immediately.
   * Awaiting this resolves only once the full-tree walk lands (a large
   * workspace's FIRST await takes minutes by design); user-visible paths
   * SHOULD instead call {@link confine} (which refuses to start a command
   * until the grant is confirmed — invariant #2) and let the agent retry, or
   * prewarm the workspace at boot. Off-path callers (tests, explicit warm-up)
   * may await it to observe completion.
   *
   * NOTE: the official npm `SandboxProvider` base class has no such method
   * (the fork added it); this is a provider-owned extension. Official executors
   * work without calling it — `confine()` internally kicks the grant off.
   * @param workspaceRoot - the absolute workspace root to grant (any spelling).
   * @returns a promise resolving once the workspace ACE stands (or was already
   *   standing); rejecting on materialization failure.
   */
  ensureWorkspaceGrant(workspaceRoot: string): Promise<void> {
    const root = this.canonicalWorkspaceRoot(workspaceRoot)
    this.kickOffWorkspaceGrant(root)
    return this.workspaceGrantInflight.get(root) ?? Promise.resolve()
  }

  /**
   * One out-of-band workspace-grant materialization: spawn the grant CLI (the
   * standing ACE is the helper's whole output) and, on success, record the SID
   * holder so later {@link confine} materialization skips the tree walk. The
   * grant is STANDING — the same cross-session reuse cache the synchronous path
   * maintains.
   * @param workspaceRoot - the absolute workspace root to grant.
   */
  private async materializeWorkspaceGrantAsync(workspaceRoot: string): Promise<void> {
    const spawnGrant = this.internals.spawnGrant ?? defaultSpawnGrant
    await spawnGrant(this.grantCliInvocation(workspaceRoot), workspaceRoot)
    // The helper applied the ACE; record the SID holder (paths stay unrecorded
    // — dispose() skips standing paths anyway, and the exact-ACE skip makes
    // any later synchronous provision O(1)).
    this.workspaceGrants.set(workspaceRoot, AclWriteGrant.create(workspaceWriteSid(workspaceRoot)))
  }

  /**
   * The windows-acl grant-cli argv prefix: the built lib/grant-cli.js entry
   * when present (production), else the package source through tsx
   * (development) — the same shape as the runner invocation.
   * @param workspaceRoot - the workspace the helper grants (the single argv argument).
   * @returns `[node, grant.js, workspaceRoot]` (or the injected override).
   */
  private grantCliInvocation(workspaceRoot: string): string[] {
    const override = this.internals.grantCliArgs
    if (override !== undefined) return [...override, workspaceRoot]
    const builtEntry = fileURLToPath(import.meta.resolve('@topolyte/windows-acl/grant'))
    if (existsSync(builtEntry)) return [process.execPath, builtEntry, workspaceRoot]
    const sourceEntry = fileURLToPath(import.meta.resolve('@topolyte/windows-acl/src/grant-cli.ts'))
    return [process.execPath, '--import', 'tsx/esm', sourceEntry, workspaceRoot]
  }

  /**
   * The windows-acl runner argv for one policy. With a calling session (the
   * policy's `sessionId`) under workspace-write, the grants are materialized
   * once per provider lifetime — the standing workspace-root grant per
   * workspace (kick-off is a no-op when one is already in flight) and a
   * revocable, RANDOM private-temp capability per live session/workspace pair.
   * The runner receives `--write-sid` plus `--temp-write-sid` and grants
   * nothing itself. Agentless workspace-write calls pass the ambient temp ROOT
   * and no SID flags: the runner creates and removes a random private child
   * directory for that one invocation.
   * @param policy - the resolved per-call policy.
   * @returns the runner invocation.
   */
  private windowsAclRunnerArgv(policy: SandboxPolicy): string[] {
    const sessionId = policy.sessionId
    if (sessionId === undefined || policy.mode === 'read-only') {
      return [
        ...this.windowsAclRunnerInvocation(),
        '--workspace', policy.workspaceRoot,
        '--temp', tmpdir(),
        '--mode', policy.mode,
      ]
    }
    // Only the write path canonicalizes: the map keys, the SID, the grant-cli
    // argument, and the runner's --workspace must all agree on ONE spelling.
    const root = this.canonicalWorkspaceRoot(policy.workspaceRoot)
    const temp = this.materializeAclGrant(sessionId, root)
    return [
      ...this.windowsAclRunnerInvocation(),
      '--workspace', root,
      '--temp', temp.dir,
      '--mode', policy.mode,
      '--write-sid', workspaceWriteSid(root),
      '--temp-write-sid', temp.writeSid,
    ]
  }

  /**
   * Materialize one workspace-write policy's per-call ACEs. The workspace SID
   * and standing root grant are shared by the workspace: the standing root
   * grant is (or is being) materialized OUT-OF-BAND by the grant-cli child
   * process — this method NEVER walks the tree synchronously (on a large
   * workspace that eager inheritable-ACE propagation takes MINUTES and must not
   * block the harness event loop). If the standing grant is not yet recorded,
   * the out-of-band materialization is kicked off (coalesced, invariant #3)
   * and the caller is then checked against the lifecycle state (invariant #5):
   * a not-yet-confirmed grant REFUSES to start the command (invariant #2) with
   * a {@link SandboxUnavailableError} carrying the `preparing`/`failed` state;
   * a confirmed grant proceeds and every later provision is O(1). The temp
   * directory is random and carries a distinct SID, so another session on the
   * same workspace cannot use the shared workspace SID to enter it. A fresh
   * provider always chooses a new path; crash residue therefore cannot collide
   * with or authorize a resumed session. Fail-closed: a half-materialized temp
   * grant is revoked and its directory removed before the error propagates.
   * @param sessionId - the policy's calling-session identity.
   * @param workspaceRoot - the canonical workspace root.
   * @returns the pair's private temp directory and write capability.
   */
  private materializeAclGrant(sessionId: SessionId, workspaceRoot: string): AclTempCapability {
    const root = this.canonicalWorkspaceRoot(workspaceRoot)
    assertTempRootOutsideWorkspace(root, tmpdir())
    if (!this.workspaceGrants.has(root)) {
      // The standing workspace grant is materialized by the grant-cli child
      // process out-of-band (kick-off is a no-op when one is already in
      // flight).
      this.kickOffWorkspaceGrant(root)
    }
    // Invariant #2: no child may run before the grant is confirmed. Fail-closed
    // REFUSAL — the command is not started (never a silent half-authorized
    // run). preparing: retry once the out-of-band walk lands; failed: bounded
    // retries exhausted, an operator/agent must retryWorkspaceGrant(). The
    // helper keeps walking in the background either way; the event loop is
    // never blocked.
    const state = this.workspaceGrantState(root)
    if (state !== 'ready') {
      throw new SandboxUnavailableError(
        'workspace-write',
        `windows-acl: workspace grant for ${root} is '${state}'; command not started (invariant #2: no child may run before the grant is confirmed; `
        + (state === 'failed'
          ? 'bounded retries exhausted — call retryWorkspaceGrant() to reset)'
          : 'retry once the grant lands, or prewarm the workspace at boot)'),
      )
    }
    const key = JSON.stringify([String(sessionId), root])
    const existing = this.tempCapabilities.get(key)
    if (existing !== undefined) return existing
    const tempDir = mkdtempSync(join(tmpdir(), 'dsh-'))
    const tempSid = tempWriteSid(tempDir)
    let grant: AclWriteGrant | undefined
    try {
      grant = AclWriteGrant.create(tempSid)
      grant.add(tempDir)
    } catch (error) {
      const cleanupFailures: unknown[] = []
      if (grant !== undefined) {
        try {
          grant.dispose()
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError)
        }
      }
      try {
        this.removeTempDir(tempDir)
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError)
      }
      if (cleanupFailures.length > 0) {
        throw new AggregateError([error, ...cleanupFailures], 'windows-acl temp grant materialization failed and its cleanup also failed')
      }
      throw error
    }
    const capability = { dir: tempDir, writeSid: tempSid, grant }
    this.tempCapabilities.set(key, capability)
    return capability
  }

  /**
   * Dispose every write grant (provider dispose): the revocable temp ACEs are
   * revoked, the private temp directories this provider created are removed,
   * and every SID allocation is freed; the standing workspace ACEs stay (the
   * reuse cache). Cleanup failures are reported, not thrown: cordis teardown
   * must not be aborted by grant cleanup.
   */
  private revokeAclGrants(): void {
    if (this.workspaceGrants.size === 0 && this.tempCapabilities.size === 0) return
    const failures: unknown[] = []
    for (const grant of [...this.workspaceGrants.values(), ...[...this.tempCapabilities.values()].map(capability => capability.grant)]) {
      try {
        grant.dispose()
      } catch (error) {
        failures.push(error)
      }
    }
    for (const { dir } of this.tempCapabilities.values()) {
      try {
        this.removeTempDir(dir)
      } catch (error) {
        failures.push(error)
      }
    }
    this.workspaceGrants.clear()
    this.tempCapabilities.clear()
    if (failures.length > 0) {
      this.ctx.logger.warn(`windows-acl: grant cleanup completed with ${failures.length} failure(s)`)
      for (const error of failures) this.ctx.logger.warn(error)
    }
  }

  /** Remove one provider-owned private temp directory (injectable for cleanup tests). */
  private removeTempDir(dir: string): void {
    const remove = this.internals.rmTempDir ?? ((path: string) => { rmSync(path, { recursive: true, force: true }) })
    remove(dir)
  }

  /**
   * Resolve which runner confines commands: the win32 chain's sole candidate,
   * selected directly (its execution-time refusal still fails closed through
   * its stderr signature and exit 127). Any non-Windows host fails closed.
   */
  private selectRunner(): SelectedRunner {
    const platform = this.internals.platform ?? process.platform
    if (platform !== 'win32') throw new SandboxUnavailableError('workspace-write')
    return { runner: 'windows-acl', enforcement: STATIC_ENFORCEMENT['windows-acl'] }
  }

  /**
   * The windows-acl runner argv prefix: the built lib/runner.js entry when
   * present (production), else the package source through tsx (development).
   * The prefix stays `[node, runner, ...]` — a future native-exe runner keeps
   * the same argv contract and only swaps these entries.
   */
  private windowsAclRunnerInvocation(): string[] {
    const override = this.internals.windowsAclRunnerArgs
    if (override !== undefined) return override
    const builtEntry = this.internals.windowsAclRunnerEntry ?? fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-sandbox-windows-acl/runner'))
    if (existsSync(builtEntry)) return [process.execPath, builtEntry]
    const sourceEntry = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-sandbox-windows-acl/src/runner.ts'))
    return [process.execPath, '--import', 'tsx/esm', sourceEntry]
  }
}

export default TopolyteWindowsAclProvider
