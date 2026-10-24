# dsh-vibestart

简体中文 | [English](README.en.md)

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

把 [VibeStart](https://github.com/Eunsolfs/vibestart)（`npx vibestart-cli`，全栈 TypeScript 脚手架）接进 DeepSeek Harness：一个内置技能加三个工具，让会话里能**离线看清当前版本支持哪些技术栈组合**、**校验用户想要的组合并给出可直接执行的命令**，需要时再经 `ctx.shell` 受控执行——默认只预览，`apply=true` 才真的写。

## 解决什么

- **不联网、不跑 npm 也能回答「有哪些选择」**：15 个 kind（toolchain / frontend / framework / router / backend / api / database / orm / auth / ui / desktop / mobile / runtime / deployment / testing）、每个 kind 的选项、以及 3409 个已校验组合，全部来自打包的离线快照。
- **不让模型凭记忆拼 flag**：`vibestart_plan` 校验栈，非法时给最近的合法组合与最小改动，并生成与上游 CLI 完全一致的命令。
- **写盘是显式的**：`vibestart_run` 默认 `--dry-run --json`，只有显式 `apply=true` 才执行；`create` 永远不带 `--yes`，维护写操作才带。

运行时零第三方依赖、不打包上游 CLI；只有真正执行时才由 `npx` 下载 `vibestart-cli`。

## 三个工具

| 工具 | 用途 | 联网 | 写盘 |
| --- | --- | --- | --- |
| `vibestart_stacks` | 离线列 kind / 选项 / 合法组合；支持按单个 `kind` 或部分 `stack` 过滤 | 否 | 否 |
| `vibestart_plan` | 校验栈（`legal` / `incomplete` / `illegal` / `invalid`），给补全、最近合法组合、最小改动与完整命令 | 否 | 否 |
| `vibestart_run` | 经 `ctx.shell` 执行 CLI；默认 `--dry-run --json` 预览，`apply=true` 才写 | 是（npx 下载 + CLI 访问 registry） | 仅 `apply=true` |

`stack` 参数是字符串语法：`kind=value` 用 `,` 或 `;` 分隔，允许空格，例如

```
framework=spa,backend=hono,api=orpc,database=sqlite,auth=better-auth
```

`none` / 空值表示该 optional kind 不选；允许只给部分 kind，`vibestart_plan` 会补全或给出最近合法组合。

维护命令（`command: "add" | "doctor" | "upgrade"`）不使用栈参数：

- `add` 的能力 ID 是**位置参数**（上游 `vibestart add [knip ultracite docker]`），用 `addons: "knip,ultracite"` 传；不传时命令退化成只读的 `add --list`，此时 `apply=true` 会被拒（空 `add` 上游会 exit 2）。
- `doctor` 只读，永远不加 `--dry-run`；`offline: true` 只对它生效。
- `upgrade` 预览走 `--dry-run`，写入走 `--yes`。

## 内置技能

技能名 `vibestart`（`config.skill: false` 可关闭注册，三个工具不受影响）：

- [SKILL.md](skills/vibestart/SKILL.md) —— 在 DSH 里怎么用、上下文确认、工作流选择、执行边界、结果汇报、硬规则清单。
- [references/create.md](skills/vibestart/references/create.md) —— 创建项目：`--list`、预览、recipe、包管理器 / runtime / 扩展、安装与校验、JSON 与退出码。
- [references/maintenance.md](skills/vibestart/references/maintenance.md) —— 维护：`doctor`、`add`、`upgrade`、收尾一次写入（conflicts / manual / 失败重跑）、自动化结果约定。

技能正文改编自 VibeStart 官方技能（MIT），保留其原有知识、命令与硬规则，只加了 DSH 适配层；来源与许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 配置

`dsh-vibestart` 插件支持以下字段（默认值即安全值）。`cordis.patch.yml` 只写出常用的前六个，其余不写即取默认值：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `skill` | `true` | 是否注册内置 `vibestart` 技能；`false` 时三个工具照常可用 |
| `allowExec` | `true` | 是否允许 `vibestart_run` 启动 CLI；`false` 时只给命令不执行 |
| `allowApply` | `true` | 是否允许 `vibestart_run` 在 `apply=true` 时真的写盘；`false` 时永远只预览 |
| `cliVersion` | `"0.1.1"` | 固定的上游版本，预览与执行必须同一版本；也接受 `"latest"`，但不推荐 |
| `runner` | `"npx"` | 启动方式：`npx` 或 `pnpm-dlx` |
| `maxStacks` | `5` | `vibestart_stacks` 未显式传 `limit` 时的样本条数（1–8） |
| `previewTimeoutMs` | `180000` | `vibestart_run` 预览超时（毫秒，5000–1800000） |
| `applyTimeoutMs` | `600000` | `vibestart_run` 真实执行超时（毫秒，5000–1800000） |
| `npmCacheDir` | `".dsh-vibestart-npm-cache"` | 执行 CLI 时注入的 `npm_config_cache`（相对命令工作目录）；`""` 表示不注入 |

`npmCacheDir` 存在的原因：DSH 默认的 `workspace-write` 文件策略会拒绝工作区外的写入，而 npm 的全局缓存在 `%LOCALAPPDATA%\npm-cache`，`npx` 会直接 `EPERM`。把缓存指到命令自己的工作目录里，默认策略下才能下载 CLI；这个目录只是缓存，可以随时删除。

字段定义与校验在 [lib/plugin/config.js](lib/plugin/config.js)，固定常量在 [lib/config.js](lib/config.js)。

## 安装

本插件不发布到 npm，用 profile 的本地 `link:` 依赖安装。以默认 `desktop` profile 为例：

1. 把仓库放在本机某个目录，例如 `C:\Users\<you>\Documents\deepseek-harness\default-workspace\dsh-vibestart`。
2. 编辑 `%DSH_HOME%\profiles\desktop\package.json`（`%DSH_HOME%` 默认是 `C:\Users\<you>\.dsh`）：

   ```json
   {
     "dependencies": {
       "dsh-vibestart": "link:C:/Users/<you>/Documents/deepseek-harness/default-workspace/dsh-vibestart"
     },
     "dsh": {
       "profile": {
         "bundles": [
           "@deepseek-ai/dsh-base",
           "@deepseek-ai/dsh-web-app",
           "dsh-vibestart"
         ]
       }
     }
   }
   ```

   - 示例省略了其余 bundle：实际保留你原有的 `dsh.profile.bundles` 条目，只在末尾**追加**一项 `"dsh-vibestart"`。
   - `link:` 后面的路径指向仓库根目录（含 `package.json` 与 `cordis.patch.yml` 的那一层），用正斜杠或转义反斜杠都可以。

3. 在 profile 目录安装依赖，然后重载：

   ```bash
   cd "$DSH_HOME/profiles/desktop"   # PowerShell: cd $env:DSH_HOME\profiles\desktop
   pnpm install
   ```

   重启 DSH（或开新会话）后，工具表里应出现 `vibestart_stacks` / `vibestart_plan` / `vibestart_run`，技能列表里应出现 `vibestart`。

回滚：从 `dependencies` 和 `dsh.profile.bundles` 里删掉 `dsh-vibestart`，再 `pnpm install`。

## 升级上游 CLI 版本

快照是「某一版 CLI 的 `--list --json`」，插件默认固定 `0.1.1`。升级步骤：

1. 改 [lib/config.js](lib/config.js) 的 `DEFAULT_CLI_VERSION`；若 profile 或 `cordis.patch.yml` 覆盖过 `cliVersion`，一并改。
2. 重建快照：

   ```bash
   npm run snapshot
   ```

   脚本会重新执行 `npx --yes vibestart-cli@<新版本> --list --json`，清理 stdout 前的 Node 警告行，校验版本与组合往返，并写入 `data/snapshot.json` 的完整性摘要。**不要手改 `data/snapshot.json`**。
3. 验证：

   ```bash
   node scripts/snapshot.mjs --check
   npm test
   ```

4. 检查 `data/snapshot.json` 的 diff（组合数可能变化），在 [CHANGELOG.md](CHANGELOG.md) 记一笔。
5. 同步文档里写死的版本号：`skills/vibestart/` 与两份 README 中的 `vibestart-cli@0.1.1` 应替换为新版本。

## 开发与测试

本插件运行时不带第三方依赖，通常无需额外安装：

```bash
npm test                          # node scripts/verify.mjs && node scripts/test.mjs
node scripts/snapshot.mjs --check # 离线校验现有快照的完整性与版本
node scripts/test.mjs             # 只跑测试
node scripts/test.mjs run         # 只跑文件名含 "run" 的测试
```

要求 Node.js `>=22.16.0`；测试用 `tests/stubs` 里的替身，不需要 DSH 运行时，工具由假 `ctx` 直接驱动。CI（[.github/workflows/ci.yml](.github/workflows/ci.yml)）在 Node 22 / 24 上跑 `npm test` 与快照检查。

测试入口用 `scripts/test.mjs`（在进程内依次 import 各测试文件）而不是 `node --test tests/`：Node 的测试运行器给每个文件开子进程，受限环境（DSH 的 Windows 沙箱、部分 CI 容器）不允许子进程通过管道交接 stdio，会直接 `spawn EPERM`。两者用例相同，沙箱外想用原生 runner 也可以。

刷新快照需要联网与可写的 npm 缓存。受限环境（沙箱 / 只读缓存）里把 `npm_config_cache` 指到工作区内目录再跑，否则 `npx` 可能报 EPERM。

### 在沙箱里真实执行 `create`

`vibestart_run` 默认只预览（`--dry-run`），不需要额外权限。`apply=true` 时上游 CLI 会写文件、`git init`、`pnpm install` 并跑 `vp check`——pnpm 的全局 store 在工作区外，默认 `workspace-write` 策略下这一步会被拒。两种可行做法：

1. 先 `vibestart_run { apply: true, noInstall: true }` 只生成文件，再用 `pwsh` 工具执行 `pnpm install`（必要时带沙箱权限升级）。
2. 直接用 `vibestart_plan` 给出的命令在 `pwsh` 里跑（语义等价），由 shell 工具的审批流程承担权限升级。

## 仓库结构

```
index.js                      薄入口（重导出 apply）
cordis.patch.yml              bundle patch：唯一插件行 + 配置
data/snapshot.json            离线快照（生成物，入库）
lib/config.js                 固定常量（CLI 版本、runner、超时、输出上限）
lib/plugin/                   宿主适配：apply、技能 provider、SchemaSpec 方言、配置
lib/catalog/                  快照加载与查询（零 DSH import）
lib/plan/                     纯函数：校验 / 补全 / 最近合法 / 命令生成
lib/exec/                     ctx.shell 执行与 JSON 解析
lib/tools/                    三个模型工具
lib/presentation/             Markdown 渲染
skills/vibestart/             内置技能与 references
scripts/                      snapshot.mjs（重建快照）/ verify.mjs（自检）/ test.mjs（测试入口）
tests/                        纯 node:test（不需要 DSH 运行时）
docs/CONTRACT.md              开发期内部契约
```

## 边界

- **不托管、不代办**：插件只做「查目录 / 校验 / 生成命令 / 受控执行」，不提供托管服务，不保存你的项目状态；生成的项目不依赖本插件。
- **不迁移生产数据**：`add` / `upgrade` 只改模板与配置；数据库初始化、迁移、重置，以及业务代码的 `manual` 移植，仍由你和 CLI 生成的步骤完成。`upgrade` 不承诺任意应用迁移。
- **写盘由上游 CLI 完成**：`vibestart_run apply=true` 只是按你确认的参数启动 `npx vibestart-cli`；文件内容、安装与检查结果的正确性由上游 CLI 负责，插件只如实转述 `status` / `files` / `nextSteps`。
- **不是安全沙箱**：`allowExec` / `allowApply` 是配置闸，用于避免误触发，不是权限隔离；`create` 会在目标目录生成代码并（默认）安装依赖、初始化 Git。
- **离线目录有版本边界**：快照里没有的 kind / 取值就是当前固定版本不支持的；要新能力先升级快照。
- **上游质量与许可归上游**：VibeStart 由上游维护，模板内容、CLI 行为与发布节奏不受本插件控制。

## 许可与第三方署名

本插件代码以 MIT 发布（[LICENSE](LICENSE)）。

技能正文（`skills/vibestart/`）改编自 VibeStart 官方技能，VibeStart 以 MIT 发布，Copyright (c) 2026 VinkyDev and contributors（<https://github.com/Eunsolfs/vibestart>）；`data/snapshot.json` 由 `vibestart-cli` 的公开输出生成。`vibestart-cli` 本身不随本插件分发，运行时经 `npx` 下载，其许可与版权归上游。完整说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
