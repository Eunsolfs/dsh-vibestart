/**
 * tools/stacks.js — `vibestart_stacks` 工具定义（契约 §8.1）
 *
 * 纯离线、只读、不联网：回答「VibeStart 能选什么 / 我的部分栈有多少合法补全」。
 * 它**不**生成命令、也不执行任何命令——那是 `vibestart_plan`（生成 + 校验）与
 * `vibestart_run`（经 ctx.shell 受控执行）的职责。分工写进 description 里，
 * 避免模型拿本工具当「执行器」或反过来用 plan 查目录。
 *
 * 工厂函数形态（契约 §8）：`createStacksTool({ config })`，由 lib/tools/index.js
 * 在 apply() 时装配。这样测试可以完全脱离 DSH 运行时。
 */

import { DEFAULT_MAX_STACKS, TIMEOUTS } from '../config.js'
import {
  CATALOG_PATH,
  capabilitySummaryZh,
  kindLabel,
  lastCatalogError,
  loadCatalog,
  matchingStacks,
  normalizeValues,
} from '../catalog/index.js'
import { kindNote } from '../catalog/kinds.js'
import { parseStackInput } from '../parse-stack.js'
import { bullet, heading, inlineCode, join, kv, table } from '../presentation/markdown.js'
import { array, integer, text } from '../plugin/schema.js'

/** 单个 kind 的合法组合数会出现在 options[].legalCount；summary 里不出现。 */
const MAX_LIMIT = 8

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** limit 在 execute 内钳制（SchemaSpec 方言不支持 minimum/maximum）。 */
function clampLimit(value, fallback) {
  const base = Number.isInteger(value) ? value : fallback
  return Math.min(MAX_LIMIT, Math.max(1, base))
}

function normalizeMaxStacks(value) {
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_STACKS
}

/** 值 → 线上语法里的展示（"" 显示成 none，和 --<kind> none 一致）。 */
function displayValue(value) {
  return value === '' ? 'none' : value
}

/** 把归一后的 values 序列化成 §8.0 的 kind=value 串（按 kindOrder）。 */
function serializeStack(values, kindOrder) {
  return kindOrder
    .filter(kind => Object.hasOwn(values, kind))
    .map(kind => `${kind}=${displayValue(values[kind])}`)
    .join(', ')
}

/** 数一数有多少合法组合在某个 kind 上取某个值（kind 模式的 legalCount）。 */
function countLegal(catalog, kind, value) {
  let count = 0
  for (const stack of catalog.stacks) {
    if (stack.values[kind] === value) count += 1
  }
  return count
}

const DESCRIPTION =
  `离线查询 VibeStart 全栈 TypeScript 脚手架的目录（${capabilitySummaryZh()}），不联网、不执行任何命令、只读：` +
  '无参数时给出 15 个 kind 与各自选项的总览；给 kind 时列出该 kind 的每个选项及其合法组合数；' +
  '给 stack（如 "framework=spa,backend=hono,database=sqlite"）时做**部分栈的合法补全**，' +
  '返回匹配数量、样本组合与每个 kind 的剩余可选值。' +
  '本工具只负责「能选什么」；要校验栈并生成可直接执行的命令，下一步用 vibestart_plan' +
  '（默认带 --dry-run --json 只预览），真正写盘再用 vibestart_run。'

/**
 * 创建 `vibestart_stacks` 工具规格。
 * @param {{config?: {maxStacks?: number}}} [deps]
 */
