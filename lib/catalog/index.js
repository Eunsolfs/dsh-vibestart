/**
 * catalog/index.js — 离线快照的加载、解码与查询（契约 §4 / §5）
 *
 * 数据流：
 *
 *   data/snapshot.json          （生成物，入库；紧凑行编码，见 encode.js）
 *        │  loadSnapshot()      按文件 mtime 记忆化，mtime 变了自动重读
 *        ▼
 *   Catalog                    解码成 { label, values, verifiedAt } 全量视图
 *        │
 *        ├─ matchingStacks()    固定若干 kind → 合法组合 + 每个 kind 的剩余可选值
 *        └─ nearestStacks()     任意栈 → 最近的合法组合 + 最小改动
 *
 * 设计要点：
 *   - **同步**读取：工具调用是同步纯计算，不引入 await 与竞态；快照约 250KB，
 *     一次解析 + 解码 < 50ms，按 mtime 缓存后每次调用只是查内存。
 *   - **只读**：Catalog 及其中的 kinds / stacks 全部 freeze。查询函数返回的是
 *     新对象（`sample` / `nearest` 的条目），调用方可以自由增删字段，不会污染缓存。
 *   - **零 DSH import、零第三方依赖**：本模块可被 `node --test` 直接跑。
 *   - 快照不可用时 `loadCatalog()` 返回 null（不抛到宿主），具体原因放在
 *     `lastCatalogError()` 里，由工具层转成可读错误。
 */

import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CLI_PACKAGE, DEFAULT_CLI_VERSION } from '../config.js'
import { normalizeKindName, normalizeStackValue } from '../parse-stack.js'
import { createCodec } from './encode.js'
import { kindLabel } from './kinds.js'

export const CATALOG_URL = new URL('../../data/snapshot.json', import.meta.url)

/** 快照文件的绝对路径（诊断信息与测试用）。 */
export const CATALOG_PATH = fileURLToPath(CATALOG_URL)

/** 本模块认识且只认识的快照结构版本。 */
export const SNAPSHOT_SCHEMA_VERSION = 1

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function snapshotMtimeMs() {
  try {
    return statSync(CATALOG_URL).mtimeMs
  } catch {
    return -1
  }
}

