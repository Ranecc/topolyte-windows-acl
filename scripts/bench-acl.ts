/**
 * ACL 同步授权 benchmark —— 直接劫持官方 ts 源码实测。
 *
 * 测量的核心数字（对应 issue 表格）：
 *   - Sync（阻塞）: 首次 grant 的同步耗时 = `SetNamedSecurityInfoW` 的急切继承传播
 *     （OI|CI ACE 落地时整树递归）——用户在首次 workspace-write 命令上可感知的卡死时长。
 *     仅在目录尚未携带该 capability SID 的 ACE 时才能测到（已授权 → skip）。
 *   - Subsequent（后续）: 已授权目录上再次 `add` 的耗时 = exact-ACE skip（O(1)，
 *     见官方 acl.ts `hasExactGrant`）——一旦 standing ACE 落地，每次后续 provision
 *     都是这个量级。
 *
 * 为什么劫持 ts 源码而不是 import npm 包：脚本直接加载
 * `deepseek-harness/packages/sandbox/sandbox-windows-acl/src/*.ts`（tsx 运行时），
 * 反映官方当前实现的真实行为，不受发布产物/版本漂移影响；koffi 原生绑定从官方包
 * 的 node_modules 解析。
 *
 * 运行（plugins 工作区根）：
 *   pnpm --filter @topolyte/windows-acl exec node --import tsx/esm scripts/bench-acl.ts <workspace> [--report <path>]
 *
 * 授权语义：一律用 standing `add(ws, true)`（真实 dsh workspace 语义——ACE 是跨
 * session 复用缓存，dispose 也不撤销）。因此：
 *   - 未授权目录：测到首次全树传播；测完该目录带上了 standing ACE（真实 dsh 行为）。
 *   - 已授权目录：只测 O(1) skip；不会撤销任何东西。
 * 不做 revocable 模式——`dispose()` 的 revokeWrite 在大型目录上同样触发全树传播，
 * 又慢又破坏已有授权，对 benchmark 无意义。
 *
 * 退出码：完成=0；Win32/参数错误=1。
 * @module @topolyte/windows-acl/scripts
 */

import { spawnSync } from 'node:child_process'
import { readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// 劫持官方 ts 源码（非 npm 编译产物）——官方当前实现
import { AclWriteGrant } from '../../../deepseek-harness/packages/sandbox/sandbox-windows-acl/src/grant.ts'
import { workspaceWriteSid } from '../../../deepseek-harness/packages/sandbox/sandbox-windows-acl/src/workspace-sid.ts'

/** 递归统计目录下的文件数（同步 walk，接受不可读子目录）。 */
function countFiles(root: string): number {
  let count = 0
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) stack.push(join(dir, entry.name))
      else if (entry.isFile()) count += 1
    }
  }
  return count
}

/** 被测目录是否已携带该 capability SID 的 ACE（通过 icacls 观察）。 */
function hasAce(path: string, sid: string): boolean {
  const result = spawnSync('icacls', [path], { encoding: 'utf8' })
  return result.status === 0 && result.stdout.includes(sid)
}

/** 毫秒格式化。 */
function ms(msNumber: number): string {
  return `${msNumber.toFixed(1)}ms`
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const workspaceArg = args.find((a) => !a.startsWith('--'))
  if (workspaceArg === undefined) {
    console.error('usage: bench-acl.ts <workspace> [--report <path>]')
    return 1
  }
  const reportPath = args.indexOf('--report') >= 0 ? args[args.indexOf('--report') + 1] : undefined

  const workspace = realpathSync.native(resolve(workspaceArg))
  if (!statSync(workspace).isDirectory()) {
    console.error(`not a directory: ${workspace}`)
    return 1
  }
  const sid = workspaceWriteSid(workspace)
  const files = countFiles(workspace)
  const alreadyGranted = hasAce(workspace, sid)

  console.log(`== ACL grant benchmark ==`)
  console.log(`workspace : ${workspace}`)
  console.log(`files     : ${files}`)
  console.log(`SID       : ${sid}`)
  console.log(`state     : ${alreadyGranted ? 'granted already (measures O(1) skip)' : 'fresh (measures first full-tree propagation)'}`)
  console.log()

  // standing 授权：真实 dsh 语义，测完保留 ACE（dispose 也不会撤销 standing）。
  const grant = AclWriteGrant.create(sid)
  const start = performance.now()
  grant.add(workspace, true)
  const elapsed = performance.now() - start

  if (alreadyGranted) {
    console.log(`subsequent : ${ms(elapsed)}   (O(1) exact-ACE skip; already-standing ACE)`)
  } else {
    console.log(`first      : ${ms(elapsed)}   (Sync / blocked; full-tree eager propagation)`)
    console.log(`note       : workspace now carries a standing ACE (real dsh semantics)`)
  }
  console.log()
  console.log(`| Scenario | Files | Sync (first, blocked) | Subsequent (O(1) skip) |`)
  console.log(`| :--- | :--- | :--- | :--- |`)
  const syncValue = alreadyGranted ? 'n/a (already granted)' : `**${ms(elapsed)}**`
  const subsequentValue = alreadyGranted ? ms(elapsed) : 'n/a (first add)'
  console.log(`| ${resolve(workspaceArg) === resolve('E:/DEV/competition/deepseek-harness') ? 'Monorepo (DSH itself)' : 'Target dir'} | ~${files.toLocaleString()} | ${syncValue} | ${subsequentValue} |`)

  if (reportPath !== undefined) {
    writeFileSync(reportPath, [
      `# ACL grant benchmark report`,
      ``,
      `- workspace: ${workspace}`,
      `- files: ${files.toLocaleString()}`,
      `- SID: ${sid}`,
      `- state: ${alreadyGranted ? 'granted already' : 'fresh'}`,
      `- elapsed: ${ms(elapsed)} (${alreadyGranted ? 'O(1) exact-ACE skip' : 'first full-tree propagation'})`,
      ``,
    ].join('\n'), 'utf8')
    console.log(`report written to ${reportPath}`)
  }

  return 0
}

main().then(
  (code) => { process.exitCode = code },
  (error) => { console.error(error); process.exitCode = 1 },
)
