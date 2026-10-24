/**
 * plugin/config.js — 插件配置面（零 DSH API / 零第三方依赖）
 *
 * 六个字段的取舍标准：都能用一句话解释清楚后果，且默认值即安全值。
 *   - skill           是否注册内置 vibestart 技能
 *   - allowExec       是否允许 vibestart_run 启动 CLI
 *   - allowApply      是否允许 vibestart_run 在 apply=true 时真的写盘
 *   - cliVersion      固定的上游版本（预览与执行必须同一版本）
 *   - runner          用 npx 还是 pnpm dlx 启动
 *   - maxStacks       工具未传 limit 时的默认样本条数
 *   - previewTimeoutMs / applyTimeoutMs  超时（预览要下载 CLI，执行还要装依赖跑检查）
 *   - npmCacheDir     npx 的缓存目录（默认相对当前工作目录）
 *
 * 为什么有 npmCacheDir：DSH 默认的 workspace-write 文件策略下，npm 的全局缓存
 * （%LOCALAPPDATA%\npm-cache）在工作区外，npx 会直接 EPERM。把缓存指到命令所在的
 * 工作目录里，vibestart_run 才能在默认策略下真正跑起来；填空字符串则完全不注入
 * （交给调用方所在环境决定）。
 *
 * 同时导出 Standard Schema 形状的 `Config`，让 Cordis 的 resolveConfig() 在
 * 加载期校验；`apply()` 内再 normalize 一次，保证直接调用（测试）也安全。
 */

import {
  DEFAULT_CLI_VERSION,
  DEFAULT_MAX_STACKS,
  DEFAULT_NPM_CACHE_DIR,
  DEFAULT_RUNNER,
  RUNNERS,
  TIMEOUTS,
} from '../config.js'

export const DEFAULT_CONFIG = Object.freeze({
  skill: true,
  allowExec: true,
  allowApply: true,
  cliVersion: DEFAULT_CLI_VERSION,
  runner: DEFAULT_RUNNER,
  maxStacks: DEFAULT_MAX_STACKS,
  previewTimeoutMs: TIMEOUTS.runPreview,
  applyTimeoutMs: TIMEOUTS.runApply,
  npmCacheDir: DEFAULT_NPM_CACHE_DIR,
})

const MIN_STACKS = 1
const MAX_STACKS = 8
const MIN_TIMEOUT_MS = 5_000
const MAX_TIMEOUT_MS = 1_800_000

/** `latest` 也接受：用户明确想跟上游时给这条路，但默认固定版本。 */
const CLI_VERSION_PATTERN = /^(latest|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/

/**
 * 校验并规范化配置。未知字段被忽略；类型/范围错误直接抛 TypeError。
 * @param {unknown} raw
 */
export function normalizeConfig(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('config 必须是对象')
  }
  const value = { ...DEFAULT_CONFIG, ...raw }

  for (const key of ['skill', 'allowExec', 'allowApply']) {
    if (typeof value[key] !== 'boolean') throw new TypeError(`${key} 必须是布尔值`)
  }

  if (typeof value.cliVersion !== 'string' || !CLI_VERSION_PATTERN.test(value.cliVersion)) {
    throw new TypeError('cliVersion 必须是 semver（如 0.1.1）或 "latest"')
  }

  if (typeof value.runner !== 'string' || !Object.hasOwn(RUNNERS, value.runner)) {
    throw new TypeError(`runner 必须是 ${Object.keys(RUNNERS).join(' / ')} 之一`)
  }

  if (!Number.isInteger(value.maxStacks) || value.maxStacks < MIN_STACKS || value.maxStacks > MAX_STACKS) {
    throw new TypeError(`maxStacks 必须是 ${MIN_STACKS}-${MAX_STACKS} 的整数`)
  }

  for (const key of ['previewTimeoutMs', 'applyTimeoutMs']) {
    const ms = value[key]
    if (!Number.isInteger(ms) || ms < MIN_TIMEOUT_MS || ms > MAX_TIMEOUT_MS) {
      throw new TypeError(`${key} 必须是 ${MIN_TIMEOUT_MS}-${MAX_TIMEOUT_MS} 的整数`)
    }
  }

  if (typeof value.npmCacheDir !== 'string' || value.npmCacheDir.length > 200) {
    throw new TypeError('npmCacheDir 必须是字符串（空字符串表示不注入 npm_config_cache）')
  }
  if (value.npmCacheDir !== '' && !value.npmCacheDir.trim()) {
    throw new TypeError('npmCacheDir 不能是纯空白')
  }

  return Object.freeze({
    skill: value.skill,
    allowExec: value.allowExec,
    allowApply: value.allowApply,
    cliVersion: value.cliVersion,
    runner: value.runner,
    maxStacks: value.maxStacks,
    previewTimeoutMs: value.previewTimeoutMs,
    applyTimeoutMs: value.applyTimeoutMs,
    npmCacheDir: value.npmCacheDir,
  })
}

/**
 * Standard Schema 适配层。Cordis 4.x 的 resolveConfig() 读取
 * `Config['~standard'].validate(config)`。
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-vibestart',
    validate(value = {}) {
      try {
        return { value: normalizeConfig(value) }
      } catch (error) {
        return { issues: [{ message: error.message, path: [] }] }
      }
    },
  },
}
