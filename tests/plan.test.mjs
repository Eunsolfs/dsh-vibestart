/**
 * tests/plan.test.mjs — lib/plan/index.js 与 vibestart_plan 的边界测试
 *
 * 用一份**自造的小 catalog fixture**（5 个 kind、11 条 stack）验证四态与命令
 * 生成，完全不依赖 1.7MB 的真实快照，也不依赖 A-catalog 的实现。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildCliCommand,
  buildCommand,
  normalizeStackValue,
  parseStackInput,
  planStack,
} from '../lib/plan/index.js'
import { assertToolSchemaDialect, validateSpecValue } from '../lib/plugin/schema.js'
import { createPlanTool } from '../lib/tools/plan.js'

// ---------- fixture catalog ----------

const kindOrder = ['toolchain', 'framework', 'database', 'auth', 'testing']

const valueDomain = {
  toolchain: ['vite-plus'],
  framework: ['', 'spa', 'next'],
  database: ['', 'sqlite', 'postgres'],
  auth: ['', 'better-auth'],
  testing: ['playwright', 'e2e'],
}

const kinds = [
  { id: 'toolchain', name: 'Toolchain', optional: false, options: [{ id: 'vite-plus', name: 'Vite+' }] },
  {
    id: 'framework',
    name: 'Framework',
    optional: true,
    options: [
      { id: 'spa', name: 'SPA' },
      { id: 'next', name: 'Next.js' },
    ],
  },
  {
    id: 'database',
    name: 'Database',
    optional: true,
    options: [
      { id: 'sqlite', name: 'SQLite' },
      { id: 'postgres', name: 'PostgreSQL' },
    ],
  },
  { id: 'auth', name: 'Auth', optional: true, options: [{ id: 'better-auth', name: 'Better Auth' }] },
  {
    id: 'testing',
    name: 'Testing',
    optional: false,
    options: [
      { id: 'playwright', name: 'Playwright' },
      { id: 'e2e', name: 'TesterArmy e2e' },
    ],
  },
]

function makeStack(framework, database, auth, testing) {
  return {
    toolchain: 'vite-plus',
    framework,
    database,
    auth,
    testing,
  }
}

const rawStacks = [
  makeStack('spa', 'sqlite', 'better-auth', 'playwright'), // 0：主 legal 用例
  makeStack('spa', 'postgres', 'better-auth', 'playwright'),
  makeStack('next', 'postgres', '', 'playwright'),
  makeStack('', '', '', 'playwright'),
  makeStack('spa', '', '', 'e2e'),
  makeStack('next', 'sqlite', '', 'e2e'),
  makeStack('', 'sqlite', 'better-auth', 'playwright'),
  makeStack('spa', 'postgres', 'better-auth', 'e2e'),
  makeStack('next', 'postgres', 'better-auth', 'e2e'),
  makeStack('', 'postgres', '', 'e2e'),
  makeStack('', '', 'better-auth', 'playwright'),
]

const stacks = rawStacks.map((values, index) => ({
  label: [values.framework || 'none', values.database || 'none', values.auth || 'none', values.testing].join('-'),
  values,
  verifiedAt: `2026-10-23T02:19:${String(index).padStart(2, '0')}.000Z`,
}))

const catalog = {
  cliVersion: '0.1.1',
  generatedAt: '2026-10-24T07:30:00.000Z',
  source: 'fixture',
  packageManagers: ['pnpm', 'bun'],
  defaultPackageManager: 'pnpm',
  addons: [
    { id: 'knip', name: 'Knip', description: 'unused code', default: true },
    { id: 'ultracite', name: 'Ultracite', description: 'lint presets', default: true },
  ],
  kinds,
  kindOrder,
  valueDomain,
  stackCount: stacks.length,
  stacks,
}

/**
 * 与 catalog 模块同语义的最小实现；plan 只依赖这两个能力。
 * @param {Record<string,string>} partial
 */