function describeValue(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/**
 * 结构性校验：只查「没有这些字段后面一定崩」的东西，逐行解码交给 buildCatalog。
 * @param {unknown} snapshot
 * @returns {object} 校验通过的同一对象
 */
function validateSnapshot(snapshot) {
  const fail = message => {
    throw new Error(`快照结构不合规（${CATALOG_PATH}）：${message}`)
  }
  if (!isPlainObject(snapshot)) fail(`顶层必须是对象，实际 ${describeValue(snapshot)}`)
  if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    fail(`schemaVersion 应为 ${SNAPSHOT_SCHEMA_VERSION}，实际 ${JSON.stringify(snapshot.schemaVersion)}`)
  }
  if (!isPlainObject(snapshot.cli)) fail('缺少 cli 块')
  if (snapshot.cli.package !== CLI_PACKAGE) {
    fail(`cli.package 应为 ${CLI_PACKAGE}，实际 ${JSON.stringify(snapshot.cli.package)}`)
  }
  if (typeof snapshot.cli.version !== 'string' || snapshot.cli.version === '') fail('缺少 cli.version')
  if (snapshot.cli.version !== DEFAULT_CLI_VERSION) {
    fail(
      `快照记录的 CLI 版本是 ${snapshot.cli.version}，但 lib/config.js 的 DEFAULT_CLI_VERSION 是 ` +
        `${DEFAULT_CLI_VERSION}；升级版本请重跑 node scripts/snapshot.mjs，或把快照换回旧版本。`,
    )
  }
  if (typeof snapshot.generatedAt !== 'string' || snapshot.generatedAt === '') fail('缺少 generatedAt')
  if (!Array.isArray(snapshot.packageManagers) || snapshot.packageManagers.length === 0) {
    fail('packageManagers 必须是非空数组')
  }
  if (!Array.isArray(snapshot.addons)) fail('addons 必须是数组')
  if (!Array.isArray(snapshot.kinds) || snapshot.kinds.length === 0) fail('kinds 必须是非空数组')
  for (const [index, kind] of snapshot.kinds.entries()) {
    if (!isPlainObject(kind)) fail(`kinds[${index}] 不是对象`)
    if (typeof kind.id !== 'string' || kind.id === '') fail(`kinds[${index}].id 缺失`)
    if (typeof kind.name !== 'string') fail(`kinds[${index}].name 缺失`)
    if (typeof kind.optional !== 'boolean') fail(`kinds[${index}].optional 必须是布尔值`)
    if (!Array.isArray(kind.options) || kind.options.length === 0) {
      fail(`kinds[${index}].options 必须是非空数组`)
    }
  }
  if (!Array.isArray(snapshot.kindOrder) || snapshot.kindOrder.length === 0) fail('kindOrder 必须是非空数组')
  const kindIds = snapshot.kinds.map(kind => kind.id)
  if (snapshot.kindOrder.length !== kindIds.length || snapshot.kindOrder.some((id, i) => id !== kindIds[i])) {
    fail('kindOrder 必须与 kinds 的 id 顺序完全一致')
  }
  if (!isPlainObject(snapshot.valueDomain)) fail('valueDomain 必须是对象')
  for (const kind of snapshot.kindOrder) {
    const domain = snapshot.valueDomain[kind]
    if (!Array.isArray(domain) || domain.length === 0) fail(`valueDomain.${kind} 必须是非空数组`)
  }
  if (!isPlainObject(snapshot.stacks)) fail('缺少 stacks 块')
  const { width, rows, labels, dates, dateIndex } = snapshot.stacks
  if (!Number.isInteger(width) || width !== snapshot.kindOrder.length) {
    fail(`stacks.width 应为 ${snapshot.kindOrder.length}，实际 ${JSON.stringify(width)}`)
  }
  for (const name of ['rows', 'labels', 'dateIndex']) {
    if (!Array.isArray(snapshot.stacks[name])) fail(`stacks.${name} 必须是数组`)
  }
  if (!Array.isArray(dates) || dates.length === 0) fail('stacks.dates 必须是非空数组')
  if (rows.length === 0) fail('stacks.rows 不能为空')
  for (const name of ['labels', 'dateIndex']) {
    if (snapshot.stacks[name].length !== rows.length) {
      fail(`stacks.${name} 长度 ${snapshot.stacks[name].length} 与 stacks.rows 长度 ${rows.length} 不一致`)
    }
  }
  if (!isPlainObject(snapshot.integrity)) fail('缺少 integrity 块')
  if (snapshot.integrity.stackCount !== rows.length) {
    fail(`integrity.stackCount=${JSON.stringify(snapshot.integrity.stackCount)} 与 stacks.rows 长度 ${rows.length} 不一致`)
  }
  if (typeof snapshot.integrity.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(snapshot.integrity.sha256)) {
    fail('integrity.sha256 必须是 64 位小写十六进制')
  }
  return snapshot
}

/** loadSnapshot 的 mtime 缓存（失败也缓存，避免反复解析坏文件）。 */
let _snapshotCache = { mtimeMs: -1, snapshot: null, error: null }

/**
 * 同步读取并解析 data/snapshot.json（按 mtime 记忆化）。
 * 文件缺失、JSON 损坏、结构不合规都会抛出带路径的中文错误——这是生成脚本、
 * verify 与测试想要的行为；运行时请用 `loadCatalog()`。
 *
 * @returns {object} 快照原始对象（只读使用，不要修改）
 */
export function loadSnapshot() {
  const mtimeMs = snapshotMtimeMs()
  if (_snapshotCache.mtimeMs === mtimeMs) {
    if (_snapshotCache.error) throw new Error(_snapshotCache.error)
    return _snapshotCache.snapshot
  }
  if (mtimeMs < 0) {
    const error = `离线快照不存在：${CATALOG_PATH}（运行 node scripts/snapshot.mjs 生成）`
    _snapshotCache = { mtimeMs, snapshot: null, error }
    throw new Error(error)
  }
  try {
    const parsed = JSON.parse(readFileSync(CATALOG_URL, 'utf8'))
    validateSnapshot(parsed)
    _snapshotCache = { mtimeMs, snapshot: parsed, error: null }
    return parsed
  } catch (error) {
    // 缓存「读失败」这一事实，但不要把原始 Error 存下来（栈帧会一直增长）。
    const message = error instanceof Error ? error.message : String(error)
    const wrapped = message.startsWith('快照结构不合规') || message.startsWith('离线快照不存在')
      ? message
      : `离线快照解析失败（${CATALOG_PATH}）：${message}`
    _snapshotCache = { mtimeMs, snapshot: null, error: wrapped }
    throw new Error(wrapped)
  }
}

