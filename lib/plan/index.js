/**
 * lib/plan/index.js — 栈规划纯函数（契约 §6）
 *
 * 这里没有 DSH API、没有第三方依赖、也不 import lib/catalog：
 * catalog 由调用方注入，且按 Lead 定下的收口**必须**在对象上提供
 * `matchingStacks()` / `nearestStacks()`（与 catalog 模块的独立导出是同一实现）。
 * 少了这两个能力就直接抛契约错误，不在这里写第二套扫描 stacks 的兜底逻辑。
 *
 * 命令生成只有一份：`buildCommand()`；plan 工具、run 工具、exec 层都走它。
 */

import {
  CLI_COMMANDS,
  CLI_PACKAGE,
  DEFAULT_CLI_VERSION,
  DEFAULT_RUNNER,
  RUNNERS,
} from '../config.js'
import { normalizeKindName, normalizeStackValue } from '../parse-stack.js'

// 契约 §6 的公开面：栈字符串解析仍由 lib/parse-stack.js 拥有，这里只再导出。
export { parseStackInput, normalizeStackValue } from '../parse-stack.js'

const DEFAULT_DIRECTORY = 'my-app'
const SAMPLE_LIMIT = 5
const FIX_LIMIT = 3

/** 维护型写操作：apply 时需要 `--yes`。doctor 只读，不加。 */
const MAINTENANCE_WRITE_COMMANDS = Object.freeze(['add', 'upgrade'])

const COMMAND_SET = new Set(CLI_COMMANDS)

function oneLine(value) {
  return String(value ?? '')
    .replace(/\s*\r?\n\s*/g, ' ')
    .trim()
}

/**
 * 把单个命令行参数拼成 Windows 友好的字符串。
 * 含空白或双引号时用双引号包裹；值里的双引号转义为 `\"`。
 * @param {unknown} value
 * @returns {string}
 */
