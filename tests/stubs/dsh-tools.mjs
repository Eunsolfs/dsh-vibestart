/**
 * tests/stubs/dsh-tools.mjs — @deepseek-ai/dsh-tools 的最小替身
 *
 * 宿主运行时才有真包；本地测试只需要「包一层、把 definition 交回来」这个行为，
 * 再加一道 schema 合方言断言——真正的字段校验在 verify.mjs 里做。
 */

export function defineTool(spec) {
  if (spec === null || typeof spec !== 'object') throw new TypeError('defineTool 需要规格对象')
  if (typeof spec.name !== 'string' || spec.name === '') throw new TypeError('工具必须有 name')
  if (typeof spec.execute !== 'function') throw new TypeError(`${spec.name}: execute 必须是函数`)
  return { ...spec, __defined: true }
}
