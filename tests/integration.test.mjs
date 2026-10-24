/**
 * tests/integration.test.mjs — 三个工具 + 真实快照的端到端行为
 *
 * 与单元测试的分工：catalog.test.mjs 管编码与查询原语，plan.test.mjs / run.test.mjs
 * 管各自的分支；这里只验证「装配之后，模型看到的东西对不对」——
 * 工具名、schema 方言、真实快照上的四种栈状态、以及 run 在无 shell 时的降级。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { loadCatalog, summary } from '../lib/catalog/index.js'
import { buildToolSpecs } from '../lib/tools/index.js'
import { DEFAULT_CONFIG } from '../lib/plugin/config.js'
import { assertToolSchemaDialect, validateSpecValue } from '../lib/plugin/schema.js'
import { parseStackInput, normalizeStackValue } from '../lib/parse-stack.js'
import * as markdown from '../lib/presentation/markdown.js'

const catalog = loadCatalog()
const specs = buildToolSpecs({
  config: DEFAULT_CONFIG,
  getCatalog: () => catalog,
  getShell: () => undefined,
})
const tool = name => {
  const found = specs.find(spec => spec.name === name)
  assert.ok(found, `缺少工具 ${name}`)
  return found
}
const run = (name, args = {}) => tool(name).execute(args, { signal: new AbortController().signal })

/** 工具返回值必须同时满足声明 schema —— 防止 render 与 schema 各自漂移。 */
function assertMatchesOutputSchema(spec, value) {
  const violations = validateSpecValue(spec.output.schema, value)
  assert.deepEqual(violations, [], `${spec.name} 的返回值不符合自己的 output.schema`)
}

test('三个工具都经过 schema 方言自检，且名字与 TOOL_NAMES 一致', () => {
  assert.equal(specs.length, 3)
  assert.deepEqual(specs.map(spec => spec.name).sort(), ['vibestart_plan', 'vibestart_run', 'vibestart_stacks'])
  for (const spec of specs) {
    assert.deepEqual(assertToolSchemaDialect(spec), [], `${spec.name} schema 不合方言`)
    assert.equal(spec.isConcurrencySafe(), true)
    assert.equal(typeof spec.output.render, 'function')
    const rendered = spec.output.render({}, {}, { ok: true })
    assert.ok(Array.isArray(rendered) && rendered.length > 0, `${spec.name}: render 必须返回内容片段`)
  }
})

test('vibestart_stacks 无参数时给出总览', async () => {
  const result = await run('vibestart_stacks')
  assertMatchesOutputSchema(tool('vibestart_stacks'), result)
  assert.equal(result.kindCount, catalog.kinds.length)
  assert.equal(result.stackCount, catalog.stackCount)
  assert.equal(result.cliVersion, summary().cliVersion)
  assert.equal(result.kinds.length, catalog.kinds.length)
  assert.equal(result.match, null)
})

test('vibestart_stacks 按 kind 列出选项与合法组合数', async () => {
  const result = await run('vibestart_stacks', { kind: 'database' })
  assertMatchesOutputSchema(tool('vibestart_stacks'), result)
  const database = result.kinds.find(kind => kind.id === 'database')
  assert.ok(database, '应返回 database 这一个 kind')
  assert.ok(database.options.some(option => option.id === 'postgres'))
  for (const option of database.options) {
    assert.equal(typeof option.legalCount, 'number')
    assert.ok(option.legalCount > 0, `${option.id} 至少应出现在一个合法组合里`)
  }
})

test('vibestart_stacks 对部分栈给出合法补全', async () => {
  const result = await run('vibestart_stacks', { stack: 'framework=next' })
  assertMatchesOutputSchema(tool('vibestart_stacks'), result)
  assert.ok(result.match, '固定了 framework=next 之后应有 match')
  assert.ok(result.match.legalCount > 0)
  assert.ok(result.match.sample.length > 0)
  assert.equal(result.match.sample[0].stack.framework, 'next')
  assert.ok(Array.isArray(result.match.perKindOptions.database))
})

