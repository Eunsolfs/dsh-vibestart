---
name: vibestart
description: VibeStart CLI 脚手架技能：vibestart 全栈 TypeScript 脚手架，15 个 kind 的技术栈组合（Vite+、Drizzle、Better Auth、Hono、oRPC、Expo、Docker 等，3409 个已校验组合），支持 create/add/doctor/upgrade、recipe 与 knip/ultracite 扩展，覆盖预览、写入、冲突与 manual 移植。Use when the user mentions vibestart, asks to scaffold a full-stack TypeScript project, choose or validate a stack combination, or maintain a project with vibestart.jsonc. Not for ordinary application feature development unrelated to the CLI.
whenToUse: 用户要新建全栈 TypeScript 脚手架项目、挑选或校验技术栈组合，或维护已有 vibestart 项目（add/doctor/upgrade）时使用。
---

# VibeStart CLI

Use the CLI to resolve stacks and maintain generated projects. Let its current help, capability list, and change plan determine what is supported; do not reconstruct templates or hand-edit the project record.

## 在 DSH 里怎么用（prefer the plugin tools）

本插件把 CLI 拆成三个工具：**离线目录 → 校验与命令生成 → 受控执行**。默认走工具，不要凭记忆拼 flag。工具名与参数以当前工具表为准。

| 工具 | 用途 | 联网 | 写盘 |
| --- | --- | --- | --- |
| `vibestart_stacks` | 离线列出 15 个 kind、每个 kind 的选项与 3409 个已校验组合；也可用 `kind` 参数或部分 `stack` 过滤合法组合 | 否 | 否 |
| `vibestart_plan` | 校验栈并返回 `legal` / `incomplete` / `illegal` / `invalid`、缺哪些 kind、非法时的最近合法组合与最小改动，以及可直接执行的完整命令 | 否 | 否 |
| `vibestart_run` | 通过 `ctx.shell` 执行 CLI；`apply=false`（默认）只加 `--dry-run --json` 预览，`apply=true` 才真写 | 是（npx 下载 + CLI 自己访问 registry） | 仅 `apply=true` 时 |

推荐顺序（照做）：

1. `vibestart_stacks` —— 无参数看总览（CLI 版本 / kind 数 / 组合数 / 每个 kind 的选项），`kind: "database"` 看单个 kind，`stack: "framework=spa,backend=hono"` 看部分栈的合法补全数量与样本。
2. `vibestart_plan` —— 把你的栈交给它校验。`stack` 是字符串语法：`kind=value` 用 `,` 或 `;` 分隔，允许空格，例如 `framework=spa,backend=hono,api=orpc,database=sqlite,auth=better-auth`；`none` 或空值表示该 optional kind 不选；允许只给部分 kind。看 `status`、`missing`、`fixes`（最小改动）、`notes`，再决定下一步。
3. `vibestart_run` —— 要真写才传 `apply: true`。`command: "create"` 时 `directory` 是相对路径且不能含 `..`；`add` / `doctor` / `upgrade` 默认在项目根执行。先 `apply: false` 预览，确认后才 `apply: true`。

工具不可用时才回退到 CLI：`npx --yes vibestart-cli@0.1.1 …`。回退时注意：

- **固定版本**：预览与执行都用 `@0.1.1`（本插件固定的默认版本）。不要一次 `latest`、一次固定版本——两次 npx 之间上游发版会让预览与实际写入不一致。
- **npm 缓存**：受限环境（沙箱/只读缓存）下 npx 可能 EPERM；先把 `npm_config_cache` 指到工作区内目录（例如 `.npm-cache`）再重试。
- **没有 `ctx.shell`**：`vibestart_run` 会返回结构化错误；此时用 `pwsh` / `bash` 工具原样执行 `vibestart_plan` 给出的 `command`，不要自己重拼 flags。
- **离线目录**：`vibestart_stacks` 不联网，快照里没有的东西就是当前版本不支持；不要用记忆补一个「应该存在」的取值。

## Establish the context

1. Identify the target directory and whether the request is creation or maintenance. Read the project's instructions. For an existing project, inspect `vibestart.jsonc` (its `name`, `version`, and choices), `package.json`, and Git status. Preserve unrelated edits.
2. Run the CLI from npm with `npx --yes vibestart-cli@0.1.1` (or `pnpm dlx vibestart-cli@0.1.1`); a global install is not required. This plugin pins `0.1.1` in `lib/config.js`; resolve its version with `npx --yes vibestart-cli@0.1.1 --version` when in doubt. For a preview followed by application, keep the exact same version in both commands so a new release cannot change the target between them.
3. Installing this skill does not install the CLI, Vite+, or project dependencies. If a required tool is unavailable, follow its installation instructions within the user's scope rather than changing the selected stack.
4. Read `npx --yes vibestart-cli@0.1.1 --help` for creation or `npx --yes vibestart-cli@0.1.1 COMMAND --help` for maintenance. Prefer `--json` for operations executed by an agent; keep stdout separate from stderr. Do not parse a task runner's banner as JSON.

