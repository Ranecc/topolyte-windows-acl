/**
 * 独立 grant-helper 入口（@topolyte/windows-acl/grant）。
 *
 * 该子进程负责物化 workspace 根目录的 standing write ACE：`SetNamedSecurityInfoW`
 * 会把可继承 ACE 急切传播到全部现存后代——大 workspace 上这是耗时数分钟的、
 * 阻塞线程的整树遍历。把它放进独立进程（provider 的 `confine()` 通过
 * `spawn` 非阻塞地拉起，绝不阻塞 harness 事件循环），即使 ACE 首次创建，
 * harness 依然保持响应。
 *
 * ACE 是 STANDING（永不撤销）的——它是跨 session 的复用缓存；一旦 ACE 落地，
 * 后续每次 provision 都命中 exact-ACE skip（O(1)），因此 helper 通常毫秒级退出。
 *
 * 稳定的 argv 契约（provider 构造它；未来换成本地 exe 替换件时保持同一契约）：
 *   [node, grant-cli.js, <workspaceRoot>]
 *
 * 失败契约：任何失败都向 stderr 打印 `windows-acl-grant: <detail>` 并退出 127，
 * 与 runner 的失败形态一致。这里不 confine、不 spawn 任何东西——只编辑
 * workspace 的 DACL。
 *
 * 与 fork 版 grant-cli 的唯一差异：`AclWriteGrant`/`workspaceWriteSid` 改从
 * 官方 npm 的 `@deepseek-ai/dsh-sandbox-windows-acl` 主入口导入（官方 npm 没有
 * `./grant` 导出，因此本包自带此入口，但复用官方包的 ACL 原语）。
 * @module @topolyte/windows-acl/grant
 */

import { AclWriteGrant, workspaceWriteSid } from '@deepseek-ai/dsh-sandbox-windows-acl'

/** provider 匹配的 stderr 失败签名（runner 的 `windows-acl-run` 兄弟形态）。 */
const GRANT_SIGNATURE = 'windows-acl-grant'
/** 每个 grant-helper 失败都退出 127，与 runner 的 RUNNER_FAILURE_EXIT 契约一致。 */
const GRANT_FAILURE_EXIT = 127

async function main(): Promise<number> {
  const workspace = process.argv[2]
  if (workspace === undefined || workspace.length === 0) {
    process.stderr.write(`${GRANT_SIGNATURE}: missing workspace path\n`)
    return GRANT_FAILURE_EXIT
  }
  // Standing grant：dispose() 只会释放内存里的 SID 指针（从不撤销 standing ACE）
  // ——对短命 helper 毫无意义，让进程退出自行回收即可。
  AclWriteGrant.create(workspaceWriteSid(workspace)).add(workspace, true)
  return 0
}

main().then(
  (exitCode) => {
    process.exitCode = exitCode
  },
  (error: unknown) => {
    process.stderr.write(`${GRANT_SIGNATURE}: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = GRANT_FAILURE_EXIT
  },
)
