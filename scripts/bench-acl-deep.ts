/**
 * Deep ACL grant benchmark — scaling curve + event-loop responsiveness + repeat statistics.
 *
 * 相对 `bench-acl.ts`（单点、单次、只看 grant.add 墙钟）的深化（v2）：
 *
 * 1. **缩放曲线**：合成 1k/5k/10k/20k/30k 文件的多规模工作区，实测首次（同步全树
 *    传播）与后续（exact-ACE skip）随文件数的缩放关系——证明首次 ~O(文件数)、
 *    后续 O(1) 且与树大小无关。
 * 2. **首次统计化**：每个规模建 `--first-repeats`（默认 3）个等规模**独立目录**，
 *    各测一次首次 add，报 min/median/max——把"首次"从单点测量变成统计量，
 *    消除单次机器噪声（v1 的首次是单点，20k 的 async stall 143ms 是噪声尖峰）。
 * 3. **幂律拟合**：对"首次 median vs 文件数"做 log-log 最小二乘回归（t = c·n^α），
 *    报实测指数 α 与 R²——把"~O(文件数)"从目测变成数学确认。
 * 4. **事件循环响应性（含 p50）**：对每个规模同时测两条路径——同步 `grant.add`
 *    （阻塞主线程）与异步 `grant-cli` 子进程（主线程继续处理 timer）。用 5ms
 *    `setInterval` 记录相邻 tick 间隔，报 max/p99/p50/mean：
 *      - sync: 首次 add 期间 tick 完全停摆，max ≈ 首次墙钟（服务器冻结时长）
 *      - async: 子进程跑整树传播时主线程持续 tick，max/p99/p50 应远小于首次墙钟
 * 5. **fail-closed 窗口量化**：异步路径的"授权确认总时长" = grant-cli 子进程
 *    spawn→exit 墙钟（`confirmMs`，冷启动 + 整树传播）。这是维护者状态机挑战
 *    #2"grant 确认前不启动子进程"下，用户第一次命令被拒/等待的窗口。随后 standing
 *    ACE 已落地，再 spawn 一次（`confirmPrewarmedMs`）量化 prewarm 后的窗口
 *    （≈ 冷启动 + exact-ACE skip）。
 * 6. **真实 monorepo 交叉验证（--real）**：对真实目录测官方同步首次墙钟 + 后续
 *    median + 异步 prewarmed 确认窗口，验证合成树结论在真实世界成立。
 *    ⚠️ 会给目标目录写入 standing write ACE（跨会话复用缓存，不撤销）。
 *
 * 与 `bench-acl.ts` 一致：同步路径劫持官方 `grant.ts`/`workspace-sid.ts` 源码
 * （反映官方当前真实实现）；异步路径 spawn 本插件的 `grant-cli` 入口（它复用官方
 * npm 包 `@deepseek-ai/dsh-sandbox-windows-acl` 的 ACL 原语，实现一致）。
 *
 * 运行（plugins 工作区根）：
 *   pnpm --filter @topolyte/windows-acl exec node --import tsx/esm scripts/bench-acl-deep.ts
 *   pnpm --filter @topolyte/windows-acl exec node --import tsx/esm scripts/bench-acl-deep.ts --scales 1000,5000,10000 --rounds 7
 *   pnpm --filter @topolyte/windows-acl exec node --import tsx/esm scripts/bench-acl-deep.ts --report docs/bench-acl-deep.json
 *   pnpm --filter @topolyte/windows-acl exec node --import tsx/esm scripts/bench-acl-deep.ts --real <monorepo-path>
 *
 * 退出码：完成=0；Win32/参数错误=1。
 * @module @topolyte/windows-acl/scripts
 */

import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

// 劫持官方 ts 源码（非 npm 编译产物）——官方当前实现
import { AclWriteGrant } from '../../../deepseek-harness/packages/sandbox/sandbox-windows-acl/src/grant.ts'
import { workspaceWriteSid } from '../../../deepseek-harness/packages/sandbox/sandbox-windows-acl/src/workspace-sid.ts'

const here = dirname(fileURLToPath(import.meta.url))
const grantCliPath = resolve(here, '../src/grant-cli.ts')
/** 本插件 grant-cli 的失败退出码（见 src/grant-cli.ts 契约）。 */
const GRANT_FAILURE_EXIT = 127
/** 事件循环采样间隔（ms）——足够密以捕捉阻塞，又不会拖慢测量。 */
const TICK_INTERVAL_MS = 5
/** 每个规模测"首次"的独立目录数（统计化，消除单点噪声）。 */
const DEFAULT_FIRST_REPEATS = 3