function quoteArg(value) {
  const text = String(value ?? '')
  if (text === '') return '""'
  if (!/[\s"]/u.test(text)) return text
  return `"${text.replace(/"/g, '\\"')}"`
}

function runnerArgs(runner) {
  const key = typeof runner === 'string' && Object.hasOwn(RUNNERS, runner) ? runner : DEFAULT_RUNNER
  return [...RUNNERS[key]]
}

/**
 * 只把命令名归一；非法命令返回 undefined（由调用方决定如何报错）。
 * @param {unknown} value
 * @returns {string|undefined}
 */
function commandName(value) {
  const name = String(value ?? '')
    .trim()
    .toLowerCase()
  return COMMAND_SET.has(name) ? name : undefined
}

/**
 * 组装 runner + 包名@版本 + argv。
 * @param {{runner?:string, cliVersion?:string, args?:string[]}} options
 * @returns {string}
 */
export function buildCliCommand({ runner, cliVersion, args = [] } = {}) {
  const version = String(cliVersion || DEFAULT_CLI_VERSION)
  const argv = Array.isArray(args) ? args : []
  return [...runnerArgs(runner), `${CLI_PACKAGE}@${version}`, ...argv.map(quoteArg)].join(' ')
}

function normalizeDirectory(value) {
  const text = oneLine(value)
  return text || DEFAULT_DIRECTORY
}

function normalizeAddons(value) {
  if (value === undefined || value === null) return undefined
  const text = Array.isArray(value) ? value.map(oneLine).filter(Boolean).join(',') : oneLine(value)
  return text || undefined
}

/**
 * `add` 的能力 ID 列表。
 *
 * 上游的 `add` 是**位置参数**命令：`vibestart add [knip ultracite docker] [--list]`，
 * 而 `create` 用的是 `--addons knip,ultracite`。两处语义相同、形状不同，所以这里
 * 把同一个 `addons` 输入拆成 ID 列表，由 buildCommand 决定按哪种形状输出。
 *
 * @param {unknown} value
 * @returns {string[]}
 */
function addonIdList(value) {
  const text = normalizeAddons(value)
  if (!text || text.toLowerCase() === 'none') return []
  return text
    .split(',')
    .map(id => id.trim())
    .filter(Boolean)
}

function normalizePackageManager(value) {
  const text = oneLine(value).toLowerCase()
  return text || undefined
}

/**
 * 生成一条可执行命令（唯一事实来源）。
 *
 * create：目录 + 按 values 的插入顺序输出 `--kind value`；`""` 写 `none`；
 * `--addons` 只在显式给出时输出；`--package-manager` 只在给出时输出。
 * add/doctor/upgrade：不带栈 flag；add/upgrade 在 apply（preview=false）时加 `--yes`。
 * preview=true 时 create/add/upgrade 追加 `--dry-run`；doctor 本来就只读，
 * 上游不接受 `--dry-run`，所以 preview/apply 都只加 `--json`。
 * `offline` 只对 doctor 生效（避免 CLI 联网查 registry）。
 *
 * `values` 的插入顺序即输出顺序——planStack 会按 catalog.kindOrder 重建对象，
 * 因此调用方拿到的命令天然是 kindOrder 顺序。
 *
 * @param {object} options
 * @returns {string}
 */
export function buildCommand({
  command = 'create',
  directory = DEFAULT_DIRECTORY,
  values,
  addons,
  packageManager,
  preview = true,
  cliVersion = DEFAULT_CLI_VERSION,
  runner = DEFAULT_RUNNER,
  noInstall = false,
  noGit = false,
  noCheck = false,
  offline = false,
} = {}) {
  const name = commandName(command)
  if (!name) throw new TypeError(`unknown command: ${String(command)}（允许：${CLI_COMMANDS.join(' / ')}）`)

  const args = []
  // `add` 的能力 ID 是位置参数；没有 ID 时退化成 `add --list`（只读的能力清单）。
  const capabilityIds = addonIdList(addons)
  const addListMode = name === 'add' && capabilityIds.length === 0

  if (name === 'create') {
    args.push('create', normalizeDirectory(directory))
    for (const [rawKind, rawValue] of Object.entries(values ?? {})) {
      const kind = oneLine(rawKind).toLowerCase()
      if (!kind) continue
      const value = normalizeStackValue(rawValue)
      args.push(`--${kind}`, value === '' ? 'none' : value)
    }
    const addonText = normalizeAddons(addons)
    if (addonText !== undefined) args.push('--addons', addonText)
    const pm = normalizePackageManager(packageManager)
    if (pm !== undefined) args.push('--package-manager', pm)
    if (noGit === true) args.push('--no-git')
    if (noInstall === true) args.push('--no-install')
    if (noCheck === true) args.push('--no-check')
  } else {
    args.push(name)
    if (name === 'add') {
      if (capabilityIds.length > 0) args.push(...capabilityIds)
      else args.push('--list')
    }
    if (preview === false && MAINTENANCE_WRITE_COMMANDS.includes(name)) args.push('--yes')
    // 上游只给 doctor 接受 --offline；其他命令即使传了也静默忽略。
    if (name === 'doctor' && offline === true) args.push('--offline')
  }

  // 上游的 --dry-run 只被 create/add/upgrade 接受，doctor 传了会 exit 2；
  // `add --list` 不需要（也不是合法组合意义上的预览）。
  if (preview !== false && name !== 'doctor' && !addListMode) args.push('--dry-run')
  args.push('--json')
  return buildCliCommand({ runner, cliVersion, args })
}

/**
 * 契约 §5 要求的注入能力。缺了就大声失败，避免悄悄退化出第二套实现。
 * @param {object} catalog
 */
function assertCatalog(catalog) {
  if (!catalog || typeof catalog !== 'object') {
    throw new TypeError('catalog 不能为空：planStack 需要 loadCatalog() 的结果（见 CONTRACT §5）')
  }
  for (const method of ['matchingStacks', 'nearestStacks']) {
    if (typeof catalog[method] !== 'function') {
      throw new TypeError(
        `catalog 必须提供 ${method}()（见 CONTRACT §5/§6）：loadCatalog() 的返回值要附挂同一实现的 catalog 模块导出`,
      )
    }
  }
  if (!Array.isArray(catalog.kindOrder) || catalog.kindOrder.length === 0) {
    throw new TypeError('catalog.kindOrder 必须是非空数组（见 CONTRACT §5）')
  }
}

/**
 * 从 catalog 建只读索引：kind 顺序、optional 标记、取值全集。
 * @param {object} catalog
 */
function buildIndex(catalog) {
  const kindOrder = catalog.kindOrder.map(kind => oneLine(kind)).filter(Boolean)
  const kindById = new Map()
  for (const kind of Array.isArray(catalog.kinds) ? catalog.kinds : []) {
    const id = oneLine(kind?.id)
    if (id) kindById.set(id, kind)
  }
  const addonIds = new Set(
    (Array.isArray(catalog.addons) ? catalog.addons : [])
      .map(addon => oneLine(addon?.id))
      .filter(Boolean),
  )

  const domain = {}
  for (const kind of kindOrder) {
    const kindMeta = kindById.get(kind)
    const declared = catalog.valueDomain?.[kind]
    if (Array.isArray(declared) && declared.length > 0) {
      domain[kind] = declared.map(value => normalizeStackValue(value))
    } else if (kindMeta) {
      const ids = (Array.isArray(kindMeta.options) ? kindMeta.options : [])
        .map(option => normalizeStackValue(option?.id))
        .filter(Boolean)
      domain[kind] = kindMeta.optional === false ? ids : ['', ...ids]
    } else {
      throw new TypeError(`catalog 缺少 kind「${kind}」的定义（kinds / valueDomain 都没有，见 CONTRACT §5）`)
    }
    if (!kindById.has(kind)) {
      kindById.set(kind, {
        id: kind,
        name: kind,
        optional: domain[kind].includes(''),
        options: domain[kind].filter(Boolean).map(id => ({ id, name: id })),
      })
    }
  }
  return { kindOrder, kindById, domain, addonIds }
}

function pushUnknown(list, entry) {
  const kind = oneLine(entry?.kind)
  const value = oneLine(entry?.value)
  if (!kind) return
  if (list.some(item => item.kind === kind && item.value === value)) return
  list.push({ kind, value })
}

/**
 * 归一用户给的局部栈；同时把不认识的 kind / 非法取值收集到 unknown。
 * @param {unknown} stack
 * @param {{kindOrder:string[], kindById:Map<string,object>, domain:Record<string,string[]>}} index
 */
function normalizePartialStack(stack, index) {
  const resolved = {}
  const unknown = []
  if (stack === undefined || stack === null) return { resolved, unknown }
  if (typeof stack !== 'object' || Array.isArray(stack)) {
    return { resolved, unknown: [{ kind: String(stack), value: '' }] }
  }

  for (const [rawKind, rawValue] of Object.entries(stack)) {
    const kind = normalizeKindName(rawKind)
    const kindMeta = index.kindById.get(kind)
    if (!kindMeta) {
      pushUnknown(unknown, { kind: kind || String(rawKind), value: String(rawValue ?? '') })
      continue
    }
    const value = normalizeStackValue(rawValue)
    const allowed = index.domain[kind] ?? []
    if (!allowed.includes(value)) {
      pushUnknown(unknown, { kind, value })
      continue
    }
    if (kindMeta.optional === false && value === '') {
      // required kind 没有 none；把它报成非法取值，比让 CLI 猜要清楚。
      pushUnknown(unknown, { kind, value: '' })
      continue
    }
    resolved[kind] = value
  }
  return { resolved: orderValues(resolved, index), unknown }
}

function orderValues(values, index) {
  const out = {}
  for (const kind of index.kindOrder) {
    if (Object.hasOwn(values, kind)) out[kind] = normalizeStackValue(values[kind])
  }
  return out
}

function fillDefaults(values, index) {
  const out = { ...values }
  for (const kind of index.kindOrder) {
    if (Object.hasOwn(out, kind)) continue
    out[kind] = index.domain[kind]?.[0] ?? ''
  }
  return orderValues(out, index)
}

function emptyCompletions() {
  return { count: 0, sample: [] }
}

function pickExact(sample, values, index) {
  return (Array.isArray(sample) ? sample : []).find(candidate => {
    if (!candidate || typeof candidate.values !== 'object') return false
    return index.kindOrder.every(kind => candidate.values[kind] === values[kind])
  })
}

function describeUnknown(entry, index) {
  if (entry.kind === 'command') return `不支持的子命令「${entry.value}」（允许：${CLI_COMMANDS.join(' / ')}）`
  if (entry.kind === 'package-manager') {
    return `不支持的 packageManager「${entry.value}」（允许：pnpm / bun）`
  }
  if (entry.kind === 'addons') {
    return `不支持的 addon「${entry.value}」（可用：${[...index.addonIds].join(' / ') || 'knip / ultracite'}）`
  }
  const allowed = index.domain[entry.kind]
  if (!allowed || allowed.length === 0) return `不认识的 kind「${entry.kind}」`
  const shown = allowed.map(value => (value === '' ? 'none' : value))
  return `kind「${entry.kind}」不接受值「${entry.value || '空'}」，可选：${shown.join(' / ')}`
}

function diffsToText(diffs) {
  return (Array.isArray(diffs) ? diffs : [])
    .map(diff => `${diff.kind}: ${diff.from === '' ? 'none' : diff.from} → ${diff.to === '' ? 'none' : diff.to}`)
    .join('；')
}

/**
 * 校验并规划一个栈（契约 §6）。
 * @param {object} input
 * @param {Record<string,string>} [input.stack]
 * @param {object} input.catalog
 * @param {string} [input.directory]
 * @param {string} [input.command]
 * @param {string} [input.addons]
 * @param {string} [input.packageManager]
 * @param {boolean} [input.preview]
 * @param {string} [input.cliVersion]
 * @param {string} [input.runner]
 * @param {{kind:string, value:string}[]} [input.unknown] 上游 parseStackInput 的语法错误
 * @param {boolean} [input.noInstall]
 * @param {boolean} [input.noGit]
 * @param {boolean} [input.noCheck]
 * @param {boolean} [input.offline] 仅 doctor 生效：跳过 registry 查询
 */
export function planStack(input = {}) {
  const catalog = input.catalog
  assertCatalog(catalog)
  const index = buildIndex(catalog)

  const { resolved, unknown: stackUnknown } = normalizePartialStack(input.stack, index)
  const unknown = [...stackUnknown]
  if (Array.isArray(input.unknown)) {
    for (const entry of input.unknown) pushUnknown(unknown, entry)
  }

  const rawCommand = input.command === undefined || input.command === null || input.command === ''
    ? 'create'
    : String(input.command).trim().toLowerCase()
  const command = commandName(rawCommand)
  if (!command) pushUnknown(unknown, { kind: 'command', value: rawCommand })

  const packageManager = normalizePackageManager(input.packageManager)
  if (
    packageManager !== undefined &&
    Array.isArray(catalog.packageManagers) &&
    catalog.packageManagers.length > 0 &&
    !catalog.packageManagers.includes(packageManager)
  ) {
    pushUnknown(unknown, { kind: 'package-manager', value: packageManager })
  }

  const cliVersion = String(input.cliVersion || catalog.cliVersion || DEFAULT_CLI_VERSION)
  const runner = typeof input.runner === 'string' && input.runner ? input.runner : DEFAULT_RUNNER
  const preview = input.preview !== false
  const directory = normalizeDirectory(input.directory)

  // addons 也走白名单：上游 `--addons` 的合法 ID 由快照的 addons 列表给出，
  // 不认识的 ID 直接 invalid，避免把它拼进命令后让 CLI（或 shell）去解释。
  let addons = normalizeAddons(input.addons)
  if (addons !== undefined && addons.toLowerCase() !== 'none') {
    addons = addons
      .split(',')
      .map(id => id.trim().toLowerCase())
      .filter(Boolean)
      .join(',')
    if (!addons) addons = undefined
  } else if (addons !== undefined) {
    addons = 'none'
  }
  if (addons !== undefined && addons !== 'none' && index.addonIds.size > 0) {
    for (const id of addons.split(',')) {
      if (!index.addonIds.has(id)) pushUnknown(unknown, { kind: 'addons', value: id })
    }
  }
  const extraFlags = {
    noInstall: input.noInstall === true,
    noGit: input.noGit === true,
    noCheck: input.noCheck === true,
    offline: input.offline === true,
  }

  /** 命令里的栈值：plan 内部会换成完整合法值，run 拿到就能直接执行。 */
  const commandFor = values => {
    if (!command) return ''
    return buildCommand({
      command,
      directory,
      values,
      addons,
      packageManager,
      preview,
      cliVersion,
      runner,
      ...extraFlags,
    })
  }

  const finish = ({ status, ok, commandText, missing = [], fixes = [], completions = emptyCompletions(), notes = [], verifiedAt = null }) => ({
    status,
    ok,
    command: commandText,
    resolved,
    missing,
    fixes,
    completions,
    notes,
    unknown,
    cliVersion,
    verifiedAt,
  })

  // 命令名或栈值本身就不成立：不查 catalog，直接 invalid。
  if (unknown.length > 0) {
    const notes = unknown.map(entry => describeUnknown(entry, index))
    notes.push('请先修正上面的 kind/取值；可用 vibestart_stacks 查看全部 kind 与合法取值。')
    return finish({
      status: 'invalid',
      ok: false,
      // 能归一的部分仍生成命令，方便模型看到「差在哪里」，但 run 不会执行。
      commandText: commandFor(resolved),
      notes,
    })
  }

  // 维护命令没有栈可校验：legal 是「参数结构合法」，不表示用户栈合法。
  // run 的 apply 闸门因此可以统一写成 status === 'legal'。
  if (command !== 'create') {
    // `add` 的写入必须点名至少一个能力：没有 ID 时只能 `add --list`（只读）。
    // 在 plan 阶段就判成 invalid，run 的 apply 闸门自然不会执行一条空 add。
    if (command === 'add' && preview === false && addonIdList(addons).length === 0) {
      return finish({
        status: 'invalid',
        ok: false,
        commandText: commandFor(undefined),
        notes: [
          'add 是位置参数命令：必须点名能力 ID，例如 addons="knip,ultracite"。',
          '可用能力（上游 add --list）通常含 knip / ultracite / docker / void；先以 addons 为空预览一次 add --list 确认。',
          '不要用 `add --yes` 空跑：上游会以 exit 2 拒绝。',
        ],
      })
    }

    const notes = []
    if (Object.keys(resolved).length > 0) notes.push('add / doctor / upgrade 不使用栈参数，stack 已忽略。')
    if (command === 'add' && addonIdList(addons).length === 0) {
      notes.push('未给 addons：这条命令是 `add --list`，列出当前版本可添加的能力（只读）；拿到 ID 后再带 addons 预览并 apply。')
    }
    if (preview && command !== 'doctor') {
      notes.push('预览命令带 --dry-run；apply=true 时维护写操作会追加 --yes。')
    } else if (command === 'doctor') {
      notes.push('doctor 是只读命令：preview 与 apply 都只加 --json，不加 --dry-run；需要跳过 registry 查询时传 offline=true。')
    }
    return finish({
      status: 'legal',
      ok: true,
      commandText: commandFor(undefined),
      notes,
    })
  }

  const match = catalog.matchingStacks(resolved, SAMPLE_LIMIT)
  if (match && Array.isArray(match.unknown)) {
    for (const entry of match.unknown) pushUnknown(unknown, entry)
  }
  if (unknown.length > 0) {
    const notes = unknown.map(entry => describeUnknown(entry, index))
    notes.push('catalog 不认识上面的 kind/取值；请先用 vibestart_stacks 确认。')
    return finish({
      status: 'invalid',
      ok: false,
      commandText: commandFor(resolved),
      notes,
    })
  }

  const complete = index.kindOrder.every(kind => Object.hasOwn(resolved, kind))
  const count = Number.isInteger(match?.count) ? match.count : 0

  if (complete && count > 0) {
    const hit = pickExact(match?.sample, resolved, index) ?? match?.sample?.[0]
    const values = hit?.values ? orderValues(hit.values, index) : resolved
    return finish({
      status: 'legal',
      ok: true,
      commandText: commandFor(values),
      verifiedAt: typeof hit?.verifiedAt === 'string' ? hit.verifiedAt : null,
    })
  }

  if (!complete && count > 0) {
    const missing = index.kindOrder.filter(
      kind => !Object.hasOwn(resolved, kind) && (index.domain[kind]?.length ?? 0) > 1,
    )
    const sample = (Array.isArray(match?.sample) ? match.sample : []).map(stack => {
      const values = orderValues(stack.values ?? {}, index)
      return {
        label: String(stack.label ?? ''),
        values,
        verifiedAt: String(stack.verifiedAt ?? ''),
        command: commandFor(values),
      }
    })
    const notes = []
    notes.push(
      missing.length > 0
        ? `还缺这些 kind：${missing.join('、')}。`
        : '栈尚未补全（部分 kind 只有一个候选，可省略；但当前仍有缺项）。',
    )
    notes.push('命令带 --json（非交互），CLI 不会替你猜缺失项；从 completions 里选一个完整组合，或补全后再执行。')
    return finish({
      status: 'incomplete',
      ok: true,
      commandText: commandFor(resolved),
      missing,
      completions: { count, sample },
      notes,
    })
  }

  // illegal：全部给齐但不命中，或缺口下没有任何合法补全。
  const expanded = complete ? orderValues(resolved, index) : fillDefaults(resolved, index)
  const nearest = catalog.nearestStacks(expanded, FIX_LIMIT)
  const fixes = (Array.isArray(nearest) ? nearest : []).map(fix => {
    const values = orderValues(fix.values ?? {}, index)
    return {
      label: String(fix.label ?? ''),
      values,
      verifiedAt: String(fix.verifiedAt ?? ''),
      distance: Number.isInteger(fix.distance) ? fix.distance : 0,
      diffs: Array.isArray(fix.diffs) ? fix.diffs.map(diff => ({
        kind: String(diff.kind ?? ''),
        from: String(diff.from ?? ''),
        to: String(diff.to ?? ''),
      })) : [],
      command: commandFor(values),
    }
  })

  const notes = []
  if (complete) {
    notes.push('当前组合不在上游校验过的合法组合里。')
  } else {
    notes.push('已选 kind 没有任何合法补全能同时满足。')
  }
  if (fixes.length > 0) {
    notes.push(`最近的合法组合与最小改动：${diffsToText(fixes[0].diffs) || '（无差异）'}。`)
    notes.push('fixes 按 distance 升序排列，command 可直接预览；不要靠删掉用户要求的能力来凑合法。')
  } else {
    notes.push('catalog 没有返回可用修复组合。')
  }

  return finish({
    status: 'illegal',
    ok: false,
    commandText: commandFor(resolved),
    fixes,
    notes,
  })
}
