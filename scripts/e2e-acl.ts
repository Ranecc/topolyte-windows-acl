/**
 * windows-acl 独立插件端到端实测脚本（真实 ACL 机制）。
 *
 * 跑全链路，不做任何 mock：
 *   1. 加载 TopolyteWindowsAclProvider（真实 Context + cordis plugin）；
 *   2. `ensureWorkspaceGrant` 拉起真实 grant-cli 子进程，用 koffi + SetNamedSecurityInfoW
 *      物化 workspace 的 standing write ACE；
 *   3. `confine` 用官方 `@deepseek-ai/dsh-sandbox-windows-acl` runner 包住真实命令，
 *      spawn 受限令牌子进程（WRITE_RESTRICTED）；
 *   4. 服务端 ACE 语义全部经 icacls（操作者自己的工具）观察：workspace/temp ACE 存在、
 *      teardown 后 temp 撤销而 workspace standing ACE 保留；
 *   5. 受限子进程内的写语义（工作区内可写/区外被拒/只读被拒）依赖 runner 用受限令牌
 *      CreateProcess——在 TRAE agent 沙箱内会被拦截（exit 2147483653），脚本如实标记
 *      BLOCKED_BY_SANDBOX，并提示用户在普通终端跑同一命令补全这半段。
 *
 * 运行（plugins 工作区根）：
 *   pnpm --filter @topolyte/windows-acl exec node --import tsx/esm scripts/e2e-acl.ts
 *   可选 --report <path>：把完整报告写为 UTF-8 文件（避免终端管道编码问题）。
 *
 * 退出码：服务端语义 + 非阻塞验证全部通过=0；受限子进程段被沙箱拦截仍计 0（环境限制），
 * 真实代码失败=1。
 * @module @topolyte/windows-acl/scripts
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { SessionId } from '@deepseek-ai/dsh-session'
import { tempWriteSid, workspaceWriteSid } from '@deepseek-ai/dsh-sandbox-windows-acl'
import { TopolyteWindowsAclProvider } from '../src/index.ts'

/** TRAE agent 沙箱拦截受限令牌 CreateProcess 时子进程的退出码。 */
const SANDBOX_BLOCKED_EXIT = 2147483653

/** 逐项结果收集：pass 取 'pass' | 'blocked' | 'fail'（blocked=环境限制，非代码失败）。 */
interface StepResult {
  name: string
  verdict: 'pass' | 'blocked' | 'fail'
  detail: string
}

const results: StepResult[] = []
const reportPath = process.argv.indexOf('--report') >= 0
  ? process.argv[process.argv.indexOf('--report') + 1]
  : undefined

function record(name: string, verdict: StepResult['verdict'], detail: string): void {
  results.push({ name, verdict, detail })
  console.log(`${verdict === 'pass' ? 'PASS ' : verdict === 'blocked' ? 'SKIP ' : 'FAIL '} ${name}\n      ${detail}`)
}

/** spawn 一个 argv 并收集 stdout/stderr/退出码（promise 化）。 */
function run(argv: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0] as string, argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

