/**
 * TopolyteWindowsAclProvider 测试：验证独立 @topolyte/windows-acl 沙箱 provider
 * 的非阻塞授权语义。Win32 ACL 原生面（AclWriteGrant / assertTempRootOutsideWorkspace /
 * workspaceWriteSid / tempWriteSid）整体 mock，授权树遍历真实发生的部分在官方
 * `@deepseek-ai/dsh-sandbox-windows-acl` 的 runner 套件里覆盖。
 *
 * 与 fork 的 sandbox-local `acl-grants.spec.ts` 的差异：本 provider 的 workspace
 * standing grant 是**异步**物化的（grant-cli 子进程），因此所有"materialize
 * workspace grant"断言都放在 `await ensureWorkspaceGrant()` 之后，而不是 confine
 * 返回的同步瞬间。
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

async function setup() {
  const ctx = new Context()
  const fiber = await ctx.plugin(TopolyteWindowsAclProvider, {})
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
      // confine 同步返回后：temp grant 已物化，workspace grant 已在途（grant-cli 子进程）。
      expect(mockState.grants).toHaveLength(1)
      expect(mockState.grants[0]?.writeSid).toBe(tempSid)
      expect(spawnCalls).toHaveLength(1)
      expect(spawnCalls[0]).toEqual({ argv: ['node', 'grant-cli.js', ws], workspaceRoot: ws })

      // 等待 out-of-band 落地：workspace standing grant 记录、temp grant 复用、二次 confine 同 argv。
      // workspace grant 是无 add 的 SID 持有者（ACE 由 grant-cli 子进程落地），仅记录以便 dispose。
      await materializeWorkspaceGrant(sandbox, ws)
      expect(mockState.grants).toHaveLength(2)
      expect(mockState.grants.some(grant => grant.writeSid === WORKSPACE_SID && grant.added.length === 0)).toBe(true)
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

      const upgraded = sandbox.confine(['true'], workspaceWrite)
      expect(flag(upgraded.argv, '--temp-write-sid')).not.toBe(WORKSPACE_SID)
      expect(mockState.grants).toHaveLength(1) // temp 同步；workspace 在途
      await materializeWorkspaceGrant(sandbox, ws)
      expect(mockState.grants).toHaveLength(2)
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
      const parent = sandbox.confine(['true'], { mode: 'workspace-write', workspaceRoot: wsA, sessionId: SessionId('parent') })
      const child = sandbox.confine(['true'], { mode: 'workspace-write', workspaceRoot: wsA, sessionId: SessionId('child') })
      const moved = sandbox.confine(['true'], { mode: 'workspace-write', workspaceRoot: wsB, sessionId: SessionId('parent') })

      expect(flag(child.argv, '--temp')).not.toBe(flag(parent.argv, '--temp'))
      expect(flag(child.argv, '--temp-write-sid')).not.toBe(flag(parent.argv, '--temp-write-sid'))
      expect(flag(moved.argv, '--temp')).not.toBe(flag(parent.argv, '--temp'))
      expect(mockState.grants).toHaveLength(3) // 同步 temp：A/parent、A/child、B/parent；workspace 均在途

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

      mockState.createTempFailure = new Error('temp SID creation exploded')
      expect(() => sandbox.confine(['true'], {
        mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('create-fail'),
      })).toThrow('temp SID creation exploded')
      expect(mockState.grants).toHaveLength(0) // temp 失败被回滚；workspace 在途（后台，无断言）

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
      const confined = sandbox.confine(['true'], {
        mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('dispose'),
      })
      const tempDir = flag(confined.argv, '--temp') ?? ''
      // 让 out-of-band workspace grant 先落地，teardown 才有 3 个失败可报
      // （workspace dispose + temp dispose + temp 目录删除）。
      await materializeWorkspaceGrant(sandbox, ws)
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

      // 并发首调合并到一次 helper spawn。
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
      // in-flight 缓存无残留：下一次调用重新 spawn。
      let calls = 0
      sandbox.internals.spawnGrant = async () => { calls++ }
      await sandbox.ensureWorkspaceGrant(ws)
      expect(calls).toBe(1)

      await fiber.dispose()
    } finally {
      cleanup()
    }
  })

  it('ensureWorkspaceGrant is a no-op for a workspace the synchronous path already granted', async () => {
    try {
      const { sandbox, fiber } = await setup()
      const ws = workspaceRoot()
      scratch.push(ws)
      sandbox.internals.grantCliArgs = ['node', 'grant-cli.js']
      const spawnCalls: string[] = []
      sandbox.internals.spawnGrant = async (argv) => { spawnCalls.push(argv.join(' ')) }
      sandbox.confine(['true'], { mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('sync') })
      await materializeWorkspaceGrant(sandbox, ws)
      expect(mockState.grants.some(grant => grant.writeSid === WORKSPACE_SID)).toBe(true)

      await sandbox.ensureWorkspaceGrant(ws)
      expect(spawnCalls).toHaveLength(1) // 首次 confine 已 kick off；再次 ensure 是 no-op

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
})
