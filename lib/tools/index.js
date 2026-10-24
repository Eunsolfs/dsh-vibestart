/**
 * tools/index.js — 三个工具规格的装配点
 *
 * 工具实现各自是工厂函数（`createXTool(deps)`），依赖从外面注入：
 *   - config      归一后的插件配置
 *   - getCatalog  懒加载 catalog（stacks / plan 都要）
 *   - getShell    懒取 ctx.shell（run 需要；未挂载时返回 undefined，由工具自己降级）
 *
 * 这样做的好处：`lib/plugin/index.js` 只在 apply() 里决定依赖，工具本身完全
 * 不知道 DSH 的存在，测试可以脱离宿主运行时直接跑。
 */

import { createStacksTool } from './stacks.js'
import { createPlanTool } from './plan.js'
import { createRunTool } from './run.js'

/**
 * 构建三个工具规格（尚未 `defineTool` 包装）。
 * @param {{ config: object, getCatalog: () => object, getShell: () => object|undefined }} deps
 * @returns {object[]}
 */
export function buildToolSpecs(deps) {
  return [
    createStacksTool({ config: deps.config }),
    createPlanTool({ config: deps.config, getCatalog: deps.getCatalog }),
    createRunTool({ config: deps.config, getCatalog: deps.getCatalog, getShell: deps.getShell }),
  ]
}

/** 工具名清单：自检与文档一致性检查共用，避免手抄漂移。 */
export const TOOL_NAMES = Object.freeze(['vibestart_stacks', 'vibestart_plan', 'vibestart_run'])
