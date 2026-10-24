/**
 * tests/catalog.test.mjs — 离线快照 + catalog + vibestart_stacks 的单元测试
 *
 * 原则：**不能只信自己的编码器**。所以完整性用「测试自己算一遍 sha256」、
 * 语义用「硬编码抽样 + 全域覆盖 + 数量断言」，另外在开发工作区里能读到
 * 上游原始输出（../vibestart-probe/list.json）时，再做一次逐条交叉校验。
 *
 * 纯 Node（node:test + node:assert/strict），不需要 DSH 运行时。
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  CATALOG_PATH,
  getKind,
  getKinds,
  lastCatalogError,
  loadCatalog,
  loadSnapshot,
  matchingStacks,
  nearestStacks,
  normalizeValues,
  summary,
} from '../lib/catalog/index.js'
import { createCodec, fromBase36, MAX_DOMAIN_SIZE, stacksDigest, toBase36 } from '../lib/catalog/encode.js'
import { KIND_LABELS, KIND_NOTES, KIND_ORDER } from '../lib/catalog/kinds.js'
import { assertToolSchemaDialect, validateSpecValue } from '../lib/plugin/schema.js'
import { createStacksTool } from '../lib/tools/stacks.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PROBE = resolve(ROOT, '..', 'vibestart-probe', 'list.json')

/** v0.1.1 的已知规模：上游发版时这里要跟着改（契约允许的「魔法数」）。 */
const EXPECTED_STACK_COUNT = 3409
const EXPECTED_KIND_COUNT = 15
const MAX_SNAPSHOT_BYTES = 300 * 1024

/**
 * 用给定 partial 补出全 15 位的 values：optional 缺省位 = ""（none），
 * required kind 缺省位取该 kind 的第一个合法取值（toolchain=vite-plus / testing=playwright）。
 */
function fullValues(partial = {}) {
  const values = {}
  for (const kind of snapshot.kinds) {
    values[kind.id] = kind.optional ? '' : snapshot.valueDomain[kind.id][0]
  }
  for (const [kind, value] of Object.entries(partial)) values[kind] = value
  return values
}

const snapshot = loadSnapshot()
const catalog = loadCatalog()

