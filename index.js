/**
 * dsh-vibestart — VibeStart 插件（薄入口）
 *
 * 只负责重导出；实现分层在 lib/ 下：
 *   plugin/        宿主适配（apply / 技能注册 / SchemaSpec 方言守卫 / 配置面）
 *   catalog/       离线快照的加载与查询（15 个 kind、上游全部已校验组合）
 *   plan/          纯函数：校验栈、合法补全、最近合法组合、命令生成
 *   exec/          通过 ctx.shell 执行 vibestart-cli 并解析 JSON 结果
 *   tools/         三个模型工具（vibestart_stacks / vibestart_plan / vibestart_run）
 *   presentation/  工具结果的 Markdown 渲染
 *
 * 数据来自 `vibestart-cli --list --json` 的离线快照（data/snapshot.json），
 * 不联网、不含模板源码；真正生成项目由上游 CLI 完成。
 *
 * @module dsh-vibestart
 */

export { name, inject } from './lib/plugin/meta.js'
export { Config } from './lib/plugin/config.js'
export { apply, buildTools } from './lib/plugin/index.js'
export { SKILL_NAME } from './lib/plugin/skill.js'
export { TOOL_NAMES } from './lib/tools/index.js'
