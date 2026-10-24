/**
 * tools/plan.js — `vibestart_plan` 工具规格（契约 §8.2）
 *
 * 纯计算：解析模型给的栈字符串 → planStack 校验/补全/最近合法 → 给出可执行命令。
 * 目录与 catalog 都由 deps 注入，因此测试不需要 DSH 运行时。
 */

import { CLI_COMMANDS, DEFAULT_CLI_VERSION, DEFAULT_RUNNER, TIMEOUTS } from '../config.js'
import { parseStackInput, planStack } from '../plan/index.js'
import { bullet, code, heading, inlineCode, join, kv, table } from '../presentation/markdown.js'
import { array, boolean, integer, object, stringEnum, text } from '../plugin/schema.js'

const PLAN_STATUSES = Object.freeze(['legal', 'illegal', 'incomplete', 'invalid'])
const PACKAGE_MANAGERS = Object.freeze(['pnpm', 'bun'])

const STATUS_LABELS = Object.freeze({
  legal: '合法',
  illegal: '不合法',
  incomplete: '待补全',
  invalid: '输入无效',
})

/** 子对象 schema：字段都是可缺省的（方言不允许 items 内 required）。 */
const stackValuesSchema = object({}, { additionalProperties: true, description: 'kind → 取值（"" 表示 none）' })

const fixSchema = object(
  {
    label: text('上游组合 label'),
    values: stackValuesSchema,
    verifiedAt: text('该校验组合的校验时间'),
    distance: integer('与请求栈的差异个数'),
    diffs: array(
      object({
        kind: text('kind id'),
        from: text('请求值'),
        to: text('合法值'),
      }),
      '最小改动列表',
    ),
    command: text('可直接预览的命令'),
  },
  { additionalProperties: false },
)

const completionSchema = object(
  {
    label: text('上游组合 label'),
    values: stackValuesSchema,
    verifiedAt: text('校验时间'),
    command: text('可直接预览的命令'),
  },
  { additionalProperties: false },
)

const unknownSchema = object(
  {
    kind: text('kind 或参数名'),
    value: text('非法取值'),
  },
  { additionalProperties: false },
)

const outputSchema = object(
  {
    status: stringEnum(PLAN_STATUSES, '四态之一', true),
    ok: boolean('legal 或 incomplete 为 true', true),
    command: text('可执行命令；incomplete 时只包含已显式选择', true),
    resolved: object({}, { additionalProperties: true, description: '归一后的输入栈', required: true }),
    missing: array(text('kind id'), '缺失且在 catalog 中有多个候选的 kind（incomplete 时有意义）', true),
    fixes: array(fixSchema, 'illegal 时的最近合法组合，按 distance 升序', true),
    completions: object(
      {
        count: integer('合法补全总数'),
        sample: array(completionSchema, '补全样本'),
      },
      { additionalProperties: false, description: 'incomplete 时的合法补全', required: true },
    ),
    notes: array(text('提示'), '面向模型的中文提示', true),
    unknown: array(unknownSchema, '不认识或非法的 kind/取值', true),
    cliVersion: text('上游 CLI 版本', true),
    verifiedAt: { oneOf: [{ type: 'string' }, { type: 'null' }], description: '命中组合的校验时间（legal 时）', required: true },
  },
  { additionalProperties: false },
)

function safeText(value, fallback = '') {
  if (value === undefined || value === null) return fallback
  return String(value)
}

function renderPlan(value) {
  try {
    if (!value || typeof value !== 'object') return '（暂无规划结果）'
    const status = safeText(value.status, 'unknown')
    const parts = [
      heading(`栈规划：${STATUS_LABELS[status] ?? status}`),
      kv([
        ['状态', value.ok === true ? `${status}（可继续）` : `${status}（需修正）`],
        ['CLI 版本', safeText(value.cliVersion)],
        ['校验时间', safeText(value.verifiedAt)],
      ]),
    ]

    if (safeText(value.command)) {
      parts.push(heading('命令', 3), code(value.command))
    }

    if (Array.isArray(value.notes) && value.notes.length > 0) {
      parts.push(heading('提示', 3), bullet(value.notes))
    }

    if (status === 'incomplete' && value.completions && Array.isArray(value.completions.sample)) {
      const sample = value.completions.sample
      parts.push(heading(`合法补全（共 ${safeText(value.completions.count, '0')} 个）`, 3))
      if (sample.length > 0) {
        const rows = sample.map(item => [safeText(item.label), safeText(item.verifiedAt)])
        parts.push(table(['组合', '校验时间'], rows))
        const commands = sample.slice(0, 3).map(item => safeText(item.command)).filter(Boolean)
        if (commands.length > 0) parts.push(code(commands.join('\n\n')))
      }
    }

    if (status === 'illegal' && Array.isArray(value.fixes) && value.fixes.length > 0) {
      parts.push(heading('最近的合法组合', 3))
      parts.push(
        table(
          ['组合', '距离', '最小改动'],
          value.fixes.map(fix => [
            safeText(fix.label),
            safeText(fix.distance),
            (Array.isArray(fix.diffs) ? fix.diffs : [])
              .map(diff => `${safeText(diff.kind)}: ${safeText(diff.from) || 'none'} → ${safeText(diff.to) || 'none'}`)
              .join('；'),
          ]),
        ),
      )
      const commands = value.fixes.map(fix => safeText(fix.command)).filter(Boolean)
      if (commands.length > 0) parts.push(code(commands.join('\n\n')))
    }

    if (Array.isArray(value.unknown) && value.unknown.length > 0) {
      parts.push(
        heading('无法识别的输入', 3),
        bullet(value.unknown.map(item => `${safeText(item.kind)}=${safeText(item.value) || '（空）'}`)),
      )
    }

    return join(parts) || '（暂无规划结果）'
  } catch {
    // render 是模型可见的最后一道门：任何格式问题都降级成一句人话，绝不抛。
    return '（规划结果渲染失败，请查看结构化输出。）'
  }
}

