#!/usr/bin/env node
/**
 * scripts/snapshot.mjs — 生成 / 校验离线快照 data/snapshot.json（契约 §4）
 *
 * 快照的数据源是 `npx --yes vibestart-cli@<version> --list --json` 的 stdout。
 * 这段 stdout 的真实形状有两个坑，脚本必须自己处理：
 *
 *   1. 前面可能混入 Node 的 ExperimentalWarning / npm 横幅 —— 必须从第一个
 *      独立的 `{` 起做「花括号配平」截取，不能按行首 or 正则硬切；
 *   2. `--list --json` 的输出里**没有版本号** —— 版本只能从 `--help` 的
 *      `(vibestart v0.1.1)` 或 npm 目录里的 version.txt 交叉验证。
 *
 * 因此有三种运行模式：
 *
 *   node scripts/snapshot.mjs                     # 联网：跑 npx 抓取 → 校验 → 写入
 *   node scripts/snapshot.mjs --from <path>       # 离线：读已经抓好的原始输出 → 校验 → 写入
 *   node scripts/snapshot.mjs --check             # 纯校验：不联网、不写盘，验证现有快照
 *
 * 写盘前一定会做四件事，任何一项失败都不写：
 *   - 版本断言（快照记录的版本 === 期望版本 === 数据源报告的版本）；
 *   - 3409 条（可 --expect-count 覆盖）**往返校验**：解码后的 label / values /
 *     verifiedAt 与上游逐条相等；
 *   - 编码自洽：`encode(decode(row)) === row`，证明行编码是双射；
 *   - sha256 完整性 + 体积上限（< 300KB，2 空格缩进的可读 JSON）。
 *
 * 体积说明：按标准 `JSON.stringify(_, null, 2)` 输出会到 309KB（超限 3%）。
 * 所以这里用一个行为等价的自定义格式化器：结构仍是 2 空格缩进、键序不变，
 * 但 `rows` / `labels` / `dates` / `dateIndex` 这几个超大平行数组按固定条数折行
 * （见 ARRAY_CHUNK），既省掉上万行的缩进开销，也不会变成一行 15 万字符。
 *
 * 沙箱注意：在 Windows 上跑 npx 必须把 npm 缓存指到工作区内（默认
 * `dsh-vibestart/.npm-cache`），否则 npm 的全局缓存目录会被沙箱拒绝（EPERM）。
 * 本脚本用 `--npm-cache` 覆盖，默认值已经指好。
 *
 * 退出码：0 成功；1 任一校验失败（用 process.exitCode，不调 process.exit）。
 */

import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CLI_PACKAGE, DEFAULT_CLI_VERSION, TIMEOUTS } from '../lib/config.js'
import { createCodec, stacksDigest } from '../lib/catalog/encode.js'
import { CATALOG_PATH, SNAPSHOT_SCHEMA_VERSION } from '../lib/catalog/index.js'
import { KIND_ORDER } from '../lib/catalog/kinds.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 快照体积上限（字节）：可读 JSON 前提下守住 300KB。 */
const MAX_SNAPSHOT_BYTES = 300 * 1024

/** v0.1.1 的已校验组合数；用于发现「上游发版但快照没跟上」。 */
const EXPECTED_STACK_COUNT = 3409

const USAGE = `用法：
  node scripts/snapshot.mjs                  联网抓取并写入 data/snapshot.json
  node scripts/snapshot.mjs --from <path>    从已抓好的 --list --json 原始输出离线重建
  node scripts/snapshot.mjs --check          只校验现有快照（不联网、不写盘）

选项：
  --from <path>        离线数据源（可以带 Node 警告前缀行）
  --out <path>         输出/校验的快照路径（默认 data/snapshot.json）
  --cli <version>      期望的上游版本（默认 ${DEFAULT_CLI_VERSION}）
  --version <version>  --cli 的别名
  --expect-count <n>   期望的组合数（默认 ${EXPECTED_STACK_COUNT}）
  --allow-count-drift  组合数变化时不失败（打印警告）
  --npm-cache <dir>    npx 缓存目录（默认 .npm-cache，必须在工作区内）
  --generated-at <iso> 固定 generatedAt（复现同一份快照时用）
  --source <text>      snapshot.source 字段的自定义文案
  --dry-run            只构建并打印统计，不写盘
  --help               显示本帮助
`

