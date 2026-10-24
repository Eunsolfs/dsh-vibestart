/**
 * catalog/encode.js — 快照里 `stacks` 的紧凑行编解码（契约 §4）
 *
 * 为什么不用「把 values 原样存成对象」：3409 个组合 × 15 个 kind 的 JSON
 * 对象会把快照撑到 1.7MB；改成「每个组合一行 base36 定长字符串」后约 250KB，
 * 同时天然可读：第 k 位就是 `kindOrder[k]` 那一维的取值下标。
 *
 *   valueDomain = { framework: ["", "spa", "tanstack-start", "next"], toolchain: ["vite-plus"], … }
 *   row         = "000000000000000"
 *                    第 k 位字符 = valueDomain[kindOrder[k]][下标]，a=10 … z=35
 *
 * 约束与不变量：
 *   - 每个 kind 的取值上限 36（单字符 base36），超过就在编码期报错，
 *     而不是悄悄截断；
 *   - 解码一定补全全部 15 个 kind（optional 的缺省值解码为 ""），
 *     编码则要求显式给出全部 15 个位置（不允许 undefined），
 *     这样才能保证 `decode(encode(x)) ≡ x` 与 `encode(decode(row)) ≡ row`；
 *   - `integrity.sha256` 由本文件的 `stacksDigest()` 定义，生成脚本、测试、
 *     `scripts/verify.mjs` 必须共用同一份实现，否则完整性断言会互相打架。
 *
 * 零 DSH import、零第三方依赖（node:crypto 是标准库）。
 */

import { createHash } from 'node:crypto'

const BASE36_DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz'

/** 单个位置能表达的取值个数上限（base36 单字符）。 */
export const MAX_DOMAIN_SIZE = BASE36_DIGITS.length

/**
 * 取值下标 → base36 字符。
 * @param {number} index
 * @returns {string}
 */
export function toBase36(index) {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_DOMAIN_SIZE) {
    throw new Error(`取值下标必须是 0–35 的整数，收到 ${String(index)}`)
  }
  return BASE36_DIGITS[index]
}

/**
 * base36 字符 → 取值下标。
 * @param {string} char
 * @returns {number}
 */
