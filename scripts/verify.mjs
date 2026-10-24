#!/usr/bin/env node
/**
 * scripts/verify.mjs — 结构性自检
 *
 * 这里只查「宿主加载时才会暴露、但本地能静态验证」的东西：
 *   1. package.json / cordis.patch.yml 的关键字段（漏一个插件就静默不生效）；
 *   2. 根入口的导出面（文本级检查，因为 @deepseek-ai/* 只在宿主运行时存在）；
 *   3. 快照能加载、计数与完整性字段自洽；
 *   4. 三个工具能被装配、schema 合方言；
 *   5. 技能文件与 frontmatter（技能目录里没有 description 等于不会出现）；
 *   6. 文档与实现的一致性（README 提到的工具名 == 实现里的工具名）。
 *
 * 运行：node scripts/verify.mjs（零依赖、不联网、不需要 DSH 运行时）
 */

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { register } from 'node:module'

// 宿主包（@deepseek-ai/dsh-tools / dsh-skill）只在 DSH 运行时存在；自检要 import
// 技能 provider，所以先把这两个 specifier 重定向到 tests/stubs 的替身。
register(new URL('../tests/stubs/hooks.mjs', import.meta.url).href)

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(SCRIPT_DIR, '..')
const EXPECTED_TOOL_NAMES = ['vibestart_stacks', 'vibestart_plan', 'vibestart_run']

const failures = []
const notes = []

function fail(label, detail) {
  failures.push(`${label}：${detail}`)
}

function pass(label) {
  notes.push(`✓ ${label}`)
}

async function readText(relativePath) {
  return readFile(join(ROOT, relativePath), 'utf8')
}

async function readJson(relativePath) {
  return JSON.parse(await readText(relativePath))
}

/** 1. package.json */
async function checkPackageJson() {
  const pkg = await readJson('package.json')
  if (pkg.name !== 'dsh-vibestart') fail('package.json', `name 应为 dsh-vibestart，实际 ${pkg.name}`)
  if (pkg.type !== 'module') fail('package.json', 'type 必须是 module（插件是纯 ESM）')
  if (pkg.main !== 'index.js') fail('package.json', 'main 必须是 index.js')
  if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') {
    fail('package.json', 'dsh.bundle.patch 必须指向 ./cordis.patch.yml')
  }
  if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
    fail('package.json', `运行时不允许有第三方依赖，实际有：${Object.keys(pkg.dependencies).join(', ')}`)
  }
  const peers = pkg.peerDependencies ?? {}
  for (const peer of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-skill', '@deepseek-ai/dsh-shell']) {
    if (!peers[peer]) fail('package.json', `peerDependencies 缺少 ${peer}`)
  }
  for (const entry of pkg.files ?? []) {
    if (entry.includes('*')) continue
    if (!existsSync(join(ROOT, entry))) fail('package.json', `files 里列了不存在的路径：${entry}`)
  }
  if (!pkg.scripts?.test?.includes('scripts/verify.mjs')) {
    fail('package.json', 'scripts.test 必须先跑 scripts/verify.mjs')
  }
  pass('package.json 关键字段')
}

/** 2. 根入口导出面 */
async function checkEntrySurface() {
  const entry = await readText('index.js')
  for (const name of ['name', 'inject', 'Config', 'apply', 'buildTools', 'SKILL_NAME', 'TOOL_NAMES']) {
    if (!new RegExp(`\\b${name}\\b`).test(entry)) fail('index.js', `缺少导出 ${name}`)
  }
  const meta = await import('../lib/plugin/meta.js')
  if (meta.name !== 'vibestart') fail('lib/plugin/meta.js', `name 应为 vibestart，实际 ${meta.name}`)
  if (!Array.isArray(meta.inject) || !meta.inject.includes('tools')) {
    fail('lib/plugin/meta.js', 'inject 必须包含 tools')
  }
  pass('根入口导出面')
}