/** 归一 echo：把用户原值照原样写回错误/unknown 里，便于模型对照自己写了什么。 */
function echoValue(raw) {
  if (raw === null) return 'null'
  if (raw === undefined) return 'undefined'
  return String(raw)
}

/**
 * 在给定 catalog 上做值归一：kind 名（含别名）+ 取值（none → ""）+ 取值合法性。
 *
 * @param {object} catalog
 * @param {Record<string, unknown>} [input]
 * @returns {{values: Record<string, string>, unknown: {kind: string, value: string}[]}}
 */
function normalizeValuesOn(catalog, input) {
  /** @type {Record<string, string>} */
  const values = {}
  /** @type {{kind: string, value: string}[]} */
  const unknown = []
  if (!isPlainObject(input)) return { values, unknown }

  for (const [rawKind, rawValue] of Object.entries(input)) {
    if (rawValue === undefined) continue
    const kind = normalizeKindName(rawKind)
    if (!kind) {
      unknown.push({ kind: echoValue(rawKind), value: echoValue(rawValue) })
      continue
    }
    const value = normalizeStackValue(rawValue)
    const domain = catalog.valueDomain[kind]
    if (!Array.isArray(domain)) {
      unknown.push({ kind, value: echoValue(rawValue) })
      continue
    }
    if (!domain.includes(value)) {
      unknown.push({ kind, value: echoValue(rawValue) })
      continue
    }
    values[kind] = value
  }
  return { values, unknown }
}

/**
 * 把 partial 归一（kind 校验 + ""/"none" 归一）。
 *
 * 返回值是 `{ values, unknown }`：`unknown` 收集「认不出的 kind」与「不存在的取值」，
 * 调用方据此报错给模型；合法部分照常放进 `values`，不会因为一个错值全盘丢弃。
 * 快照不可用时返回空结果（此时应当先检查 `loadCatalog()`）。
 *
 * @param {Record<string, unknown>} values
 * @returns {{values: Record<string, string>, unknown: {kind: string, value: string}[]}}
 */
export function normalizeValues(values) {
  const catalog = loadCatalog()
  if (!catalog) return { values: {}, unknown: [] }
  return normalizeValuesOn(catalog, values)
}

function cloneStack(stack) {
  return { label: stack.label, values: { ...stack.values }, verifiedAt: stack.verifiedAt }
}

/** 把 limit 钳成非负整数；非法值退回 fallback。 */
function clampLimit(limit, fallback) {
  if (typeof limit === 'number' && Number.isFinite(limit)) return Math.max(0, Math.trunc(limit))
  return fallback
}

/**
 * 在给定 catalog 上按部分栈过滤（模块级 matchingStacks 与 Catalog 上的方法共用）。
 * @param {object} catalog
 * @param {Record<string, string>} partial
 * @param {number} [limit]
 */
function matchingStacksOn(catalog, partial, limit = 5) {
  const { values: fixed, unknown } = normalizeValuesOn(catalog, partial)
  const pinned = Object.entries(fixed)

  const matches = pinned.length === 0
    ? catalog.stacks
    : catalog.stacks.filter(stack => pinned.every(([kind, value]) => stack.values[kind] === value))

  /** @type {Record<string, string[]>} */
  const perKindOptions = {}
  if (matches.length > 0) {
    for (const kind of catalog.kindOrder) {
      const seen = new Set()
      for (const stack of matches) seen.add(stack.values[kind])
      // 保持 valueDomain 的顺序（optional 的 "" 在前），便于模型直接接着选。
      const options = catalog.valueDomain[kind].filter(value => seen.has(value))
      if (options.length > 0) perKindOptions[kind] = options
    }
  }

  return {
    count: matches.length,
    sample: matches.slice(0, clampLimit(limit, 5)).map(cloneStack),
    perKindOptions,
    unknown,
  }
}

/**
 * 在给定 catalog 上找最近的合法组合（模块级 nearestStacks 与 Catalog 上的方法共用）。
 *
 * 距离定义：只在**调用方给出的** kind 上比较（省略 = 通配，不计距离），
 * 每个不一致的 kind 记 1，`diffs` 按 kindOrder 排序。
 * 未知 kind 无法比较，直接忽略；未知取值按「一定不匹配」计入距离。
 *
 * @param {object} catalog
 * @param {Record<string, string>} values
 * @param {number} [k]
 */