export function fromBase36(char) {
  if (typeof char !== 'string' || char.length !== 1) {
    throw new Error(`base36 字符必须是单个字符，收到 ${JSON.stringify(char)}`)
  }
  const index = BASE36_DIGITS.indexOf(char)
  if (index < 0) throw new Error(`不是合法的 base36 字符：${JSON.stringify(char)}`)
  return index
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 校验 kindOrder / valueDomain 并缓存成「位置 → 取值数组」的查找表。
 * 编码/解码 3409 行时不该每行重跑一遍校验。
 *
 * @param {string[]} kindOrder
 * @param {Record<string, string[]>} valueDomain
 * @returns {{kindOrder: string[], domains: string[][], width: number, domainIndex: Map<string, Map<string, number>>}}
 */
function prepareDomains(kindOrder, valueDomain) {
  if (!Array.isArray(kindOrder) || kindOrder.length === 0) {
    throw new Error('kindOrder 必须是非空数组')
  }
  if (!isPlainObject(valueDomain)) throw new Error('valueDomain 必须是 kind → 取值数组的映射')
  if (new Set(kindOrder).size !== kindOrder.length) throw new Error('kindOrder 里有重复的 kind')

  const domains = []
  const domainIndex = new Map()
  for (const kind of kindOrder) {
    const domain = valueDomain[kind]
    if (!Array.isArray(domain) || domain.length === 0) {
      throw new Error(`valueDomain 缺少 kind「${kind}」的取值数组`)
    }
    if (domain.length > MAX_DOMAIN_SIZE) {
      throw new Error(
        `kind「${kind}」有 ${domain.length} 个取值，超过单字符 base36 的 ${MAX_DOMAIN_SIZE} 个上限；` +
          '需要扩展编码（多字符位）或削减取值。',
      )
    }
    if (new Set(domain).size !== domain.length) {
      throw new Error(`kind「${kind}」的 valueDomain 有重复取值`)
    }
    const noneIndex = domain.indexOf('')
    if (noneIndex >= 0 && noneIndex !== 0) {
      throw new Error(`kind「${kind}」的 ""（none）必须是 valueDomain[0]`)
    }
    domains.push(domain)
    domainIndex.set(kind, new Map(domain.map((value, index) => [value, index])))
  }
  return { kindOrder: [...kindOrder], domains, width: kindOrder.length, domainIndex }
}

/**
 * 为一套 kindOrder / valueDomain 创建编解码器。
 *
 * 一次创建、多次使用（3409 行）：`encodeRow` / `decodeRow` 走预建索引，
 * 不做重复校验。返回的函数都只在出错时抛错，不做静默修正。
 *
 * @param {string[]} kindOrder
 * @param {Record<string, string[]>} valueDomain
 */
export function createCodec(kindOrder, valueDomain) {
  const prepared = prepareDomains(kindOrder, valueDomain)
  const { width } = prepared

  /**
   * values（全量，"" 表示 none）→ 定长行字符串。
   * @param {Record<string, string>} values
   * @returns {string}
   */
  function encodeRow(values) {
    if (!isPlainObject(values)) throw new Error('encodeRow 需要 kind → 取值的对象')
    const digits = new Array(width)
    for (let position = 0; position < width; position += 1) {
      const kind = prepared.kindOrder[position]
      if (!Object.hasOwn(values, kind)) {
        throw new Error(
          `编码缺少 kind「${kind}」的取值；optional kind 不选时请显式传 ""（不要省略）。`,
        )
      }
      const value = values[kind]
      const index = prepared.domainIndex.get(kind).get(value)
      if (index === undefined) {
        throw new Error(
          `kind「${kind}」的取值 ${JSON.stringify(value)} 不在 valueDomain 内：` +
            prepared.domains[position].map(item => JSON.stringify(item)).join(', '),
        )
      }
      digits[position] = toBase36(index)
    }
    return digits.join('')
  }

  /**
   * 定长行字符串 → values（全量，"" 表示 none）。
   * @param {string} row
   * @returns {Record<string, string>}
   */
  function decodeRow(row) {
    if (typeof row !== 'string') throw new Error(`row 必须是字符串，收到 ${typeof row}`)
    if (row.length !== width) {
      throw new Error(`row 长度必须是 ${width}，收到 ${row.length}：${JSON.stringify(row)}`)
    }
    /** @type {Record<string, string>} */
    const values = {}
    for (let position = 0; position < width; position += 1) {
      const kind = prepared.kindOrder[position]
      const index = fromBase36(row[position])
      const domain = prepared.domains[position]
      if (index >= domain.length) {
        throw new Error(
          `row 第 ${position} 位（${kind}）是 ${JSON.stringify(row[position])}，` +
            `但该 kind 只有 ${domain.length} 个取值`,
        )
      }
      values[kind] = domain[index]
    }
    return values
  }

  /**
   * 上游 stacks（[{label, values, verifiedAt}]）→ 快照的 stacks 块。
   * 日期去重按首次出现顺序编号，`dateIndex` 指回 `dates`。
   *
   * @param {{label: string, values: Record<string, string>, verifiedAt: string}[]} stacks
   * @returns {{width: number, rows: string[], labels: string[], dates: string[], dateIndex: number[]}}
   */
  function encodeStacks(stacks) {
    if (!Array.isArray(stacks)) throw new Error('encodeStacks 需要 stacks 数组')
    const rows = new Array(stacks.length)
    const labels = new Array(stacks.length)
    const dates = []
    const dateIndex = new Array(stacks.length)
    const dateLookup = new Map()

    stacks.forEach((stack, index) => {
      if (!isPlainObject(stack)) throw new Error(`第 ${index} 个 stack 不是对象`)
      if (typeof stack.label !== 'string' || stack.label === '') {
        throw new Error(`第 ${index} 个 stack 缺少 label`)
      }
      if (typeof stack.verifiedAt !== 'string' || stack.verifiedAt === '') {
        throw new Error(`第 ${index} 个 stack（${stack.label}）缺少 verifiedAt`)
      }
      try {
        rows[index] = encodeRow(stack.values)
      } catch (error) {
        throw new Error(`第 ${index} 个 stack（${stack.label}）编码失败：${error.message}`)
      }
      labels[index] = stack.label
      let dateSlot = dateLookup.get(stack.verifiedAt)
      if (dateSlot === undefined) {
        dateSlot = dates.length
        dates.push(stack.verifiedAt)
        dateLookup.set(stack.verifiedAt, dateSlot)
      }
      dateIndex[index] = dateSlot
    })

    return { width, rows, labels, dates, dateIndex }
  }

  /**
   * 快照的 stacks 块 → [{label, values, verifiedAt}]（保持上游顺序）。
   * @param {{rows: string[], labels: string[], dates: string[], dateIndex: number[]}} encoded
   * @returns {{label: string, values: Record<string, string>, verifiedAt: string}[]}
   */
  function decodeStacks(encoded) {
    if (!isPlainObject(encoded)) throw new Error('decodeStacks 需要快照的 stacks 对象')
    const { rows, labels, dates, dateIndex } = encoded
    for (const [name, list] of Object.entries({ rows, labels, dateIndex })) {
      if (!Array.isArray(list)) throw new Error(`stacks.${name} 必须是数组`)
      if (list.length !== rows.length) {
        throw new Error(`stacks.${name} 长度 ${list.length} 与 stacks.rows 长度 ${rows.length} 不一致`)
      }
    }
    if (!Array.isArray(dates) || dates.length === 0) throw new Error('stacks.dates 必须是非空数组')

    return rows.map((row, index) => {
      let values
      try {
        values = decodeRow(row)
      } catch (error) {
        throw new Error(`第 ${index} 行解码失败：${error.message}`)
      }
      const dateSlot = dateIndex[index]
      if (!Number.isInteger(dateSlot) || dateSlot < 0 || dateSlot >= dates.length) {
        throw new Error(`第 ${index} 行的 dateIndex=${JSON.stringify(dateSlot)} 越界（dates 长度 ${dates.length}）`)
      }
      return { label: labels[index], values, verifiedAt: dates[dateSlot] }
    })
  }

  return { width, kindOrder: prepared.kindOrder, domains: prepared.domains, encodeRow, decodeRow, encodeStacks, decodeStacks }
}

/**
 * 完整性摘要的规范化 JSON（契约 §4 的定义，逐字节固定，不要改字段顺序）。
 * @param {{rows: string[], labels: string[], dates: string[], dateIndex: number[]}} encoded
 * @returns {string}
 */
export function canonicalStacksJson(encoded) {
  const { rows, labels, dates, dateIndex } = encoded
  if (!Array.isArray(rows) || !Array.isArray(labels) || !Array.isArray(dates) || !Array.isArray(dateIndex)) {
    throw new Error('canonicalStacksJson 需要 { rows, labels, dates, dateIndex }')
  }
  if (labels.length !== rows.length || dateIndex.length !== rows.length) {
    throw new Error('canonicalStacksJson：rows / labels / dateIndex 长度必须一致')
  }
  return JSON.stringify(rows.map((row, index) => [row, labels[index], dates[dateIndex[index]]]))
}

/**
 * sha256（hex）。
 * @param {string} text
 * @returns {string}
 */
export function sha256Hex(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

/**
 * 快照 `integrity.sha256` 的取值：canonical stacks JSON 的 sha256。
 * @param {{rows: string[], labels: string[], dates: string[], dateIndex: number[]}} encoded
 * @returns {string}
 */
export function stacksDigest(encoded) {
  return sha256Hex(canonicalStacksJson(encoded))
}
