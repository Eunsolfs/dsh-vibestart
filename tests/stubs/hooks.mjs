/**
 * tests/stubs/hooks.mjs — 把宿主包重定向到本地替身的解析钩子
 *
 * 只在这一件事上骗过 Node：把 `@deepseek-ai/dsh-tools` / `@deepseek-ai/dsh-skill`
 * 解析到 tests/stubs 下的替身，让根入口能在纯 Node 里被真正 import。
 * 其余 specifier 原样交给默认解析。
 */

const STUBS = new Map([
  ['@deepseek-ai/dsh-tools', new URL('./dsh-tools.mjs', import.meta.url).href],
  ['@deepseek-ai/dsh-skill', new URL('./dsh-skill.mjs', import.meta.url).href],
])

export async function resolve(specifier, context, nextResolve) {
  const stub = STUBS.get(specifier)
  if (stub) return { url: stub, shortCircuit: true }
  return nextResolve(specifier, context)
}
