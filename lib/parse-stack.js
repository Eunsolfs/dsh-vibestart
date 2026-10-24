/**
 * lib/parse-stack.js — 模型面向的「栈字符串」语法（契约 §8.0）
 *
 * SchemaSpec 方言里 object 的 `additionalProperties` 只接受布尔值，无法表达
 * 「任意 kind → string」的映射，所以模型传的是字符串：
 *
 *   "framework=spa,backend=hono,api=orpc,database=sqlite,auth=better-auth"
 *
 * 这里只做**语法**层的事：切分、归一（大小写/空白/none）、别名。
 * 「这个 kind 存不存在、这个值合不合法」由 catalog 负责——分层要清楚，
 * 否则错误信息会混在一起，模型改不动。
 */

/** optional kind 表达「不选」的几种写法，统一归一为空串。 */
const NONE_VALUES = new Set(['', 'none', 'null', 'off', '-', 'false'])

/**
 * 少数常见简写。只收录「不写错也别扭」的几个，不做大而全的猜测——
 * 猜错的代价比让模型重写一次高得多。
 */
const KIND_ALIASES = Object.freeze({
  db: 'database',
  datasource: 'database',
  test: 'testing',
  tests: 'testing',
  deploy: 'deployment',
  desk: 'desktop',
  mob: 'mobile',
  pkg: 'package-manager',
})

/**
 * 归一单个 kind 值。
 * @param {unknown} value
 * @returns {string} 空串表示 none
 */
export function normalizeStackValue(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'boolean') return value ? '' : 'none'
  const text = String(value).trim().toLowerCase()
  return NONE_VALUES.has(text) ? '' : text
}

/**
 * 归一 kind 名（小写 + 去空白 + 别名）。
 * @param {unknown} kind
 * @returns {string}
 */
export function normalizeKindName(kind) {
  const name = String(kind ?? '').trim().toLowerCase()
  return KIND_ALIASES[name] ?? name
}

/**
 * 解析栈字符串。
 *
 * 容错范围：`,` `;` 换行分隔；`kind=value` 两侧空白；重复 kind 以最后一次为准。
 * 无法解析的片段不会被静默丢弃，而是进 `unknown`，由工具层报给模型。
 *
 * @param {unknown} input
 * @returns {{values: Record<string, string>, unknown: {kind: string, value: string}[]}}
 */
export function parseStackInput(input) {
  /** @type {Record<string, string>} */
  const values = {}
  /** @type {{kind: string, value: string}[]} */
  const unknown = []

  if (input === undefined || input === null || input === '') return { values, unknown }
  if (typeof input !== 'string') {
    // schema 已约束成字符串；真被绕开时给一条可读的错误，而不是抛 TypeError。
    return { values, unknown: [{ kind: String(input), value: '' }] }
  }

  for (const rawToken of String(input).split(/[,;\n]+/)) {
    const token = rawToken.trim()
    if (!token) continue
    const eq = token.indexOf('=')
    if (eq <= 0) {
      unknown.push({ kind: token, value: '' })
      continue
    }
    const kind = normalizeKindName(token.slice(0, eq))
    const value = normalizeStackValue(token.slice(eq + 1))
    if (!kind) {
      unknown.push({ kind: token, value: '' })
      continue
    }
    values[kind] = value
  }
  return { values, unknown }
}

/**
 * 把对象的栈值归一（内部模块之间传递用，也让工具能容忍对象入参）。
 * @param {Record<string, unknown>} [values]
 * @returns {Record<string, string>}
 */
export function normalizeStackMap(values) {
  /** @type {Record<string, string>} */
  const out = {}
  if (!values || typeof values !== 'object') return out
  for (const [rawKind, rawValue] of Object.entries(values)) {
    const kind = normalizeKindName(rawKind)
    if (!kind) continue
    out[kind] = normalizeStackValue(rawValue)
  }
  return out
}