## Choose the workflow

Read the relevant reference before acting. Paths are relative to this skill's directory, not the user's project.

| User intent | First action in DSH | Raw CLI if tools are unavailable | Reference |
| --- | --- | --- | --- |
| Create a project or use a recipe | `vibestart_stacks` → `vibestart_plan` → `vibestart_run` | `npx --yes vibestart-cli@0.1.1 --list --json` | [Creating projects](references/create.md) |
| Add a capability | 先取 ID（`add --list --json`）→ `vibestart_plan`（`command: "add"`, `addons: "knip,ultracite"`）→ `vibestart_run`（同上 + `apply=true`） | `npx --yes vibestart-cli@0.1.1 add --list --json` | [Maintenance](references/maintenance.md#add-capabilities) |
| Diagnose an existing project | `vibestart_run`（`command: "doctor"`，默认只预览） | `npx --yes vibestart-cli@0.1.1 doctor --offline --json` | [Maintenance](references/maintenance.md#inspect-project-state) |
| Update a generated project | `vibestart_plan`（`command: "upgrade"`）→ `vibestart_run`（`command: "upgrade"`） | `npx --yes vibestart-cli@0.1.1 upgrade --dry-run --json` | [Maintenance](references/maintenance.md#upgrade-templates) |
| Finish a write: conflicts, manual changes, checks | Read the write's JSON result and `git diff` | Read the write's JSON result and `git diff` | [Maintenance](references/maintenance.md#finish-a-write) |

Run maintenance from the generated project root, or pass `--cwd /actual/project/path`. Creation instead takes a positional destination directory; it has no `--cwd` option.

## Execute within the requested scope

- Preview changes before writing. When the user has requested the operation and the plan meets that scope, proceed without an extra permission loop. Ask only about missing product choices or material changes outside the request. A request to inspect or preview does not authorize applying the plan.
- Creation uses `--json` to disable prompts. Maintenance writes additionally require `--yes`. Do not pass `--yes` to creation.
- A maintenance write needs a clean Git worktree. When the worktree holds the user's uncommitted work, ask whether to commit or stash it before writing.
- The package manager and Hono runtime are separate choices: `--package-manager bun` selects dependency installation; `--runtime bun` selects Hono execution. Neither changes the other or moves the Vite+ test toolchain to Bun. Do not replace `vp test` with `bun test` or force the CLI to run under Bun.
- Existing projects use `add` and `upgrade`. Change choices only through those commands; keep `vibestart.jsonc`'s `name` and `version` as the CLI wrote them, since upgrades regenerate the original templates from them.
- Respect the environment's installation and service restrictions. Normal creation and maintenance writes run setup/checks. If these are unavailable, use a read-only preview, or explicitly defer installation when file writes are in scope. `--full-check` can start services and browsers.

## Report the actual result

State the CLI version, target project, selected changes, returned status, checks actually run, and any remaining action, including conflicts and `manual` changes still to port. For machine output, inspect both exit code and JSON fields. A successful preview, `doctor` result, or historical stack verification record is not evidence that this project's tests passed. `needs-install` is an unfinished operation even though its exit code is zero.

Use the project's generated tasks for subsequent work: `vp install`, `vp check`, and the tasks present in `package.json` or `vite.config.ts`. `vp run ready` runs the full project validation chain. Do not assume a task exists when its optional capability is absent. The generator repository's `vp run deps update` is a maintainer command, not the generated project's upgrade command.

## 硬规则清单（动手前逐条确认）

- [ ] 先看 `--list` / `--help`，取值只来自工具或 CLI 输出，不凭记忆编造。
- [ ] 先预览（`vibestart_run` 默认 `apply=false`，即 `--dry-run --json`），确认无误再写。
- [ ] `create` 永远不加 `--yes`；维护写操作才加 `--yes`。
- [ ] 维护写之前 worktree 必须干净；有用户未提交的改动先问「提交还是 stash」。
- [ ] `needs-install` 是未完成：文件写了但安装/检查没跑，要报告并建议 `next` 里的步骤。
- [ ] 不手改 `vibestart.jsonc` 的 `name` / `version`；改栈只能走 `add` / `upgrade`。
- [ ] `add` 的能力 ID 是**位置参数**（`add knip ultracite`），用 `addons=knip,ultracite` 传；不知道 ID 就先不带 `addons` 让命令退化成只读的 `add --list`，不要空跑 `add --yes`（上游会 exit 2）。
- [ ] 包管理器与 Hono runtime 是两个独立选择，不要互相顶替，也不要把 `vp test` 换成 `bun test`。
- [ ] 报告实际结果：CLI 版本、目标目录、改了什么、status、真正跑过的检查、遗留的 conflicts / manual。

> Adapted from VibeStart (MIT) — https://github.com/Eunsolfs/vibestart. Copyright (c) 2026 VinkyDev and contributors.
