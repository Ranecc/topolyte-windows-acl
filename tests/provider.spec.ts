/**
 * TopolyteWindowsAclProvider 测试：验证独立 @topolyte/windows-acl 沙箱 provider
 * 的非阻塞授权语义 + 十项修复不变量（对齐社区手册
 * `deepseek-harness-handbook/windows-acl-first-run.html`）。Win32 ACL 原生面
 * （AclWriteGrant / assertTempRootOutsideWorkspace / workspaceWriteSid /
 * tempWriteSid）整体 mock，授权树遍历真实发生的部分在官方
 * `@deepseek-ai/dsh-sandbox-windows-acl` 的 runner 套件里覆盖。
 *
 * 与 fork 的 sandbox-local `acl-grants.spec.ts` 的差异：本 provider 的 workspace
 * standing grant 是**异步**物化的（grant-cli 子进程），且授权确认前命令不启动
 * （invariant #2），因此所有 workspace-write 的 confine 断言都放在
 * `await ensureWorkspaceGrant()`（或 grant 已确认）之后。
 * @module @topolyte/windows-acl/tests
 */

import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SandboxUnavailableError, type SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TopolyteWindowsAclProvider } from '../src/index.ts'

/** 与 vi.mock 工厂共享的跨文件状态（hoisting 契约）。 */
const mockState = vi.hoisted(() => ({
  grants: [] as Array<{ writeSid: string; added: Array<{ path: string; standing: boolean }>; disposed: boolean }>,
  addFailure: undefined as Error | undefined,
  /** 把 add 失败限定到 standing（workspace）或 revocable（temp）。 */
  addFailureStanding: undefined as boolean | undefined,
  createTempFailure: undefined as Error | undefined,
  disposeFailure: undefined as Error | undefined,
}))

vi.mock('@deepseek-ai/dsh-sandbox-windows-acl', () => {
  class MockAclWriteGrant {
    readonly writeSid: string
    readonly added: Array<{ path: string; standing: boolean }> = []
    disposed = false
    constructor(writeSid: string) {
      this.writeSid = writeSid
      mockState.grants.push(this)
    }
    static create(writeSid: string): MockAclWriteGrant {
      if (writeSid.startsWith('TEMP:') && mockState.createTempFailure !== undefined) throw mockState.createTempFailure
      return new MockAclWriteGrant(writeSid)
    }
    add(path: string, standing = false): void {
      this.added.push({ path, standing })
      if (mockState.addFailure !== undefined
        && (mockState.addFailureStanding === undefined || mockState.addFailureStanding === standing)) {
        throw mockState.addFailure
      }
    }
    dispose(): void {
      if (mockState.disposeFailure !== undefined) throw mockState.disposeFailure
      this.disposed = true
    }
  }
  return {
    AclWriteGrant: MockAclWriteGrant,
    assertTempRootOutsideWorkspace: (workspaceRoot: string, tempRoot: string) => {
      const workspace = realpathSync.native(workspaceRoot)
      const temp = realpathSync.native(tempRoot)
      if (temp === workspace || temp.startsWith(`${workspace}${process.platform === 'win32' ? '\\' : '/'}`)) {
        throw new Error(`Windows ACL temp root must be outside the workspace: workspace=${workspaceRoot}; temp=${tempRoot}`)
      }
    },
    workspaceWriteSid: () => 'S-1-4-42-42',
    tempWriteSid: (path: string) => `TEMP:${path}`,
  }
})

const WORKSPACE_SID = 'S-1-4-42-42'

/** 每次 confine 需要等待的异步 workspace grant；返回即表示 standing grant 已记录。 */
function materializeWorkspaceGrant(sandbox: TopolyteWindowsAclProvider, workspaceRoot: string): Promise<void> {
  return sandbox.ensureWorkspaceGrant(workspaceRoot)
}

async function setup(config: Record<string, unknown> = {}) {
  const ctx = new Context()
  const fiber = await ctx.plugin(TopolyteWindowsAclProvider, config)
  const sandbox = ctx.sandbox as TopolyteWindowsAclProvider
  sandbox.internals = { platform: 'win32', windowsAclRunnerArgs: ['node', 'windows-acl-runner.js'] }
  return { ctx, sandbox, fiber }
}

function workspaceRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-acl-grants-ws-'))
}

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  return index < 0 ? undefined : argv[index + 1]
}

