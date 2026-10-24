/**
 * lib/config.js — 跨模块共享的常量（零 DSH API / 零第三方依赖）
 *
 * `lib/plugin/config.js` 负责用户可配的那一层；这里只放「不该由用户改」的
 * 事实：上游包的默认固定版本、runner 的调用形状、超时与输出上限。
 */

/** 上游 CLI 包名。 */
export const CLI_PACKAGE = 'vibestart-cli'

/**
 * 默认固定的上游版本。
 *
 * 固定而不是 `latest`：技能里要求「预览与执行用同一版本」，否则两次 npx 之间
 * 上游发版会让 dry-run 的结果与实际写入不一致。升级走 `npm run snapshot`。
 */
export const DEFAULT_CLI_VERSION = '0.1.1'

/** 允许的 runner → 启动 argv 前缀（包名与版本由 buildCliCommand 拼在中间）。 */
export const RUNNERS = Object.freeze({
  npx: Object.freeze(['npx', '--yes']),
  'pnpm-dlx': Object.freeze(['pnpm', 'dlx']),
})

export const DEFAULT_RUNNER = 'npx'

/** 单个命令的输出上限（字符）。超过后截断并标注。 */
export const MAX_OUTPUT_CHARS = 200_000

/**
 * 工具级超时（毫秒）。
 * - stacks / plan 是纯计算，给一个宽松但有限的上限即可；
 * - run 的预览要等 npx 下载 CLI，真实执行还要装依赖跑检查，分开给。
 */
export const TIMEOUTS = Object.freeze({
  stacks: 10_000,
  plan: 10_000,
  runPreview: 180_000,
  runApply: 600_000,
  snapshot: 300_000,
})

/** 维护型子命令；`create` 之外都从项目根执行。 */
export const MAINTENANCE_COMMANDS = Object.freeze(['add', 'doctor', 'upgrade'])

/** 本插件支持的全部子命令。 */
export const CLI_COMMANDS = Object.freeze(['create', ...MAINTENANCE_COMMANDS])

/** 模型工具的默认命中条数。 */
export const DEFAULT_MAX_STACKS = 5

/**
 * npx 缓存目录的默认值（相对命令的工作目录）。
 *
 * DSH 默认的 workspace-write 文件策略会把工作区外的写入拒掉，而 npm 的默认缓存
 * 在 `%LOCALAPPDATA%\npm-cache`（工作区外），npx 一跑就 EPERM。把缓存指到命令
 * 自己的工作目录里，默认策略下才能正常下载 CLI。
 */
export const DEFAULT_NPM_CACHE_DIR = '.dsh-vibestart-npm-cache'