catalog.matchingStacks = function matchingStacks(partial, limit = 5) {
  const unknown = []
  const requested = {}
  for (const [kind, value] of Object.entries(partial ?? {})) {
    if (!kindOrder.includes(kind)) {
      unknown.push({ kind, value })
      continue
    }
    const normalized = value === 'none' ? '' : value
    if (!valueDomain[kind].includes(normalized)) {
      unknown.push({ kind, value: normalized })
      continue
    }
    requested[kind] = normalized
  }
  if (unknown.length > 0) {
    return { count: 0, sample: [], perKindOptions: {}, unknown }
  }
  const matched = stacks.filter(stack =>
    Object.entries(requested).every(([kind, value]) => stack.values[kind] === value),
  )
  const perKindOptions = {}
  for (const kind of kindOrder) {
    const seen = new Set(matched.map(stack => stack.values[kind]))
    perKindOptions[kind] = valueDomain[kind].filter(value => seen.has(value))
  }
  return { count: matched.length, sample: matched.slice(0, limit), perKindOptions, unknown: [] }
}

catalog.nearestStacks = function nearestStacks(values, k = 3) {
  const target = {}
  for (const kind of kindOrder) {
    const raw = values?.[kind]
    target[kind] = raw === 'none' ? '' : raw !== undefined ? raw : valueDomain[kind][0]
  }
  return stacks
    .map(stack => {
      const diffs = []
      for (const kind of kindOrder) {
        if (stack.values[kind] !== target[kind]) {
          diffs.push({ kind, from: target[kind], to: stack.values[kind] })
        }
      }
      return { label: stack.label, values: stack.values, verifiedAt: stack.verifiedAt, distance: diffs.length, diffs }
    })
    .sort((a, b) => a.distance - b.distance || a.label.localeCompare(b.label))
    .slice(0, k)
}

const FULL = {
  toolchain: 'vite-plus',
  framework: 'spa',
  database: 'sqlite',
  auth: 'better-auth',
  testing: 'playwright',
}

// ---------- 公开面与解析 ----------

test('plan 模块导出契约 §6 的公开函数', async () => {
  const module = await import('../lib/plan/index.js')
  for (const name of ['planStack', 'buildCommand', 'buildCliCommand', 'normalizeStackValue', 'parseStackInput']) {
    assert.equal(typeof module[name], 'function', `${name} 必须是函数`)
  }
})

test('parseStackInput / normalizeStackValue 从 parse-stack 再导出且语义正确', () => {
  const parsed = parseStackInput(' framework = SPA ; database=none, auth=null ,junk')
  assert.deepEqual(parsed.values, { framework: 'spa', database: '', auth: '' })
  assert.deepEqual(parsed.unknown, [{ kind: 'junk', value: '' }])
  assert.equal(normalizeStackValue(' NONE '), '')
  assert.equal(normalizeStackValue(undefined), '')
  assert.equal(normalizeStackValue('Next'), 'next')
})

// ---------- 四态 ----------

test('legal：完整且命中 → 按 kindOrder 输出完整命令', () => {
  // 故意打乱输入顺序，验证 resolved/command 都按 kindOrder 重排。
  const stack = {
    testing: 'playwright',
    auth: 'better-auth',
    database: 'sqlite',
    framework: 'spa',
    toolchain: 'vite-plus',
  }
  const plan = planStack({ stack, catalog })
  assert.equal(plan.status, 'legal')
  assert.equal(plan.ok, true)
  assert.deepEqual(plan.unknown, [])
  assert.equal(plan.verifiedAt, stacks[0].verifiedAt)
  assert.equal(
    plan.command,
    'npx --yes vibestart-cli@0.1.1 create my-app --toolchain vite-plus --framework spa --database sqlite --auth better-auth --testing playwright --dry-run --json',
  )
})

test('legal：optional 的 "" 逐字写成 none', () => {
  const plan = planStack({
    stack: { toolchain: 'vite-plus', framework: '', database: 'none', auth: 'NONE', testing: 'playwright' },
    catalog,
  })
  assert.equal(plan.status, 'legal')
  assert.equal(plan.resolved.database, '')
  assert.match(
    plan.command,
    /--toolchain vite-plus --framework none --database none --auth none --testing playwright --dry-run --json$/u,
  )
})

