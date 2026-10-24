# THIRD_PARTY_NOTICES

本插件包含或派生自以下第三方内容。插件自身代码以 MIT 发布，完整许可见 [LICENSE](LICENSE)。

## VibeStart（技能正文来源）

- 项目：VibeStart — <https://github.com/Eunsolfs/vibestart>
- 上游包：`vibestart-cli`（全栈 TypeScript 脚手架）
- 本插件中派生自它的文件：
  - `skills/vibestart/SKILL.md`
  - `skills/vibestart/references/create.md`
  - `skills/vibestart/references/maintenance.md`
- 改动说明（仅适配 DeepSeek Harness，不改变上游知识）：
  - 命令统一固定为 `npx --yes vibestart-cli@0.1.1`，与插件默认版本一致；
  - 在 `SKILL.md` 开头增加「在 DSH 里怎么用」与硬规则清单，正文保留上游原文；
  - references 保留上游原文，仅在文件头注明来源与改动；
  - 每个派生文件末尾保留署名行。
- 上游许可：MIT License，Copyright (c) 2026 VinkyDev and contributors。完整许可文本见下。

### VibeStart MIT License

```
MIT License

Copyright (c) 2026 VinkyDev and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## vibestart-cli（运行时由 npx 下载）

- npm 包：`vibestart-cli`，默认版本 `0.1.1`（见 `lib/config.js` 的 `DEFAULT_CLI_VERSION`）。
- 本插件**不分发**该包的任何代码；只有 `vibestart_run` 执行时（或技能里手动回退到 CLI 时）才由 `npx` 从 npm 下载并启动。
- 该包的许可、版权与发布节奏归上游；使用前请遵守其许可条款。

## 离线快照 `data/snapshot.json`

- 来源：`npx --yes vibestart-cli@0.1.1 --list --json` 的公开输出。
- 内容：15 个 kind、每个 kind 的选项、组合的 label 与已校验时间、以及聚合后的完整性摘要；**不包含任何生成模板或项目源码**。
- 生成与校验：`scripts/snapshot.mjs`（在线重建）与 `scripts/snapshot.mjs --check`（离线校验）。
- 该数据派生自 VibeStart，适用上文 VibeStart MIT 许可与署名。

## DeepSeek Harness

- 插件通过 peerDependencies 使用宿主提供的 `@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-skill`、`@deepseek-ai/dsh-shell`、`@deepseek-ai/cordis`，不随本仓库分发这些包的代码。
