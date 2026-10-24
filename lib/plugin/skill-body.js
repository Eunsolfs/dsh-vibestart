/**
 * plugin/skill-body.js — SKILL.md frontmatter 拆分（零 DSH / 零第三方依赖）
 *
 * 原生 `SkillDefinition.content` 要的是「去掉 provider 元数据后的 Markdown 正文」，
 * 而技能文件以 YAML frontmatter 开头。这里只解析用到的标量字段
 * （name / description / whenToUse），不引入 YAML 解析器——技能 frontmatter
 * 保持扁平是仓库约定，写复杂 YAML 会在自检里被拒。
 */

/**
 * 把 SKILL.md 拆成 `{ data, body }`。
 * 解析失败时返回 `{ data: {}, body: 原文 }`，保证不会因 frontmatter 格式问题丢正文。
 * @param {string} raw
 * @returns {{ data: Record<string, string>, body: string }}
 */
export function splitFrontmatter(raw) {
  const text = String(raw ?? '').replace(/^\uFEFF/, '')
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!match) return { data: {}, body: text }
  /** @type {Record<string, string>} */
  const data = {}
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/)
    if (!kv) continue
    const value = kv[2].trim()
    // 多行块（| / >）或嵌套结构不是本仓库接受的技能 frontmatter 形态，跳过并留空，
    // 让调用方回退到默认值而不是把一段 YAML 当描述塞给模型。
    if (value.startsWith('|') || value.startsWith('>') || value === '') continue
    data[kv[1]] = value.replace(/^["']|["']$/g, '')
  }
  return { data, body: text.slice(match[0].length).replace(/^\r?\n/, '') }
}