test('legal：directory 含空格、addons=none、pnpm-dlx、apply 预览关闭', () => {
  const plan = planStack({
    stack: FULL,
    catalog,
    directory: 'my app',
    addons: 'none',
    packageManager: 'bun',
    preview: false,
    runner: 'pnpm-dlx',
    cliVersion: '0.2.0',
  })
  assert.equal(plan.status, 'legal')
  assert.equal(
    plan.command,
    'pnpm dlx vibestart-cli@0.2.0 create "my app" --toolchain vite-plus --framework spa --database sqlite --auth better-auth --testing playwright --addons none --package-manager bun --json',
  )
  assert.doesNotMatch(plan.command, /--dry-run/u)
})

test('incomplete：缺 kind → 给补全样本、数量与缺失列表', () => {
  const plan = planStack({
    stack: { toolchain: 'vite-plus', framework: 'spa', testing: 'playwright' },
    catalog,
  })
  assert.equal(plan.status, 'incomplete')
  assert.equal(plan.ok, true)
  assert.deepEqual(plan.missing, ['database', 'auth'])
  assert.ok(plan.completions.count > 0)
  assert.ok(plan.completions.sample.length > 0)
  assert.match(plan.completions.sample[0].command, /--database \S+ --auth \S+ --testing playwright --dry-run --json$/u)
  assert.equal(
    plan.command,
    'npx --yes vibestart-cli@0.1.1 create my-app --toolchain vite-plus --framework spa --testing playwright --dry-run --json',
  )
  assert.ok(plan.notes.some(note => note.includes('还缺')))
})

test('illegal：完整但不命中 → fixes 按 distance 升序并带命令', () => {
  const plan = planStack({
    stack: { toolchain: 'vite-plus', framework: 'next', database: 'sqlite', auth: 'better-auth', testing: 'playwright' },
    catalog,
  })
  assert.equal(plan.status, 'illegal')
  assert.equal(plan.ok, false)
  assert.ok(plan.fixes.length > 0)
  const distances = plan.fixes.map(fix => fix.distance)
  assert.deepEqual(distances, [...distances].sort((a, b) => a - b))
  assert.ok(plan.fixes[0].diffs.length >= 1)
  assert.match(plan.fixes[0].command, /create my-app --toolchain vite-plus .* --dry-run --json$/u)
  assert.ok(plan.notes.some(note => note.includes('最小改动')))
})

test('illegal：缺口下没有任何合法补全（单候选 kind 也不放过）', () => {
  const plan = planStack({
    stack: { framework: 'next', database: 'sqlite', auth: 'better-auth', testing: 'playwright' },
    catalog,
  })
  assert.equal(plan.status, 'illegal')
  assert.deepEqual(plan.missing, [])
  assert.ok(plan.fixes.length > 0)
  assert.equal(plan.fixes[0].values.toolchain, 'vite-plus')
})

test('invalid：不认识的 kind、非法取值、required 取 none', () => {
  const unknownKind = planStack({ stack: { ...FULL, package: 'x' }, catalog })
  assert.equal(unknownKind.status, 'invalid')
  assert.ok(unknownKind.unknown.some(item => item.kind === 'package'))
  assert.ok(unknownKind.notes.some(note => note.includes('不认识的 kind')))

  const badValue = planStack({ stack: { ...FULL, database: 'oracle' }, catalog })
  assert.equal(badValue.status, 'invalid')
  assert.deepEqual(badValue.unknown, [{ kind: 'database', value: 'oracle' }])
  assert.ok(badValue.notes.some(note => note.includes('不接受值')))

  const requiredNone = planStack({ stack: { ...FULL, testing: '' }, catalog })
  assert.equal(requiredNone.status, 'invalid')
  assert.deepEqual(requiredNone.unknown, [{ kind: 'testing', value: '' }])
})