test('vibestart_stacks 把不认识的取值单独报出来（不做过滤）', async () => {
  const result = await run('vibestart_stacks', { stack: 'framework=vue' })
  assertMatchesOutputSchema(tool('vibestart_stacks'), result)
  assert.ok(result.unknown.length > 0, '未知取值必须进 unknown，而不是静默忽略')
  assert.equal(result.unknown[0].kind, 'framework')
  // 未知取值不参与过滤：合法组合总数应仍是全量
  assert.equal(result.match.legalCount, catalog.stackCount)
})

test('vibestart_plan 对合法组合给出可执行命令', async () => {
  const full = catalog.stacks[0].values
  const stack = Object.entries(full)
    .map(([kind, value]) => `${kind}=${value || 'none'}`)
    .join(',')
  const result = await run('vibestart_plan', { stack, directory: 'my-app' })
  assertMatchesOutputSchema(tool('vibestart_plan'), result)
  assert.equal(result.status, 'legal')
  assert.equal(result.ok, true)
  assert.match(result.command, /vibestart-cli@[\d.]+/u)
  assert.match(result.command, /create my-app/u)
  assert.match(result.command, /--framework spa/u)
  assert.match(result.command, /--backend hono/u)
  assert.match(result.command, /--database postgres/u)
  assert.match(result.command, /--dry-run/u)
  assert.match(result.command, /--json/u)
  assert.ok(result.verifiedAt, 'legal 时应带上校验时间')
})

test('vibestart_plan 对非法组合给出最近合法与最小改动', async () => {
  // Void 部署明确排除 Next.js（见上游技能的 create 参考）。
  const result = await run('vibestart_plan', {
    stack: 'framework=next,deployment=void,runtime=workers',
    directory: 'my-app',
  })
  assertMatchesOutputSchema(tool('vibestart_plan'), result)
  assert.equal(result.status, 'illegal')
  assert.equal(result.ok, false)
  assert.ok(result.fixes.length > 0, '非法组合必须给最近合法组合')
  const nearest = result.fixes[0]
  assert.ok(nearest.distance >= 1)
  assert.ok(nearest.diffs.length >= 1)
  assert.ok(nearest.command.includes('--dry-run'))
  // 相似度排序：distance 单调不减
  for (let i = 1; i < result.fixes.length; i += 1) {
    assert.ok(result.fixes[i].distance >= result.fixes[i - 1].distance)
  }
})

test('vibestart_plan 对缺值给出补全样本', async () => {
  const result = await run('vibestart_plan', { stack: 'framework=spa' })
  assertMatchesOutputSchema(tool('vibestart_plan'), result)
  assert.equal(result.status, 'incomplete')
  assert.ok(result.completions.count > 0)
  assert.ok(result.completions.sample.length > 0)
  assert.ok(result.missing.length > 0, '应指出还缺哪些 kind')
})

test('vibestart_plan 对未知取值拒绝并列出 unknown', async () => {
  const result = await run('vibestart_plan', { stack: 'framework=vue,databsae=postgres' })
  assertMatchesOutputSchema(tool('vibestart_plan'), result)
  assert.equal(result.status, 'invalid')
  assert.equal(result.ok, false)
  assert.ok(result.unknown.length >= 1)
})

test('vibestart_run 在没有 shell 时不执行、给出可执行下一步', async () => {
  const result = await run('vibestart_run', { command: 'doctor' })
  assertMatchesOutputSchema(tool('vibestart_run'), result)
  assert.equal(result.ok, false)
  assert.equal(result.applied, false)
  assert.match(String(result.message), /pwsh|bash|shell/iu)
})

test('vibestart_run 拒绝把文件写到工作区外', async () => {
  const result = await run('vibestart_run', { command: 'create', directory: '../escape' })
  assert.equal(result.ok, false)
  assert.match(String(result.message), /相对路径|\.\./u)
})

