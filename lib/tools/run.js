/**
 * tools/run.js — `vibestart_run` 工具规格（契约 §8.3）
 *
 * 安全边界全在这一个文件里：
 *   - apply=false 一律只跑 `--dry-run`，绝不写盘；
 *   - apply=true 前必须 planStack() 为 legal，否则不 spawn；
 *   - create 永不加 `--yes`，维护写操作才加；
 *   - 目录只接受相对路径且不含 `..`；
 *   - ctx.shell 缺失 / allowExec=false / allowApply=false 都返回结构化拒绝，
 *     但仍把可复制的命令交回给模型（可改用 pwsh/bash 执行）。
 */

import {
  CLI_COMMANDS,
  DEFAULT_CLI_VERSION,
  DEFAULT_NPM_CACHE_DIR,
  DEFAULT_RUNNER,
  TIMEOUTS,
} from '../config.js'
import { buildCommand, parseStackInput, planStack } from '../plan/index.js'
import { parseCliJson, runCommand } from '../exec/shell.js'
import { bullet, code, heading, join, kv } from '../presentation/markdown.js'
import { array, boolean, integer, object, stringEnum, text } from '../plugin/schema.js'
import { normalizeConfig } from '../plugin/config.js'

const PACKAGE_MANAGERS = Object.freeze(['pnpm', 'bun'])
const MIN_TIMEOUT_MS = 5_000
const MAX_TIMEOUT_MS = 1_800_000

const nullableText = {
  oneOf: [{ type: 'string' }, { type: 'null' }],
  description: '无值时显式返回 null',
  required: true,
}

const nullableStack = {
  oneOf: [
    { type: 'object', additionalProperties: true, description: 'CLI 返回的栈对象' },
    { type: 'null' },
  ],
  description: 'CLI 返回的栈；没有时为 null',
  required: true,
}

const nullableStringArray = {
  oneOf: [
    { type: 'array', items: { type: 'string' } },
    { type: 'null' },
  ],
  description: '字符串列表；没有时为 null',
  required: true,
}

const nullableRaw = {
  oneOf: [
    { type: 'object', additionalProperties: true, description: 'CLI 返回的原始 JSON' },
    { type: 'null' },
  ],
  description: 'CLI 的原始 JSON；解析失败时为 null',
  required: true,
}

const outputSchema = object(
  {
    ok: boolean('命令是否成功（预览成功也算成功）', true),
    applied: boolean('是否真的执行了写操作', true),
    command: text('实际执行（或本应执行）的命令', true),
    exitCode: {
      oneOf: [{ type: 'integer' }, { type: 'null' }],
      description: '退出码；未执行或基础设施失败为 null',
      required: true,
    },
    timedOut: boolean('是否因超时被终止', true),
    aborted: boolean('是否被调用方取消', true),
    status: text('CLI 返回的 status（available/written/needs-install/…）或 blocked/error', true),
    cliVersion: text('固定的上游 CLI 版本', true),
    stack: nullableStack,
    files: nullableStringArray,
    nextSteps: nullableStringArray,
    message: nullableText,
    raw: nullableRaw,
    stderr: nullableText,
  },
  { additionalProperties: false },
)

function baseResult({ command = '', cliVersion = DEFAULT_CLI_VERSION, status = 'blocked', message = null } = {}) {
  return {
    ok: false,
    applied: false,
    command,
    exitCode: null,
    timedOut: false,
    aborted: false,
    status,
    cliVersion,
    stack: null,
    files: null,
    nextSteps: null,
    message,
    raw: null,
    stderr: null,
  }
}

function oneLine(value) {
  return String(value ?? '')
    .replace(/\s*\r?\n\s*/g, ' ')
    .trim()
}

function firstLine(value) {
  return String(value ?? '').split(/\r?\n/).find(line => line.trim())?.trim() ?? ''
}

function commandName(value) {
  const name = oneLine(value).toLowerCase()
  return CLI_COMMANDS.includes(name) ? name : undefined
}