export function createStacksTool(deps = {}) {
  const config = isPlainObject(deps.config) ? deps.config : {}
  const maxStacks = normalizeMaxStacks(config.maxStacks)

  return {
    name: 'vibestart_stacks',
    description: DESCRIPTION,
    timeoutMs: TIMEOUTS.stacks,
    isConcurrencySafe: () => true,
    parameters: {
      kind: text(
        '单个 kind id（如 database、framework、deployment）→ 列出该 kind 的选项与「含该选项的合法组合数」。' +
          `可用的 kind：${loadCatalog()?.kindOrder.join('、') ?? 'toolchain、frontend、framework、router、backend、api、database、orm、auth、ui、desktop、mobile、runtime、deployment、testing'}。`,
      ),
      stack: text(
        '部分栈，语法 kind=value，用逗号或分号分隔（如 "framework=spa,backend=hono,database=sqlite"）；' +
          '可只写想固定的 kind，其余由已校验组合自动补全；optional kind 写 none 表示不选。',
      ),
      limit: integer(`样本条数，1–8，默认 ${maxStacks}（超出会被钳制）。`),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cliVersion: text('快照对应的 vibestart-cli 版本。', true),
          kindOrder: array({ type: 'string' }, 'kind 的规范顺序（栈位顺序）。', true),
          kindCount: integer('kind 数量。', true),
          stackCount: integer('已校验的合法组合总数。', true),
          kinds: array(
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                optional: { type: 'boolean' },
                options: array(
                  {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      id: { type: 'string' },
                      name: { type: 'string' },
                      description: { type: 'string' },
                      legalCount: { type: 'integer' },
                    },
                  },
                  '该 kind 的取值；kind 模式下 optional kind 会多出 id=""（none）一项，并带 legalCount。',
                ),
              },
            },
            'kind 列表（无 kind 参数时是总览，有 kind 参数时只含该 kind）。',
            true,
          ),
          match: {
            oneOf: [
              { type: 'null' },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  requested: { type: 'object', additionalProperties: true, description: '归一后的请求（kind → 取值，"" 表示 none）。' },
                  legalCount: { type: 'integer' },
                  sample: array(
                    {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        label: { type: 'string' },
                        stack: { type: 'object', additionalProperties: true },
                        verifiedAt: { type: 'string' },
                      },
                    },
                    '命中组合的样本（最多 limit 条）。',
                  ),
                  perKindOptions: { type: 'object', additionalProperties: true, description: '每个 kind 在命中集合里仍可取的取值（按 valueDomain 顺序）。' },
                },
              },
            ],
          },
          unknown: array(
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string' },
                value: { type: 'string' },
                reason: { type: 'string' },
              },
            },
            '无法识别的 kind / 取值 / 语法片段；为空表示请求全部被理解。',
            true,
          ),
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: renderStacks(_args, value) }]
      },
    },
    /**
     * 纯内存查询。不观察 exec.signal（无 I/O）。
     * @param {{kind?: string, stack?: string, limit?: number}} [args]
     */
    async execute(args = {}) {
      const catalog = loadCatalog()
      if (!catalog) {
        throw new Error(
          `VibeStart 离线快照不可用：${lastCatalogError() ?? CATALOG_PATH}。` +
            '请重装插件或运行 node scripts/snapshot.mjs 重建快照；本工具不联网，无法兜底。',
        )
      }

      const limit = clampLimit(args.limit, maxStacks)
      const kindId = typeof args.kind === 'string' ? args.kind.trim().toLowerCase() : ''
      const stackText = typeof args.stack === 'string' ? args.stack.trim() : ''

      /** @type {{kind: string, value: string, reason: string}[]} */
      const unknown = []

      /** 选中的 kind（kind 模式）；未知 kind 不抛错，退回总览并把问题写进 unknown。 */
      let selectedKind = null
      if (kindId) {
        selectedKind = catalog.kinds.find(kind => kind.id === kindId) ?? null
        if (!selectedKind) {
          unknown.push({
            kind: kindId,
            value: '',
            reason: `未知 kind；可用：${catalog.kindOrder.join(', ')}`,
          })
        }
      }

      let match = null
      if (stackText) {
        const parsed = parseStackInput(stackText)
        for (const item of parsed.unknown) {
          unknown.push({
            kind: item.kind,
            value: item.value,
            reason: '语法无法解析：片段应为 kind=value',
          })
        }
        // 归一放到 catalog 层做（与 plan 共用同一份「值 → 合法域」判断）。
        const normalized = normalizeValues(parsed.values)
        for (const item of normalized.unknown) {
          unknown.push({
            kind: item.kind,
            value: item.value,
            reason: 'catalog 中没有这个 kind 或该取值',
          })
        }
        const result = matchingStacks(normalized.values, limit)
        match = {
          requested: { ...normalized.values },
          legalCount: result.count,
          sample: result.sample.map(stack => ({
            label: stack.label,
            stack: { ...stack.values },
            verifiedAt: stack.verifiedAt,
          })),
          perKindOptions: result.perKindOptions,
        }
      }

      const kinds = (selectedKind ? [selectedKind] : catalog.kinds).map(kind => {
        const options = kind.options.map(option => ({
          id: option.id,
          name: option.name,
          description: option.description,
        }))
        if (selectedKind) {
          for (const option of options) option.legalCount = countLegal(catalog, kind.id, option.id)
          // optional kind 的「不选」也是合法取值：补一项 id=""（= none），
          // 这样 legalCount 加起来正好等于 stackCount，模型不会误以为还有隐藏组合。
          if (kind.optional) {
            options.unshift({
              id: '',
              name: 'None（不选）',
              description: '该 kind 可省略；命令行里写 --<kind> none',
              legalCount: countLegal(catalog, kind.id, ''),
            })
          }
        }
        return { id: kind.id, name: kind.name, optional: kind.optional, options }
      })

      return {
        cliVersion: catalog.cliVersion,
        kindOrder: [...catalog.kindOrder],
        kindCount: catalog.kindOrder.length,
        stackCount: catalog.stackCount,
        kinds,
        match,
        unknown,
      }
    },
  }
}

