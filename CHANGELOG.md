# Changelog

本文件记录 dsh-vibestart 对用户可见的变更。版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)；
插件版本与上游 CLI 版本（默认固定 `0.1.1`）是两回事，升级上游请见 README 的「升级上游 CLI 版本」。

## [0.1.0] - 2026-10-24

首个版本。面向 DeepSeek Harness 的 VibeStart 接入：离线栈目录 + 校验 + 受控执行，加一个内置技能。

### Added

- 内置技能 `vibestart`（[SKILL.md](skills/vibestart/SKILL.md)）：DSH 工具优先路径、上下文确认、工作流选择、执行边界、结果汇报与硬规则清单；references 覆盖[创建项目](skills/vibestart/references/create.md)与[项目维护](skills/vibestart/references/maintenance.md)。
- 三个模型工具：
  - `vibestart_stacks`：离线列 15 个 kind、每个 kind 的选项与 3409 个已校验组合，支持按 kind / 部分栈过滤。
  - `vibestart_plan`：校验栈（`legal` / `incomplete` / `illegal` / `invalid`），给补全、最近合法组合、最小改动与完整命令。
  - `vibestart_run`：经 `ctx.shell` 受控执行；默认 `--dry-run --json` 预览，`apply=true` 才写；`create` 不带 `--yes`，维护写操作才带；`directory` 必须是相对路径且不含 `..`。
- 离线快照 `data/snapshot.json`：来自 `npx --yes vibestart-cli@0.1.1 --list --json`，带版本与 sha256 完整性摘要；`scripts/snapshot.mjs` 可重建，`--check` 可离线校验。
- 配置项：`skill`、`allowExec`、`allowApply`、`cliVersion`、`runner`、`maxStacks`、`previewTimeoutMs`、`applyTimeoutMs`（见 [lib/plugin/config.js](lib/plugin/config.js)）。
- 双语文档（[README.md](README.md) / [README.en.md](README.en.md)）、[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 与 MIT [LICENSE](LICENSE)。
- GitHub Actions CI（[.github/workflows/ci.yml](.github/workflows/ci.yml)）：Node 22 / 24 上跑 `npm test` 与快照检查。

### Notes

- 运行时零第三方依赖；只有 `vibestart_run` 且 `apply=true`（或显式要求预览）时才会由 `npx` 下载并启动上游 CLI。
- 已验证的上游版本是 `vibestart-cli@0.1.1`；快照里的 15 个 kind / 3409 个组合是这一版的真实输出。
