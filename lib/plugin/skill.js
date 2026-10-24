/**
 * plugin/skill.js — 内置技能注册定义（唯一认识 dsh-skill API 的文件）
 *
 * SKILL.md 路径集中在这里；描述优先取 frontmatter，缺失时回退到本文件的默认值。
 * 正文由 skill-body.js 去掉 frontmatter 后返回——原生 `SkillDefinition.content`
 * 要求的是「去除 provider 元数据后的 Markdown 正文」。
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { BUNDLED_SKILL_RANK } from '@deepseek-ai/dsh-skill'
import { splitFrontmatter } from './skill-body.js'

export const SKILL_NAME = 'vibestart'

export const SKILL_BODY_URL = new URL('../../skills/vibestart/SKILL.md', import.meta.url)
export const SKILL_PATH = fileURLToPath(SKILL_BODY_URL)

export const SKILL_RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('../../skills/vibestart/', import.meta.url)),
}

export const SKILL_INVOCATION = { modelInvocable: true, userInvocable: true }

export const DEFAULT_WHEN_TO_USE =
  '要在会话里起一个全栈 TypeScript 项目、挑技术栈组合、校验组合是否合法、生成 vibestart 命令，' +
  '或维护已有 vibestart 项目（add / doctor / upgrade）时使用。'

export const SKILL_DESCRIPTION =
  'VibeStart 技能：用离线栈目录（15 个 kind、3409 个已校验组合）挑组合，校验并生成可执行的 ' +
  'vibestart-cli 命令，预览后再写入；也覆盖 add / doctor / upgrade 的维护流程与冲突处理。'

/**
 * 用 frontmatter 数据构造候选；frontmatter 缺失时回退到模块级默认值。
 * @param {Record<string, string>} data
 */
function candidateFrom(data) {
  return {
    name: SKILL_NAME,
    description: data.description || SKILL_DESCRIPTION,
    whenToUse: data.whenToUse || DEFAULT_WHEN_TO_USE,
    invocation: SKILL_INVOCATION,
    provider: 'dsh-vibestart',
    source: 'bundled',
    resourceBase: SKILL_RESOURCE_BASE,
    path: SKILL_PATH,
    rank: BUNDLED_SKILL_RANK,
    locator: SKILL_BODY_URL,
    metadata: data,
  }
}

/** 静态兜底候选（读文件失败时 `list()` 仍能返回它）。 */
export const SKILL_CANDIDATE = candidateFrom({})

/**
 * 解析候选的 locator：原生 locator 是不透明值，本项目使用文件 URL。
 * 兼容 URL 与字符串路径；缺失时回退到内置 SKILL.md。
 * @param {unknown} locator
 */
function resolveLocator(locator) {
  if (locator instanceof URL) return fileURLToPath(locator)
  if (typeof locator === 'string' && locator.length > 0) return locator
  return SKILL_PATH
}

export const skillProvider = {
  name: 'dsh-vibestart',
  /**
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<object[]>}
   */
  async list(options = {}) {
    if (options.signal?.aborted) return []
    try {
      const { data } = splitFrontmatter(await readFile(SKILL_BODY_URL, 'utf8'))
      return [candidateFrom(data)]
    } catch {
      // 内置文件不可读时仍返回目录候选，避免技能在目录里直接消失；
      // get() 会再次尝试读取并把错误交给宿主。
      return [SKILL_CANDIDATE]
    }
  },
  /**
   * @param {{ name?: string, locator?: unknown, description?: string, whenToUse?: string, provider?: string, source?: string }} candidate
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<object|undefined>}
   */
  async get(candidate, options = {}) {
    if (options.signal?.aborted) return undefined
    const filePath = resolveLocator(candidate?.locator)
    const { data, body } = splitFrontmatter(await readFile(filePath, 'utf8'))
    return {
      name: candidate?.name || SKILL_NAME,
      description: data.description || candidate?.description || SKILL_DESCRIPTION,
      whenToUse: data.whenToUse || candidate?.whenToUse || DEFAULT_WHEN_TO_USE,
      invocation: SKILL_INVOCATION,
      provider: candidate?.provider || 'dsh-vibestart',
      source: candidate?.source || 'bundled',
      resourceBase: SKILL_RESOURCE_BASE,
      path: filePath,
      metadata: data,
      content: body,
    }
  },
}