function nearestStacksOn(catalog, values, k = 3) {
  // 去重 + 按 kindOrder 排序，保证 diffs 的顺序与 kindOrder 一致。
  const requested = new Map()
  if (isPlainObject(values)) {
    for (const [rawKind, rawValue] of Object.entries(values)) {
      if (rawValue === undefined) continue
      const kind = normalizeKindName(rawKind)
      if (!Object.hasOwn(catalog.valueDomain, kind)) continue
      requested.set(kind, normalizeStackValue(rawValue))
    }
  }
  const pinned = catalog.kindOrder
    .filter(kind => requested.has(kind))
    .map(kind => ({ kind, value: requested.get(kind) }))

  const ranked = []
  catalog.stacks.forEach((stack, index) => {
    let distance = 0
    /** @type {{kind: string, from: string, to: string}[]} */
    const diffs = []
    for (const { kind, value } of pinned) {
      const candidate = stack.values[kind]
      if (candidate === value) continue
      distance += 1
      diffs.push({ kind, from: value, to: candidate })
    }
    ranked.push({ stack, index, distance, diffs })
  })

  // 距离升序；同距离保持上游顺序（显式用 index 兜底，不依赖 sort 的稳定性）。
  ranked.sort((a, b) => a.distance - b.distance || a.index - b.index)

  return ranked.slice(0, clampLimit(k, 3)).map(({ stack, distance, diffs }) => ({
    ...cloneStack(stack),
    distance,
    diffs: diffs.map(diff => ({ ...diff })),
  }))
}

function freezeStack(stack) {
  return Object.freeze({
    label: stack.label,
    values: Object.freeze({ ...stack.values }),
    verifiedAt: stack.verifiedAt,
  })
}

/**
 * 快照 → 规范化 Catalog（解码全量 stacks，全部 freeze）。
 * @param {object} snapshot
 * @returns {object}
 */
function buildCatalog(snapshot) {
  const codec = createCodec(snapshot.kindOrder, snapshot.valueDomain)
  const stacks = Object.freeze(codec.decodeStacks(snapshot.stacks).map(freezeStack))

  const kinds = Object.freeze(
    snapshot.kinds.map(kind =>
      Object.freeze({
        id: kind.id,
        name: kind.name,
        optional: kind.optional,
        options: Object.freeze(
          (kind.options ?? []).map(option =>
            Object.freeze({
              id: option.id,
              name: option.name,
              description: option.description ?? '',
            }),
          ),
        ),
      }),
    ),
  )

  const valueDomain = Object.freeze(
    Object.fromEntries(snapshot.kindOrder.map(kind => [kind, Object.freeze([...snapshot.valueDomain[kind]])])),
  )

  /** @type {Record<string, object>} */
  const catalog = {
    cliVersion: snapshot.cli.version,
    generatedAt: snapshot.generatedAt,
    source: snapshot.source ?? '',
    packageManagers: Object.freeze([...snapshot.packageManagers]),
    defaultPackageManager: snapshot.defaultPackageManager,
    addons: Object.freeze(
      (snapshot.addons ?? []).map(addon =>
        Object.freeze({
          id: addon.id,
          name: addon.name,
          description: addon.description ?? '',
          default: addon.default === true,
        }),
      ),
    ),
    kinds,
    kindOrder: Object.freeze([...snapshot.kindOrder]),
    valueDomain,
    stackCount: stacks.length,
    stacks,
  }

  // 契约之外的便利：把两个查询函数挂在 catalog 上，让 plan 这类「catalog 依赖注入」
  // 的纯函数不必再由 tools 层额外注入一套函数。实现与模块级导出同一份（matchingStacksOn /
  // nearestStacksOn），区别只在**作用对象**：
  //   - 作为方法调用（`catalog.matchingStacks(...)` / 裁剪过的假 catalog）时，
  //     查的是调用者自己的 stacks（this），所以依赖注入仍然成立；
  //   - 被摘下来当普通函数用时（this 丢失），退回本对象，行为与模块级导出一致。
  function resolveSelf(candidate) {
    return isPlainObject(candidate) && Array.isArray(candidate.stacks) && isPlainObject(candidate.valueDomain)
      ? candidate
      : catalog
  }
  catalog.matchingStacks = function matchingStacksMethod(partial, limit = 5) {
    return matchingStacksOn(resolveSelf(this), partial, limit)
  }
  catalog.nearestStacks = function nearestStacksMethod(values, k = 3) {
    return nearestStacksOn(resolveSelf(this), values, k)
  }

  Object.freeze(catalog)
  return catalog
}