/**
 * 工具结果的 Markdown 渲染（纯函数、绝不抛错；数据缺失时降级成一句话）。
 * @param {{kind?: string, stack?: string}} args
 * @param {object} value
 * @returns {string}
 */
function renderStacks(args, value) {
  if (!isPlainObject(value) || !Array.isArray(value.kinds)) {
    return 'VibeStart 离线目录暂无数据；请重装插件或重跑 scripts/snapshot.mjs。'
  }
  const parts = []
  const kindId = typeof args?.kind === 'string' ? args.kind.trim().toLowerCase() : ''
  const stackText = typeof args?.stack === 'string' ? args.stack.trim() : ''

  parts.push(heading('VibeStart 离线目录（不联网、只读）', 2))
  const kindSummary = kindId && value.kinds.length === 1
    ? `${value.kindCount} 个（当前只看 ${kindId}）`
    : `${value.kindCount} 个`
  parts.push(
    kv([
      ['CLI', `vibestart-cli ${value.cliVersion}`],
      ['kind', kindSummary],
      ['已校验组合', `${value.stackCount} 个`],
    ]),
  )

  if (value.match) {
    const match = value.match
    parts.push(heading(match.legalCount > 0 ? `匹配结果：${match.legalCount} 个合法组合` : '匹配结果：没有合法组合', 3))
    const requested = serializeStack(match.requested ?? {}, value.kindOrder ?? [])
    parts.push(kv([['请求', requested || '（空）']]))

    if (match.sample?.length > 0) {
      parts.push(
        table(
          ['样本组合', '校验时间'],
          match.sample.map(stack => [stack.label, stack.verifiedAt]),
        ),
      )
    } else {
      parts.push(
        '没有完全匹配的组合。把同一份栈交给 `vibestart_plan`，它会返回最近的合法组合与最小改动（diffs），' +
          '并生成可执行命令。',
      )
    }

    const perKind = Object.entries(match.perKindOptions ?? {})
    if (perKind.length > 0) {
      parts.push(heading('每个 kind 仍可取的取值', 3))
      parts.push(bullet(perKind.map(([kind, values]) => `${kindLabel(kind)}（${kind}）：${values.map(displayValue).join(' / ')}`)))
    }
    if (match.legalCount > 0 && match.sample?.[0]) {
      parts.push(`**下一步**：把完整栈 ${inlineCode(serializeStack(match.sample[0].stack, value.kindOrder ?? []))} 交给 \`vibestart_plan\`，生成可直接执行的 \`npx vibestart-cli\` 命令（默认 \`--dry-run --json\`，只预览不写盘）。`)
    }
  } else if (kindId && value.kinds.length === 1) {
    const kind = value.kinds[0]
    parts.push(heading(`${kindLabel(kind.id)}（${kind.id}）`, 3))
    if (kind.optional) parts.push(kv([['可省略', '是（none 表示不选）']]))
    parts.push(
      table(
        ['取值', '名称', '合法组合数', '说明'],
        kind.options.map(option => [
          option.id === '' ? 'none' : option.id,
          option.name,
          option.legalCount ?? '—',
          option.description,
        ]),
      ),
    )
    const note = kindNote(kind.id)
    if (note) parts.push(note)
    parts.push('**下一步**：把要固定的取值拼成 `kind=value` 传给 `vibestart_plan`，即可校验并生成命令。')
  } else {
    parts.push(heading('全部 kind 与选项', 3))
    parts.push(
      table(
        ['kind', '名称', '可省略', '选项'],
        value.kinds.map(kind => [
          kind.id,
          kindLabel(kind.id),
          kind.optional ? '是' : '否',
          kind.options.map(option => option.id).join('、'),
        ]),
      ),
    )
    parts.push(
      '**下一步**：传 `stack`（如 `framework=spa,database=sqlite`）看合法补全，' +
        '再把选定的栈交给 `vibestart_plan` 生成 `npx vibestart-cli` 命令；本工具不联网、不执行任何命令。',
    )
  }

  if (value.unknown?.length > 0) {
    parts.push(heading('需要修正的输入', 3))
    parts.push(
      bullet(
        value.unknown.map(item =>
          `${item.kind}${item.value === '' ? '' : `=${item.value}`}：${item.reason ?? '无法识别'}`,
        ),
      ),
    )
  }

  return join(parts)
}