test('invalid：未知 addon 被白名单拒绝，addon 大小写/空白归一', () => {
  const bad = planStack({ stack: FULL, addons: 'knip,evil', catalog })
  assert.equal(bad.status, 'invalid')
  assert.deepEqual(bad.unknown, [{ kind: 'addons', value: 'evil' }])

  const normalized = planStack({ stack: FULL, addons: ' Knip , ULTRACITE ', catalog })
  assert.equal(normalized.status, 'legal')
  assert.match(normalized.command, /--addons knip,ultracite --dry-run --json$/u)
})

test('invalid：parsed.unknown（语法错误）会被 planStack 合并', () => {
  const plan = planStack({ stack: FULL, unknown: [{ kind: 'oops', value: '' }], catalog })
  assert.equal(plan.status, 'invalid')
  assert.ok(plan.unknown.some(item => item.kind === 'oops'))
})

test('catalog 缺少 matchingStacks/nearestStacks 时直接抛契约错误', () => {
  assert.throws(
    () => planStack({ stack: FULL, catalog: { kindOrder } }),
    /matchingStacks|nearestStacks/u,
  )
})

// ---------- 维护命令与 buildCommand ----------

test('维护命令：不带栈 flag，apply 时 add/upgrade 加 --yes，doctor 不加', () => {
  // add 是位置参数命令（vibestart add [knip ultracite docker]）：能力 ID 跟在子命令后。
  const addPreview = planStack({ stack: {}, catalog, command: 'add', addons: 'knip,ultracite' })
  assert.equal(addPreview.status, 'legal')
  assert.equal(addPreview.command, 'npx --yes vibestart-cli@0.1.1 add knip ultracite --dry-run --json')

  const addApply = planStack({ stack: {}, catalog, command: 'add', addons: 'knip', preview: false })
  assert.equal(addApply.command, 'npx --yes vibestart-cli@0.1.1 add knip --yes --json')

  // 没有能力 ID：预览退化成只读的 --list，写入判 invalid（空 add 上游会 exit 2）。
  const addList = planStack({ stack: {}, catalog, command: 'add' })
  assert.equal(addList.status, 'legal')
  assert.equal(addList.command, 'npx --yes vibestart-cli@0.1.1 add --list --json')
  const addEmptyApply = planStack({ stack: {}, catalog, command: 'add', preview: false })
  assert.equal(addEmptyApply.status, 'invalid')
  assert.equal(addEmptyApply.ok, false)

  const upgradePreview = planStack({ stack: {}, catalog, command: 'upgrade' })
  assert.equal(upgradePreview.command, 'npx --yes vibestart-cli@0.1.1 upgrade --dry-run --json')

  const upgradeApply = planStack({ stack: {}, catalog, command: 'upgrade', preview: false })
  assert.equal(upgradeApply.command, 'npx --yes vibestart-cli@0.1.1 upgrade --yes --json')

  const doctorApply = planStack({ stack: {}, catalog, command: 'doctor', preview: false })
  assert.equal(doctorApply.command, 'npx --yes vibestart-cli@0.1.1 doctor --json')
})

test('doctor 永不追加 --dry-run（上游只给 create/add/upgrade）；offline 只对 doctor 生效', () => {
  for (const preview of [true, false]) {
    const doctor = planStack({ stack: {}, catalog, command: 'doctor', preview })
    assert.equal(doctor.command, 'npx --yes vibestart-cli@0.1.1 doctor --json')
    assert.doesNotMatch(doctor.command, /--dry-run/u)

    const offline = planStack({ stack: {}, catalog, command: 'doctor', preview, offline: true })
    assert.equal(offline.command, 'npx --yes vibestart-cli@0.1.1 doctor --offline --json')
  }

  const addOffline = planStack({ stack: {}, catalog, command: 'add', offline: true, addons: 'knip' })
  assert.doesNotMatch(addOffline.command, /--offline/u)
  assert.match(addOffline.command, /add knip --dry-run --json$/u)

  const upgradeOffline = planStack({ stack: {}, catalog, command: 'upgrade', preview: false, offline: true })
  assert.equal(upgradeOffline.command, 'npx --yes vibestart-cli@0.1.1 upgrade --yes --json')

  const createOffline = planStack({ stack: FULL, catalog, offline: true })
  assert.doesNotMatch(createOffline.command, /--offline/u)
})