interface ScalePoint {
  /** 合成工作区文件总数。 */
  files: number
  /** 子目录数（文件均匀铺在这些目录里，eager 传播必须遍历它们）。 */
  dirs: number
}

/** 默认规模序列：从 ~1k 到 ~30k 文件，覆盖"小目录"到"中型 monorepo"。 */
const DEFAULT_SCALES: ScalePoint[] = [
  { files: 1_000, dirs: 20 },
  { files: 5_000, dirs: 100 },
  { files: 10_000, dirs: 200 },
  { files: 20_000, dirs: 400 },
  { files: 30_000, dirs: 600 },
]

/** 后续 provision 的重复次数（同目录、standing ACE 已落地，可安全重复）。 */
const DEFAULT_ROUNDS = 7

interface Stat {
  min: number
  median: number
  max: number
  mean: number
  std: number
  samples: number[]
}

function stats(samples: number[]): Stat {
  const sorted = [...samples].sort((a, b) => a - b)
  const n = sorted.length
  const mean = sorted.reduce((acc, v) => acc + v, 0) / n
  const variance = sorted.reduce((acc, v) => acc + (v - mean) ** 2, 0) / n
  const median = n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2
  return {
    min: sorted[0],
    median,
    max: sorted[n - 1],
    mean,
    std: Math.sqrt(variance),
    samples: sorted,
  }
}

function ms(v: number): string {
  return `${v.toFixed(1)}ms`
}

/** 递归统计目录下文件数（同步 walk，接受不可读子目录）。 */
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

/** 创建合成工作区：`files` 个空文件均匀铺在 `dirs` 个子目录里。 */
function createTree(root: string, files: number, dirs: number): void {
  mkdirSync(root, { recursive: true })
  const per = Math.max(1, Math.floor(files / dirs))
  let remaining = files
  for (let d = 0; d < dirs && remaining > 0; d++) {
    const dir = join(root, `d${d}`)
    mkdirSync(dir, { recursive: true })
    for (let i = 0; i < per && remaining > 0; i++) {
      // 空文件即可：ACL eager 传播遍历的是目录项，文件内容无关。
      const fd = openSync(join(dir, `f${remaining--}.bin`), 'w')
      closeSync(fd)
    }
  }
}

interface StallResult {
  /** 最大相邻 tick 间隔（= 事件循环被占用/阻塞的时长，ms）。 */
  max: number
  /** 99 分位相邻 tick 间隔。 */
  p99: number
  /** 50 分位相邻 tick 间隔（抗单次噪声的典型抖动）。 */
  p50: number
  /** 相邻 tick 间隔均值。 */
  mean: number
  /** 全部相邻 tick 间隔。 */
  gaps: number[]
}

/**
 * 在 `work` 执行期间用 5ms `setInterval` 采样事件循环：相邻 tick 间隔即事件循环
 * 两次回调间被占用的时长。同步 `work` 阻塞时 tick 完全停摆（max ≈ 阻塞墙钟）；
 * 异步 `work`（子进程后台跑）时主线程持续 tick（max/p99/p50 应接近采样间隔）。
 */
async function measureTickStall(work: () => void | Promise<void>): Promise<StallResult> {
  const gaps: number[] = []
  let last = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    gaps.push(now - last)
    last = now
  }, TICK_INTERVAL_MS)
  try {
    await work()
  } finally {
    clearInterval(timer)
  }
  const sorted = [...gaps].sort((a, b) => a - b)
  const n = sorted.length
  const mean = n > 0 ? sorted.reduce((acc, v) => acc + v, 0) / n : 0
  const p99 = n > 0 ? sorted[Math.min(n - 1, Math.floor(n * 0.99))] : 0
  const p50 = n > 0 ? sorted[Math.min(n - 1, Math.floor(n * 0.5))] : 0
  return { max: n > 0 ? sorted[n - 1] : 0, p99, p50, mean, gaps: sorted }
}