/** 目录 DACL 的 icacls 文本（操作者可见形态）；失败返回空串。 */
function icaclsText(path: string): string {
  const result = spawnSync('icacls', [path], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout : ''
}

/** 受限子进程内的探针：写 workspace / 写外部 / 写私有 temp，打印结构化结果。 */
function probeScript(workspace: string, outside: string, temp: string): string {
  const ws = JSON.stringify(workspace)
  const out = JSON.stringify(outside)
  const tmp = JSON.stringify(temp)
  return [
    "const fs = require('node:fs')",
    "const r = {}",
    `try { fs.writeFileSync(${ws} + '/inside.txt', 'e2e-ok'); r.workspace = 'WRITE_OK' }`,
    `catch (e) { r.workspace = 'WRITE_DENIED:' + (e.code ?? e.message) }`,
    `try { fs.writeFileSync(${out} + '/denied.txt', 'e2e-no'); r.outside = 'WRITE_OK' }`,
    `catch (e) { r.outside = 'WRITE_DENIED:' + (e.code ?? e.message) }`,
    `try { fs.writeFileSync(${tmp} + '/temp.txt', 'e2e-tmp'); r.temp = 'WRITE_OK' }`,
    `catch (e) { r.temp = 'WRITE_DENIED:' + (e.code ?? e.message) }`,
    "console.log('E2E_RESULT ' + JSON.stringify(r))",
  ].join('\n')
}

/**
 * 从受限子进程 stdout 中提取探针 JSON。
 * 探针输出 `E2E_RESULT {...}`——捕获组必须**含外层花括号**（正则写 `\{.*\}` 会把
 * 花括号吃掉、只剩裸键值对，JSON.parse 会因"完整 value 后跟多余字符"而失败）。
 * 解析失败返回 null（调用方如实记录，而不是让脚本崩在中间）。
 */
function parseProbe(stdout: string): Record<string, string> | null {
  const m = /E2E_RESULT (\{.*\})/u.exec(stdout)
  if (!m) return null
  try {
    return JSON.parse(m[1] as string) as Record<string, string>
  } catch {
    return null
  }
}

async function main(): Promise<number> {
  const scratch: string[] = []
  const cleanup = () => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
  }
  try {
    // --- 1. 加载 provider ----------------------------------------------------
    const ctx = new Context()
    const fiber = await ctx.plugin(TopolyteWindowsAclProvider, { prewarm: [] })
    const sandbox = ctx.sandbox as TopolyteWindowsAclProvider
    if (!(sandbox instanceof TopolyteWindowsAclProvider)) {
      record('provider 注册为 ctx.sandbox', 'fail', `得到 ${sandbox?.constructor?.name}，期望 TopolyteWindowsAclProvider`)
      cleanup()
      return 1
    }
    record('provider 注册为 ctx.sandbox', 'pass', 'TopolyteWindowsAclProvider（继承官方 SandboxProvider）')

    // --- 2. 真实工作区 / 外部目录 ------------------------------------------
    const workspace = mkdtempSync(join(tmpdir(), 'topolyte-e2e-ws-'))
    const outside = mkdtempSync(join(tmpdir(), 'topolyte-e2e-out-'))
    scratch.push(workspace, outside)
    record('准备目录', 'pass', `workspace=${workspace}\n      outside=${outside}`)

    // --- 3. 非阻塞 + 真实 grant-cli 物化 standing ACE ----------------------
    const before = performance.now()
    const pending = sandbox.ensureWorkspaceGrant(workspace)
    const kickMs = performance.now() - before
    record('ensureWorkspaceGrant 非阻塞返回', kickMs < 1000 ? 'pass' : 'fail', `kick-off 返回耗时 ${kickMs.toFixed(1)}ms（子进程异步物化）`)
    await pending
    const wsSid = workspaceWriteSid(workspace)
    const wsDaclAfterGrant = icaclsText(workspace)
    record('grant-cli 真实物化 standing ACE', wsDaclAfterGrant.includes(wsSid) ? 'pass' : 'fail',
      `icacls 含 workspace SID ${wsSid}: ${wsDaclAfterGrant.includes(wsSid)}`)

    // --- 4. workspace-write：confine 出 runner argv，temp ACE 落地 -------------
    const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: workspace, sessionId: SessionId('e2e-run') }
    const confined = sandbox.confine(['node', '-e', ''], policy)
    const tempIndex = confined.argv.indexOf('--temp')
    const tempDir = tempIndex >= 0 ? confined.argv[tempIndex + 1] as string : ''
    scratch.push(tempDir)
    const tempSid = tempWriteSid(tempDir)
    const tempDacl = icaclsText(tempDir)
    record('temp 私有目录 + ACE 物化', tempDacl.includes(tempSid) ? 'pass' : 'fail',
      `icacls 含 temp SID ${tempSid}: ${tempDacl.includes(tempSid)}\n      temp=${tempDir}`)

    // --- 5. 受限子进程写语义（runner WRITE_RESTRICTED 令牌）-----------------
    // 探针需要真实 temp 路径：runner 的 --temp 在 '--' 分隔符之前（runner 自身参数），
    // 被包命令（node -e）在 '--' 之后看不到它 → 拿到 tempDir 后把真实脚本注入 argv。
    const sepIndex = confined.argv.indexOf('--')
    const probeArgIndex = confined.argv.indexOf('-e', sepIndex) + 1
    confined.argv[probeArgIndex] = probeScript(workspace, outside, tempDir)
    // TRAE agent 沙箱拦截受限令牌 CreateProcess（exit 2147483653）→ 标记 blocked。
    const result = await run(confined.argv)
    if (result.code === SANDBOX_BLOCKED_EXIT) {
      record('workspace-write 受限子进程（写工作区/写外部/写temp）', 'blocked',
        'TRAE agent 沙箱拦截受限令牌 CreateProcess（exit 2147483653）。请在普通终端跑同命令补全验证。')
    } else {
      const probe = parseProbe(result.stdout)
      const detail = `probe.workspace=${probe?.workspace ?? 'N/A'}; probe.outside=${probe?.outside ?? 'N/A'}; probe.temp=${probe?.temp ?? 'N/A'}`
      record('workspace-write: 工作区内可写', probe?.workspace === 'WRITE_OK' ? 'pass' : 'fail',
        `${detail}\n      stdout=${JSON.stringify(result.stdout.slice(0, 200))}`)
      record('workspace-write: 工作区外被拒', (probe?.outside ?? '').startsWith('WRITE_DENIED') ? 'pass' : 'fail',
        `probe.outside=${probe?.outside}`)
      record('workspace-write: 私有 temp 可写', probe?.temp === 'WRITE_OK' ? 'pass' : 'fail',
        `probe.temp=${probe?.temp}`)
      record('受限子进程退出码', result.code === 0 ? 'pass' : 'fail', `exit=${result.code}\n      stderr=${result.stderr.trim() || '(empty)'}`)
    }

    // --- 6. read-only：写工作区也应被拒 -------------------------------------
    const roPolicy: SandboxPolicy = { mode: 'read-only', workspaceRoot: workspace, sessionId: SessionId('e2e-ro') }
    const roConfined = sandbox.confine(['node', '-e', probeScript(workspace, outside, '')], roPolicy)
    const roResult = await run(roConfined.argv)
    if (roResult.code === SANDBOX_BLOCKED_EXIT) {
      record('read-only 受限子进程（写工作区应被拒）', 'blocked', 'TRAE agent 沙箱拦截受限令牌 CreateProcess（exit 2147483653）')
    } else {
      const roProbe = parseProbe(roResult.stdout)
      record('read-only: 工作区写被拒', (roProbe?.workspace ?? '').startsWith('WRITE_DENIED') ? 'pass' : 'fail',
        `probe.workspace=${roProbe?.workspace ?? 'N/A'}; stdout=${JSON.stringify(roResult.stdout.slice(0, 200))}`)
    }

    // --- 7. teardown：temp ACE 撤销 + 目录删除；workspace standing ACE 保留 ----
    await fiber.dispose()
    const tempDaclAfter = icaclsText(tempDir)
    const wsDaclAfter = icaclsText(workspace)
    record('teardown 撤销 temp ACE 并删除私有目录',
      !existsSync(tempDir) && !tempDaclAfter.includes(tempSid) ? 'pass' : 'fail',
      `temp 目录存在=${existsSync(tempDir)}；icacls 仍含 temp SID=${tempDaclAfter.includes(tempSid)}`)
    record('workspace standing ACE 跨 provider 保留', wsDaclAfter.includes(wsSid) ? 'pass' : 'fail',
      `icacls 仍含 workspace SID ${wsSid}: ${wsDaclAfter.includes(wsSid)}`)

    const failed = results.filter(r => r.verdict === 'fail').length
    const blocked = results.filter(r => r.verdict === 'blocked').length
    const summary = `==== E2E ${failed === 0 ? 'CORE PASS' : `${failed} FAILED`} (${results.length} checks, ${blocked} blocked-by-sandbox) ====`
    console.log(`\n${summary}`)
    if (blocked > 0) {
      console.log('受限子进程段被 TRAE agent 沙箱拦截，请在普通终端运行同一命令补全：')
      console.log('  cd E:\\DEV\\competition\\plugins && pnpm --filter @topolyte/windows-acl exec node --import tsx/esm scripts/e2e-acl.ts')
    }

    if (reportPath !== undefined) {
      const lines = [`# windows-acl E2E report`, ``, ...results.map(r => `[${r.verdict.toUpperCase()}] ${r.name}\n${r.detail}`), ``, summary]
      writeFileSync(reportPath, lines.join('\n'), 'utf8')
      console.log(`报告已写入 ${reportPath}`)
    }

    cleanup()
    return failed === 0 ? 0 : 1
  } catch (error) {
    console.error('E2E 脚本异常终止：', error)
    cleanup()
    return 1
  }
}

main().then(
  (code) => { process.exitCode = code },
  (error) => { console.error(error); process.exitCode = 1 },
)
