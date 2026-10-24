/**
 * plugin/meta.js — 插件元信息
 *
 * 不 import DSH API，供根入口直接重导出。
 */

/** Cordis 插件名（仅作标识，Loader 用 patch 行里的包名解析入口）。 */
export const name = 'vibestart'

/**
 * 强依赖 ctx.tools：没有工具注册表就没有本插件的三个模型工具。
 * skills / shell 两个缝都是可选的，在 apply() 里用 ctx.inject 单独挂。
 */
export const inject = ['tools']