/**
 * spawn 本插件 grant-cli 子进程并返回 spawn→exit 的墙钟（ms）。
 * 子进程退出 = standing ACE 已落地 = 授权确认。该墙钟即 fail-closed 窗口：
 * 维护者不变量 #2"grant 确认前不启动子进程"下，用户第一次命令被拒/等待的时长。
 * 全程不阻塞主线程（`spawn` 异步，事件循环持续响应）。
 */
async function runGrantCliAsync(workspace: string): Promise<number> {
  const t0 = performance.now()
  const child = spawn(process.execPath, ['--import', 'tsx/esm', grantCliPath, workspace], {
    stdio: 'ignore',
    windowsHide: true,
  })
  const [code] = (await once(child, 'exit')) as [number | null]
  const wall = performance.now() - t0
  if (code !== 0 && code !== null) {
    throw new Error(`grant-cli exited ${code} (want 0)`)
  }
  return wall
}

/**
 * 对 (x, y) 做 log-log 最小二乘拟合：log y = log c + α·log x（即 t = c·n^α）。
 * 返回实测指数 α 与决定系数 R²（越接近 1 拟合越好）。α≈1 → ~O(文件数)。
 */
function fitPowerLaw(points: { x: number; y: number }[]): { alpha: number; rSquared: number; intercept: number } {
  const n = points.length
  if (n < 2) return { alpha: NaN, rSquared: NaN, intercept: NaN }
  const lx = points.map((p) => Math.log(p.x))
  const ly = points.map((p) => Math.log(p.y))
  const mx = lx.reduce((a, b) => a + b, 0) / n
  const my = ly.reduce((a, b) => a + b, 0) / n
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0; i < n; i++) {
    sxy += (lx[i] - mx) * (ly[i] - my)
    sxx += (lx[i] - mx) ** 2
    syy += (ly[i] - my) ** 2
  }
  const alpha = sxy / sxx
  const intercept = my - alpha * mx // log c
  const rSquared = sxy ** 2 / (sxx * syy)
  return { alpha, rSquared, intercept }
}

interface ScaleResult {
  files: number
  actualFiles: number
  /** 数据来源：synthetic=合成均匀树；real=真实目录（--real）。 */
  source: 'synthetic' | 'real'
  /** 真实目录名（仅 real 模式）。 */
  realPath?: string
  sync: {
    /** 首次 add 统计（统计化：FIRST_REPEATS 个独立等规模目录）。 */
    first: Stat
    /** 兼容字段：首次中位数（≈ first.median）。 */
    firstMs: number
    /** 兼容字段：sync 首次阻塞期间的最大 gap（= 最大首次墙钟）。 */
    stallMax: number
    subsequent: Stat
  }
  async: {
    /** 异步子进程跑整树传播期间主线程的 tick 分布（=服务器响应性）。 */
    stall: StallResult
    /** fail-closed 窗口（cold）：grant-cli spawn→exit 墙钟 = 冷启动 + 整树传播。 */
    confirmMs: number
    /** prewarm 后的确认窗口：standing ACE 已落地，再次 spawn→exit（≈ 冷启动 + skip）。 */
    confirmPrewarmedMs: number
  }
}