/** 解析 `--flag value` / `--flag` 形式的参数；遇到未知 flag 直接报错。 */
function parseArgs(argv) {
  const flags = new Set(['--check', '--dry-run', '--help', '--allow-count-drift'])
  const withValue = new Set(['--from', '--out', '--cli', '--version', '--expect-count', '--npm-cache', '--generated-at', '--source'])
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (flags.has(token)) {
      parsed[token.slice(2)] = true
      continue
    }
    if (withValue.has(token)) {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${token} 需要一个值`)
      parsed[token.slice(2)] = value
      index += 1
      continue
    }
    throw new Error(`未知参数：${token}`)
  }
  return parsed
}

function humanBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 超大平行数组的折行粒度：键名 → 每行元素个数。
 * 只影响「一行放几个」，元素顺序、键序、缩进宽度都不变，解析结果与标准
 * `JSON.stringify(_, null, 2)` 完全一致（生成时会断言这一点）。
 */
const ARRAY_CHUNK = new Map([
  ['rows', 12],
  ['labels', 4],
  ['dates', 4],
  ['dateIndex', 24],
])

/**
 * 确定性格式化器：默认与 `JSON.stringify(value, null, 2)` 逐字符一致，
 * 仅对 ARRAY_CHUNK 命中的标量数组按固定条数折行。
 *
 * @param {unknown} value
 * @param {{depth?: number, key?: string|null}} [options]
 * @returns {string}
 */
function formatJson(value, { depth = 0, key = null } = {}) {
  const pad = '  '.repeat(depth)
  const inner = '  '.repeat(depth + 1)

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const perLine = ARRAY_CHUNK.get(key)
    const scalarOnly = value.every(item => item === null || typeof item !== 'object')
    if (perLine && scalarOnly) {
      const chunks = []
      for (let index = 0; index < value.length; index += perLine) {
        chunks.push(`${inner}${value.slice(index, index + perLine).map(item => JSON.stringify(item)).join(', ')}`)
      }
      return `[\n${chunks.join(',\n')}\n${pad}]`
    }
    return `[\n${value.map(item => inner + formatJson(item, { depth: depth + 1 })).join(',\n')}\n${pad}]`
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined)
    if (entries.length === 0) return '{}'
    const body = entries
      .map(([name, item]) => `${inner}${JSON.stringify(name)}: ${formatJson(item, { depth: depth + 1, key: name })}`)
      .join(',\n')
    return `{\n${body}\n${pad}}`
  }

  return JSON.stringify(value)
}

/** 快照 → 入库字符串（2 空格缩进 + 固定换行，结尾一个换行）。 */
export function formatSnapshotJson(snapshot) {
  return `${formatJson(snapshot)}\n`
}

/**
 * 从一段可能带前导垃圾的 stdout 里取出第一个完整的 JSON 对象。
 *
 * 用花括号配平 + 字符串/转义状态机，而不是 `slice(indexOf('{'), lastIndexOf('}'))`：
 * JSON 字符串值里可能出现 `}`，尾部也可能再混入日志行。
 *
 * @param {string} stdout
 * @returns {{json: string, skippedLines: number, trailing: string}}
 */
export function extractJsonObject(stdout) {
  const text = String(stdout ?? '')
  const start = text.indexOf('{')
  if (start < 0) throw new Error('stdout 里没有找到 JSON 对象（期望一个独立的 { 开始）')

  let depth = 0
  let inString = false
  let escaped = false
  let end = -1
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        end = index + 1
        break
      }
      if (depth < 0) throw new Error('stdout 里的 JSON 花括号不配平（多余的 }）')
    }
  }
  if (end < 0) throw new Error('stdout 里的 JSON 不完整（花括号没有闭合）')

  const prefix = text.slice(0, start)
  const skippedLines = prefix.split(/\r?\n/).filter(line => line.trim() !== '').length
  return { json: text.slice(start, end), skippedLines, trailing: text.slice(end).trim() }
}

/** 解析 `--list --json` 的原始输出。 */
function parseListOutput(rawText, label) {
  const { json, skippedLines, trailing } = extractJsonObject(rawText)
  let parsed
  try {
    parsed = JSON.parse(json)
  } catch (error) {
    throw new Error(`${label} 不是合法 JSON：${error.message}`)
  }
  if (!isPlainObject(parsed)) throw new Error(`${label} 的 JSON 顶层不是对象`)
  if (parsed.ok !== true) {
    throw new Error(`${label} 报告 ok !== true：${JSON.stringify(parsed.error ?? parsed).slice(0, 400)}`)
  }
  if (!Array.isArray(parsed.kinds) || parsed.kinds.length === 0) throw new Error(`${label} 缺少 kinds 数组`)
  if (!Array.isArray(parsed.stacks) || parsed.stacks.length === 0) throw new Error(`${label} 缺少 stacks 数组`)
  return { raw: parsed, skippedLines, trailing }
}

/** 从 `--help` 文本里取 `(vibestart v0.1.1)`。 */
function detectVersionFromHelp(text) {
  const match = /vibestart v(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(String(text ?? ''))
  return match?.[1]
}

/**
 * 离线模式下推断上游版本：优先显式 --cli，其次数据源同目录的 version.txt / help.txt。
 * 都推断不到时只警告（原始 --list 数据本身不含版本号，无法凭空验证）。
 *
 * @param {string} fromPath
 * @param {string} expectedVersion
 * @param {{cli?: string, version?: string}} args
 */
function resolveOfflineVersion(fromPath, expectedVersion, args) {
  if (args.cli || args.version) return { version: expectedVersion, evidence: `--cli ${expectedVersion}` }
  const dir = dirname(fromPath)
  for (const [name, extract] of [
    ['version.txt', text => (/^\s*(\d+\.\d+\.\d+)/.exec(text)?.[1])],
    ['help.txt', detectVersionFromHelp],
  ]) {
    try {
      const version = extract(readFileSync(resolve(dir, name), 'utf8'))
      if (version) return { version, evidence: `${name}` }
    } catch {
      // 同目录没有这个文件就继续尝试下一个
    }
  }
  console.log(`  ! 数据源同目录没有 version.txt / help.txt，无法用数据自证版本；按 --cli 的 ${expectedVersion} 记录`)
  return { version: expectedVersion, evidence: null }
}

/** 跑一次 npx（Windows 上必须以 shell 方式启动 npx.cmd）。 */
function runNpx(args, { cliVersion, npmCache }) {
  const fullArgs = ['--yes', `${CLI_PACKAGE}@${cliVersion}`, ...args]
  const env = {
    ...process.env,
    npm_config_cache: npmCache,
    npm_config_update_notifier: 'false',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  }
  return new Promise((resolvePromise, reject) => {
    const failWith = detail => {
      reject(
        new Error(
          `npx ${fullArgs.join(' ')} 启动/执行失败：${detail.message ?? detail}` +
            (detail.output ? `\n--- 子进程输出 ---\n${detail.output}` : '') +
            `\n提示：npm 缓存必须指向工作区内（当前 npm_config_cache=${npmCache}）；` +
            '若报 EPERM/无法创建管道，说明当前环境禁止子进程；请在沙箱外运行，或改用 --from 离线重建。',
        ),
      )
    }
    try {
      execFile(
        'npx',
        fullArgs,
        {
          cwd: ROOT,
          env,
          timeout: TIMEOUTS.snapshot,
          maxBuffer: 64 * 1024 * 1024,
          windowsHide: true,
          shell: process.platform === 'win32',
        },
        (error, stdout, stderr) => {
          if (error) {
            const detail = [stderr, stdout].filter(Boolean).join('\n').trim().slice(-2000)
            failWith({ message: error.message, output: detail })
            return
          }
          resolvePromise({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
        },
      )
    } catch (error) {
      // 某些沙箱会在 spawn 阶段同步抛 EPERM（回调根本不会触发）。
      failWith(error)
    }
  })
}

/** 联网抓取原始 list 输出，并用 --help 交叉验证版本。 */
async function fetchFromNpx({ cliVersion, npmCache }) {
  mkdirSync(npmCache, { recursive: true })
  console.log(`→ 联网抓取：npx --yes ${CLI_PACKAGE}@${cliVersion} --list --json`)
  console.log(`  npm_config_cache=${npmCache}`)
  const list = await runNpx(['--list', '--json'], { cliVersion, npmCache })
  const help = await runNpx(['--help'], { cliVersion, npmCache })
  const reported = detectVersionFromHelp(help.stdout)
  if (!reported) {
    console.log('  ! --help 里没有解析到版本号，跳过版本交叉验证')
  } else if (reported !== cliVersion) {
    throw new Error(
      `版本断言失败：请求的是 ${CLI_PACKAGE}@${cliVersion}，但 --help 报告 v${reported}；` +
        '拒绝写入来源不明的快照。',
    )
  } else {
    console.log(`  ✓ 版本断言：--help 报告 v${reported}`)
  }
  return { text: list.stdout, evidence: `--help v${reported ?? cliVersion}` }
}

/**
 * 上游一条 stack 的 `stack` 对象里，optional kind 不选时**整个键都省略**；
 * 快照编码要求 15 位全给定（"" 表示 none）。这个函数负责补全并校验。
 *
 * @param {unknown} rawStack
 * @param {string[]} kindOrder
 * @param {Record<string, string[]>} valueDomain
 * @param {number} index
 * @returns {{label: string, values: Record<string, string>, verifiedAt: string}}
 */
function normalizeUpstreamStack(rawStack, kindOrder, valueDomain, index) {
  if (!isPlainObject(rawStack)) throw new Error(`第 ${index} 个 stack 不是对象`)
  const label = rawStack.label
  const verifiedAt = rawStack.verifiedAt
  const stack = rawStack.stack
  if (typeof label !== 'string' || label === '') throw new Error(`第 ${index} 个 stack 缺少 label`)
  if (typeof verifiedAt !== 'string' || verifiedAt === '') throw new Error(`第 ${index} 个 stack（${label}）缺少 verifiedAt`)
  if (!isPlainObject(stack)) throw new Error(`第 ${index} 个 stack（${label}）的 stack 字段不是对象`)

  for (const [kind, value] of Object.entries(stack)) {
    if (!Object.hasOwn(valueDomain, kind)) {
      throw new Error(`第 ${index} 个 stack（${label}）出现未知 kind「${kind}」；请同步 lib/catalog/kinds.js 与编码`)
    }
    if (typeof value !== 'string') throw new Error(`第 ${index} 个 stack（${label}）的 ${kind} 取值不是字符串`)
    if (!valueDomain[kind].includes(value)) {
      throw new Error(
        `第 ${index} 个 stack（${label}）的 ${kind}=${JSON.stringify(value)} 不在 options 声明的取值内：` +
          valueDomain[kind].filter(Boolean).join(', '),
      )
    }
  }

  /** @type {Record<string, string>} */
  const values = {}
  for (const kind of kindOrder) {
    const value = Object.hasOwn(stack, kind) ? stack[kind] : ''
    if (!Object.hasOwn(stack, kind) && valueDomain[kind].indexOf('') < 0) {
      throw new Error(`第 ${index} 个 stack（${label}）缺少 required kind「${kind}」的取值`)
    }
    values[kind] = value
  }
  return { label, values, verifiedAt }
}

/** 依据上游 kinds 构建 kinds / kindOrder / valueDomain，并断言顺序与 kinds.js 一致。 */
function buildKindTables(rawKinds) {
  const kinds = rawKinds.map((kind, index) => {
    if (!isPlainObject(kind)) throw new Error(`kinds[${index}] 不是对象`)
    if (typeof kind.id !== 'string' || kind.id === '') throw new Error(`kinds[${index}].id 缺失`)
    if (typeof kind.name !== 'string' || kind.name === '') throw new Error(`kinds[${index}].name 缺失`)
    if (typeof kind.optional !== 'boolean') throw new Error(`kinds[${index}].optional 必须是布尔值`)
    if (!Array.isArray(kind.options) || kind.options.length === 0) {
      throw new Error(`kinds[${index}]（${kind.id}）没有 options`)
    }
    const seen = new Set()
    const options = kind.options.map((option, optionIndex) => {
      if (!isPlainObject(option)) throw new Error(`kinds[${index}].options[${optionIndex}] 不是对象`)
      if (typeof option.id !== 'string' || option.id === '') {
        throw new Error(`kinds[${index}].options[${optionIndex}].id 缺失`)
      }
      if (option.id.includes('=') || option.id.includes(',')) {
        throw new Error(`kind「${kind.id}」的取值「${option.id}」含分隔符，命令生成会歧义`)
      }
      if (seen.has(option.id)) throw new Error(`kind「${kind.id}」的取值「${option.id}」重复`)
      seen.add(option.id)
      return { id: option.id, name: option.name ?? option.id, description: option.description ?? '' }
    })
    return { id: kind.id, name: kind.name, optional: kind.optional, options }
  })

  const kindOrder = kinds.map(kind => kind.id)
  if (kindOrder.length !== KIND_ORDER.length || kindOrder.some((id, index) => id !== KIND_ORDER[index])) {
    throw new Error(
      '上游 kind 顺序与本仓库 lib/catalog/kinds.js 的 KIND_ORDER 不一致；' +
        '行编码依赖顺序，属于破坏性变更：请先更新 kinds.js（并重跑测试），再生成快照。\n' +
        `  上游：${kindOrder.join(', ')}\n  本地：${KIND_ORDER.join(', ')}`,
    )
  }

  /** @type {Record<string, string[]>} */
  const valueDomain = {}
  for (const kind of kinds) {
    const ids = kind.options.map(option => option.id)
    valueDomain[kind.id] = kind.optional ? ['', ...ids] : ids
  }
  return { kinds, kindOrder, valueDomain }
}

/** 解码器 → 逐条与上游对象比对（label / verifiedAt / 每个 kind 的取值）。 */
function assertRoundTrip(stacks, codec) {
  const encoded = codec.encodeStacks(stacks)
  const decoded = codec.decodeStacks(encoded)
  if (decoded.length !== stacks.length) {
    throw new Error(`往返校验失败：编码 ${stacks.length} 条，解码出 ${decoded.length} 条`)
  }
  for (let index = 0; index < stacks.length; index += 1) {
    const expected = stacks[index]
    const actual = decoded[index]
    if (actual.label !== expected.label) {
      throw new Error(`往返校验失败（第 ${index} 条）：label ${JSON.stringify(actual.label)} !== ${JSON.stringify(expected.label)}`)
    }
    if (actual.verifiedAt !== expected.verifiedAt) {
      throw new Error(`往返校验失败（第 ${index} 条 ${expected.label}）：verifiedAt 不一致`)
    }
    const expectedKeys = Object.keys(expected.values)
    const actualKeys = Object.keys(actual.values)
    if (expectedKeys.length !== actualKeys.length) {
      throw new Error(`往返校验失败（第 ${index} 条 ${expected.label}）：values 键数量不一致`)
    }
    for (const kind of expectedKeys) {
      if (actual.values[kind] !== expected.values[kind]) {
        throw new Error(
          `往返校验失败（第 ${index} 条 ${expected.label}）：${kind} 解出 ` +
            `${JSON.stringify(actual.values[kind])}，期望 ${JSON.stringify(expected.values[kind])}`,
        )
      }
    }
    // 编码双射：decode→encode 必须回到同一行字符串。
    if (codec.encodeRow(actual.values) !== encoded.rows[index]) {
      throw new Error(`编码不自洽（第 ${index} 条 ${expected.label}）：encode(decode(row)) !== row`)
    }
  }
  return encoded
}

/** 统计每个 kind 的取值覆盖情况（生成时给警告，测试里作不变量）。 */
function coverageReport(stacks, kindOrder, valueDomain) {
  const missing = []
  for (const kind of kindOrder) {
    const used = new Set(stacks.map(stack => stack.values[kind]))
    for (const value of valueDomain[kind]) {
      if (!used.has(value)) missing.push({ kind, value })
    }
  }
  return missing
}

/** 由规范化数据组装最终快照对象（字段顺序 = 契约 §4 的顺序）。 */
function assembleSnapshot({ raw, kinds, kindOrder, valueDomain, stacks, encoded, cliVersion, generatedAt, source }) {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    cli: { package: CLI_PACKAGE, version: cliVersion },
    generatedAt,
    source,
    packageManagers: [...raw.packageManagers],
    defaultPackageManager: raw.defaultPackageManager ?? raw.packageManagers?.[0] ?? '',
    addons: (raw.addons ?? []).map(addon => ({
      id: addon.id,
      name: addon.name ?? addon.id,
      description: addon.description ?? '',
      default: addon.default === true,
    })),
    kinds,
    kindOrder,
    valueDomain,
    stacks: encoded,
    integrity: { stackCount: stacks.length, sha256: stacksDigest(encoded) },
  }
}

/** 从原始 list 输出构建快照对象（纯函数，便于 --check 之外复用）。 */
function buildSnapshot({ raw, skippedLines, cliVersion, generatedAt, source, expectCount, allowCountDrift }) {
  const { kinds, kindOrder, valueDomain } = buildKindTables(raw.kinds)
  console.log(`  ${kinds.length} 个 kind：${kindOrder.join(', ')}`)

  const stacks = raw.stacks.map((stack, index) => normalizeUpstreamStack(stack, kindOrder, valueDomain, index))
  console.log(`  ${stacks.length} 个组合（期望 ${expectCount}）`)
  if (stacks.length !== expectCount) {
    if (!allowCountDrift) {
      throw new Error(
        `组合数断言失败：期望 ${expectCount}，实际 ${stacks.length}。` +
          '上游发版通常意味着需要同步 lib/config.js 的版本与测试断言；' +
          `确认可接受时加 --expect-count ${stacks.length} 或 --allow-count-drift。`,
      )
    }
    console.log(`  ! 组合数与期望不同（${stacks.length} ≠ ${expectCount}），已按 --allow-count-drift 继续`)
  }

  const codec = createCodec(kindOrder, valueDomain)
  const encoded = assertRoundTrip(stacks, codec)
  console.log(`  ✓ 往返校验：${stacks.length}/${stacks.length} 条 label/values/verifiedAt 完全一致（共 ${encoded.dates.length} 个校验时间）`)
  console.log('  ✓ 编码自洽：encode(decode(row)) === row')

  const missing = coverageReport(stacks, kindOrder, valueDomain)
  if (missing.length > 0) {
    console.log(
      `  ! 取值覆盖：${missing.length} 个声明取值未出现在任何组合中（` +
        missing.slice(0, 6).map(item => `${item.kind}=${item.value || '(none)'}`).join(', ') +
        (missing.length > 6 ? ' …' : '') +
        '）；工具里这些选项的 legalCount 会是 0',
    )
  }

  const snapshot = assembleSnapshot({
    raw,
    kinds,
    kindOrder,
    valueDomain,
    stacks,
    encoded,
    cliVersion,
    generatedAt,
    source,
  })
  if (skippedLines > 0) console.log(`  ✓ 已跳过 stdout 前导的 ${skippedLines} 行 Node 警告/横幅`)
  return { snapshot, stacks }
}

/** 校验一份已存在（或刚构建）的快照对象，返回检查项列表。 */
function inspectSnapshot(snapshot, { bytes }) {
  const checks = []
  const add = (name, detail) => checks.push({ name, detail })

  if (!isPlainObject(snapshot)) throw new Error('快照顶层不是对象')
  if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(`schemaVersion 应为 ${SNAPSHOT_SCHEMA_VERSION}，实际 ${JSON.stringify(snapshot.schemaVersion)}`)
  }
  if (!isPlainObject(snapshot.cli) || snapshot.cli.package !== CLI_PACKAGE) {
    throw new Error(`cli.package 应为 ${CLI_PACKAGE}`)
  }
  if (snapshot.cli.version !== DEFAULT_CLI_VERSION) {
    throw new Error(
      `版本断言失败：快照记录 v${snapshot.cli.version}，但 lib/config.js 的 DEFAULT_CLI_VERSION 是 ` +
        `${DEFAULT_CLI_VERSION}；升级版本请重跑 node scripts/snapshot.mjs。`,
    )
  }
  if (typeof snapshot.generatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(snapshot.generatedAt)) {
    throw new Error('generatedAt 必须是 ISO 时间字符串')
  }
  if (!Array.isArray(snapshot.kinds) || !Array.isArray(snapshot.kindOrder) || !isPlainObject(snapshot.valueDomain)) {
    throw new Error('kinds / kindOrder / valueDomain 缺失')
  }
  if (snapshot.kindOrder.length !== KIND_ORDER.length || snapshot.kindOrder.some((id, i) => id !== KIND_ORDER[i])) {
    throw new Error('kindOrder 与 lib/catalog/kinds.js 的 KIND_ORDER 不一致（编码会错位）')
  }
  if (snapshot.kindOrder.some((id, i) => snapshot.kinds[i]?.id !== id)) {
    throw new Error('kindOrder 与 kinds 的 id 顺序不一致')
  }
  for (const kind of snapshot.kindOrder) {
    const domain = snapshot.valueDomain[kind]
    if (!Array.isArray(domain) || domain.length === 0) throw new Error(`valueDomain.${kind} 缺失`)
    const declared = snapshot.kinds.find(item => item.id === kind)
    const ids = declared.options.map(option => option.id)
    const expected = declared.optional ? ['', ...ids] : ids
    if (domain.length !== expected.length || domain.some((value, i) => value !== expected[i])) {
      throw new Error(`valueDomain.${kind} 与 kinds 声明不一致：${JSON.stringify(domain)}`)
    }
  }
  add('结构', `schemaVersion=${snapshot.schemaVersion}、cli=${CLI_PACKAGE}@${snapshot.cli.version}、${snapshot.kindOrder.length} 个 kind`)

  const { width, rows, labels, dates, dateIndex } = snapshot.stacks ?? {}
  if (width !== snapshot.kindOrder.length) throw new Error(`stacks.width 应为 ${snapshot.kindOrder.length}`)
  for (const [name, list] of Object.entries({ rows, labels, dateIndex })) {
    if (!Array.isArray(list)) throw new Error(`stacks.${name} 必须是数组`)
  }
  if (!Array.isArray(dates) || dates.length === 0) throw new Error('stacks.dates 必须是非空数组')
  if (rows.length !== labels.length || rows.length !== dateIndex.length) {
    throw new Error('rows / labels / dateIndex 长度不一致')
  }
  const integrity = snapshot.integrity
  if (!isPlainObject(integrity)) throw new Error('缺少 integrity')
  if (integrity.stackCount !== rows.length) {
    throw new Error(`integrity.stackCount=${integrity.stackCount} 与 rows 长度 ${rows.length} 不一致`)
  }
  if (!/^[0-9a-f]{64}$/.test(integrity.sha256 ?? '')) throw new Error('integrity.sha256 必须是 64 位小写十六进制')

  for (const [index, row] of rows.entries()) {
    if (typeof row !== 'string' || row.length !== width) {
      throw new Error(`第 ${index} 行长度不是 ${width}：${JSON.stringify(row)}`)
    }
  }
  for (const [index, slot] of dateIndex.entries()) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= dates.length) {
      throw new Error(`第 ${index} 行的 dateIndex=${JSON.stringify(slot)} 越界（dates 长度 ${dates.length}）`)
    }
  }
  add('行编码', `${rows.length} 行 × ${width} 位 base36`)

  const codec = createCodec(snapshot.kindOrder, snapshot.valueDomain)
  const stacks = codec.decodeStacks(snapshot.stacks)
  const reencoded = assertRoundTrip(stacks, codec)
  add('往返', `${stacks.length}/${stacks.length} 条 decode→encode 与原始行逐字节相同`)

  const digest = stacksDigest(reencoded)
  if (digest !== integrity.sha256) {
    throw new Error(`完整性校验失败：重算 sha256=${digest}，快照记录 ${integrity.sha256}`)
  }
  add('完整性', `sha256 ${digest.slice(0, 12)}…（${stacks.length} 条）`)

  if (bytes > MAX_SNAPSHOT_BYTES) {
    throw new Error(`体积超限：${humanBytes(bytes)} > ${humanBytes(MAX_SNAPSHOT_BYTES)}（需要更紧凑的编码或减少可读缩进）`)
  }
  add('体积', `${humanBytes(bytes)} < ${humanBytes(MAX_SNAPSHOT_BYTES)}`)

  const missing = coverageReport(stacks, snapshot.kindOrder, snapshot.valueDomain)
  const totalValues = snapshot.kindOrder.reduce((sum, kind) => sum + snapshot.valueDomain[kind].length, 0)
  if (missing.length === 0) {
    add('取值覆盖', `${snapshot.kindOrder.length} 个 kind 的全部 ${totalValues} 个取值均出现在合法组合中`)
  } else {
    checks.push({
      name: '取值覆盖',
      detail: `${missing.length}/${totalValues} 个取值未被使用（` +
        missing.slice(0, 6).map(item => `${item.kind}=${item.value || '(none)'}`).join(', ') +
        '）；这些选项的 legalCount 会是 0，仍属合法快照',
      warning: true,
    })
  }
  return checks
}

/** 读取并校验磁盘上的快照；返回退出码。 */
function runCheck() {
  const target = ARGS.out ? resolve(process.cwd(), ARGS.out) : CATALOG_PATH
  console.log(`→ 校验快照：${target}`)
  let text
  try {
    text = readFileSync(target, 'utf8')
  } catch (error) {
    console.error(`✗ 读不到快照：${error.message}`)
    return 1
  }
  let snapshot
  try {
    snapshot = JSON.parse(text)
  } catch (error) {
    console.error(`✗ 快照不是合法 JSON：${error.message}`)
    return 1
  }
  // Windows 上换行是 \r\n，按实际字节数算体积。
  const bytes = Buffer.byteLength(text, 'utf8')
  try {
    const checks = inspectSnapshot(snapshot, { bytes })
    for (const check of checks) {
      console.log(`  ${check.warning ? '!' : '✓'} ${check.name}：${check.detail}`)
    }
  } catch (error) {
    console.error(`✗ ${error.message}`)
    return 1
  }
  console.log(`✓ 快照校验通过（${humanBytes(bytes)}）`)
  return 0
}

/** 生成模式主流程。 */
async function runGenerate() {
  let rawText
  let skippedLines = 0
  let source
  let cliVersion = ARGS.cli ?? ARGS.version ?? DEFAULT_CLI_VERSION

  if (ARGS.from) {
    const fromPath = resolve(process.cwd(), ARGS.from)
    console.log(`→ 读取离线数据：${fromPath}`)
    rawText = readFileSync(fromPath, 'utf8')
    const detected = resolveOfflineVersion(fromPath, cliVersion, ARGS)
    cliVersion = detected.version
    console.log(`  ✓ 版本证据：${detected.evidence ?? '无（按 --cli 记录）'} → v${cliVersion}`)
    if (cliVersion !== (ARGS.cli ?? ARGS.version ?? DEFAULT_CLI_VERSION)) {
      throw new Error(
        `版本断言失败：数据源同目录的证据是 v${cliVersion}，但期望 v${ARGS.cli ?? ARGS.version ?? DEFAULT_CLI_VERSION}；` +
          '请确认数据源与 lib/config.js 的 DEFAULT_CLI_VERSION 是否一致。',
      )
    }
  } else {
    // 默认把 npm 缓存钉在仓库内（不是 cwd）：沙箱下只有工作区内的目录可写。
    const npmCache = ARGS['npm-cache'] ? resolve(process.cwd(), ARGS['npm-cache']) : resolve(ROOT, '.npm-cache')
    const fetched = await fetchFromNpx({ cliVersion, npmCache })
    rawText = fetched.text
  }
  source = ARGS.source ?? `npx --yes ${CLI_PACKAGE}@${cliVersion} --list --json`

  const parsed = parseListOutput(rawText, '上游 --list --json 输出')
  skippedLines = parsed.skippedLines
  if (parsed.trailing) console.log(`  ! JSON 之后还有 ${parsed.trailing.split(/\r?\n/).length} 行非 JSON 输出，已忽略`)

  const { snapshot, stacks } = buildSnapshot({
    raw: parsed.raw,
    skippedLines,
    cliVersion,
    generatedAt: ARGS['generated-at'] ?? new Date().toISOString(),
    source,
    expectCount: Number(ARGS['expect-count'] ?? EXPECTED_STACK_COUNT),
    allowCountDrift: ARGS['allow-count-drift'] === true,
  })

  const json = formatSnapshotJson(snapshot)
  // 格式化器等价性断言：解析回来的对象必须与待写对象逐字段一致（键序也一致），
  // 否则宁可失败也不写一份「看起来对」的快照。
  if (JSON.stringify(JSON.parse(json)) !== JSON.stringify(snapshot)) {
    throw new Error('格式化器输出与快照对象不一致（内部错误，拒绝写盘）')
  }
  const bytes = Buffer.byteLength(json, 'utf8')
  const checks = inspectSnapshot(snapshot, { bytes })
  for (const check of checks) console.log(`  ${check.warning ? '!' : '✓'} ${check.name}：${check.detail}`)
  console.log(`  ✓ 完整性：sha256=${snapshot.integrity.sha256}`)

  if (ARGS['dry-run']) {
    console.log(`\n（--dry-run）未写盘；目标 ${ARGS.out ? resolve(process.cwd(), ARGS.out) : CATALOG_PATH}（${humanBytes(bytes)}）`)
    return 0
  }

  const outPath = ARGS.out ? resolve(process.cwd(), ARGS.out) : CATALOG_PATH
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, json, 'utf8')
  console.log(`\n✓ 已写入 ${outPath}`)
  console.log(`  ${stacks.length} 个组合，${snapshot.stacks.dates.length} 个校验时间，${humanBytes(bytes)}（2 空格缩进可读 JSON）`)
  return 0
}

const ARGS = (() => {
  try {
    return parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`✗ ${error.message}\n\n${USAGE}`)
    process.exitCode = 2
    return null
  }
})()

if (ARGS) {
  if (ARGS.help) {
    console.log(USAGE)
  } else if (ARGS.check) {
    process.exitCode = runCheck()
  } else {
    try {
      process.exitCode = await runGenerate()
    } catch (error) {
      console.error(`✗ 生成失败：${error.message}`)
      process.exitCode = 1
    }
  }
}