/** loadCatalog 的 mtime 缓存；失败原因留给 lastCatalogError()。 */
let _catalogCache = { mtimeMs: -1, catalog: null, error: null }

/**
 * 规范化视图（解码后的全量 stacks）。同一份快照在 mtime 不变期间返回**同一对象引用**。
 * 快照不可用时返回 null（不抛错），原因见 `lastCatalogError()`。
 *
 * @returns {object|null} Catalog
 */
export function loadCatalog() {
  const mtimeMs = snapshotMtimeMs()
  if (_catalogCache.mtimeMs === mtimeMs) return _catalogCache.catalog
  if (mtimeMs < 0) {
    _catalogCache = { mtimeMs, catalog: null, error: `离线快照不存在：${CATALOG_PATH}（运行 node scripts/snapshot.mjs 生成）` }
    return null
  }
  try {
    const catalog = buildCatalog(loadSnapshot())
    _catalogCache = { mtimeMs, catalog, error: null }
    return catalog
  } catch (error) {
    _catalogCache = { mtimeMs, catalog: null, error: error instanceof Error ? error.message : String(error) }
    return null
  }
}

/**
 * 最近一次 `loadCatalog()` 失败的可读原因；成功时为 null。
 * @returns {string|null}
 */
export function lastCatalogError() {
  if (_catalogCache.mtimeMs < 0 || _catalogCache.mtimeMs !== snapshotMtimeMs()) loadCatalog()
  return _catalogCache.error
}

/**
 * kind 列表（保持 kindOrder）。快照不可用时返回空数组。
 * @returns {object[]}
 */
export function getKinds() {
  return loadCatalog()?.kinds ?? []
}

/**
 * 按 id 取 kind；不存在返回 undefined。
 * @param {string} id
 * @returns {object|undefined}
 */
export function getKind(id) {
  const key = String(id ?? '').trim().toLowerCase()
  return getKinds().find(kind => kind.id === key)
}

/**
 * 数字摘要（不包含 kinds 明细以外的东西，便于工具描述与技能正文插值）。
 * 快照不可用时返回全 0 的降级结构，调用方可用 `loadCatalog() === null` 区分。
 * @returns {{kindOrder:string[], kindCount:number, stackCount:number, cliVersion:string, kinds:object[]}}
 */
export function summary() {
  const catalog = loadCatalog()
  if (!catalog) return { kindOrder: [], kindCount: 0, stackCount: 0, cliVersion: '', kinds: [] }
  return {
    kindOrder: [...catalog.kindOrder],
    kindCount: catalog.kindOrder.length,
    stackCount: catalog.stackCount,
    cliVersion: catalog.cliVersion,
    kinds: catalog.kinds,
  }
}

/**
 * 一句话能力摘要（工具描述 / 技能文案插值用；快照不可读时给中性文案）。
 * @returns {string}
 */
export function capabilitySummaryZh() {
  const catalog = loadCatalog()
  if (!catalog) return '内置离线目录（快照不可读）'
  const date = /^\d{4}-\d{2}-\d{2}/.test(catalog.generatedAt) ? catalog.generatedAt.slice(0, 10) : catalog.generatedAt
  return `vibestart-cli ${catalog.cliVersion} 的 ${catalog.kindOrder.length} 个 kind、${catalog.stackCount} 个已校验组合（快照 ${date}）`
}

/**
 * 按部分栈过滤合法组合（契约 §5）。
 * @param {Record<string, string>} partial 只包含想固定的 kind；值必须是 valueDomain 里的值（""=none，也接受 "none"）
 * @param {number} [limit=5]
 * @returns {{count:number, sample:object[], perKindOptions:Record<string,string[]>, unknown:{kind:string,value:string}[]}}
 */
export function matchingStacks(partial, limit = 5) {
  return matchingStacksOn(requireCatalog(), partial, limit)
}

/**
 * 找最近的合法组合（契约 §5）。
 * @param {Record<string, string>} values
 * @param {number} [k=3]
 * @returns {{label:string, values:Record<string,string>, verifiedAt:string, distance:number, diffs:{kind:string,from:string,to:string}[]}[]}
 */
export function nearestStacks(values, k = 3) {
  return nearestStacksOn(requireCatalog(), values, k)
}

function requireCatalog() {
  const catalog = loadCatalog()
  if (!catalog) {
    throw new Error(`离线快照不可用：${lastCatalogError() ?? CATALOG_PATH}`)
  }
  return catalog
}

/** `kindLabel` 也在这里再导出，方便工具层只 import 一个模块。 */
export { kindLabel }