/** 3. 配置面：默认值必须能过自己的校验，坏输入必须被拒 */
async function checkConfig() {
  const { DEFAULT_CONFIG, normalizeConfig, Config } = await import('../lib/plugin/config.js')
  try {
    const resolved = normalizeConfig({})
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      if (resolved[key] !== DEFAULT_CONFIG[key]) fail('lib/plugin/config.js', `默认 ${key} 未按 DEFAULT_CONFIG 生效`)
    }
  } catch (error) {
    fail('lib/plugin/config.js', `默认配置过不了 normalizeConfig：${error.message}`)
  }
  const rejects = [
    [{ skill: 'yes' }, '布尔字段'],
    [{ runner: 'bunx' }, '未知 runner'],
    [{ maxStacks: 0 }, 'maxStacks 下界'],
    [{ cliVersion: 'v0.1.1' }, '非法 cliVersion'],
    [{ npmCacheDir: 5 }, 'npmCacheDir 非字符串'],
    [{ npmCacheDir: '   ' }, 'npmCacheDir 纯空白'],
  ]
  for (const [input, label] of rejects) {
    let threw = false
    try {
      normalizeConfig(input)
    } catch {
      threw = true
    }
    if (!threw) fail('lib/plugin/config.js', `${label} 应被拒绝：${JSON.stringify(input)}`)
  }
  const validated = Config['~standard'].validate({ maxStacks: 3 })
  if (!validated.value || validated.value.maxStacks !== 3) {
    fail('lib/plugin/config.js', 'Config[~standard].validate 未返回规范化结果')
  }
  pass('配置面校验')
}

/** 4. 快照可加载且自洽 */
async function checkSnapshot() {
  const { loadCatalog, loadSnapshot, summary } = await import('../lib/catalog/index.js')
  const snapshot = loadSnapshot()
  if (snapshot.schemaVersion !== 1) fail('data/snapshot.json', `schemaVersion 应为 1，实际 ${snapshot.schemaVersion}`)
  if (!snapshot.cli?.version) fail('data/snapshot.json', '缺少 cli.version')
  const catalog = loadCatalog()
  if (catalog.stackCount !== catalog.stacks.length) {
    fail('lib/catalog', `stackCount(${catalog.stackCount}) 与解码后的条数(${catalog.stacks.length}) 不一致`)
  }
  if (catalog.stackCount < 100) fail('data/snapshot.json', `组合数异常偏低：${catalog.stackCount}`)
  if (catalog.kindOrder.length < 5) fail('data/snapshot.json', 'kindOrder 异常')
  const info = summary()
  if (info.cliVersion !== snapshot.cli.version) fail('lib/catalog', 'summary().cliVersion 与快照不一致')
  for (const kind of catalog.kinds) {
    const domain = catalog.valueDomain[kind.id]
    if (!Array.isArray(domain) || domain.length === 0) fail('lib/catalog', `kind ${kind.id} 缺少 valueDomain`)
    if (kind.optional && domain?.[0] !== '') fail('lib/catalog', `optional kind ${kind.id} 的 valueDomain 首项应为 ""`)
  }
  pass(`快照可加载（${catalog.kinds.length} kinds / ${catalog.stackCount} stacks / CLI ${snapshot.cli.version}）`)
}

/** 5. 三个工具装配 + schema 合方言 */
async function checkTools() {
  const { DEFAULT_CONFIG } = await import('../lib/plugin/config.js')
  const { buildToolSpecs, TOOL_NAMES } = await import('../lib/tools/index.js')
  const { loadCatalog } = await import('../lib/catalog/index.js')
  const { assertToolSchemaDialect } = await import('../lib/plugin/schema.js')

  if (TOOL_NAMES.join(',') !== EXPECTED_TOOL_NAMES.join(',')) {
    fail('lib/tools/index.js', `TOOL_NAMES 应为 ${EXPECTED_TOOL_NAMES.join(', ')}`)
  }

  const specs = buildToolSpecs({
    config: DEFAULT_CONFIG,
    getCatalog: () => loadCatalog(),
    getShell: () => undefined,
  })
  if (specs.length !== 3) fail('lib/tools/index.js', `应装配 3 个工具，实际 ${specs.length}`)
  for (const spec of specs) {
    const violations = assertToolSchemaDialect(spec)
    if (violations.length > 0) fail(`工具 ${spec.name}`, violations.join('；'))
    if (typeof spec.execute !== 'function') fail(`工具 ${spec.name}`, 'execute 必须是函数')
    if (spec.output?.render && typeof spec.output.render !== 'function') {
      fail(`工具 ${spec.name}`, 'output.render 必须是函数')
    }
  }
  const names = specs.map(spec => spec.name).sort()
  if (names.join(',') !== [...EXPECTED_TOOL_NAMES].sort().join(',')) {
    fail('lib/tools/index.js', `工具名不符：${names.join(', ')}`)
  }
  pass('三个工具装配 + schema 方言')
}

