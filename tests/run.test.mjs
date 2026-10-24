/**
 * tests/run.test.mjs — vibestart_run + lib/exec/shell.js 的安全边界测试
 *
 * 全部使用假 shell：记录 resolve()/execute()/result() 的调用，返回预设 stdout。
 * 这里绝不启动 npx、绝不访问网络。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseCliJson, runCommand } from '../lib/exec/shell.js'
import { assertToolSchemaDialect, validateSpecValue } from '../lib/plugin/schema.js'
import { createRunTool } from '../lib/tools/run.js'

// ---------- fixture catalog（与 plan.test 同形，独立复制一份，互不耦合） ----------

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
  { id: 'framework', name: 'Framework', optional: true, options: [{ id: 'spa', name: 'SPA' }, { id: 'next', name: 'Next.js' }] },
  { id: 'database', name: 'Database', optional: true, options: [{ id: 'sqlite', name: 'SQLite' }, { id: 'postgres', name: 'PostgreSQL' }] },
  { id: 'auth', name: 'Auth', optional: true, options: [{ id: 'better-auth', name: 'Better Auth' }] },
  { id: 'testing', name: 'Testing', optional: false, options: [{ id: 'playwright', name: 'Playwright' }, { id: 'e2e', name: 'TesterArmy e2e' }] },
]

function makeStack(framework, database, auth, testing) {
  return { toolchain: 'vite-plus', framework, database, auth, testing }
}

const rawStacks = [
  makeStack('spa', 'sqlite', 'better-auth', 'playwright'),
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
  addons: [],
  kinds,
  kindOrder,
  valueDomain,
  stackCount: stacks.length,
  stacks,
}

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
  if (unknown.length > 0) return { count: 0, sample: [], perKindOptions: {}, unknown }
  const matched = stacks.filter(stack => Object.entries(requested).every(([kind, value]) => stack.values[kind] === value))
  return { count: matched.length, sample: matched.slice(0, limit), perKindOptions: {}, unknown: [] }
}

catalog.nearestStacks = function nearestStacks(values, k = 3) {
  const target = {}
  for (const kind of kindOrder) {
    const raw = values?.[kind]
    target[kind] = raw === 'none' ? '' : raw !== undefined ? raw : valueDomain[kind][0]
  }
  return stacks
    .map(stack => {
      const diffs = kindOrder
        .filter(kind => stack.values[kind] !== target[kind])
        .map(kind => ({ kind, from: target[kind], to: stack.values[kind] }))
      return { label: stack.label, values: stack.values, verifiedAt: stack.verifiedAt, distance: diffs.length, diffs }
    })
    .sort((a, b) => a.distance - b.distance || a.label.localeCompare(b.label))
    .slice(0, k)
}

const FULL_STRING =
  'toolchain=vite-plus,framework=spa,database=sqlite,auth=better-auth,testing=playwright'
const FULL_COMMAND =
  'npx --yes vibestart-cli@0.1.1 create my-app --toolchain vite-plus --framework spa --database sqlite --auth better-auth --testing playwright'

const BASE_CONFIG = {
  skill: true,
  allowExec: true,
  allowApply: true,
  cliVersion: '0.1.1',
  runner: 'npx',
  maxStacks: 5,
  previewTimeoutMs: 180_000,
  applyTimeoutMs: 600_000,
}

// ---------- fake shell ----------

function createFakeShell({ stdout = '', stderr = '', exitCode = 0, reject = false } = {}) {
  const calls = []
  return {
    calls,
    resolve(request) {
      calls.push({ type: 'resolve', request })
      return { request }
    },
    async execute(spec) {
      calls.push({ type: 'execute', spec })
      return {
        async result() {
          calls.push({ type: 'result' })
          if (reject) throw new Error('spawn failed: ENOENT')
          return {
            exitCode,
            timedOut: false,
            aborted: false,
            stdout: { text: stdout },
            stderr: { text: stderr },
          }
        },
      }
    },
  }
}

function makeTool(shell, { config = {}, getShell } = {}) {
  return createRunTool({
    config: { ...BASE_CONFIG, ...config },
    getCatalog: () => catalog,
    getShell: getShell ?? (() => shell),
  })
}

function lastResolve(shell) {
  return shell.calls.find(call => call.type === 'resolve')?.request
}

// ---------- schema / render ----------

test('vibestart_run 的 schema 通过方言检查', () => {
  const tool = makeTool(createFakeShell())
  assert.deepEqual(assertToolSchemaDialect(tool), [])
  assert.equal(tool.name, 'vibestart_run')
  assert.equal(tool.isConcurrencySafe(), true)
})

test('render 对垃圾输入降级且不抛', () => {
  const tool = makeTool(createFakeShell())
  assert.equal(tool.output.render({}, undefined)[0].type, 'text')
  const rendered = tool.output.render({}, {
    applied: false,
    status: 'available',
    command: 'npx x',
    cliVersion: '0.1.1',
    exitCode: 0,
    timedOut: false,
    aborted: false,
    files: ['a', 'b'],
    nextSteps: ['pnpm install'],
    message: null,
    stderr: null,
    stack: null,
    raw: null,
  })
  assert.match(rendered[0].text, /VibeStart/u)
  assert.match(rendered[0].text, /npx x/u)
})

// ---------- 默认 dry-run ----------

test('默认 apply=false：只跑 --dry-run，绝不写盘；能从警告前缀里解析 JSON', async () => {
  const stdout = [
    '(node:14584) ExperimentalWarning: glob is an experimental feature and might change at any time',
    '(Use `node --trace-warnings ...` to show where the warning was created)',
    JSON.stringify({
      ok: true,
      status: 'available',
      stack: { toolchain: 'vite-plus', framework: 'spa', database: 'sqlite', auth: 'better-auth', testing: 'playwright' },
      files: ['package.json', 'src/main.tsx'],
      nextSteps: ['pnpm install', 'pnpm dev'],
    }),
    '',
  ].join('\n')
  const shell = createFakeShell({ stdout })
  const tool = makeTool(shell)

  const value = await tool.execute({ command: 'create', stack: FULL_STRING })

  assert.equal(shell.calls.filter(call => call.type === 'result').length, 1)
  const request = lastResolve(shell)
  assert.equal(request.command, `${FULL_COMMAND} --dry-run --json`)
  assert.equal(request.timeoutMs, 180_000)
  assert.equal(request.onExpiry, 'kill')
  assert.ok(request.stdoutMaxBytes > 0)
  assert.equal(request.workdir, undefined, 'create 不传 workdir')
  // npm 缓存必须在工作区内，否则 npx 在默认沙箱下会 EPERM。
  assert.equal(request.env.npm_config_cache, '.dsh-vibestart-npm-cache')
  assert.equal(request.env.npm_config_loglevel, 'error')
  assert.equal(request.env.npm_config_update_notifier, 'false')

  assert.equal(value.ok, true)
  assert.equal(value.applied, false)
  assert.equal(value.status, 'available')
  assert.equal(value.exitCode, 0)
  assert.deepEqual(value.files, ['package.json', 'src/main.tsx'])
  assert.deepEqual(value.nextSteps, ['pnpm install', 'pnpm dev'])
  assert.equal(value.stack.framework, 'spa')
  assert.equal(value.stderr, null)
  assert.deepEqual(validateSpecValue(tool.output.schema, value), [])
})

test('apply=true：create 加 --json 但绝不含 --yes；applied 由 CLI status 决定', async () => {
  const stdout = JSON.stringify({ ok: true, status: 'written', stack: { framework: 'spa' }, nextSteps: [] })
  const shell = createFakeShell({ stdout })
  const tool = makeTool(shell)

  const value = await tool.execute({ command: 'create', stack: FULL_STRING, directory: 'apps/web', apply: true })

  assert.equal(lastResolve(shell).command, `${FULL_COMMAND.replace('create my-app', 'create apps/web')} --json`)
  // 命令里只允许 npx 自己的 --yes，create 子命令后面不得再出现 --yes。
  assert.equal((lastResolve(shell).command.match(/--yes/gu) ?? []).length, 1)
  assert.doesNotMatch(lastResolve(shell).command, /create[^]*--yes/u)
  assert.equal(lastResolve(shell).timeoutMs, 600_000)
  assert.equal(value.ok, true)
  assert.equal(value.applied, true)
  assert.equal(value.status, 'written')
  assert.deepEqual(validateSpecValue(tool.output.schema, value), [])
})

// ---------- apply 闸门 ----------

test('apply=true 且栈 incomplete → blocked，完全不 spawn', async () => {
  const shell = createFakeShell()
  const tool = makeTool(shell)
  const value = await tool.execute({
    command: 'create',
    stack: 'toolchain=vite-plus,framework=spa,testing=playwright',
    apply: true,
  })
  assert.equal(shell.calls.length, 0)
  assert.equal(value.ok, false)
  assert.equal(value.status, 'blocked')
  assert.match(value.message, /legal|incomplete/u)
})

test('apply=true 且栈 illegal → blocked，并给出最近候选命令', async () => {
  const shell = createFakeShell()
  const tool = makeTool(shell)
  const value = await tool.execute({
    command: 'create',
    stack: 'toolchain=vite-plus,framework=next,database=sqlite,auth=better-auth,testing=playwright',
    apply: true,
  })
  assert.equal(shell.calls.length, 0)
  assert.equal(value.status, 'blocked')
  assert.match(value.message, /illegal/u)
  assert.match(value.message, /create my-app/u)
})

test('预览 incomplete：允许执行，让 CLI 自己报 incomplete-stack', async () => {
  const stdout = JSON.stringify({
    ok: false,
    status: 'incomplete-stack',
    error: { code: 'incomplete-stack', message: 'missing database' },
  })
  const shell = createFakeShell({ stdout, exitCode: 1 })
  const tool = makeTool(shell)
  const value = await tool.execute({
    command: 'create',
    stack: 'toolchain=vite-plus,framework=spa,testing=playwright',
  })
  assert.equal(shell.calls.filter(call => call.type === 'result').length, 1)
  assert.match(lastResolve(shell).command, /--dry-run --json$/u)
  assert.equal(value.ok, false)
  assert.equal(value.status, 'incomplete-stack')
  assert.match(value.message, /missing database/u)
})

test('预览 invalid：直接 blocked，不 spawn', async () => {
  const shell = createFakeShell()
  const tool = makeTool(shell)
  const value = await tool.execute({
    command: 'create',
    stack: 'toolchain=vite-plus,database=oracle',
  })
  assert.equal(shell.calls.length, 0)
  assert.equal(value.status, 'blocked')
  assert.match(value.message, /oracle|无效/u)
})

// ---------- 目录安全 ----------

test('directory/projectDir 拒绝绝对路径与 ..', async () => {
  const shell = createFakeShell()
  const tool = makeTool(shell)

  for (const directory of ['../outside', 'a/../../b', 'C:\\outside', '/tmp/x', '~/.ssh', 'a&b', '$(calc)', 'a;b']) {
    const value = await tool.execute({ command: 'create', stack: FULL_STRING, directory })
    assert.equal(value.ok, false, `${directory} 应被拒绝`)
    assert.equal(value.status, 'blocked')
    assert.match(value.message, /相对路径|\.\.|shell 特殊字符/u)
  }
  assert.equal(shell.calls.length, 0, '被拒绝时不得 spawn')

  const projectDir = await tool.execute({ command: 'doctor', projectDir: '..\\escape', apply: true })
  assert.equal(projectDir.status, 'blocked')
  assert.equal(shell.calls.length, 0)
})

// ---------- 维护命令 ----------

test('维护 add apply=true：workdir 指向项目根，命令加 --yes 且不带栈 flag', async () => {
  const stdout = JSON.stringify({
    ok: true,
    status: 'completed',
    next: ['pnpm install'],
    changes: ['package.json'],
  })
  const shell = createFakeShell({ stdout })
  const tool = makeTool(shell)

  // add 的能力 ID 是位置参数：addons 会被展开成 `add knip ultracite`。
  const value = await tool.execute({ command: 'add', projectDir: 'apps/web', apply: true, addons: 'knip,ultracite' })

  const request = lastResolve(shell)
  assert.equal(request.workdir, 'apps/web')
  assert.equal(request.command, 'npx --yes vibestart-cli@0.1.1 add knip ultracite --yes --json')
  assert.doesNotMatch(request.command, /--toolchain|--framework/u)
  assert.equal(value.applied, true)
  assert.deepEqual(value.nextSteps, ['pnpm install'])
  assert.deepEqual(validateSpecValue(tool.output.schema, value), [])
})

test('维护 doctor apply=true：只读命令不加 --yes', async () => {
  const stdout = JSON.stringify({ ok: true, status: 'healthy' })
  const shell = createFakeShell({ stdout })
  const tool = makeTool(shell)
  await tool.execute({ command: 'doctor', directory: 'apps/web', apply: true })
  assert.equal(lastResolve(shell).command, 'npx --yes vibestart-cli@0.1.1 doctor --json')
  assert.equal(lastResolve(shell).workdir, 'apps/web')
})

test('doctor 永不追加 --dry-run（preview/apply 都一样）；offline 只对 doctor 生效', async () => {
  const stdout = JSON.stringify({ ok: true, status: 'healthy' })

  const previewShell = createFakeShell({ stdout })
  await makeTool(previewShell).execute({ command: 'doctor', projectDir: 'apps/web' })
  assert.equal(lastResolve(previewShell).command, 'npx --yes vibestart-cli@0.1.1 doctor --json')
  assert.doesNotMatch(lastResolve(previewShell).command, /--dry-run/u)

  const offlineShell = createFakeShell({ stdout })
  await makeTool(offlineShell).execute({ command: 'doctor', projectDir: 'apps/web', apply: true, offline: true })
  assert.equal(lastResolve(offlineShell).command, 'npx --yes vibestart-cli@0.1.1 doctor --offline --json')
  assert.doesNotMatch(lastResolve(offlineShell).command, /--dry-run/u)

  const addShell = createFakeShell({ stdout: JSON.stringify({ ok: true, status: 'completed' }) })
  await makeTool(addShell).execute({ command: 'add', projectDir: 'apps/web', apply: true, offline: true, addons: 'knip' })
  assert.equal(lastResolve(addShell).command, 'npx --yes vibestart-cli@0.1.1 add knip --yes --json')
  assert.doesNotMatch(lastResolve(addShell).command, /--offline/u)
})

test('add apply=true 但没有能力 ID：不 spawn，返回 blocked', async () => {
  const shell = createFakeShell({ stdout: JSON.stringify({ ok: true }) })
  const tool = makeTool(shell)
  const value = await tool.execute({ command: 'add', projectDir: 'apps/web', apply: true })
  assert.equal(shell.calls.length, 0)
  assert.equal(value.ok, false)
  assert.equal(value.status, 'blocked')
  assert.match(value.message, /能力|addon/iu)
})

// ---------- 配置 / shell 闸 ----------

test('allowExec=false：不 spawn，message 同时给 allowExec 与 pwsh/bash 出路，仍返回命令', async () => {
  const shell = createFakeShell()
  const tool = makeTool(shell, { config: { allowExec: false } })
  const value = await tool.execute({ command: 'create', stack: FULL_STRING })
  assert.equal(shell.calls.length, 0)
  assert.equal(value.ok, false)
  assert.equal(value.status, 'blocked')
  assert.match(value.message, /allowExec/u)
  assert.match(value.message, /pwsh\/bash/u)
  assert.equal(value.command, `${FULL_COMMAND} --dry-run --json`)
})

test('allowApply=false + apply=true：拒绝写盘，但预览命令保留', async () => {
  const shell = createFakeShell()
  const tool = makeTool(shell, { config: { allowApply: false } })
  const value = await tool.execute({ command: 'create', stack: FULL_STRING, apply: true })
  assert.equal(shell.calls.length, 0)
  assert.equal(value.status, 'blocked')
  assert.match(value.message, /allowApply/u)
  assert.equal(value.command, `${FULL_COMMAND} --json`)
})

test('ctx.shell 缺失：结构化错误、不抛，message 提到 allowExec 与 pwsh/bash', async () => {
  const tool = makeTool(undefined, { getShell: () => undefined })
  const value = await tool.execute({ command: 'create', stack: FULL_STRING })
  assert.equal(value.ok, false)
  assert.equal(value.status, 'blocked')
  assert.match(value.message, /allowExec|shell/u)
  assert.match(value.message, /pwsh\/bash/u)
  assert.equal(value.command, `${FULL_COMMAND} --dry-run --json`)
  assert.deepEqual(validateSpecValue(tool.output.schema, value), [])
})

test('ctx.shell 的 result() reject → 转成结构化结果，不向外抛', async () => {
  const shell = createFakeShell({ reject: true })
  const tool = makeTool(shell)
  const value = await tool.execute({ command: 'create', stack: FULL_STRING })
  assert.equal(value.ok, false)
  assert.equal(value.exitCode, null)
  assert.equal(value.status, 'error')
  assert.match(value.stderr, /spawn failed/u)
  assert.match(value.message, /spawn failed/u)
  assert.deepEqual(validateSpecValue(tool.output.schema, value), [])
})

test('npmCacheDir="" 时不注入 npm_config_cache，其余 npm 环境变量仍在', async () => {
  const shell = createFakeShell({ stdout: JSON.stringify({ ok: true, status: 'available' }) })
  const tool = makeTool(shell, { config: { npmCacheDir: '' } })
  await tool.execute({ command: 'create', stack: FULL_STRING })
  const request = lastResolve(shell)
  assert.equal(Object.hasOwn(request.env, 'npm_config_cache'), false)
  assert.equal(request.env.npm_config_loglevel, 'error')
  assert.equal(request.env.npm_config_update_notifier, 'false')
})

test('自定义 npmCacheDir 原样注入（相对路径由 npm 按 cwd 解析）', async () => {
  const shell = createFakeShell({ stdout: JSON.stringify({ ok: true, status: 'available' }) })
  const tool = makeTool(shell, { config: { npmCacheDir: '.cache/npm' } })
  await tool.execute({ command: 'create', stack: FULL_STRING })
  assert.equal(lastResolve(shell).env.npm_config_cache, '.cache/npm')
})

// ---------- 超时钳制 ----------

test('timeoutMs 钳制到 [5000, 配置上限]；非法值回退默认', async () => {
  const shell = createFakeShell({ stdout: JSON.stringify({ ok: true, status: 'available' }) })
  const tool = makeTool(shell)

  await tool.execute({ command: 'create', stack: FULL_STRING, timeoutMs: 999_999_999 })
  assert.equal(lastResolve(shell).timeoutMs, 180_000)

  shell.calls.length = 0
  await tool.execute({ command: 'create', stack: FULL_STRING, timeoutMs: 1 })
  assert.equal(lastResolve(shell).timeoutMs, 5_000)

  shell.calls.length = 0
  await tool.execute({ command: 'create', stack: FULL_STRING, timeoutMs: 'abc' })
  assert.equal(lastResolve(shell).timeoutMs, 180_000)

  shell.calls.length = 0
  await tool.execute({ command: 'create', stack: FULL_STRING, apply: true, timeoutMs: 999_999_999 })
  assert.equal(lastResolve(shell).timeoutMs, 600_000)
})

// ---------- parseCliJson / runCommand ----------

test('parseCliJson：跳过 Node 警告与 npm 横幅，失败返回 null', () => {
  const withWarning = [
    '(node:14584) ExperimentalWarning: glob is an experimental feature and might change at any time',
    '(Use `node --trace-warnings ...` to show where the warning was created)',
    '{',
    '  "ok": true',
    '}',
  ].join('\n')
  assert.deepEqual(parseCliJson(withWarning), { ok: true })

  const withNpmBanner = ['npm notice', 'npm notice New major version', '{"ok":true,"status":"available"}'].join('\n')
  assert.deepEqual(parseCliJson(withNpmBanner), { ok: true, status: 'available' })

  // Windows 上实测 stdout 是 CRLF：多行前缀 + 花括号行不能因为 \r 偏移而失配。
  const crlf = 'warning one\r\nwarning two\r\n{\r\n  "ok": true\r\n}'
  assert.deepEqual(parseCliJson(crlf), { ok: true })

  // 末尾混入日志行时退一步解析到最后一个 }。
  assert.deepEqual(parseCliJson('{"ok":true}\nsome trailing log'), { ok: true })

  assert.equal(parseCliJson('not json at all'), null)
  assert.equal(parseCliJson('{ broken json'), null)
  assert.equal(parseCliJson(''), null)
  assert.equal(parseCliJson(undefined), null)
})

test('runCommand：shell 缺失与同步抛错都转成结构化结果', async () => {
  const missing = await runCommand({ shell: undefined, command: 'x', timeoutMs: 1000 })
  assert.equal(missing.exitCode, null)
  assert.match(missing.stderr, /shell 不可用/u)

  const throwing = await runCommand({
    shell: {
      resolve() {
        throw new Error('bad workdir')
      },
      async execute() {
        throw new Error('never reached')
      },
    },
    command: 'x',
    timeoutMs: 1000,
  })
  assert.equal(throwing.exitCode, null)
  assert.match(throwing.stderr, /bad workdir/u)
})

test('runCommand：env/workdir/signal 原样进入 resolve() 请求', async () => {
  let captured
  const controller = new AbortController()
  const shell = {
    resolve(request) {
      captured = request
      return request
    },
    async execute() {
      return {
        async result() {
          return { exitCode: 0, timedOut: false, aborted: false, stdout: { text: 'ok' }, stderr: { text: '' } }
        },
      }
    },
  }
  const result = await runCommand({
    shell,
    command: 'npx x',
    timeoutMs: 12_345,
    workdir: 'apps/web',
    signal: controller.signal,
    env: { npm_config_cache: '.cache' },
  })
  assert.equal(result.stdout, 'ok')
  assert.equal(captured.command, 'npx x')
  assert.equal(captured.timeoutMs, 12_345)
  assert.equal(captured.workdir, 'apps/web')
  assert.equal(captured.signal, controller.signal)
  assert.deepEqual(captured.env, { npm_config_cache: '.cache' })
})