/**
 * 目录安全闸：只允许相对路径，且任何层级都不能出现 `..`。
 * 反斜杠统一按分隔符处理（Windows 上两种写法都常见）。
 *
 * 额外拒绝 shell 元字符：命令最终交给 pwsh/bash 解释，仅靠「相对 + 无 ..」
 * 挡不住 `$(...)`、`` ` ``、`;` 这类注入；NTFS 本身也禁用其中一部分字符。
 * @param {unknown} value
 * @param {string} label
 * @returns {{ok:true, value:string|undefined}|{ok:false, reason:string}}
 */
function validateRelativePath(value, label) {
  if (value === undefined || value === null) return { ok: true, value: undefined }
  const text = oneLine(value)
  if (!text) return { ok: true, value: undefined }
  if (text === '.') return { ok: true, value: '.' }

  if (/^[A-Za-z]:/.test(text)) {
    return { ok: false, reason: `${label} 必须是相对路径：${text} 是 Windows 绝对路径。` }
  }
  if (text.startsWith('/') || text.startsWith('\\')) {
    return { ok: false, reason: `${label} 必须是相对路径：${text} 以根目录开头。` }
  }
  if (text.startsWith('~')) {
    return { ok: false, reason: `${label} 必须是相对路径：${text} 会被 shell 展开到主目录。` }
  }
  if (/[\u0000-\u001f"`$%^&|<>*?{}()![\];]/u.test(text)) {
    return {
      ok: false,
      reason: `${label} 含 shell 特殊字符（引号、$、反引号、分号、管道等）：${text}。请改用普通目录名。`,
    }
  }
  const segments = text.replace(/\\/g, '/').split('/')
  if (segments.includes('..')) {
    return { ok: false, reason: `${label} 不能包含 ".."：${text} 可能把文件写到工作区外。` }
  }
  return { ok: true, value: text }
}

function resolveConfig(raw) {
  try {
    return normalizeConfig(raw && typeof raw === 'object' ? raw : {})
  } catch {
    return {
      allowExec: raw?.allowExec !== false,
      allowApply: raw?.allowApply !== false,
      cliVersion: typeof raw?.cliVersion === 'string' && raw.cliVersion ? raw.cliVersion : DEFAULT_CLI_VERSION,
      runner: typeof raw?.runner === 'string' && raw.runner ? raw.runner : DEFAULT_RUNNER,
      previewTimeoutMs: TIMEOUTS.runPreview,
      applyTimeoutMs: TIMEOUTS.runApply,
      npmCacheDir:
        typeof raw?.npmCacheDir === 'string' ? raw.npmCacheDir : DEFAULT_NPM_CACHE_DIR,
    }
  }
}

/**
 * npx / npm 需要的环境变量。
 *
 * DSH 默认 workspace-write 策略下，npm 的全局缓存（%LOCALAPPDATA%\npm-cache）
 * 在工作区外，npx 一跑就 EPERM；把 npm_config_cache 指到工作者目录里的相对路径，
 * 交给进程 cwd 解析。另外压掉 npm notice 噪声。
 * `npmCacheDir: ''` 表示完全不注入 npm_config_cache（交给外部环境决定）。
 */
function buildNpmEnv(config) {
  const env = {
    npm_config_loglevel: 'error',
    npm_config_update_notifier: 'false',
  }
  if (config.npmCacheDir) env.npm_config_cache = config.npmCacheDir
  return env
}

function clampTimeout(requested, cap) {
  const limit = Number.isInteger(cap) && cap >= MIN_TIMEOUT_MS ? Math.min(cap, MAX_TIMEOUT_MS) : TIMEOUTS.runApply
  if (!Number.isInteger(requested) || requested <= 0) return limit
  return Math.min(Math.max(requested, MIN_TIMEOUT_MS), limit)
}

async function resolveShell(getShell) {
  if (typeof getShell !== 'function') return undefined
  try {
    return await getShell()
  } catch {
    return undefined
  }
}

function deriveStatus(raw, exitCode, apply, command) {
  if (raw && typeof raw.status === 'string' && raw.status.trim()) return raw.status.trim()
  if (raw && raw.ok === false) return 'error'
  if (exitCode === 0) {
    if (command === 'create') return apply ? 'written' : 'available'
    return apply ? 'completed' : 'available'
  }
  return 'error'
}

function errorText(raw) {
  const error = raw?.error
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const code = oneLine(error.code)
    const message = oneLine(error.message)
    if (code && message) return `${code}: ${message}`
    return message || code || null
  }
  return null
}

