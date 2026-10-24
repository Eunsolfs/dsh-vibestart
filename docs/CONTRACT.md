# dsh-vibestart 内部契约（开发期必读）

本文件是并行开发的**唯一事实来源**。任何模块的公开签名、数据格式、工具 schema 都以这里为准；
实现与契约冲突时，先改契约（并在这里记录），再改实现。

## 1. 产品目标

把 [VibeStart](https://github.com/Eunsolfs/vibestart)（`npx vibestart-cli`，全栈 TypeScript 脚手架）
做成 DeepSeek Harness 的插件 `dsh-vibestart`，让会话中能：

1. **离线秒懂可选栈**：不联网、不跑 npm，就能列出 15 个 kind、每个 kind 的选项、以及 3409 个已校验组合。
2. **校验用户的栈并给出命令**：部分栈 → 合法补全；非法组合 → 最近的合法组合与最小改动；最后给出可直接执行的完整命令。
3. **受控执行**：通过 DSH 官方执行缝 `ctx.shell` 跑 `npx vibestart-cli`，默认 `--dry-run`，只有 `apply: true` 才真写。

运行时零第三方依赖、零网络（除第 3 条由 `ctx.shell` 启动的 CLI 进程自己联网）。

## 2. 仓库布局与写入归属

```
dsh-vibestart/
  index.js                     [Lead] 薄入口，只重导出
  package.json                 [Lead]
  cordis.patch.yml             [Lead]
  README.md / README.en.md     [C-skill]
  CHANGELOG.md / LICENSE / icon.svg / THIRD_PARTY_NOTICES.md   [C-skill]
  lib/
    config.js                  [Lead] 常量（CLI 版本、runner、超时、输出上限）
    parse-stack.js             [Lead] 栈字符串语法（parseStackInput / normalizeStackValue）
    presentation/
      markdown.js              [Lead] 共享 Markdown 渲染小工具
      index.js                 [Lead] 再导出
    plugin/
      meta.js                  [Lead] name / inject
      config.js                [Lead] normalizeConfig + Standard Schema Config
      schema.js                [Lead] SchemaSpec 方言构造助手
      skill.js                 [Lead] 技能 provider
      skill-body.js            [Lead] frontmatter 拆分
      index.js                 [Lead] apply()
    catalog/
      index.js                 [A-catalog] 快照加载 + 查询 API
      encode.js                [A-catalog] 紧凑行编解码
      kinds.js                 [A-catalog] kind 顺序/中文标签
    plan/
      index.js                 [B-planner] 纯函数：校验 / 补全 / 最近合法 / 命令生成
    exec/
      shell.js                 [B-planner] 通过 ctx.shell 执行 CLI + JSON 解析
    tools/
      index.js                 [Lead] toolSpecs 汇总
      stacks.js                [A-catalog] vibestart_stacks
      plan.js                  [B-planner] vibestart_plan
      run.js                   [B-planner] vibestart_run
  data/
    snapshot.json              [A-catalog] 紧凑快照（生成物，入库）
  scripts/
    snapshot.mjs               [A-catalog] 从 `--list --json` 重建快照
    verify.mjs                 [Lead] 结构性自检（package.json/导出/快照/技能）
  skills/vibestart/
    SKILL.md                   [C-skill]
    references/create.md       [C-skill]
    references/maintenance.md  [C-skill]
  tests/
    catalog.test.mjs           [A-catalog]
    plan.test.mjs              [B-planner]
    run.test.mjs               [B-planner]
    integration.test.mjs       [Lead] 工具注册 + 快照 + 技能端到端
  .github/workflows/ci.yml     [C-skill]
```

**写入纪律**：只写自己名下的文件。需要改别人的文件时，发消息给 Lead，不要直接改。

## 3. 编码约定

- 纯 ESM，`import ... from '../x.js'`（必须带 `.js`），无构建步骤，无第三方依赖。
- 只在 `lib/plugin/*`、`lib/exec/*`、`lib/tools/*` 里接触 DSH API；`lib/catalog/*`、`lib/plan/*` 必须**零 DSH import**（可被 `node --test` 直接跑）。
- 注释用中文，标识符用英文；工具 `description` 用中文 + 必要的英文关键词（便于模型与检索命中）。
- 不用 `Date.now()` 决定正确性；快照生成时间只作展示。
- 不能用 `process.exit()`；错误以返回结构或 throw 表达。

## 4. 快照格式 `data/snapshot.json`

上游来源：`npx --yes vibestart-cli@<version> --list --json`（stdout 前面可能混入 Node 的 `ExperimentalWarning` 行，
解析时必须从第一个独立的 `{` 起截取，见 §6.1）。

```jsonc
{
  "schemaVersion": 1,
  "cli": { "package": "vibestart-cli", "version": "0.1.1" },
  "generatedAt": "2026-10-24T07:30:00.000Z",
  "source": "npx --yes vibestart-cli@0.1.1 --list --json",
  "packageManagers": ["pnpm", "bun"],
  "defaultPackageManager": "pnpm",
  "addons": [{ "id": "knip", "name": "Knip", "description": "…", "default": true }],
  "kinds": [
    {
      "id": "framework",
      "name": "Framework",
      "optional": true,
      "options": [{ "id": "spa", "name": "SPA", "description": "…" }]
    }
  ],
  "kindOrder": ["toolchain", "frontend", "…"],
  "valueDomain": { "framework": ["", "spa", "tanstack-start", "next"], "toolchain": ["vite-plus"] },
  "stacks": {
    "width": 15,
    "rows": ["000000000000000", "…"],
    "labels": ["spa-hono-orpc-postgres-better-auth-electron-expo-docker", "…"],
    "dates": ["2026-10-23T02:19:59.004Z", "…"],
    "dateIndex": [0, 0, 1, "…"]
  },
  "integrity": { "stackCount": 3409, "sha256": "<canonical stacks JSON 的 sha256>" }
}
```

要点：

- `valueDomain[kind]` 是**该 kind 的取值全集**，元素的**下标**即 `rows` 里对应位的 base36 编码。
  - required kind：`options` 里全部 `id`，顺序同 `options`。
  - optional kind：`""`（表示 none）在最前，其后是 `options` 的 `id`。
- `rows[i]` 是长度 `width` 的字符串，第 k 位 = `valueDomain[kindOrder[k]]` 中取值的下标（base36，a=10）。
- `labels[i]` 是上游原始 label；`dateIndex[i]` 是 `stacks.dates` 的下标。
- `integrity.sha256` = 对 `stacks.rows.map((r,i)=>[r,labels[i],dates[dateIndex[i]]])` 的
  `JSON.stringify` 取 sha256（hex）。用于 `scripts/verify.mjs` 与测试的完整性断言；编码/解码改动时必须同步更新。
- 生成物**必须**通过 `node scripts/verify.mjs`。快照更新后，测试里对「kind 数、stack 数」的断言跟随快照，不写死魔法数以外的假设。

## 5. `lib/catalog/index.js`（A-catalog 实现，B/Lead 消费）

```js
/** @returns {Snapshot} 同步读取并解析 data/snapshot.json，按 mtime 记忆化。 */
export function loadSnapshot()

/** @returns {Catalog} 规范化视图（每次调用返回同一对象引用；只读） */
export function loadCatalog()

/** @returns {object[]} kind 列表（保持 kindOrder） */
export function getKinds()

/** @param {string} id @returns {object|undefined} */
export function getKind(id)

/** @returns {{kindOrder:string[], kindCount:number, stackCount:number, cliVersion:string, kinds:object[]}} */
export function summary()

/**
 * 按部分栈过滤合法组合。
 * @param {Record<string,string>} partial 只包含想固定的 kind；值必须是 valueDomain 里的值（""=none，也接受 "none"）
 * @returns {{count:number, sample:Stack[], perKindOptions:Record<string,string[]>, unknown:{kind:string,value:string}[]}}
 */
export function matchingStacks(partial, limit = 5)

/**
 * 给定完整栈值（缺省位按 valueDomain 全量展开），找最近的合法组合。
 * @param {Record<string,string>} values
 * @param {number} [k] 最多返回几个
 * @returns {{label:string, values:Record<string,string>, verifiedAt:string, distance:number,
 *            diffs:{kind:string, from:string, to:string}[]}[]}  按 distance 升序
 */
export function nearestStacks(values, k = 3)

/** @param {Record<string,string>} values 规范化：kind 校验 + ""/"none" 归一（返回 {values, unknown}） */
export function normalizeValues(values)

/** 最近一次 catalog 加载失败的原因（未失败为 null），供工具层给出可读报错。 */
export function lastCatalogError()

/** 一句话能力摘要（中文），verify 与技能描述共用，避免数字手抄漂移。 */
export function capabilitySummaryZh()

export const CATALOG_PATH
```

`Catalog` 形状：

```js
{
  cliVersion, generatedAt, source,
  packageManagers, defaultPackageManager, addons,
  kinds: [{id, name, optional, options:[{id,name,description}]}],
  kindOrder, valueDomain,
  stackCount,
  stacks: [{ label, values, verifiedAt }],   // 解码后的全量，按上游顺序
  matchingStacks(partial, limit),            // 与模块级导出同一实现（plan 依赖它）
  nearestStacks(values, k),                  // 同上
}
```

**为什么把两个查询函数挂在 Catalog 上**：`lib/plan` 是纯函数、catalog 通过参数注入；
如果只有模块级导出，plan 要么让 tools 层多注入一套函数，要么自己再扫一遍 stacks（第二套
逻辑，迟早与 catalog 的语义分叉）。因此约定：`catalog.matchingStacks` /
`catalog.nearestStacks` 与同名模块导出是**同一份实现**，Catalog 仍视为只读。
```

`Stack` = `{ label, values, verifiedAt }`。

## 6. `lib/plan/index.js`（B-planner 实现，纯函数）

```js
/**
 * 校验并规划一个栈。
 * @param {object} input
 * @param {Record<string,string>} input.stack            用户/模型给的栈（可部分）
 * @param {object} input.catalog                         loadCatalog() 的结果（依赖注入，便于测试）
 * @param {string} [input.directory='my-app']
 * @param {string} [input.command='create']               create|add|doctor|upgrade
 * @param {string} [input.addons]                        "knip,ultracite" | "none"
 * @param {'pnpm'|'bun'} [input.packageManager]
 * @param {boolean} [input.preview=true]                 true → 追加 --dry-run --json
 * @param {string} [input.cliVersion]                    默认取 catalog.cliVersion
 * @param {'npx'|'pnpm-dlx'} [input.runner='npx']
 */
export function planStack(input)

/**
 * 只生成命令（无 catalog 时也可用，由调用方保证栈已合法）。
 * @returns {string} 形如 `npx --yes vibestart-cli@0.1.1 create my-app --framework spa … --dry-run --json`
 */
export function buildCommand({ command, directory, values, addons, packageManager, preview, cliVersion, runner })

/** 把任意写法的栈值归一："none"/"null"/undefined → ""；大小写与空白容错。 */
export function normalizeStackValue(value)   // 实际实现见 lib/parse-stack.js，plan/index.js 再导出

/**
 * 解析模型给的栈字符串（§8.0 语法）。实现见 lib/parse-stack.js。
 * @param {string} input
 * @returns {{values: Record<string,string>, unknown: {kind:string, value:string}[]}}
 */
export function parseStackInput(input)       // 同上，plan/index.js 只做 re-export
```

`planStack` 返回：

```js
{
  status: 'legal' | 'illegal' | 'incomplete' | 'invalid',
  ok: boolean,                       // legal || incomplete
  command: string,                   // 可执行命令（incomplete 时也给出，带 --no-interactive 提示）
  resolved: Record<string,string>,   // 归一后的输入
  missing: string[],                 // omitted 且在 catalog 里有多个候选的 kind（仅 incomplete 时有意义）
  fixes: [{label, values, verifiedAt, distance, diffs:[{kind,from,to}], command}],  // illegal 时非空，按 distance 升序
  completions: { count: number, sample: [{label, values, verifiedAt, command}] },  // incomplete 时非空
  notes: string[],                   // 面向模型的中文提示（例如「Docker 需要 web 或 server」）
  unknown: [{kind,value}],           // 不认识的 kind 或非法取值
  cliVersion, verifiedAt             // 命中组合的校验时间（legal 时）
}
```

判定规则：

- `unknown.length > 0` → `invalid`。
- 所有 15 个 kind 都给出取值，且命中 `matchingStacks` → `legal`。
- 给了全部值但不命中 → `illegal`，`fixes` 用 `nearestStacks`。
- 缺值且合法补全存在（`matchingStacks` 命中）→ `incomplete`，`completions` 给出样本 + 数量。
- 缺值且不存在任何补全 → `illegal`（`fixes` 为最近合法，用缺省值展开后计算）。

命令生成规则（必须与上游 CLI 一致）：

- `create`：`<runner> <package>@<version> create <directory> --<kind> <value> … --addons <ids> --package-manager <pm> --dry-run --json`
  - 只输出 optional kind 的 `""` 位：写 `--<kind> none`；required kind 全部输出。
  - `--kind value` 按 `kindOrder` 顺序；`packageManager` 只在给了的时候输出。
  - `--addons` 只在明确给出时输出（`none` 原样输出）。
- `add`：能力 ID 是**位置参数**——`add knip ultracite [--dry-run|--yes] --json`；`addons` 里的逗号列表即位置参数。
  没给 `addons` 时退化为只读的 `add --list --json`（列能力），此时 `preview=false`（apply）必须判 `invalid`，
  因为上游空 `add` 会 exit 2。
- `doctor`：**永不带 `--dry-run`**（上游只允许 create/add/upgrade；传了 exit 2）；`--offline` 只对它生效。
- `upgrade`：`upgrade [--dry-run|--yes] --json`。
- 维护命令都不带栈 flag；`--cwd` 不使用（项目根通过工作目录传入）。
- 传给 shell 时，命令字符串里的路径与参数值如果含空格，用双引号包裹（Windows 优先）。

## 7. `lib/exec/shell.js`（B-planner 实现）

```js
/**
 * 通过 ctx.shell 跑一条命令并收集结果。
 * @param {object} options
 * @param {object} options.shell            ctx.shell 服务
 * @param {string} options.command
 * @param {number} options.timeoutMs
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{exitCode:number|null, timedOut:boolean, aborted:boolean, stdout:string, stderr:string}>}
 */
export async function runCommand(options)

/** 从 CLI stdout 里取出那一个 JSON 对象：跳过 Node 警告行、npm 横幅，从第一个以 { 开头的独立行开始解析。 */
export function parseCliJson(stdout)

/** 组装可执行命令：runner + 包名@版本 + 子命令 + flags。 */
export function buildCliCommand({ runner, cliVersion, args })
```

约束：

- 只用 `ctx.shell.resolve({command, timeoutMs, onExpiry:'kill', stdoutMaxBytes})` + `execute` + `result()`；
  不 import `@deepseek-ai/dsh-shell`（避免把类型依赖带进运行时），只按契约调用。
- `result()` 可能 reject（基础设施失败）→ 捕获后转成 `{ exitCode: null, stdout:'', stderr: message }`，不向外抛。
- 输出超过 200k 字符时截断（`lib/config.js` 的 `MAX_OUTPUT_CHARS`）。

## 8. 三个工具（模型可见契约）

命名对齐兄弟插件 `dsh-watermelon-ui` 的 `watermelon_*` 风格 → 本插件统一 `vibestart_*`。
全部 `isConcurrencySafe: () => true`（stacks/plan 纯计算；run 由用户显式触发，重复执行由 CLI 自己拒绝）。

**工具一律导出工厂函数**，由 `lib/tools/index.js` 装配：

```js
// lib/tools/stacks.js
export function createStacksTool(deps = {})   // deps = { config }
// lib/tools/plan.js
export function createPlanTool(deps = {})     // deps = { config, getCatalog }
// lib/tools/run.js
export function createRunTool(deps = {})      // deps = { config, getShell, getCatalog }
```

原因：run 需要运行时注入 `ctx.shell`；统一签名后测试可以完全脱离 DSH 运行时
（假 config、假 catalog、假 shell）。工厂返回的都是同一个工具规格对象形状。

### 8.0 栈参数的线上语法（重要）

SchemaSpec 方言里 object 的 `additionalProperties` 只能是布尔值，无法表达
「任意 kind → string」的映射，因此**模型面向的 `stack` 参数是字符串**：

```
"framework=spa,backend=hono,api=orpc,database=sqlite,auth=better-auth"
```

- 分隔：`,` 或 `;`；元素 `kind=value`；允许空格。
- `value` 取 `none` / `""` 均表示该 optional kind 不选（归一为 `""`）。
- 允许只写部分 kind（plan/stacks 会做合法补全）。
- 解析在工具层完成：`parseStackInput(string)` → `{ values: Record<string,string>, unknown: [{kind,value}] }`。
  该解析函数放在 **B-planner** 的 `lib/plan/index.js` 里导出（stacks 工具也用它）。
- 工具输出里的 `stack` 仍是对象（`additionalProperties: true`），供模型读。

### 8.1 `vibestart_stacks`

- `kind?: string` 单个 kind id（如 `database`）→ 列出该 kind 的选项与「含该选项的合法组合数」。
- `stack?: string` 部分栈（§8.0 语法）→ 合法补全数量 + 样本 + 每个 kind 的可选值。
- `limit?: integer` 1–8，默认取配置 `maxStacks`。
- **无参数**时返回总览：CLI 版本、kind 数、组合数、每个 kind 的选项摘要。

输出（`output.schema`）：

```js
{
  cliVersion: string,
  kindOrder: string[], kindCount: integer, stackCount: integer,
  kinds: [{ id, name, optional, options: [{ id, name, description, legalCount? }] }],
  unknown: [{ kind: string, value: string, reason: string }],   // 必填；未知 kind / 非法取值 / 语法片段
  match: null | {
    requested: object,
    legalCount: integer,
    sample: [{ label, stack: object, verifiedAt: string }],
    perKindOptions: { [kind]: string[] }
  }
}
```

- 未知取值**不抛错**：已知部分照常过滤并返回，问题进 `unknown`。
- `kind` 模式下，optional kind 的 `options` 首位多一项 `{id:"", name:"None（不选）"}`，
  使各选项 `legalCount` 之和等于 `stackCount`；overview 模式不逐项算 `legalCount`。

### 8.2 `vibestart_plan`

参数：`stack`（string，必填，§8.0 语法）、`directory`、`command`（枚举 create/add/doctor/upgrade，默认 create）、
`addons`、`packageManager`（pnpm|bun）、`preview`（boolean，默认 true）。

输出：`planStack()` 的返回值（`output.schema` 与之同构，禁止 `additionalProperties` 之外的惊喜字段）。

### 8.3 `vibestart_run`

参数：`command`（必填，同上）、`directory`、`stack`（string，§8.0 语法）、`addons`、`packageManager`、
`apply`（boolean，默认 false）、`noInstall`、`noGit`、`noCheck`（boolean）、`timeoutMs`（integer，按配置上限钳制）。

行为：

- `apply=false` → 命令追加 `--dry-run --json`，只预览，绝不写盘。
- `apply=true` → 追加 `--json`；`create` **不允许** `--yes`；维护写操作追加 `--yes`。
- `apply=true` 前先用 `planStack()` 校验；`status !== 'legal'` 直接返回失败，不执行命令。
- `directory`/`projectDir` 必须是**相对路径**且不含 `..`（防止把文件写到工作区外）。
- `ctx.shell` 不存在 → 返回结构化错误，提示改用 `pwsh`/`bash` 工具执行 `command`。
- 配置 `allowExec=false` 或（`apply=true` 时）`allowApply=false` → 返回拒绝原因。

输出：

```js
{
  ok: boolean, applied: boolean, command: string,
  exitCode: integer|null, timedOut: boolean, aborted: boolean,
  status: string,                 // CLI 返回的 status（available/written/needs-install/…）或 'blocked'/'error'
  cliVersion: string,
  stack: object|null, files: string[]|null, nextSteps: string[]|null,
  message: string|null, raw: object|null, stderr: string|null
}
```

## 9. 共享渲染助手 `lib/presentation/markdown.js`

```js
export function heading(text, level = 2)      // '## text'
export function bullet(items)                 // '- a\n- b'
export function kv(pairs)                     // '- **k**：v'
export function code(text, lang='sh')         // '```sh\ntext\n```'
export function table(headers, rows)          // GFM 表格，空行返回 ''
export function inlineCode(text)              // '`text`'
```

工具返回值里的 `output.render(_args, value)` 只能返回 `[{ type:'text', text }]`（或 image part，但本插件不用）。
`render` 必须是纯函数、不得抛错；数据缺失时降级为简短文本。

## 10. SchemaSpec 方言（`lib/plugin/schema.js`）

与 `dsh-watermelon-ui` 一致：根层属性用 `required: true`；`items` / `oneOf` 内的嵌套对象不允许 `required`；
不支持 `type` 数组（可空用 `oneOf`）；不支持 `minimum/maximum`（在 execute 内钳制）。

## 11. 质量门

- `npm test` = `node scripts/verify.mjs && node --test tests/`
- 所有测试必须能在**没有 DSH 运行时**的纯 Node 下跑（工具测试用假 ctx：`{ tools: { register(){} }, logger: { debug(){} } }`）。
- `scripts/verify.mjs` 至少覆盖：package.json 关键字段、`index.js` 导出、快照能加载且 stackCount 一致、
  三个工具 schema 通过方言检查、技能文件存在且 frontmatter 有 name/description、README 里提到的工具名与实现一致。