describe('快照文件与结构（不经过 catalog 的解码）', () => {
  test('文件存在、是 2 空格缩进的可读 JSON、体积 < 300KB', () => {
    const stat = statSync(CATALOG_PATH)
    assert.ok(stat.size > 0)
    assert.ok(stat.size < MAX_SNAPSHOT_BYTES, `快照 ${stat.size} 字节，超过 ${MAX_SNAPSHOT_BYTES} 上限`)
    const text = readFileSync(CATALOG_PATH, 'utf8')
    assert.ok(text.includes('\n  "stacks": {'), '应保持 2 空格缩进（不是压缩成一行）')
    assert.ok(text.endsWith('\n'), '文件应以单个换行结尾，方便 diff')
  })

  test('基础元信息：schemaVersion / cli / source / generatedAt', () => {
    assert.equal(snapshot.schemaVersion, 1)
    assert.deepEqual(snapshot.cli, { package: 'vibestart-cli', version: '0.1.1' })
    assert.match(snapshot.source, /^npx --yes vibestart-cli@0\.1\.1 --list --json$/)
    assert.match(snapshot.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    assert.deepEqual(snapshot.packageManagers, ['pnpm', 'bun'])
    assert.equal(snapshot.defaultPackageManager, 'pnpm')
    assert.deepEqual(snapshot.addons.map(addon => addon.id), ['knip', 'ultracite'])
    assert.ok(snapshot.addons.every(addon => addon.default === true))
  })

  test('kind 数与顺序：15 个 kind、顺序与 lib/catalog/kinds.js 完全一致', () => {
    assert.equal(snapshot.kinds.length, EXPECTED_KIND_COUNT)
    assert.equal(snapshot.kindOrder.length, EXPECTED_KIND_COUNT)
    assert.deepEqual(snapshot.kindOrder, [...KIND_ORDER])
    assert.deepEqual(snapshot.kinds.map(kind => kind.id), [...KIND_ORDER])
    assert.equal(snapshot.stacks.width, EXPECTED_KIND_COUNT)
  })

  test('valueDomain 可从 kinds 独立推导：required 无 ""，optional 的 "" 在最前', () => {
    assert.deepEqual(Object.keys(snapshot.valueDomain).sort(), [...KIND_ORDER].sort())
    for (const kind of snapshot.kinds) {
      const ids = kind.options.map(option => option.id)
      const expected = kind.optional ? ['', ...ids] : ids
      assert.deepEqual(snapshot.valueDomain[kind.id], expected, `${kind.id} 的 valueDomain 与 options 不一致`)
      // 同一 kind 的 option id 不能重复，否则编码会歧义
      assert.equal(new Set(ids).size, ids.length)
    }
  })

  test('3409 个组合：rows/labels/dateIndex 等长、行是定长 base36', () => {
    const { rows, labels, dates, dateIndex, width } = snapshot.stacks
    assert.equal(rows.length, EXPECTED_STACK_COUNT)
    assert.equal(labels.length, EXPECTED_STACK_COUNT)
    assert.equal(dateIndex.length, EXPECTED_STACK_COUNT)
    assert.equal(snapshot.integrity.stackCount, EXPECTED_STACK_COUNT)
    assert.ok(dates.length > 0 && dates.length < rows.length, 'dates 应去重（远少于组合数）')
    assert.ok(dates.every(date => !Number.isNaN(Date.parse(date))))

    for (const [index, row] of rows.entries()) {
      assert.equal(typeof row, 'string')
      assert.equal(row.length, width, `第 ${index} 行长度不是 ${width}`)
      assert.match(row, /^[0-9a-z]+$/, `第 ${index} 行含非法字符`)
      for (let position = 0; position < width; position += 1) {
        const digit = fromBase36(row[position])
        const domain = snapshot.valueDomain[snapshot.kindOrder[position]]
        assert.ok(digit < domain.length, `第 ${index} 行第 ${position} 位超出 ${domain.length} 个取值`)
      }
      assert.equal(typeof labels[index], 'string')
      assert.ok(labels[index].length > 0)
      assert.ok(Number.isInteger(dateIndex[index]) && dateIndex[index] >= 0 && dateIndex[index] < dates.length)
    }
    // 上游 label 本身唯一：如果出现重复，说明 rows 里可能有重复组合。
    assert.equal(new Set(labels).size, labels.length, 'labels 应全部唯一')
  })

  test('完整性：测试自己算 canonical stacks JSON 的 sha256，与 integrity 比对', () => {
    const { rows, labels, dates, dateIndex } = snapshot.stacks
    const canonical = JSON.stringify(rows.map((row, index) => [row, labels[index], dates[dateIndex[index]]]))
    const digest = createHash('sha256').update(canonical, 'utf8').digest('hex')
    assert.match(digest, /^[0-9a-f]{64}$/)
    assert.equal(digest, snapshot.integrity.sha256)
    // 同一份实现（verify/生成脚本用）也必须得到同一个值
    assert.equal(stacksDigest(snapshot.stacks), digest)
  })
})

describe('编解码：无损、双射、全域', () => {
  const codec = createCodec(snapshot.kindOrder, snapshot.valueDomain)

  test('base36 是 0–35 的双射，越界会报错', () => {
    for (let index = 0; index < MAX_DOMAIN_SIZE; index += 1) {
      assert.equal(fromBase36(toBase36(index)), index)
    }
    assert.throws(() => toBase36(36))
    assert.throws(() => toBase36(-1))
    assert.throws(() => fromBase36('!'))
    assert.throws(() => fromBase36('ab'))
  })

  test('每个 kind 的每个取值都能 encode → decode 还原（全域往返）', () => {
    for (const kind of KIND_ORDER) {
      for (const value of snapshot.valueDomain[kind]) {
        const values = fullValues({ [kind]: value })
        const row = codec.encodeRow(values)
        assert.equal(row.length, snapshot.stacks.width)
        assert.deepEqual(codec.decodeRow(row), values)
      }
    }
  })

  test('全量 rows 双向可逆：encode(decode(row)) === row', () => {
    for (const [index, row] of snapshot.stacks.rows.entries()) {
      const values = codec.decodeRow(row)
      assert.equal(codec.encodeRow(values), row, `第 ${index} 行往返不一致`)
      assert.equal(Object.keys(values).length, KIND_ORDER.length, '解码必须补齐全部 kind')
    }
  })

  test('解码后的 label / values / verifiedAt 与快照逐条对应', () => {
    const decoded = codec.decodeStacks(snapshot.stacks)
    assert.equal(decoded.length, EXPECTED_STACK_COUNT)
    for (const [index, stack] of decoded.entries()) {
      assert.equal(stack.label, snapshot.stacks.labels[index])
      assert.equal(stack.verifiedAt, snapshot.stacks.dates[snapshot.stacks.dateIndex[index]])
      assert.deepEqual(codec.encodeRow(stack.values), snapshot.stacks.rows[index])
    }
    // 3409 个组合必须互不重复（编码是双射，重复组合会让上面的 label 唯一性失效）
    const combos = new Set(decoded.map(stack => JSON.stringify(stack.values)))
    assert.equal(combos.size, decoded.length)
  })

  test('硬编码抽样：首条组合的每个 kind 取值都对得上', () => {
    const first = codec.decodeStacks(snapshot.stacks)[0]
    assert.equal(first.label, 'spa-hono-orpc-postgres-better-auth-electron-expo-docker')
    assert.equal(first.verifiedAt, '2026-10-23T02:19:59.004Z')
    assert.deepEqual(
      first.values,
      fullValues({
        toolchain: 'vite-plus',
        frontend: 'react',
        framework: 'spa',
        router: 'tanstack-router',
        backend: 'hono',
        api: 'orpc',
        database: 'postgres',
        orm: 'drizzle',
        auth: 'better-auth',
        ui: 'shadcn',
        desktop: 'electron',
        mobile: 'expo',
        runtime: 'node',
        deployment: 'docker',
        testing: 'playwright',
      }),
    )
  })

  test('硬编码抽样：最小栈 "expo" 只有 mobile 存在，其余 optional 全为 ""', () => {
    const expo = codec.decodeStacks(snapshot.stacks).find(stack => stack.label === 'expo')
    assert.ok(expo, '应存在 label 为 expo 的组合')
    assert.deepEqual(expo.values, fullValues({ toolchain: 'vite-plus', mobile: 'expo', testing: 'playwright' }))
    assert.equal(
      Object.values(expo.values).filter(value => value === '').length,
      12,
      '15 位里只有 3 位有值，其余 12 位应为 ""',
    )
  })

  test('全域覆盖：每个 kind 的每个声明取值都至少出现在一个合法组合里', () => {
    const decoded = codec.decodeStacks(snapshot.stacks)
    for (const kind of KIND_ORDER) {
      const used = new Set(decoded.map(stack => stack.values[kind]))
      for (const value of snapshot.valueDomain[kind]) {
        assert.ok(used.has(value), `${kind}=${value || '(none)'} 没有出现在任何合法组合中`)
      }
    }
    // 每个 optional kind 都必须能「不选」，否则工具给的 none 提示是假的
    for (const kind of snapshot.kinds.filter(item => item.optional)) {
      const used = new Set(decoded.map(stack => stack.values[kind.id]))
      assert.ok(used.has(''), `optional kind ${kind.id} 没有任何一个组合是 none`)
    }
  })

  test('required kind 在每条组合里都非空', () => {
    const decoded = codec.decodeStacks(snapshot.stacks)
    for (const kind of snapshot.kinds.filter(item => !item.optional)) {
      for (const stack of decoded) {
        assert.notEqual(stack.values[kind.id], '', `${kind.id} 是 required，但 ${stack.label} 里为空`)
      }
    }
  })

  test('编码器拒绝坏输入：缺位 / 未知取值 / 超出 36 个取值', () => {
    assert.throws(() => codec.encodeRow({ toolchain: 'vite-plus' }), /编码缺少 kind/)
    assert.throws(() => codec.encodeRow(fullValues({ framework: 'oracle' })), /不在 valueDomain 内/)
    assert.throws(() => codec.decodeRow('0'.repeat(KIND_ORDER.length - 1)), /长度必须是/)
    assert.throws(() => codec.decodeRow('z'.repeat(KIND_ORDER.length)), /只有/)
    const tooMany = { ...snapshot.valueDomain, framework: Array.from({ length: 37 }, (_, i) => `f${i}`) }
    assert.throws(() => createCodec(snapshot.kindOrder, tooMany), /超过单字符 base36/)
  })
})

describe('catalog 视图与 summary', () => {
  test('summary 的数字与快照一致', () => {
    const info = summary()
    assert.equal(info.kindCount, EXPECTED_KIND_COUNT)
    assert.equal(info.stackCount, EXPECTED_STACK_COUNT)
    assert.equal(info.cliVersion, '0.1.1')
    assert.equal(info.kindOrder.length, EXPECTED_KIND_COUNT)
    assert.equal(info.kinds.length, EXPECTED_KIND_COUNT)
    assert.equal(info.kinds[0].id, 'toolchain')
    assert.equal(info.kinds.at(-1).id, 'testing')
  })

  test('loadCatalog 按 mtime 记忆化：多次调用返回同一引用，且是只读的', () => {
    assert.ok(catalog, `快照不可用：${lastCatalogError()}`)
    assert.equal(loadCatalog(), catalog)
    assert.equal(lastCatalogError(), null)
    assert.ok(Object.isFrozen(catalog))
    assert.ok(Object.isFrozen(catalog.kinds))
    assert.ok(Object.isFrozen(catalog.stacks))
    assert.ok(Object.isFrozen(catalog.stacks[0]))
    assert.ok(Object.isFrozen(catalog.stacks[0].values))
    assert.ok(Object.isFrozen(catalog.valueDomain.framework))
    // 冻结是**深**的：改任何一层都抛 TypeError（严格模式下）。
    assert.throws(() => {
      catalog.stacks[0].values.toolchain = 'tampered'
    }, TypeError)
    assert.throws(() => {
      catalog.kinds.push({ id: 'x' })
    }, TypeError)
  })

  test('Catalog 附带与模块级同语义的查询函数（供 plan 依赖注入）', () => {
    assert.equal(typeof catalog.matchingStacks, 'function')
    assert.equal(typeof catalog.nearestStacks, 'function')
    const viaCatalog = catalog.matchingStacks({ framework: 'spa' }, 2)
    const viaModule = matchingStacks({ framework: 'spa' }, 2)
    assert.equal(viaCatalog.count, viaModule.count)
    assert.deepEqual(viaCatalog.sample.map(stack => stack.label), viaModule.sample.map(stack => stack.label))
    assert.equal(catalog.nearestStacks({ framework: 'spa' })[0].distance, 0)

    // 绑定语义：方法调用时查的是**调用者自己**的 stacks，所以把裁剪过的 catalog
    // 注入给 plan 时不会偷偷回落到磁盘上的全量快照。
    const fake = { ...catalog, stacks: catalog.stacks.slice(0, 3), stackCount: 3 }
    assert.equal(fake.matchingStacks({}, 10).count, 3)
    assert.equal(fake.nearestStacks({}, 10).length, 3)
    // 摘下来当普通函数用（丢失 this）时退回模块单例，行为与模块级导出一致。
    const { matchingStacks: detached } = catalog
    assert.equal(detached({ framework: 'spa' }, 1).count, matchingStacks({ framework: 'spa' }, 1).count)
  })

  test('getKinds / getKind 与快照 kinds 一致；未知 id 返回 undefined', () => {
    assert.equal(getKinds().length, EXPECTED_KIND_COUNT)
    assert.deepEqual(getKinds().map(kind => kind.id), [...KIND_ORDER])
    const database = getKind('database')
    assert.equal(database.optional, true)
    assert.deepEqual(database.options.map(option => option.id), ['postgres', 'mysql', 'sqlite', 'mongodb'])
    assert.equal(getKind('nope'), undefined)
    assert.equal(KIND_LABELS.database, '数据库')
    assert.ok(KIND_NOTES.testing.length > 0)
  })

  test('normalizeValues：none 归一、别名、未知 kind/取值都会进 unknown', () => {
    const normalized = normalizeValues({ framework: 'none', db: 'sqlite', nope: 'x', orm: 'oracle' })
    assert.equal(normalized.values.framework, '')
    assert.equal(normalized.values.database, 'sqlite', 'db 是 database 的别名')
    assert.equal(normalized.values.orm, undefined, '非法取值不应进入 values')
    assert.deepEqual(
      normalized.unknown.map(item => `${item.kind}=${item.value}`).sort(),
      ['nope=x', 'orm=oracle'],
    )
  })
})

describe('matchingStacks：固定 / 补全 / 未知值', () => {
  test('空请求 = 全部 3409 个组合，perKindOptions 覆盖每个 kind 的完整取值域', () => {
    const result = matchingStacks({})
    assert.equal(result.count, EXPECTED_STACK_COUNT)
    assert.equal(result.sample.length, 5)
    assert.deepEqual(result.unknown, [])
    for (const kind of KIND_ORDER) {
      assert.deepEqual(result.perKindOptions[kind], snapshot.valueDomain[kind], `${kind} 的可选值应等于完整取值域`)
    }
  })

  test('固定两个 kind：计数正确，样本确实都满足条件', () => {
    const result = matchingStacks({ framework: 'spa', database: 'sqlite' }, 3)
    assert.ok(result.count > 0 && result.count < EXPECTED_STACK_COUNT)
    assert.equal(result.sample.length, 3)
    for (const stack of result.sample) {
      assert.equal(stack.values.framework, 'spa')
      assert.equal(stack.values.database, 'sqlite')
      assert.ok(stack.label.length > 0)
      assert.ok(!Number.isNaN(Date.parse(stack.verifiedAt)))
    }
    // perKindOptions 必须与固定值相容
    assert.ok(result.perKindOptions.framework.includes('spa'))
    assert.ok(result.perKindOptions.database.includes('sqlite'))
    // 固定值仍出现在每个样本里
    for (const stack of result.sample) {
      for (const [kind, value] of Object.entries({ framework: 'spa', database: 'sqlite' })) {
        assert.equal(stack.values[kind], value)
      }
    }
  })

  test('按 kind 的取值分区：某个 kind 各取值的计数之和 = 总组合数', () => {
    for (const kind of ['framework', 'database', 'deployment']) {
      let sum = 0
      for (const value of snapshot.valueDomain[kind]) {
        sum += matchingStacks({ [kind]: value }, 0).count
      }
      assert.equal(sum, EXPECTED_STACK_COUNT, `${kind} 的取值计数之和应等于组合总数`)
    }
  })

  test('none 与空串等价："database=none" 与 { database: "" } 结果相同', () => {
    const viaNone = matchingStacks({ database: 'none' })
    const viaEmpty = matchingStacks({ database: '' })
    assert.equal(viaNone.count, viaEmpty.count)
    assert.ok(viaNone.count > 0)
    assert.ok(viaNone.sample.every(stack => stack.values.database === ''))
  })

  test('未知 kind 与未知取值：不崩、计数按已知部分算、unknown 报告问题', () => {
    const unknownKind = matchingStacks({ nope: 'x' })
    assert.equal(unknownKind.count, EXPECTED_STACK_COUNT)
    assert.deepEqual(unknownKind.unknown, [{ kind: 'nope', value: 'x' }])

    const unknownValue = matchingStacks({ framework: 'oracle' })
    assert.equal(unknownValue.count, EXPECTED_STACK_COUNT, '唯一一个无效值不影响其余过滤')
    assert.deepEqual(unknownValue.unknown, [{ kind: 'framework', value: 'oracle' }])

    const mixed = matchingStacks({ framework: 'spa', database: 'oracle' })
    assert.deepEqual(mixed.unknown, [{ kind: 'database', value: 'oracle' }])
    assert.equal(mixed.count, matchingStacks({ framework: 'spa' }).count)
  })

  test('limit：默认 5、可调、0 表示只要计数、非法值退回默认', () => {
    assert.equal(matchingStacks({}).sample.length, 5)
    assert.equal(matchingStacks({}, 2).sample.length, 2)
    assert.equal(matchingStacks({}, 0).sample.length, 0)
    assert.equal(matchingStacks({}, Number.NaN).sample.length, 5)
    assert.equal(matchingStacks({}, 1.9).sample.length, 1)
  })

  test('返回的是副本：改样本不会污染 catalog', () => {
    const result = matchingStacks({ framework: 'spa' }, 1)
    const label = result.sample[0].label
    result.sample[0].values.framework = 'tampered'
    result.sample[0].label = 'tampered'
    const fresh = matchingStacks({ framework: 'spa' }, 1)
    assert.equal(fresh.sample[0].label, label)
    assert.equal(fresh.sample[0].values.framework, 'spa')
  })
})

describe('nearestStacks：距离与 diffs 排序', () => {
  const codec = createCodec(snapshot.kindOrder, snapshot.valueDomain)
  const decoded = codec.decodeStacks(snapshot.stacks)

  test('精确命中：distance 0、diffs 为空', () => {
    const target = decoded[0]
    const [best] = nearestStacks(target.values, 1)
    assert.equal(best.distance, 0)
    assert.deepEqual(best.diffs, [])
    assert.equal(best.label, target.label)
    assert.equal(best.verifiedAt, target.verifiedAt)
    assert.deepEqual(best.values, target.values)
  })

  test('单个非法取值：最近组合距离为 1，diff 指出 from/to', () => {
    const [best] = nearestStacks({ database: 'oracle', framework: 'spa' }, 1)
    assert.equal(best.distance, 1)
    assert.deepEqual(best.diffs, [{ kind: 'database', from: 'oracle', to: best.values.database }])
    assert.equal(best.values.framework, 'spa')
    assert.notEqual(best.values.database, 'oracle')
  })

  test('省略的 kind 不算距离（通配），结果全部 distance 0', () => {
    const results = nearestStacks({ framework: 'spa', database: 'sqlite' }, 3)
    assert.equal(results.length, 3)
    assert.ok(results.every(item => item.distance === 0))
    assert.ok(results.every(item => item.diffs.length === 0))
  })

  test('距离升序 + diffs 按 kindOrder 排序 + 结果稳定', () => {
    const values = {
      toolchain: 'vite-plus',
      frontend: 'react',
      framework: 'next',
      router: 'tanstack-router',
      backend: 'self',
      api: 'openapi',
      database: 'mongodb',
      orm: 'mongoose',
      deployment: 'void',
      testing: 'playwright',
    }
    const results = nearestStacks(values, 5)
    assert.equal(results.length, 5)
    for (let index = 1; index < results.length; index += 1) {
      assert.ok(results[index].distance >= results[index - 1].distance, '必须按距离升序')
    }
    const positions = new Map(KIND_ORDER.map((kind, index) => [kind, index]))
    for (const item of results) {
      for (let index = 1; index < item.diffs.length; index += 1) {
        assert.ok(positions.get(item.diffs[index - 1].kind) < positions.get(item.diffs[index].kind), 'diffs 必须按 kindOrder 排序')
      }
      assert.equal(item.distance, item.diffs.length, 'distance 就是 diffs 的条数')
      for (const diff of item.diffs) {
        assert.equal(diff.to, item.values[diff.kind])
        assert.notEqual(diff.from, diff.to)
      }
    }
    // 同输入两次调用结果完全一致（不依赖 sort 稳定性）
    assert.deepEqual(nearestStacks(values, 5), results)
  })

  test('k 的钳制：默认 3、非法值退回 3、0 返回空数组', () => {
    assert.equal(nearestStacks({ framework: 'spa' }).length, 3)
    assert.equal(nearestStacks({ framework: 'spa' }, Number.NaN).length, 3)
    assert.equal(nearestStacks({ framework: 'spa' }, 0).length, 0)
    assert.equal(nearestStacks({ framework: 'spa' }, 2.7).length, 2)
  })
})

describe('vibestart_stacks 工具（工厂 + 纯 Node）', () => {
  const tool = createStacksTool({ config: { maxStacks: 5 } })
  const schema = tool.output.schema

  test('SchemaSpec 方言合规，且是工厂函数产物', () => {
    assert.equal(tool.name, 'vibestart_stacks')
    assert.deepEqual(assertToolSchemaDialect(tool), [])
    assert.equal(tool.isConcurrencySafe(), true)
    assert.ok(tool.timeoutMs > 0)
    assert.deepEqual(Object.keys(tool.parameters).sort(), ['kind', 'limit', 'stack'])
  })

  test('description 用中文讲清「离线、不联网、只读」与 vibestart_plan 的分工', () => {
    for (const keyword of ['离线', '不联网', '只读', 'vibestart_plan', '不执行任何命令', '15 个 kind', '3409']) {
      assert.ok(tool.description.includes(keyword), `description 缺少「${keyword}」`)
    }
  })

  test('无参数 → 总览：kind 数、组合数、每个 kind 的选项摘要', async () => {
    const value = await tool.execute({})
    assert.deepEqual(validateSpecValue(schema, value), [])
    assert.equal(value.cliVersion, '0.1.1')
    assert.equal(value.kindCount, EXPECTED_KIND_COUNT)
    assert.equal(value.stackCount, EXPECTED_STACK_COUNT)
    assert.equal(value.kindOrder.length, EXPECTED_KIND_COUNT)
    assert.equal(value.kinds.length, EXPECTED_KIND_COUNT)
    assert.equal(value.match, null)
    assert.deepEqual(value.unknown, [])
    for (const kind of value.kinds) {
      assert.ok(kind.options.length > 0)
      assert.ok(kind.options.every(option => option.legalCount === undefined), '总览不逐个算 legalCount')
    }
  })

  test('kind 模式：options 的 legalCount 之和 = stackCount（optional 含 none 桶）', async () => {
    for (const kind of KIND_ORDER) {
      const value = await tool.execute({ kind })
      assert.deepEqual(validateSpecValue(schema, value), [], `${kind} 的输出不符合 schema`)
      assert.equal(value.kinds.length, 1)
      const listed = value.kinds[0]
      assert.equal(listed.id, kind)
      const sum = listed.options.reduce((total, option) => total + option.legalCount, 0)
      assert.equal(sum, EXPECTED_STACK_COUNT, `${kind} 的 legalCount 之和应等于组合总数`)
      const declared = snapshot.kinds.find(item => item.id === kind)
      if (declared.optional) {
        assert.equal(listed.options[0].id, '', 'optional kind 的 none 桶应排在最前')
        assert.equal(listed.options[0].legalCount, matchingStacks({ [kind]: '' }, 0).count)
      }
    }
  })

  test('stack 模式：与 matchingStacks 同源，样本与 perKindOptions 可用', async () => {
    const value = await tool.execute({ stack: 'framework=spa, database=sqlite', limit: 3 })
    assert.deepEqual(validateSpecValue(schema, value), [])
    assert.ok(value.match)
    const expected = matchingStacks({ framework: 'spa', database: 'sqlite' }, 3)
    assert.equal(value.match.legalCount, expected.count)
    assert.equal(value.match.sample.length, 3)
    assert.deepEqual(value.match.requested, { framework: 'spa', database: 'sqlite' })
    assert.deepEqual(Object.keys(value.match.perKindOptions).sort(), Object.keys(expected.perKindOptions).sort())
    for (const item of value.match.sample) {
      assert.equal(item.stack.framework, 'spa')
      assert.equal(item.stack.database, 'sqlite')
      assert.equal(typeof item.label, 'string')
      assert.equal(typeof item.verifiedAt, 'string')
    }
    assert.deepEqual(value.unknown, [])
  })

  test('limit 钳制到 1–8；缺省用 config.maxStacks', async () => {
    assert.equal((await tool.execute({ stack: 'framework=spa', limit: 99 })).match.sample.length, 8)
    assert.equal((await tool.execute({ stack: 'framework=spa', limit: 0 })).match.sample.length, 1)
    const two = createStacksTool({ config: { maxStacks: 2 } })
    assert.equal((await two.execute({ stack: 'framework=spa' })).match.sample.length, 2)
    const fallback = createStacksTool({})
    assert.equal((await fallback.execute({ stack: 'framework=spa' })).match.sample.length, 5)
  })

  test('未知 kind / 未知取值：不抛错，进 unknown，其余照常返回', async () => {
    const unknownKind = await tool.execute({ kind: 'nope' })
    assert.deepEqual(validateSpecValue(schema, unknownKind), [])
    assert.ok(unknownKind.unknown.length > 0)
    assert.equal(unknownKind.kinds.length, EXPECTED_KIND_COUNT, '未知 kind 退回总览')

    const unknownValue = await tool.execute({ stack: 'framework=oracle,database=sqlite' })
    assert.deepEqual(validateSpecValue(schema, unknownValue), [])
    assert.deepEqual(unknownValue.unknown.map(item => item.kind), ['framework'])
    // 已知部分仍参与过滤
    assert.ok(unknownValue.match.sample.every(item => item.stack.database === 'sqlite'))

    const badSyntax = await tool.execute({ stack: 'spa,sqlite' })
    assert.ok(badSyntax.unknown.some(item => item.reason.includes('kind=value')))
  })

  test('render：三种模式都能出中文文本，且对坏数据不抛错', async () => {
    const cases = [
      {},
      { kind: 'database' },
      { stack: 'framework=spa, database=sqlite' },
      { stack: 'framework=oracle' },
      { kind: 'nope' },
      { stack: 'spa,sqlite' },
    ]
    for (const args of cases) {
      const value = await tool.execute(args)
      const parts = tool.output.render(args, value)
      assert.ok(Array.isArray(parts) && parts.length > 0)
      assert.equal(parts[0].type, 'text')
      assert.ok(parts[0].text.length > 0)
      assert.match(parts[0].text, /VibeStart/)
    }
    // 缺数据时降级成一句话，不抛错
    const degraded = tool.output.render({}, {})
    assert.equal(degraded[0].type, 'text')
    assert.ok(degraded[0].text.length > 0)
    // 空栈模式的建议里要出现 vibestart_plan
    const overview = await tool.execute({})
    assert.ok(tool.output.render({}, overview)[0].text.includes('vibestart_plan'))
  })
})

describe('上游交叉校验（开发工作区有 vibestart-probe/list.json 时才跑）', () => {
  test('解码结果与上游原始 --list 输出逐条一致（3409/3409）', t => {
    if (!existsSync(PROBE)) {
      t.skip('没有 ../vibestart-probe/list.json（发布包里不包含探针数据）')
      return
    }
    const raw = readFileSync(PROBE, 'utf8')
    const start = raw.indexOf('{')
    assert.ok(start > 0, '探针文件应带 Node 警告前缀')
    const upstream = JSON.parse(raw.slice(start))
    assert.equal(upstream.stacks.length, EXPECTED_STACK_COUNT)

    const codec = createCodec(snapshot.kindOrder, snapshot.valueDomain)
    const decoded = codec.decodeStacks(snapshot.stacks)
    assert.equal(decoded.length, upstream.stacks.length)

    for (const [index, expected] of upstream.stacks.entries()) {
      const actual = decoded[index]
      assert.equal(actual.label, expected.label, `第 ${index} 条 label 不一致`)
      assert.equal(actual.verifiedAt, expected.verifiedAt, `第 ${index} 条 verifiedAt 不一致`)
      for (const kind of KIND_ORDER) {
        assert.equal(
          actual.values[kind],
          expected.stack[kind] ?? '',
          `第 ${index} 条（${expected.label}）的 ${kind} 不一致`,
        )
      }
      // 上游 stack 对象里不应该出现未知 kind（出现了说明 kinds.js 需要更新）
      for (const kind of Object.keys(expected.stack)) {
        assert.ok(KIND_ORDER.includes(kind), `上游出现未知 kind：${kind}`)
      }
    }
    // 上游 kinds 的 options 与我们的 valueDomain 也必须一致
    for (const kind of upstream.kinds) {
      const ids = kind.options.map(option => option.id)
      assert.deepEqual(snapshot.valueDomain[kind.id], kind.optional ? ['', ...ids] : ids)
    }
  })
})