function readMessage(raw, result, timeoutMs) {
  const fromError = errorText(raw)
  if (fromError) return fromError
  if (typeof raw?.message === 'string' && raw.message.trim()) return raw.message.trim()
  if (result.timedOut) return `命令超时（${timeoutMs}ms）被终止。`
  if (result.aborted) return '命令被调用方取消。'
  if (result.exitCode !== 0) {
    const line = firstLine(result.stderr)
    if (line) return line
  }
  return null
}

/** `next` 是维护命令的字段名，`nextSteps` 是 create 的；两者都收。 */
function readStringArray(value) {
  if (!Array.isArray(value)) return null
  return value.map(item => String(item))
}

function renderRun(value) {
  try {
    if (!value || typeof value !== 'object') return '（暂无执行结果）'
    const parts = [
      heading(value.applied ? 'VibeStart：已执行' : 'VibeStart：预览/未写入'),
      kv([
        ['状态', oneLine(value.status) || 'unknown'],
        ['退出码', value.exitCode === null || value.exitCode === undefined ? '—' : value.exitCode],
        ['CLI 版本', oneLine(value.cliVersion)],
        ['超时/取消', `${value.timedOut === true ? '超时' : '否'} / ${value.aborted === true ? '取消' : '否'}`],
      ]),
    ]

    if (oneLine(value.command)) parts.push(heading('命令', 3), code(value.command))

    if (oneLine(value.message)) parts.push(heading('说明', 3), bullet([value.message]))

    if (Array.isArray(value.nextSteps) && value.nextSteps.length > 0) {
      parts.push(heading('后续步骤', 3), bullet(value.nextSteps))
    }

    if (Array.isArray(value.files) && value.files.length > 0) {
      const shown = value.files.slice(0, 20)
      const more = value.files.length > shown.length ? `…共 ${value.files.length} 个文件` : ''
      parts.push(heading('文件', 3), bullet([...shown, more].filter(Boolean)))
    }

    if (oneLine(value.stderr)) parts.push(heading('stderr', 3), code(value.stderr, 'text'))

    return join(parts) || '（暂无执行结果）'
  } catch {
    return '（执行结果渲染失败，请查看结构化输出。）'
  }
}

/**
 * 造 `vibestart_run` 工具规格。
 * @param {{
 *   config?: object,
 *   getCatalog?: () => object|Promise<object>,
 *   getShell?: () => object|undefined|Promise<object|undefined>,
 * }} [deps]
 */