describe('windows-acl write grants (TopolyteWindowsAclProvider)', () => {
  const scratch: string[] = []

  beforeEach(() => {
    mockState.grants = []
    mockState.addFailure = undefined
    mockState.addFailureStanding = undefined
    mockState.createTempFailure = undefined
    mockState.disposeFailure = undefined
  })

  const cleanup = () => {
    for (const grant of mockState.grants) {
      for (const added of grant.added) {
        if (!added.standing) rmSync(added.path, { recursive: true, force: true })
      }
    }
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
  }

  it('workspace-write confines under the windows-acl runner and materializes temp synchronously + workspace out-of-band', async () => {
    try {
      const { sandbox, fiber } = await setup()
      const ws = workspaceRoot()
      scratch.push(ws)
      sandbox.internals.grantCliArgs = ['node', 'grant-cli.js']
      const spawnCalls: Array<{ argv: string[]; workspaceRoot: string }> = []
      sandbox.internals.spawnGrant = async (argv, workspaceRoot) => { spawnCalls.push({ argv: [...argv], workspaceRoot }) }
      const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('sess-1') }

      // 授权确认（out-of-band grant-cli）后才允许启动命令（invariant #2）。
      await materializeWorkspaceGrant(sandbox, ws)
      expect(spawnCalls).toEqual([{ argv: ['node', 'grant-cli.js', ws], workspaceRoot: ws }])

      const confined = sandbox.confine(['pwsh', '/Command', 'x'], policy)
      const tempDir = flag(confined.argv, '--temp')
      const tempSid = flag(confined.argv, '--temp-write-sid')
      expect(tempDir).toBeDefined()
      expect(basename(tempDir ?? '')).toMatch(/^dsh-[A-Za-z0-9_-]{6}$/u)
      expect(tempSid).toBe(`TEMP:${tempDir}`)
      expect(tempSid).not.toBe(WORKSPACE_SID)
      expect(confined.argv).toEqual([
        'node', 'windows-acl-runner.js',
        '--workspace', ws,
        '--temp', tempDir,
        '--mode', 'workspace-write',
        '--write-sid', WORKSPACE_SID,
        '--temp-write-sid', tempSid,
        '--',
        'pwsh', '/Command', 'x',
      ])
      // confine 返回后：temp grant 已物化（同步）；workspace grant 由 grant-cli
      // 在途落地（SID 持有者，无 add —— ACE 由子进程落地）。
      expect(mockState.grants).toHaveLength(2)
      expect(mockState.grants.some(grant => grant.writeSid === WORKSPACE_SID && grant.added.length === 0)).toBe(true)

      // 二次 confine 复用 temp capability 与 standing grant；不再 spawn helper。
      expect(sandbox.confine(['pwsh', '/Command', 'x'], policy).argv).toEqual(confined.argv)
      expect(spawnCalls).toHaveLength(1)

      await fiber.dispose()
      expect(mockState.grants.every(grant => grant.disposed)).toBe(true)
      expect(existsSync(tempDir ?? '')).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('read-only materializes no capability; upgrade creates them and downgrade leaves them reusable', async () => {
    try {
      const { sandbox, fiber } = await setup()
      const ws = workspaceRoot()
      scratch.push(ws)
      sandbox.internals.grantCliArgs = ['node', 'grant-cli.js']
      sandbox.internals.spawnGrant = async () => { /* out-of-band helper; no-op for this test */ }
      const readOnly: SandboxPolicy = { mode: 'read-only', workspaceRoot: ws, sessionId: SessionId('switch') }
      const workspaceWrite: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('switch') }

      expect(sandbox.confine(['true'], readOnly).argv).toEqual([
        'node', 'windows-acl-runner.js',
        '--workspace', ws,
        '--temp', tmpdir(),
        '--mode', 'read-only',
        '--',
        'true',
      ])
      expect(mockState.grants).toHaveLength(0)

      await materializeWorkspaceGrant(sandbox, ws)
      const upgraded = sandbox.confine(['true'], workspaceWrite)
      expect(flag(upgraded.argv, '--temp-write-sid')).not.toBe(WORKSPACE_SID)
      expect(mockState.grants).toHaveLength(2) // temp 同步 + workspace standing
      sandbox.confine(['true'], readOnly)
      expect(mockState.grants).toHaveLength(2)
      expect(mockState.grants.every(grant => !grant.disposed)).toBe(true)
      expect(sandbox.confine(['true'], workspaceWrite).argv).toEqual(upgraded.argv)

      await fiber.dispose()
    } finally {
      cleanup()
    }
  })

  it('forks and workspace changes receive distinct temp capabilities while each workspace grant is reused', async () => {
    try {
      const { sandbox, fiber } = await setup()
      const wsA = workspaceRoot()
      const wsB = workspaceRoot()
      scratch.push(wsA, wsB)
      sandbox.internals.grantCliArgs = ['node', 'grant-cli.js']
      sandbox.internals.spawnGrant = async () => { /* out-of-band helper; no-op for this test */ }
      // 两个 workspace 都先确认授权，命令才允许启动。
      await Promise.all([materializeWorkspaceGrant(sandbox, wsA), materializeWorkspaceGrant(sandbox, wsB)])
      const parent = sandbox.confine(['true'], { mode: 'workspace-write', workspaceRoot: wsA, sessionId: SessionId('parent') })
      const child = sandbox.confine(['true'], { mode: 'workspace-write', workspaceRoot: wsA, sessionId: SessionId('child') })
      const moved = sandbox.confine(['true'], { mode: 'workspace-write', workspaceRoot: wsB, sessionId: SessionId('parent') })

      expect(flag(child.argv, '--temp')).not.toBe(flag(parent.argv, '--temp'))
      expect(flag(child.argv, '--temp-write-sid')).not.toBe(flag(parent.argv, '--temp-write-sid'))
      expect(flag(moved.argv, '--temp')).not.toBe(flag(parent.argv, '--temp'))
      // 同步 temp：A/parent、A/child、B/parent；workspace：A、B（standing）。
      expect(mockState.grants).toHaveLength(5)

      await fiber.dispose()
    } finally {
      cleanup()
    }
  })

  it('temp grant creation/add failures remove the random directory; cleanup failures aggregate', async () => {
    try {
      const { sandbox } = await setup()
      const ws = workspaceRoot()
      scratch.push(ws)
      sandbox.internals.grantCliArgs = ['node', 'grant-cli.js']
      sandbox.internals.spawnGrant = async () => { /* out-of-band helper; no-op for this test */ }
      await materializeWorkspaceGrant(sandbox, ws)

      mockState.createTempFailure = new Error('temp SID creation exploded')
      expect(() => sandbox.confine(['true'], {
        mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('create-fail'),
      })).toThrow('temp SID creation exploded')
      expect(mockState.grants).toHaveLength(1) // 仅 workspace standing；temp 创建失败被回滚

      mockState.createTempFailure = undefined
      mockState.addFailureStanding = false
      mockState.addFailure = new Error('temp add exploded')
      expect(() => sandbox.confine(['true'], {
        mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('add-fail'),
      })).toThrow('temp add exploded')
      const failedTempGrant = mockState.grants.at(-1)
      expect(failedTempGrant?.disposed).toBe(true)
      expect(failedTempGrant?.added).toHaveLength(1)
      expect(existsSync(failedTempGrant?.added[0]?.path ?? '')).toBe(false)

      mockState.addFailureStanding = false
      mockState.addFailure = new Error('temp add exploded')
      sandbox.internals.rmTempDir = () => { throw new Error('temp rm exploded') }
      expect(() => sandbox.confine(['true'], {
        mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('rm-fail'),
      })).toThrow(/temp grant materialization failed and its cleanup also failed/u)
      delete sandbox.internals.rmTempDir

      mockState.addFailureStanding = false
      mockState.addFailure = new Error('temp add exploded')
      mockState.disposeFailure = new Error('temp cleanup exploded')
      expect(() => sandbox.confine(['true'], {
        mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('aggregate-fail'),
      })).toThrow(/temp grant materialization failed and its cleanup also failed/u)
    } finally {
      cleanup()
    }
  })

  it('rejects a workspace containing the ambient temp root before any ACL mutation', async () => {
    const { sandbox } = await setup()
    expect(() => sandbox.confine(['true'], {
      mode: 'workspace-write', workspaceRoot: realpathSync.native(tmpdir()), sessionId: SessionId('overlap'),
    })).toThrow(/temp root must be outside the workspace/u)
    expect(mockState.grants).toHaveLength(0)
  })

  it('agentless calls pass a temp root and no capabilities; the runner owns the private child lifecycle', async () => {
    try {
      const { sandbox, fiber } = await setup()
      const confined = sandbox.confine(['pwsh', '/Command', 'x'], { mode: 'workspace-write', workspaceRoot: '/ws' })
      expect(confined.argv).toEqual([
        'node', 'windows-acl-runner.js',
        '--workspace', '/ws',
        '--temp', tmpdir(),
        '--mode', 'workspace-write',
        '--',
        'pwsh', '/Command', 'x',
      ])
      expect(mockState.grants).toHaveLength(0)
      await fiber.dispose()
    } finally {
      cleanup()
    }
  })

  it('provider teardown reports grant and directory cleanup failures without aborting teardown', async () => {
    try {
      const { ctx, sandbox, fiber } = await setup()
      const ws = workspaceRoot()
      scratch.push(ws)
      sandbox.internals.grantCliArgs = ['node', 'grant-cli.js']
      sandbox.internals.spawnGrant = async () => { /* out-of-band helper; no-op for this test */ }
      await materializeWorkspaceGrant(sandbox, ws)
      const confined = sandbox.confine(['true'], {
        mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('dispose'),
      })
      const tempDir = flag(confined.argv, '--temp') ?? ''
      // 授权已确认：workspace standing + temp 都在 mockState.grants 里，teardown
      // 有 3 个失败可报（workspace dispose + temp dispose + temp 目录删除）。
      mockState.disposeFailure = new Error('revoke exploded')
      sandbox.internals.rmTempDir = () => { throw new Error('rm exploded') }
      const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)

      await fiber.dispose()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('cleanup completed with 3 failure(s)'))
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ message: 'revoke exploded' }))
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ message: 'rm exploded' }))
      expect(existsSync(tempDir)).toBe(true) // 注入的删除失败；test cleanup 兜底回收
    } finally {
      cleanup()
    }
  })

  it('ensureWorkspaceGrant spawns the grant helper once, coalesces concurrent calls, then confine reuses the standing grant', async () => {
    try {
      const { sandbox, fiber } = await setup()
      const ws = workspaceRoot()
      scratch.push(ws)
      sandbox.internals.grantCliArgs = ['node', 'grant-cli.js']
      const spawnCalls: Array<{ argv: string[]; workspaceRoot: string }> = []
      sandbox.internals.spawnGrant = async (argv, workspaceRoot) => {
        spawnCalls.push({ argv: [...argv], workspaceRoot })
      }
      const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('sess-1') }

      // 并发首调合并到一次 helper spawn（invariant #3）。
      await Promise.all([
        sandbox.ensureWorkspaceGrant(ws),
        sandbox.ensureWorkspaceGrant(ws),
        sandbox.ensureWorkspaceGrant(ws),
      ])
      expect(spawnCalls).toHaveLength(1)
      expect(spawnCalls[0]).toEqual({ argv: ['node', 'grant-cli.js', ws], workspaceRoot: ws })

      // 已授权 workspace 不再 spawn。
      await sandbox.ensureWorkspaceGrant(ws)
      expect(spawnCalls).toHaveLength(1)

      // confine() 复用 out-of-band standing grant；只有 temp capability 是新的。
      const confined = sandbox.confine(['pwsh', '/Command', 'x'], policy)
      expect(flag(confined.argv, '--write-sid')).toBe(WORKSPACE_SID)
      expect(mockState.grants).toHaveLength(2)
      expect(mockState.grants.some(grant => grant.writeSid === WORKSPACE_SID && grant.added.length === 0)).toBe(true)

      await fiber.dispose()
    } finally {
      cleanup()
    }
  })

  it('a failing grant helper rejects, seeds nothing, and the next call retries the helper', async () => {
    try {
      const { sandbox, fiber } = await setup()
      const ws = workspaceRoot()
      scratch.push(ws)
      sandbox.internals.grantCliArgs = ['node', 'grant-cli.js']
      sandbox.internals.spawnGrant = async () => { throw new Error('grant helper exploded') }

      await expect(sandbox.ensureWorkspaceGrant(ws)).rejects.toThrow('grant helper exploded')
      // in-flight 缓存无残留：下一次调用重新 spawn（failures=1 < maxRetries=3）。
      let calls = 0
      sandbox.internals.spawnGrant = async () => { calls++ }
      await sandbox.ensureWorkspaceGrant(ws)
      expect(calls).toBe(1)

      await fiber.dispose()
    } finally {
      cleanup()
    }
  })

  it('confine fails closed on a non-Windows host with the sandbox-unavailable error', async () => {
    const { sandbox, fiber } = await setup()
    sandbox.internals.platform = 'linux'
    expect(() => sandbox.confine(['true'], {
      mode: 'workspace-write', workspaceRoot: '/ws', sessionId: SessionId('linux'),
    })).toThrow(SandboxUnavailableError)
    expect(mockState.grants).toHaveLength(0)
    await fiber.dispose()
  })

  it('confine reports the windows-acl enforcement, denial dialect, and runner-failure rules', async () => {
    const { sandbox, fiber } = await setup()
    const ws = workspaceRoot()
    scratch.push(ws)
    const confined = sandbox.confine(['true'], { mode: 'read-only', workspaceRoot: ws })
    expect(confined.enforcement).toBe('partial')
    expect(confined.denialSignatures).toEqual(['access is denied', 'access to the path', 'permission denied'])
    expect(confined.runnerFailureRules).toEqual([
      { allowedExitCodes: [127], fatalSignatures: ['windows-acl-run: '] },
    ])
    await fiber.dispose()
  })

  it('invariant #2: a workspace-write command does not start until the grant is confirmed', async () => {
    try {
      const { sandbox, fiber } = await setup()
      const ws = workspaceRoot()
      scratch.push(ws)
      sandbox.internals.grantCliArgs = ['node', 'grant-cli.js']
      // 挂起的 grant-cli：helper 已 spawn，但永不 settle（模拟分钟级大树遍历）。
      let pendingResolve: () => void = () => {}
      sandbox.internals.spawnGrant = () => new Promise<void>((resolve) => { pendingResolve = resolve })

      // 触发挂起授权（不 await —— 这是 in-flight 的 prewarm/首次触发）。
      void sandbox.ensureWorkspaceGrant(ws)
      expect(sandbox.workspaceGrantState(ws)).toBe('preparing')

      // 授权未确认：confine 同步抛 SandboxUnavailableError（fail-closed 拒绝），
      // 事件循环不被阻塞 —— 耗时断言证明 confine 没有 await 挂起的 grant。
      const started = Date.now()
      expect(() => sandbox.confine(['true'], {
        mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('prep'),
      })).toThrow(SandboxUnavailableError)
      expect(() => sandbox.confine(['true'], {
        mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('prep'),
      })).toThrow(/is 'preparing'/u)
      expect(Date.now() - started).toBeLessThan(200)

      // 授权落地 → ready → 命令允许启动。
      pendingResolve()
      await sandbox.ensureWorkspaceGrant(ws)
      expect(sandbox.workspaceGrantState(ws)).toBe('ready')
      const confined = sandbox.confine(['true'], {
        mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('prep'),
      })
      expect(flag(confined.argv, '--write-sid')).toBe(WORKSPACE_SID)

      await fiber.dispose()
    } finally {
      cleanup()
    }
  })

  it('invariant #8: bounded retry pins a workspace to failed; retryWorkspaceGrant resets it', async () => {
    try {
      const { sandbox, fiber } = await setup({ maxGrantRetries: 2 })
      const ws = workspaceRoot()
      scratch.push(ws)
      sandbox.internals.grantCliArgs = ['node', 'grant-cli.js']
      sandbox.internals.spawnGrant = async () => { throw new Error('grant helper exploded') }

      // 连续失败达到 maxGrantRetries → 状态 pinned 到 failed。
      await expect(sandbox.ensureWorkspaceGrant(ws)).rejects.toThrow('grant helper exploded') // failures=1
      await expect(sandbox.ensureWorkspaceGrant(ws)).rejects.toThrow('grant helper exploded') // failures=2
      expect(sandbox.workspaceGrantState(ws)).toBe('failed')

      // 自动重试停止：第三次 ensure 不再 spawn（bounded），resolve 但不授权。
      let calls = 0
      sandbox.internals.spawnGrant = async () => { calls++ }
      await sandbox.ensureWorkspaceGrant(ws)
      expect(calls).toBe(0)
      expect(sandbox.workspaceGrantState(ws)).toBe('failed')

      // failed 状态同样拒绝启动命令，且错误信息给出逃生通道。
      expect(() => sandbox.confine(['true'], {
        mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('pinned'),
      })).toThrow(SandboxUnavailableError)
      expect(() => sandbox.confine(['true'], {
        mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('pinned'),
      })).toThrow(/is 'failed'/u)
      expect(() => sandbox.confine(['true'], {
        mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('pinned'),
      })).toThrow(/retryWorkspaceGrant/u)

      // 逃生通道：retryWorkspaceGrant 重置计数 → helper 成功后 ready → 命令可启动。
      sandbox.internals.spawnGrant = async () => { /* now succeeds */ }
      await sandbox.retryWorkspaceGrant(ws)
      expect(sandbox.workspaceGrantState(ws)).toBe('ready')
      const confined = sandbox.confine(['true'], {
        mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('pinned'),
      })
      expect(flag(confined.argv, '--write-sid')).toBe(WORKSPACE_SID)

      await fiber.dispose()
    } finally {
      cleanup()
    }
  })

  it('invariant #3/#6: canonical path spellings dedup to one grant and one SID', async () => {
    try {
      const { sandbox, fiber } = await setup()
      const ws = workspaceRoot()
      scratch.push(ws)
      sandbox.internals.grantCliArgs = ['node', 'grant-cli.js']
      const spawnCalls: string[] = []
      sandbox.internals.spawnGrant = async (argv) => { spawnCalls.push(argv.join(' ')) }

      await sandbox.ensureWorkspaceGrant(ws)
      // 同一目录的不同拼写（尾分隔符 / "." 段 / 大小写）合并到同一 canonical 键。
      await sandbox.ensureWorkspaceGrant(`${ws}\\`)
      await sandbox.ensureWorkspaceGrant(`${ws}\\.`)
      if (process.platform === 'win32') await sandbox.ensureWorkspaceGrant(ws.toUpperCase())
      expect(spawnCalls).toHaveLength(1)
      expect(sandbox.workspaceGrantState(`${ws}\\`)).toBe('ready')

      // 不同拼写也能启动命令，且 runner 收到的是 canonical 路径（无尾分隔符）。
      const confined = sandbox.confine(['true'], {
        mode: 'workspace-write', workspaceRoot: `${ws}\\`, sessionId: SessionId('canon'),
      })
      expect(flag(confined.argv, '--workspace')).toBe(realpathSync.native(ws))
      expect(flag(confined.argv, '--workspace')).not.toMatch(/[\\/]$/u)

      await fiber.dispose()
    } finally {
      cleanup()
    }
  })

  it('invariant #1/#10: a pending grant never stalls unrelated confinement (event loop responds)', async () => {
    try {
      const { sandbox, fiber } = await setup()
      const wsA = workspaceRoot()
      const wsB = workspaceRoot()
      scratch.push(wsA, wsB)
      sandbox.internals.grantCliArgs = ['node', 'grant-cli.js']
      let pendingResolve: () => void = () => {}
      sandbox.internals.spawnGrant = (argv) => {
        // 只有 A 挂起；B 立即成功。
        if (argv.includes(wsB)) return Promise.resolve()
        return new Promise<void>((resolve) => { pendingResolve = resolve })
      }
      await materializeWorkspaceGrant(sandbox, wsB)
      void sandbox.ensureWorkspaceGrant(wsA) // 挂起，不 await
      expect(sandbox.workspaceGrantState(wsA)).toBe('preparing')

      // A 的授权挂起时，B 的 workspace-write 与 A 的 read-only 都立即返回。
      const started = Date.now()
      const bConfined = sandbox.confine(['true'], { mode: 'workspace-write', workspaceRoot: wsB, sessionId: SessionId('b') })
      sandbox.confine(['true'], { mode: 'read-only', workspaceRoot: wsA })
      expect(flag(bConfined.argv, '--write-sid')).toBe(WORKSPACE_SID)
      expect(Date.now() - started).toBeLessThan(200)

      pendingResolve()
      await fiber.dispose()
    } finally {
      cleanup()
    }
  })

  it('invariant #7: shutdown observes the in-flight grant helper before revoking', async () => {
    const { sandbox, fiber } = await setup()
    const ws = workspaceRoot()
    scratch.push(ws)
    sandbox.internals.grantCliArgs = ['node', 'grant-cli.js']
    let pendingResolve: () => void = () => {}
    sandbox.internals.spawnGrant = () => new Promise<void>((resolve) => { pendingResolve = resolve })
    void sandbox.ensureWorkspaceGrant(ws) // in-flight 挂起

    // dispose 必须等待 in-flight helper settle，而不是中途撤销。
    const disposing = fiber.dispose()
    let disposed = false
    disposing.then(() => { disposed = true })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(disposed).toBe(false) // 授权未 settle，dispose 仍在等待（invariant #7）

    pendingResolve()
    await disposing
    expect(disposed).toBe(true)
  })
})