/** 6. 技能文件与 frontmatter */
async function checkSkill() {
  const { SKILL_NAME, skillProvider, SKILL_PATH } = await import('../lib/plugin/skill.js')
  const { splitFrontmatter } = await import('../lib/plugin/skill-body.js')
  if (SKILL_NAME !== 'vibestart') fail('lib/plugin/skill.js', `SKILL_NAME 应为 vibestart，实际 ${SKILL_NAME}`)
  if (!existsSync(SKILL_PATH)) {
    fail('skills/vibestart/SKILL.md', '文件不存在')
    return
  }
  const raw = await readText('skills/vibestart/SKILL.md')
  const { data, body } = splitFrontmatter(raw)
  if (!raw.startsWith('---')) fail('SKILL.md', '必须以 --- frontmatter 开头')
  if (data.name !== 'vibestart') fail('SKILL.md', `frontmatter name 应为 vibestart，实际 ${data.name ?? '(缺失)'}`)
  if (!data.description || data.description.length < 40) fail('SKILL.md', 'frontmatter description 缺失或过短')
  if (!data.whenToUse) fail('SKILL.md', 'frontmatter 缺少 whenToUse')
  if (body.trim().length < 500) fail('SKILL.md', '正文过短，疑似只写了 frontmatter')
  const listed = await skillProvider.list()
  if (!Array.isArray(listed) || listed.length !== 1) fail('skillProvider.list', '应返回恰好 1 个候选')
  const resolved = await skillProvider.get(listed[0])
  if (!resolved?.content || resolved.content.length < 100) fail('skillProvider.get', '未返回正文')
  for (const reference of ['references/create.md', 'references/maintenance.md']) {
    if (!existsSync(join(ROOT, 'skills/vibestart', reference))) {
      fail('skills/vibestart', `缺少 ${reference}`)
    }
  }
  pass('技能文件与 frontmatter')
}

/** 7. 文档与实现一致性 */
async function checkDocs() {
  for (const file of ['README.md', 'README.en.md', 'CHANGELOG.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    if (!existsSync(join(ROOT, file))) fail('仓库根目录', `缺少 ${file}`)
  }
  if (existsSync(join(ROOT, 'README.md'))) {
    const readme = await readText('README.md')
    for (const name of EXPECTED_TOOL_NAMES) {
      if (!readme.includes(name)) fail('README.md', `未提到工具 ${name}`)
    }
    // 反方向：README 里不该出现已废弃的旧工具名。
    for (const stale of ['vibestart_list', 'vibestart_resolve', 'vibestart_create']) {
      if (readme.includes(stale)) fail('README.md', `出现已废弃的工具名 ${stale}`)
    }
  }
  const ci = '.github/workflows/ci.yml'
  if (!existsSync(join(ROOT, ci))) fail('.github/workflows', '缺少 ci.yml')
  else {
    const yml = await readText(ci)
    if (!yml.includes('npm test')) fail(ci, 'CI 未运行 npm test')
  }
  pass('文档与实现一致性')
}

/** 8. 快照脚本可用性（--check 走单独的 npm script，这里只确认文件存在） */
async function checkScripts() {
  if (!existsSync(join(ROOT, 'scripts/snapshot.mjs'))) fail('scripts/', '缺少 snapshot.mjs')
  pass('快照脚本存在')
}

const checks = [
  ['package.json', checkPackageJson],
  ['入口导出面', checkEntrySurface],
  ['配置面', checkConfig],
  ['快照', checkSnapshot],
  ['工具', checkTools],
  ['技能', checkSkill],
  ['文档', checkDocs],
  ['脚本', checkScripts],
]

for (const [label, run] of checks) {
  try {
    await run()
  } catch (error) {
    fail(label, error instanceof Error ? error.message : String(error))
  }
}

if (failures.length > 0) {
  console.error('✗ dsh-vibestart 自检未通过：')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exitCode = 1
} else {
  console.log(`✓ dsh-vibestart 自检通过（${notes.length} 项）`)
  for (const note of notes) console.log(`  ${note}`)
}