export function createRunTool(deps = {}) {
  const config = resolveConfig(deps.config)
  const getCatalog = deps.getCatalog ?? (async () => {
    const catalogModule = await import('../catalog/index.js')
    return catalogModule.loadCatalog()
  })
  const getShell = deps.getShell ?? (() => undefined)

  return {
    name: 'vibestart_run',
    description:
      '通过 DSH 的 ctx.shell 执行 VibeStart CLI。默认 apply=false，只跑 --dry-run 预览，绝不写盘；' +
      'apply=true 时会先校验栈必须合法（status=legal）才真正执行，create 永不加 --yes，add/upgrade 写操作才加 --yes。' +
      'directory/projectDir 必须是相对路径且不含 ".."。CLI 需要联网安装依赖。' +
      'apply=true 通常会跑安装与检查；若当前沙箱不允许工作区外写入，请先 noInstall=true 生成文件，' +
      '再用 pwsh 工具（必要时升级沙箱权限）安装。' +
      '不支持 shell 或 allowExec=false 时只返回可直接复制执行的 command，请改用 pwsh/bash 工具执行。',
    timeoutMs: TIMEOUTS.runApply,
    isConcurrencySafe: () => true,
    parameters: {
      command: stringEnum(CLI_COMMANDS, '子命令：create 建项目；add/doctor/upgrade 维护已有项目。', true),
      directory: text('create 的目标目录（相对路径，默认 my-app）；维护命令中作为项目根目录。'),
      projectDir: text('维护命令的项目根目录（相对路径）；directory 的别名，优先于 directory。'),
      stack: text('栈字符串（§8.0 语法 "kind=value,..."），仅 create 使用；apply=true 时必须能校验为 legal。'),
      addons: text(
        'create 的扩展 ID（--addons knip,ultracite）；command=add 时它变成位置参数能力 ID' +
          '（add knip ultracite），不传则只跑只读的 add --list（apply=true 会被拒，因为空 add 上游会 exit 2）。' +
          'none 表示全部不选。',
      ),
      packageManager: stringEnum(PACKAGE_MANAGERS, '包管理器；不传用上游默认。'),
      apply: boolean('是否真的执行写操作；默认 false，只预览。'),
      noInstall: boolean('create 时跳过依赖安装与 setup（--no-install）。'),
      noGit: boolean('create 时跳过 git init（--no-git）。'),
      noCheck: boolean('create 时跳过最终检查（--no-check）。'),
      offline: boolean('仅 doctor 生效：加 --offline 跳过 registry 查询；其他命令忽略。'),
      timeoutMs: integer('超时毫秒数；会钳制到 [5000, 配置上限]（默认预览 180000、执行 600000）。'),
    },
    output: {
      schema: outputSchema,
      render(_args, value) {
        return [{ type: 'text', text: renderRun(value) }]
      },
      presentationMeta(_args, value) {
        try {
          return {
            status: value?.status ?? 'unknown',
            applied: value?.applied === true,
            exitCode: value?.exitCode ?? null,
            command: value?.command ?? null,
          }
        } catch {
          return {}
        }
      },
    },
    async execute(args = {}) {
      const command = commandName(args.command)
      if (!command) {
        return baseResult({
          command: '',
          cliVersion: config.cliVersion,
          message: `不支持的子命令「${oneLine(args.command) || '（空）'}」；允许：${CLI_COMMANDS.join(' / ')}。`,
        })
      }

      const apply = args.apply === true
      const isCreate = command === 'create'

      // ---------- 目录安全闸 ----------
      const rawTarget = isCreate ? (args.directory ?? 'my-app') : (args.projectDir ?? args.directory)
      const target = validateRelativePath(rawTarget, isCreate ? 'directory' : 'projectDir/directory')
      if (!target.ok) {
        return baseResult({ command: '', cliVersion: config.cliVersion, message: target.reason })
      }
      const workdir = isCreate ? undefined : target.value

      // ---------- 规划（纯计算；失败也尽量把命令交回去） ----------
      const parsed = parseStackInput(args.stack)
      let plan
      try {
        const catalog = await getCatalog()
        plan = planStack({
          stack: parsed.values,
          unknown: parsed.unknown,
          catalog,
          directory: target.value,
          command,
          addons: args.addons,
          packageManager: args.packageManager,
          preview: !apply,
          cliVersion: config.cliVersion,
          runner: config.runner,
          noInstall: args.noInstall === true,
          noGit: args.noGit === true,
          noCheck: args.noCheck === true,
          offline: args.offline === true,
        })
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        let fallback = ''
        try {
          fallback = buildCommand({
            command,
            directory: target.value,
            values: parsed.values,
            addons: args.addons,
            packageManager: args.packageManager,
            preview: !apply,
            cliVersion: config.cliVersion,
            runner: config.runner,
            noInstall: args.noInstall === true,
            noGit: args.noGit === true,
            noCheck: args.noCheck === true,
            offline: args.offline === true,
          })
        } catch {
          fallback = ''
        }
        return baseResult({
          command: fallback,
          cliVersion: config.cliVersion,
          status: 'error',
          message: `无法完成栈规划：${reason}。可改用 vibestart_stacks 查看可选值，或用 pwsh/bash 执行上面的命令。`,
        })
      }

      // ---------- 配置闸（拒绝时仍返回命令，便于改用 pwsh/bash） ----------
      if (!config.allowExec) {
        return baseResult({
          command: plan.command,
          cliVersion: config.cliVersion,
          message:
            '配置 allowExec=false：vibestart_run 不会启动 CLI。上面的 command 可直接用 pwsh/bash 工具执行；' +
            '若希望工具直接执行，请在插件配置里把 allowExec 设为 true。',
        })
      }
      if (apply && !config.allowApply) {
        return baseResult({
          command: plan.command,
          cliVersion: config.cliVersion,
          message:
            '配置 allowApply=false：apply=true 被拒绝（预览仍可用）。先去掉 apply 只做 --dry-run 预览，' +
            '或把配置里的 allowApply 设为 true 后再执行。',
        })
      }

      // ---------- apply 必须 legal ----------
      if (apply && plan.status !== 'legal') {
        const details = Array.isArray(plan.notes) ? plan.notes.join(' ') : ''
        const firstFix = Array.isArray(plan.fixes) && plan.fixes.length > 0 ? plan.fixes[0].command : ''
        const firstCompletion =
          plan.completions && Array.isArray(plan.completions.sample) && plan.completions.sample.length > 0
            ? plan.completions.sample[0].command
            : ''
        const hint = firstFix || firstCompletion
        return baseResult({
          command: plan.command,
          cliVersion: config.cliVersion,
          message:
            `apply=true 要求 planStack 为 legal，当前是 ${plan.status}。${details}` +
            (hint ? ` 最近的可执行候选：${hint}` : ' 请先用 vibestart_plan 查看 fixes/completions。'),
        })
      }
      if (!apply && plan.status === 'invalid') {
        return baseResult({
          command: plan.command,
          cliVersion: config.cliVersion,
          message: `栈输入无效：${Array.isArray(plan.notes) ? plan.notes.join(' ') : '请先修正 kind/取值。'}`,
        })
      }

      // ---------- shell 闸 ----------
      const shell = await resolveShell(getShell)
      if (!shell) {
        return baseResult({
          command: plan.command,
          cliVersion: config.cliVersion,
          message:
            'ctx.shell 不可用或配置 allowExec=false：无法启动 vibestart CLI。' +
            '上面的 command 可直接用 pwsh/bash 工具执行；若已在 DSH 里挂载 shell 服务，请确认 allowExec=true。',
        })
      }

      // ---------- 执行 ----------
      const cap = apply ? config.applyTimeoutMs : config.previewTimeoutMs
      const timeoutMs = clampTimeout(args.timeoutMs, cap)
      const result = await runCommand({
        shell,
        command: plan.command,
        timeoutMs,
        workdir,
        env: buildNpmEnv(config),
      })
      const raw = parseCliJson(result.stdout)
      const status = deriveStatus(raw, result.exitCode, apply, command)

      const cliOk = raw ? raw.ok !== false : result.exitCode === 0
      const ok =
        !result.timedOut &&
        !result.aborted &&
        result.exitCode === 0 &&
        cliOk &&
        !['blocked', 'error', 'failed'].includes(status)
      const applied =
        apply &&
        raw !== null &&
        !['blocked', 'error', 'failed', 'planned', 'available', 'no-op'].includes(status)

      const stack = raw?.stack && typeof raw.stack === 'object' && !Array.isArray(raw.stack) ? raw.stack : null
      const files = readStringArray(raw?.files)
      const nextSteps = readStringArray(raw?.nextSteps) ?? readStringArray(raw?.next)

      return {
        ok,
        applied,
        command: plan.command,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        aborted: result.aborted,
        status,
        cliVersion: config.cliVersion,
        stack,
        files,
        nextSteps,
        message: readMessage(raw, result, timeoutMs),
        raw,
        stderr: result.stderr || null,
      }
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: `VibeStart ${oneLine(args.command) || 'create'}${args.apply === true ? '（写盘）' : '（预览）'}`,
        kind: 'run',
        rawInput: args,
      }
    },
    presentResult(_args, result) {
      if (result?.isError) return undefined
      const meta = result?.meta
      if (!meta || typeof meta !== 'object') return undefined
      return {
        card: 'generic',
        title: `VibeStart：${oneLine(meta.status) || 'unknown'}`,
        content: [{ type: 'text', text: oneLine(meta.command) || '查看结构化输出。' }],
      }
    },
  }
}
