/**
 * tests/load.test.mjs — 真正把插件装进一个假宿主里跑一遍
 *
 * 这是唯一覆盖 `lib/plugin/index.js` 的测试：用 module.register 把两个宿主包
 * 重定向到 tests/stubs，然后在假 ctx 上调用 apply()，检查
 *   - 三个工具被 defineTool 包装并注册到 ctx.tools；
 *   - config.skill=false 时不碰 skills 缝；
 *   - shell 缝挂载后，getShell 能拿到服务（run 工具因此可执行）；
 *   - config.allowExec=false 时 getShell 恒为 undefined（装配期闸门）；
 *   - 非法配置在 apply() 阶段就被拒。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

register('./stubs/hooks.mjs', import.meta.url)

const plugin = await import('../index.js')

/** 假 ctx：cordis 的最小面（tools.register / inject / reflect.get / logger）。 */
function fakeContext({ shell, skills } = {}) {
  const registered = []
  const injected = []
  const services = new Map()
  if (shell) services.set('shell', shell)
  if (skills) services.set('skills', skills)
  const ctx = {
    tools: {
      register(tool) {
        registered.push(tool)
      },
    },
    inject(deps, callback) {
      injected.push(deps)
      const deps_ = deps.map(name => ({ name, ready: services.has(name) }))
      if (deps_.every(entry => entry.ready)) {
        const scoped = { ...ctx }
        for (const { name } of deps_) scoped[name] = services.get(name)
        callback(scoped)
      }
    },
    reflect: {
      get(name) {
        return services.get(name)
      },
    },
    logger: { debug() {}, info() {}, warn() {} },
  }
  return { ctx, registered, injected }
}

test('apply() 注册技能与三个工具', async () => {
  // registerProvider 收的是「返回 provider 的工厂」（与 dsh-skill 的原生契约一致）。
  const skills = { registerProvider(factory) { skills.factory = factory } }
  const { ctx, registered, injected } = fakeContext({ skills, shell: { fake: true } })
  plugin.apply(ctx, {})

  assert.deepEqual(
    registered.map(tool => tool.name).sort(),
    [...plugin.TOOL_NAMES].sort(),
  )
  for (const tool of registered) {
    assert.equal(tool.__defined, true, `${tool.name} 应经过 defineTool 包装`)
  }
  assert.ok(injected.some(deps => deps.includes('skills')), '应请求 skills 缝')
  assert.ok(injected.some(deps => deps.includes('shell')), '应请求 shell 缝')
  assert.equal(typeof skills.factory, 'function', '应把工厂交给 skills 服务')
  const candidate = await skills.factory().list()
  assert.equal(candidate.length, 1)
  assert.equal(candidate[0].name, 'vibestart')
})

test('config.skill=false 时不注册技能，工具照常', () => {
  const skills = { registerProvider() { throw new Error('不该被调用') } }
  const { ctx, registered, injected } = fakeContext({ skills, shell: { fake: true } })
  plugin.apply(ctx, { skill: false })
  assert.equal(registered.length, 3)
  assert.ok(!injected.some(deps => deps.includes('skills')))
})

test('skills / shell 未挂载时仍能加载（工具降级）', () => {
  const { ctx, registered } = fakeContext()
  plugin.apply(ctx, {})
  assert.equal(registered.length, 3)
})

test('allowExec=false 时 run 工具拿不到 shell', async () => {
  const { ctx, registered } = fakeContext({ shell: { fake: true } })
  plugin.apply(ctx, { allowExec: false })
  const run = registered.find(tool => tool.name === 'vibestart_run')
  assert.ok(run, 'run 工具仍应注册')
  const result = await run.execute({ command: 'doctor' }, { signal: new AbortController().signal })
  assert.equal(result.ok, false)
  assert.match(result.message ?? '', /allowExec|shell/u)
})

test('非法配置在 apply() 阶段被拒', () => {
  const { ctx } = fakeContext()
  assert.throws(() => plugin.apply(ctx, { maxStacks: 99 }), /maxStacks/u)
  assert.throws(() => plugin.apply(ctx, { runner: 'bunx' }), /runner/u)
})

test('buildTools() 直接可用（测试与宿主共用同一条装配路径）', () => {
  const tools = plugin.buildTools({}, { getShell: () => undefined })
  assert.deepEqual(tools.map(tool => tool.name).sort(), [...plugin.TOOL_NAMES].sort())
  assert.throws(() => plugin.buildTools({ maxStacks: 0 }), /maxStacks/u)
})
