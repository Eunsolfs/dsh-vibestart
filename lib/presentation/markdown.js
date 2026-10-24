/**
 * presentation/markdown.js — 工具结果的共享 Markdown 小工具
 *
 * 只做字符串拼接，零依赖、零 DSH API。工具的 `output.render` 与技能正文之外
 * 的所有模型可见文本都从这里拼，保证三个工具的输出风格一致。
 *
 * 约定：这里每个函数都必须能安全接受 undefined / 空数组，绝不抛错——渲染
 * 失败会让整条工具结果变成错误，代价远大于少一行格式。
 */

/** 把任意值转成单行文本（去掉换行，避免破坏 Markdown 结构）。 */
function oneLine(value) {
  return String(value ?? '').replace(/\s*\r?\n\s*/g, ' ').trim()
}

/**
 * 标题。
 * @param {unknown} text
 * @param {number} [level] 2–6，越界自动钳制
 * @returns {string}
 */
export function heading(text, level = 2) {
  const label = oneLine(text)
  if (!label) return ''
  const depth = Math.min(6, Math.max(1, Number.isFinite(level) ? Math.trunc(level) : 2))
  return `${'#'.repeat(depth)} ${label}`
}

/**
 * 无序列表。空数组返回空串。
 * @param {unknown[]} items
 * @returns {string}
 */
export function bullet(items) {
  if (!Array.isArray(items)) return ''
  return items
    .map(oneLine)
    .filter(Boolean)
    .map(line => `- ${line}`)
    .join('\n')
}

/**
 * 键值对列表；键加粗。
 * @param {Array<[string, unknown]>|Record<string, unknown>} pairs
 * @returns {string}
 */
export function kv(pairs) {
  const entries = Array.isArray(pairs) ? pairs : Object.entries(pairs ?? {})
  return entries
    .filter(([, value]) => value !== undefined && value !== null && oneLine(value) !== '')
    .map(([key, value]) => `- **${oneLine(key)}**：${oneLine(value)}`)
    .join('\n')
}

/**
 * 代码块。内容里带 ``` 时自动改用更长的围栏。
 * @param {unknown} text
 * @param {string} [lang]
 * @returns {string}
 */
export function code(text, lang = 'sh') {
  const body = String(text ?? '').replace(/\s+$/, '')
  if (!body) return ''
  let fence = '```'
  while (body.includes(fence)) fence += '`'
  return `${fence}${lang}\n${body}\n${fence}`
}

/**
 * GFM 表格；无行时返回空串。单元格里的 `|` 会被转义。
 * @param {string[]} headers
 * @param {Array<Array<unknown>>} rows
 * @returns {string}
 */
export function table(headers, rows) {
  if (!Array.isArray(headers) || headers.length === 0) return ''
  if (!Array.isArray(rows) || rows.length === 0) return ''
  const cell = value => oneLine(value).replace(/\|/g, '\\|') || '—'
  const head = `| ${headers.map(oneLine).join(' | ')} |`
  const divider = `| ${headers.map(() => '---').join(' | ')} |`
  const body = rows.map(row => `| ${row.map(cell).join(' | ')} |`).join('\n')
  return [head, divider, body].join('\n')
}

/**
 * 行内代码。
 * @param {unknown} text
 * @returns {string}
 */
export function inlineCode(text) {
  const value = oneLine(text)
  if (!value) return ''
  return value.includes('`') ? `\`\` ${value} \`\`` : `\`${value}\``
}

/**
 * 把若干片段用空行连接，自动丢弃空片段。写渲染函数时用它收尾。
 * @param {(string|undefined|null|false|[string|undefined|null|false])[]} parts
 * @returns {string}
 */
export function join(parts) {
  return parts
    .flatMap(part => (Array.isArray(part) ? part : [part]))
    .map(part => (typeof part === 'string' ? part.replace(/\s+$/, '') : ''))
    .filter(Boolean)
    .join('\n\n')
}