/**
 * 造 `vibestart_plan` 工具规格。
 * @param {{ config?: object, getCatalog?: () => object|Promise<object> }} [deps]
 */
export function createPlanTool(deps = {}) {
  const config = deps.config && typeof deps.config === 'object' ? deps.config : {}
  const getCatalog = deps.getCatalog ?? (async () => {
    const catalogModule = await import('../catalog/index.js')
    return catalogModule.loadCatalog()
  })

  return {
    name: 'vibestart_plan',
    description:
      '校验一个 VibeStart 技术栈并给出可直接执行的 create 命令：合法栈照原样输出，部分栈给出合法补全，' +
      '非法组合给出最近的合法组合与最小改动。参数 stack 用 "kind=value,kind=value" 字符串（如 ' +
      '"framework=spa,backend=hono,api=orpc,database=sqlite,auth=better-auth"），可只写部分 kind；' +
      'value 取 none 表示该 optional kind 不选。纯离线计算，不联网、不写盘；真正执行请用 vibestart_run。',
    timeoutMs: TIMEOUTS.plan,
    isConcurrencySafe: () => true,
    parameters: {
      stack: text(
        '栈字符串，格式 "kind=value,kind=value"（也接受 ; 分隔与空格）；可只写部分 kind，value 用 none 表示不选。',
        true,
      ),
      directory: text('create 的目标目录（相对路径），默认 my-app。'),
      command: stringEnum(CLI_COMMANDS, '子命令，默认 create；add/doctor/upgrade 不使用栈参数。'),
      addons: text(
        'create 的扩展 ID（--addons knip,ultracite）；command=add 时它变成位置参数能力 ID' +
          '（add knip ultracite），不传则生成只读的 add --list。none 表示全部不选。',
      ),
      packageManager: stringEnum(PACKAGE_MANAGERS, '包管理器；不传则用上游默认。'),
      preview: boolean('是否生成 --dry-run 预览命令，默认 true。'),
      offline: boolean('仅 doctor 生效：加 --offline 跳过 registry 查询；其他命令忽略。'),
    },
    output: {
      schema: outputSchema,
      render(_args, value) {
        return [{ type: 'text', text: renderPlan(value) }]
      },
      presentationMeta(_args, value) {
        try {
          return {
            status: value?.status ?? 'invalid',
            ok: value?.ok === true,
            command: value?.command ?? null,
            fixes: Array.isArray(value?.fixes) ? value.fixes.length : 0,
            completions: value?.completions?.count ?? 0,
          }
        } catch {
          return {}
        }
      },
    },
    async execute(args = {}) {
      const cliVersion = safeText(config.cliVersion, DEFAULT_CLI_VERSION) || DEFAULT_CLI_VERSION
      const runner = safeText(config.runner, DEFAULT_RUNNER) || DEFAULT_RUNNER
      const parsed = parseStackInput(args.stack)

      try {
        const catalog = await getCatalog()
        return planStack({
          stack: parsed.values,
          unknown: parsed.unknown,
          catalog,
          directory: args.directory,
          command: args.command ?? 'create',
          addons: args.addons,
          packageManager: args.packageManager,
          preview: args.preview !== false,
          offline: args.offline === true,
          cliVersion,
          runner,
        })
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        return {
          status: 'invalid',
          ok: false,
          command: '',
          resolved: parsed.values,
          missing: [],
          fixes: [],
          completions: { count: 0, sample: [] },
          notes: [
            `规划失败：${reason}`,
            '内置目录不可用时可改用 vibestart_stacks 查看可选值，或直接用 pwsh/bash 运行 npx --yes vibestart-cli@' + cliVersion + ' --list --json。',
          ],
          unknown: parsed.unknown,
          cliVersion,
          verifiedAt: null,
        }
      }
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: `VibeStart 栈规划：${safeText(args.stack) || '（未指定）'}`,
        kind: 'plan',
        rawInput: args,
      }
    },
    presentResult(_args, result) {
      if (result?.isError) return undefined
      const meta = result?.meta
      if (!meta || typeof meta !== 'object') return undefined
      return {
        card: 'generic',
        title: `栈规划：${safeText(meta.status, 'unknown')}`,
        content: [{ type: 'text', text: meta.command ? `${inlineCode(meta.command)}` : '查看结构化输出。' }],
      }
    },
  }
}