async function benchScale(scale: ScalePoint, rounds: number, firstRepeats: number): Promise<ScaleResult> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-bench-'))
  const syncWs = join(root, 'sync')
  const asyncWs = join(root, 'async')
  try {
    createTree(syncWs, scale.files, scale.dirs)
    createTree(asyncWs, scale.files, scale.dirs)
    const actualFiles = countFiles(syncWs)

    // --- sync path: 首次统计化（独立等规模目录各测一次，消除单点噪声） ---
    // 同步 add 期间事件循环完全停摆（5ms timer 零触发）——用户可感知的冻结时长
    // = 每次 add 的墙钟。同一目录无法重复测首次（一次即落地 standing ACE），
    // 因此建 firstRepeats 个独立目录，报 min/median/max。
    const firstSamples: number[] = []
    for (let i = 0; i < firstRepeats; i++) {
      const dir = join(root, `sync-first-${i}`)
      createTree(dir, scale.files, scale.dirs)
      const sid = workspaceWriteSid(dir)
      const grant = AclWriteGrant.create(sid)
      const t0 = performance.now()
      grant.add(dir, true)
      firstSamples.push(performance.now() - t0)
    }
    const first = stats(firstSamples)

    // --- subsequent provisions: exact-ACE skip，重复 rounds 次取统计 ---
    const sid = workspaceWriteSid(syncWs)
    const subsequentSamples: number[] = []
    for (let i = 0; i < rounds; i++) {
      const grant = AclWriteGrant.create(sid)
      const t1 = performance.now()
      grant.add(syncWs, true)
      subsequentSamples.push(performance.now() - t1)
    }

    // --- async path: grant-cli 子进程跑整树传播，主线程继续响应 timer ---
    // confirmMs = fail-closed 窗口（cold）：冷启动 + 全树传播，全程主线程响应。
    let confirmMs = 0
    const asyncStall = await measureTickStall(async () => {
      confirmMs = await runGrantCliAsync(asyncWs)
    })
    // prewarm 后：standing ACE 已落地（exact-ACE skip），再次确认的窗口趋近冷启动。
    const confirmPrewarmedMs = await runGrantCliAsync(asyncWs)

    console.log(
      `scale ${String(actualFiles).padStart(6)} files | ` +
        `sync first median ${ms(first.median)} (min/max ${ms(first.min)}/${ms(first.max)}) | ` +
        `subsequent median ${ms(stats(subsequentSamples).median)} | ` +
        `async stall max ${ms(asyncStall.max)} p50 ${ms(asyncStall.p50)} | ` +
        `confirm cold ${ms(confirmMs)} prewarmed ${ms(confirmPrewarmedMs)}`,
    )

    return {
      files: scale.files,
      actualFiles,
      source: 'synthetic',
      sync: {
        first,
        firstMs: first.median,
        stallMax: first.max,
        subsequent: stats(subsequentSamples),
      },
      async: {
        stall: asyncStall,
        confirmMs,
        confirmPrewarmedMs,
      },
    }
  } finally {
    // 清理合成工作区（standing ACE 加过也不影响删除——OWNER 仍可删）。
    rmSync(root, { recursive: true, force: true })
  }
}

/**
 * 真实 monorepo 交叉验证。⚠️ 会给 `realPath` 写入 standing write ACE（不撤销）。
 * 真实目录只有一个，无法像合成树那样统计化首次，也无法公平地让 sync/async 都测
 * 首次（谁先跑谁就是首次）。因此：
 *   - sync.firstMs = 官方同步路径在真实树上的首次墙钟（= 服务器冻结时长）——单点；
 *   - sync.subsequent = 后续 provision（exact-ACE skip，真实树 O(1) 验证）；
 *   - async.confirmPrewarmedMs = 插件 + prewarm 后的确认窗口（standing 已在，
 *     趋近冷启动；插件冷窗口已在合成树量化）。
 */