test('vibestart_run 把上游的对象数组折成可读字符串（真实 CLI 形状）', async () => {
  const stdout = JSON.stringify({
    ok: true,
    dryRun: true,
    fileCount: 2,
    files: [{ owner: 'vite-plus', path: '.gitattributes' }, { owner: 'app', path: '.env', ignored: true }],
    nextSteps: [{ note: 'install Vite+', run: 'curl -fsSL https://vite.plus | bash' }],
  })
  const shell = {
    resolve: spec => spec,
    execute: async () => ({
      result: async () => ({ exitCode: 0, timedOut: false, aborted: false, stdout: { text: stdout }, stderr: { text: '' } }),
    }),
  }
  const specsWithShell = buildToolSpecs({
    config: DEFAULT_CONFIG,
    getCatalog: () => catalog,
    getShell: () => shell,
  })
  const runTool = specsWithShell.find(spec => spec.name === 'vibestart_run')
  const full = catalog.stacks[0].values
  const stack = Object.entries(full)
    .map(([kind, value]) => `${kind}=${value || 'none'}`)
    .join(',')
  const value = await runTool.execute({ command: 'create', stack, directory: 'demo' }, { signal: new AbortController().signal })

  assert.equal(value.ok, true)
  assert.deepEqual(value.files, ['.gitattributes', '.env（本地 .env，git 忽略）'])
  assert.deepEqual(value.nextSteps, ['install Vite+ → curl -fsSL https://vite.plus | bash'])
  const rendered = runTool.output.render({}, value, { ok: true })
  assert.ok(!rendered[0].text.includes('[object Object]'), '渲染不得出现 [object Object]')
  assert.ok(rendered[0].text.includes('.gitattributes'))
  assert.ok(rendered[0].text.includes('install Vite+ →'))
})

test('维护命令的命令形状与上游一致（add 位置参数 / doctor 无 --dry-run）', async () => {
  const plan = args => run('vibestart_plan', args)

  // add 是位置参数命令：能力 ID 紧跟子命令，且不带 --addons。
  const addPreview = await plan({ command: 'add', addons: 'knip,ultracite' })
  assert.equal(addPreview.status, 'legal')
  assert.match(addPreview.command, /vibestart-cli@[\d.]+ add knip ultracite --dry-run --json$/u)
  assert.ok(!addPreview.command.includes('--addons'))

  const addApply = await plan({ command: 'add', addons: 'knip', preview: false })
  assert.match(addApply.command, / add knip --yes --json$/u)

  // 没有能力 ID 的 add 只能退化成 --list（只读）；apply 时必须被判成 invalid。
  const addList = await plan({ command: 'add' })
  assert.equal(addList.status, 'legal')
  assert.match(addList.command, / add --list --json$/u)
  const addEmptyApply = await plan({ command: 'add', preview: false })
  assert.equal(addEmptyApply.status, 'invalid')
  assert.equal(addEmptyApply.ok, false)

  // doctor 永不带 --dry-run；offline 只对它生效。
  const doctor = await plan({ command: 'doctor' })
  assert.ok(!doctor.command.includes('--dry-run'))
  const doctorOffline = await plan({ command: 'doctor', offline: true })
  assert.match(doctorOffline.command, / doctor --offline --json$/u)

  // upgrade 的预览与写入
  const upgradePreview = await plan({ command: 'upgrade' })
  assert.match(upgradePreview.command, / upgrade --dry-run --json$/u)
  const upgradeApply = await plan({ command: 'upgrade', preview: false })
  assert.match(upgradeApply.command, / upgrade --yes --json$/u)
})

test('栈字符串语法容错', () => {
  assert.deepEqual(parseStackInput('framework=spa, backend=hono').values, {
    framework: 'spa',
    backend: 'hono',
  })
  assert.deepEqual(parseStackInput('api=none;db=postgres').values, { api: '', database: 'postgres' })
  assert.deepEqual(parseStackInput('framework').unknown, [{ kind: 'framework', value: '' }])
  assert.equal(normalizeStackValue('NONE'), '')
  assert.equal(normalizeStackValue('  Spa '), 'spa')
  assert.deepEqual(parseStackInput('').values, {})
})

test('Markdown 渲染助手不抛错且丢弃空片段', () => {
  assert.equal(markdown.heading('标题', 3), '### 标题')
  assert.equal(markdown.bullet([]), '')
  assert.equal(markdown.kv([['a', 1], ['b', undefined]]), '- **a**：1')
  assert.ok(markdown.code('npx x').startsWith('```sh'))
  assert.ok(markdown.table(['A'], [['x|y']]).includes('x\\|y'))
  assert.equal(markdown.join(['a', '', null, 'b']), 'a\n\nb')
  assert.equal(markdown.inlineCode(''), '')
})