test('buildCommand：单点生成 create 的全部 flag 组合', () => {
  assert.equal(
    buildCommand({ values: FULL, preview: true }),
    'npx --yes vibestart-cli@0.1.1 create my-app --toolchain vite-plus --framework spa --database sqlite --auth better-auth --testing playwright --dry-run --json',
  )
  assert.equal(
    buildCommand({ values: FULL, preview: false, addons: 'knip,ultracite', packageManager: 'pnpm' }),
    'npx --yes vibestart-cli@0.1.1 create my-app --toolchain vite-plus --framework spa --database sqlite --auth better-auth --testing playwright --addons knip,ultracite --package-manager pnpm --json',
  )
  assert.match(buildCommand({ values: { framework: 'my value' } }), /--framework "my value"/u)
  assert.match(
    buildCommand({ values: FULL, noGit: true, noInstall: true, noCheck: true }),
    /--no-git --no-install --no-check --dry-run --json$/u,
  )
  assert.equal(
    buildCliCommand({ runner: 'pnpm-dlx', cliVersion: '1.2.3', args: ['create', 'a b'] }),
    'pnpm dlx vibestart-cli@1.2.3 create "a b"',
  )
  // doctor 不吃 --dry-run；offline 也只给 doctor。
  assert.equal(buildCommand({ command: 'doctor', preview: true }), 'npx --yes vibestart-cli@0.1.1 doctor --json')
  assert.equal(buildCommand({ command: 'doctor', preview: false }), 'npx --yes vibestart-cli@0.1.1 doctor --json')
  assert.equal(
    buildCommand({ command: 'doctor', preview: true, offline: true }),
    'npx --yes vibestart-cli@0.1.1 doctor --offline --json',
  )
  assert.equal(
    buildCommand({ command: 'add', preview: true, offline: true, addons: 'knip,ultracite' }),
    'npx --yes vibestart-cli@0.1.1 add knip ultracite --dry-run --json',
  )
  // 没有能力 ID 的 add 只能列能力（--list），不叠加 --dry-run。
  assert.equal(
    buildCommand({ command: 'add', preview: true }),
    'npx --yes vibestart-cli@0.1.1 add --list --json',
  )
  assert.throws(() => buildCommand({ command: 'rm', values: {} }), /unknown command/u)
})

// ---------- 工具规格 ----------

test('vibestart_plan 的 schema 通过方言检查，execute 可直接返回合法输出', async () => {
  const tool = createPlanTool({
    config: { cliVersion: '0.1.1', runner: 'npx', previewTimeoutMs: 180_000, applyTimeoutMs: 600_000 },
    getCatalog: () => catalog,
  })
  assert.deepEqual(assertToolSchemaDialect(tool), [])
  assert.equal(tool.name, 'vibestart_plan')
  assert.equal(tool.isConcurrencySafe(), true)

  const value = await tool.execute({
    stack: 'toolchain=vite-plus; framework=spa, database=none, auth=none, testing=e2e',
  })
  assert.equal(value.status, 'legal')
  assert.deepEqual(validateSpecValue(tool.output.schema, value), [])

  const rendered = tool.output.render({}, value)
  assert.equal(rendered[0].type, 'text')
  assert.match(rendered[0].text, /栈规划/u)
  assert.match(rendered[0].text, /--database none/u)

  // render 是纯函数：缺值/垃圾值也要降级而不是抛。
  assert.equal(tool.output.render({}, null)[0].type, 'text')
  assert.equal(tool.output.render({}, { status: 'legal' })[0].type, 'text')
})

test('vibestart_plan：catalog 不可用时返回 invalid 而不是抛', async () => {
  const tool = createPlanTool({
    config: { cliVersion: '0.1.1', runner: 'npx' },
    getCatalog: () => {
      throw new Error('snapshot corrupted')
    },
  })
  const value = await tool.execute({ stack: 'framework=spa' })
  assert.equal(value.status, 'invalid')
  assert.ok(value.notes.some(note => note.includes('snapshot corrupted')))
  assert.deepEqual(validateSpecValue(tool.output.schema, value), [])
})