async function benchReal(realPath: string, rounds: number): Promise<ScaleResult> {
  const actualFiles = countFiles(realPath)
  const firstSamples: number[] = []
  {
    const sid = workspaceWriteSid(realPath)
    const grant = AclWriteGrant.create(sid)
    const t0 = performance.now()
    grant.add(realPath, true)
    firstSamples.push(performance.now() - t0)
  }
  const first = stats(firstSamples)

  const sid = workspaceWriteSid(realPath)
  const subsequentSamples: number[] = []
  for (let i = 0; i < rounds; i++) {
    const grant = AclWriteGrant.create(sid)
    const t1 = performance.now()
    grant.add(realPath, true)
    subsequentSamples.push(performance.now() - t1)
  }
  const confirmPrewarmedMs = await runGrantCliAsync(realPath)

  console.log(
    `real ${basename(realPath)} (${actualFiles.toLocaleString()} files) | ` +
      `sync first ${ms(first.median)} | subsequent median ${ms(stats(subsequentSamples).median)} | ` +
      `confirm prewarmed ${ms(confirmPrewarmedMs)}`,
  )

  return {
    files: actualFiles,
    actualFiles,
    source: 'real',
    realPath,
    sync: {
      first,
      firstMs: first.median,
      stallMax: first.max,
      subsequent: stats(subsequentSamples),
    },
    async: {
      stall: { max: 0, p99: 0, p50: 0, mean: 0, gaps: [] },
      confirmMs: 0,
      confirmPrewarmedMs,
    },
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const reportPath = args.indexOf('--report') >= 0 ? args[args.indexOf('--report') + 1] : undefined
  const scalesArg = args.indexOf('--scales') >= 0 ? args[args.indexOf('--scales') + 1] : undefined
  const roundsArg = args.indexOf('--rounds') >= 0 ? args[args.indexOf('--rounds') + 1] : undefined
  const firstRepeatsArg = args.indexOf('--first-repeats') >= 0 ? args[args.indexOf('--first-repeats') + 1] : undefined
  const realArg = args.indexOf('--real') >= 0 ? args[args.indexOf('--real') + 1] : undefined

  let scales = DEFAULT_SCALES
  if (scalesArg !== undefined) {
    scales = scalesArg.split(',').map((s) => {
      const files = Number.parseInt(s, 10)
      if (!Number.isFinite(files) || files <= 0) throw new Error(`bad scale: ${s}`)
      return { files, dirs: Math.max(1, Math.round(files / 50)) }
    })
  }
  const rounds = roundsArg !== undefined ? Number.parseInt(roundsArg, 10) : DEFAULT_ROUNDS
  if (!Number.isFinite(rounds) || rounds <= 0) throw new Error(`bad rounds: ${roundsArg}`)
  const firstRepeats =
    firstRepeatsArg !== undefined ? Number.parseInt(firstRepeatsArg, 10) : DEFAULT_FIRST_REPEATS
  if (!Number.isFinite(firstRepeats) || firstRepeats <= 0) throw new Error(`bad first-repeats: ${firstRepeatsArg}`)

  if (process.platform !== 'win32') {
    console.error('bench-acl-deep: Windows-only (SetNamedSecurityInfoW ACL semantics)')
    return 1
  }

  console.log(`== Deep ACL grant benchmark ==`)
  console.log(`scales      : ${scales.map((s) => `${s.files.toLocaleString()} files / ${s.dirs} dirs`).join(', ')}`)
  console.log(`rounds      : ${rounds} (subsequent provisions per scale)`)
  console.log(`firstRepeat : ${firstRepeats} (independent dirs per first-add stat)`)
  console.log(`sync        : official grant.ts (hijacked ts sources, first add)`)
  console.log(`async       : @topolyte/windows-acl grant-cli child (spawn, first add)`)
  console.log()

  const results: ScaleResult[] = []
  for (const scale of scales) {
    results.push(await benchScale(scale, rounds, firstRepeats))
  }

  if (realArg !== undefined) {
    console.log()
    console.warn(
      `⚠️  --real ${realArg}: 将写入 standing write ACE（不撤销，跨会话复用缓存）。` +
        `此操作修改目标目录的 DACL，请确认无误。`,
    )
    results.push(await benchReal(realArg, rounds))
  }

  // 幂律拟合：仅用合成数据的首次中位数（真实数据单点、来源不同，不参与拟合）。
  const fit = fitPowerLaw(
    results
      .filter((r) => r.source === 'synthetic')
      .map((r) => ({ x: r.actualFiles, y: r.sync.first.median })),
  )

  console.log()
  console.log(`| Files | Source | Sync first med (ms) | First min/max | Subsequent med (ms) | Async stall max/p50 (ms) | Confirm cold (ms) | Confirm prewarmed (ms) |`)
  console.log(`| --- | --- | --- | --- | --- | --- | --- | --- |`)
  for (const r of results) {
    const sub = r.sync.subsequent
    console.log(
      `| ${r.actualFiles.toLocaleString()} | ${r.source} | **${r.sync.first.median.toFixed(1)}** | ` +
        `${r.sync.first.min.toFixed(1)}/${r.sync.first.max.toFixed(1)} | ${sub.median.toFixed(1)} | ` +
        `${r.async.stall.max.toFixed(1)}/${r.async.stall.p50.toFixed(1)} | ${r.async.confirmMs.toFixed(1)} | ` +
        `${r.async.confirmPrewarmedMs.toFixed(1)} |`,
    )
  }
  if (Number.isFinite(fit.alpha)) {
    console.log()
    console.log(`power-law fit (synthetic first median): t = ${Math.exp(fit.intercept).toFixed(3)} × n^${fit.alpha.toFixed(3)}, R²=${fit.rSquared.toFixed(4)}`)
  }

  if (reportPath !== undefined) {
    writeFileSync(
      reportPath,
      JSON.stringify({ fit, results, rounds, firstRepeats, tickIntervalMs: TICK_INTERVAL_MS }, null, 2),
      'utf8',
    )
    console.log(`report written to ${reportPath}`)
  }
  return 0
}

main().then(
  (code) => { process.exitCode = code },
  (error) => {
    console.error(error)
    process.exitCode = 1
  },
)
