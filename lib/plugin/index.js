/**
 * plugin/index.js — 宿主适配层
 *
 * 唯一 import @deepseek-ai/* 的地方：把 lib/tools 的普通规格套上 defineTool，
 * 注册内置技能与三个模型工具，并把三个可选缝（skills / shell / catalog）接上。
 *
 * 三个依赖都是**惰性**的：
 *   - catalog 用动态 import，快照损坏时只让相关工具报错，不拖垮整个插件加载；
 *   - shell 用 ctx.inject 后读服务，未挂载时 run 工具自己降级为「只出命令」；
 *   - skills 未就绪时技能等待服务，工具照常注册。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { buildToolSpecs } from '../tools/index.js'
import { assertToolSchemaDialect } from './schema.js'
import { skillProvider } from './skill.js'
import { DEFAULT_CONFIG, normalizeConfig } from './config.js'

/** catalog 模块缓存：动态 import 只解析一次。 */
let catalogModule

/** 懒加载 + 记忆化 catalog；失败时把错误交给调用它的工具。 */
async function getCatalog() {
  if (!catalogModule) catalogModule = await import('../catalog/index.js')
  return catalogModule.loadCatalog()
}

/**
 * 构建三个工具（已 `defineTool` 包装）。
 * 导出以便测试直接校验 schema 与 execute；apply() 仅负责注册。
 *
 * 不缓存结果：defineTool 只是纯包装（微秒级），而模块级缓存会让多次 apply()
 * （多 profile / 热重载）共享同一批 definition 对象——宿主若在其上挂运行时
 * 状态，实例之间会互相污染。
 *
 * @param {object} [rawConfig]
 * @param {{ getCatalog?: () => Promise<object>|object, getShell?: () => object|undefined }} [deps]
 * @returns {import('@deepseek-ai/dsh-tools').ToolDefinition[]}
 */
export function buildTools(rawConfig = DEFAULT_CONFIG, deps = {}) {
  const config = normalizeConfig(rawConfig)
  const specs = buildToolSpecs({
    config,
    getCatalog: deps.getCatalog ?? getCatalog,
    getShell: deps.getShell ?? (() => undefined),
  })
  return specs.map(spec => {
    const violations = assertToolSchemaDialect(spec)
    if (violations.length > 0) {
      throw new TypeError(`[dsh-vibestart] 工具 ${spec.name} 的 schema 不合方言：${violations.join('；')}`)
    }
    return defineTool(spec)
  })
}

/**
 * 插件主体：注册技能（skills 缝存在且 config.skill 未关闭时）与三个工具。
 * @param {object} ctx
 * @param {object} [rawConfig]
 */
export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)

  /** @type {object|undefined} */
  let shellService
  // strict=false 的等价物：只判断服务是否已声明，不因未激活而抛错。
  try {
    shellService = ctx.reflect?.get?.('shell', false)
  } catch {
    shellService = undefined
  }
  ctx.inject(['shell'], shellCtx => {
    shellService = shellCtx.shell
  })

  let skillsReady = false
  try {
    skillsReady = ctx.reflect?.get?.('skills', false) !== undefined
  } catch {
    skillsReady = false
  }

  if (config.skill) {
    ctx.inject(['skills'], skillCtx => {
      skillCtx.skills.registerProvider(() => skillProvider)
    })
  } else {
    ctx.logger?.debug?.('[dsh-vibestart] config.skill=false：跳过内置技能注册，三个工具照常注册。')
  }
  if (config.skill && !skillsReady) {
    ctx.logger?.debug?.('[dsh-vibestart] skills 服务当前未就绪：内置技能将等待该服务；三个工具已照常注册。')
  }

  // 执行能力的两道闸：装配期只看配置，运行期工具还会再查一次。
  const getShell = () => (config.allowExec ? shellService : undefined)
  if (!config.allowExec) {
    ctx.logger?.debug?.('[dsh-vibestart] config.allowExec=false：vibestart_run 只会给出命令，不会启动 CLI。')
  }
  if (config.allowExec && !shellService) {
    ctx.logger?.debug?.('[dsh-vibestart] shell 服务未挂载：vibestart_run 将提示改用 pwsh/bash 工具执行命令。')
  }

  for (const tool of buildTools(config, { getCatalog, getShell })) {
    ctx.tools.register(tool)
  }
}
