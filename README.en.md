# dsh-vibestart

English | [简体中文](README.md)

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Brings [VibeStart](https://github.com/Eunsolfs/vibestart) (`npx vibestart-cli`, a full-stack TypeScript scaffolder) into DeepSeek Harness: one bundled skill and three tools that let a session **see the supported stack combinations offline**, **validate the combination the user wants and get an exact runnable command**, and then execute it through `ctx.shell` under explicit control — preview by default, write only with `apply=true`.

## What it solves

- **Answer "what can I pick" with no network and no npm run**: 15 kinds (toolchain / frontend / framework / router / backend / api / database / orm / auth / ui / desktop / mobile / runtime / deployment / testing), each kind's options, and 3409 verified combinations — all from a bundled offline snapshot.
- **Stop the model from inventing flags from memory**: `vibestart_plan` validates a stack, returns the nearest legal combination and the minimal edit when it is illegal, and builds a command identical to the upstream CLI's.
- **Writing is explicit**: `vibestart_run` previews with `--dry-run --json` by default and only executes with `apply=true`; `create` never gets `--yes`, maintenance writes do.

The runtime has zero third-party dependencies and does not bundle the upstream CLI; `npx` downloads `vibestart-cli` only when something is actually executed.

## The three tools

| Tool | What it does | Network | Writes files |
| --- | --- | --- | --- |
| `vibestart_stacks` | Lists kinds / options / legal combinations offline; filters by a single `kind` or a partial `stack` | No | No |
| `vibestart_plan` | Validates a stack (`legal` / `incomplete` / `illegal` / `invalid`), returns completions, nearest legal combinations, minimal edits and the full command | No | No |
| `vibestart_run` | Runs the CLI through `ctx.shell`; previews with `--dry-run --json` by default, writes only with `apply=true` | Yes (npx download + registry access by the CLI) | Only with `apply=true` |

The `stack` argument uses a string syntax: `kind=value` separated by `,` or `;`, whitespace allowed, for example

```
framework=spa,backend=hono,api=orpc,database=sqlite,auth=better-auth
```

`none` or an empty value means the optional kind is not selected; partial stacks are allowed and `vibestart_plan` completes them or returns the nearest legal combination.

Maintenance commands (`command: "add" | "doctor" | "upgrade"`) take no stack flags:

- `add` takes capability IDs as **positional arguments** (upstream: `vibestart add [knip ultracite docker]`), passed as `addons: "knip,ultracite"`. Without them the command degrades to the read-only `add --list`, and `apply: true` is refused (an empty `add` exits 2 upstream).
- `doctor` is read-only and never gets `--dry-run`; `offline: true` only affects it.
- `upgrade` previews with `--dry-run` and writes with `--yes`.

## Bundled skill

Skill name `vibestart` (set `config.skill: false` to skip registration; the three tools keep working):

- [SKILL.md](skills/vibestart/SKILL.md) — how to work in DSH, establishing context, choosing the workflow, execution boundaries, reporting results, a hard-rules checklist.
- [references/create.md](skills/vibestart/references/create.md) — creating projects: `--list`, previews, recipes, package manager / runtime / extensions, install and validation, JSON and exit codes.
- [references/maintenance.md](skills/vibestart/references/maintenance.md) — maintenance: `doctor`, `add`, `upgrade`, finishing a write (conflicts / manual / rerunning a failed step), automation result contract.

The skill text is adapted from VibeStart's official skill (MIT); its knowledge, commands and hard rules are preserved and only a DSH adaptation layer was added. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for provenance and licensing.

## Configuration

The `dsh-vibestart` plugin accepts these fields (defaults are the safe values). `cordis.patch.yml` only writes the first six; anything omitted takes its default:

| Field | Default | Meaning |
| --- | --- | --- |
| `skill` | `true` | Register the bundled `vibestart` skill; when `false`, the three tools still work |
| `allowExec` | `true` | Let `vibestart_run` start the CLI; when `false`, it only returns the command |
| `allowApply` | `true` | Let `vibestart_run` actually write with `apply=true`; when `false`, it always previews |
| `cliVersion` | `"0.1.1"` | Pinned upstream version used for both preview and apply; `"latest"` is accepted but not recommended |
| `runner` | `"npx"` | Launcher: `npx` or `pnpm-dlx` |
| `maxStacks` | `5` | Default sample size for `vibestart_stacks` when `limit` is omitted (1–8) |
| `previewTimeoutMs` | `180000` | Timeout for a `vibestart_run` preview (ms, 5000–1800000) |
| `applyTimeoutMs` | `600000` | Timeout for a real `vibestart_run` execution (ms, 5000–1800000) |
| `npmCacheDir` | `".dsh-vibestart-npm-cache"` | `npm_config_cache` injected when running the CLI (relative to the command's working directory); `""` disables it |

`npmCacheDir` exists because DSH's default `workspace-write` policy refuses writes outside the workspace, while npm's global cache sits in `%LOCALAPPDATA%\npm-cache` — `npx` then fails with `EPERM`. Pointing the cache at the command's own working directory makes the download work under the default policy; it is only a cache and can be deleted at any time.

Field definitions and validation live in [lib/plugin/config.js](lib/plugin/config.js); fixed constants live in [lib/config.js](lib/config.js).

## Installation

This plugin is not published to npm. Two ways to install, pick one:

**A. Straight from GitHub** (no local checkout needed)

Point the dependency at the repository in `%DSH_HOME%\profiles\desktop\package.json`:

```json
"dependencies": {
  "dsh-vibestart": "github:Eunsolfs/dsh-vibestart"
}
```

Or let pnpm fetch it: `pnpm add github:Eunsolfs/dsh-vibestart`.

**B. Local `link:`** (edits take effect immediately; use this while developing)

Using the default `desktop` profile:

1. Put the repository somewhere on disk, e.g. `C:\Users\<you>\Documents\deepseek-harness\default-workspace\dsh-vibestart`.
2. Edit `%DSH_HOME%\profiles\desktop\package.json` (`%DSH_HOME%` defaults to `C:\Users\<you>\.dsh`):

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

   - The snippet omits your other bundles: keep your existing `dsh.profile.bundles` entries and only **append** `"dsh-vibestart"`.
   - The `link:` path points at the repository root (the directory holding `package.json` and `cordis.patch.yml`); forward slashes or escaped backslashes both work.

3. Install dependencies in the profile directory, then reload:

   ```bash
   cd "$DSH_HOME/profiles/desktop"   # PowerShell: cd $env:DSH_HOME\profiles\desktop
   pnpm install
   ```

   After restarting DSH (or opening a new session), the tool list should contain `vibestart_stacks` / `vibestart_plan` / `vibestart_run`, and the skill list should contain `vibestart`.

Rollback: remove `dsh-vibestart` from `dependencies` and `dsh.profile.bundles`, then run `pnpm install` again.

## Upgrading the upstream CLI version

The snapshot is the `--list --json` output of one CLI release; the plugin pins `0.1.1` by default. To upgrade:

1. Change `DEFAULT_CLI_VERSION` in [lib/config.js](lib/config.js); update any `cliVersion` override in your profile or `cordis.patch.yml` too.
2. Rebuild the snapshot:

   ```bash
   npm run snapshot
   ```

   The script re-runs `npx --yes vibestart-cli@<new version> --list --json`, strips Node warning lines before the JSON, checks the version and the encode/decode round trip, and writes the integrity digest into `data/snapshot.json`. **Do not hand-edit `data/snapshot.json`.**
3. Verify:

   ```bash
   node scripts/snapshot.mjs --check
   npm test
   ```

4. Review the `data/snapshot.json` diff (the combination count may change) and note it in [CHANGELOG.md](CHANGELOG.md).
5. Update hard-coded versions in the docs: replace `vibestart-cli@0.1.1` in `skills/vibestart/` and both READMEs with the new version.

## Development and testing

The runtime carries no third-party dependencies, so no extra install is normally needed:

```bash
npm test                          # node scripts/verify.mjs && node scripts/test.mjs
node scripts/snapshot.mjs --check # offline integrity and version check of the existing snapshot
node scripts/test.mjs             # tests only
node scripts/test.mjs run         # only test files whose name contains "run"
```

Requires Node.js `>=22.16.0`; the tests use the stand-ins under `tests/stubs`, need no DSH runtime, and drive the tools with a fake `ctx`. CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs `npm test` and the snapshot check on Node 22 / 24.

Tests run through `scripts/test.mjs` (importing each test file in-process) rather than `node --test tests/`: Node's test runner spawns one child process per file, and restricted environments (the DSH Windows sandbox, some CI containers) refuse child processes that hand stdio over pipes, failing with `spawn EPERM`. The cases are identical, and the native runner still works outside a sandbox.

Refreshing the snapshot needs network access and a writable npm cache. In restricted environments (sandbox / read-only cache), point `npm_config_cache` at a directory inside the workspace first; otherwise `npx` may fail with EPERM.

### Running a real `create` inside a sandbox

`vibestart_run` previews only (`--dry-run`) by default and needs no extra permission. With `apply=true` the upstream CLI writes files, runs `git init`, `pnpm install` and `vp check` — pnpm's global store lives outside the workspace, and the default `workspace-write` policy refuses that step. Two workable routes:

1. Run `vibestart_run { apply: true, noInstall: true }` to write files only, then run `pnpm install` with the `pwsh` tool (escalating the sandbox when needed).
2. Take the command from `vibestart_plan` and run it in `pwsh` yourself; the shell tool's approval flow owns the escalation.

## Repository layout

```
index.js                      thin entry point (re-exports apply)
cordis.patch.yml              bundle patch: the single plugin row + config
data/snapshot.json            offline snapshot (generated, committed)
lib/config.js                 fixed constants (CLI version, runner, timeouts, output cap)
lib/plugin/                   host adapter: apply, skill provider, SchemaSpec dialect, config
lib/catalog/                  snapshot loading and queries (zero DSH imports)
lib/plan/                     pure functions: validate / complete / nearest legal / build command
lib/exec/                     ctx.shell execution and JSON parsing
lib/tools/                    the three model tools
lib/presentation/             Markdown rendering
skills/vibestart/             bundled skill and references
scripts/                      snapshot.mjs (rebuild) / verify.mjs (self-check)
tests/                        plain node:test (no DSH runtime)
docs/CONTRACT.md              internal development contract
```

## Boundaries

- **No hosting, no running the project for you**: the plugin only lists the catalog, validates stacks, builds commands and executes under control. It is not a hosted service, stores no project state, and generated projects do not depend on it.
- **No production data migration**: `add` / `upgrade` only touch templates and configuration; database initialization, migration and reset, plus porting `manual` changes into business code, remain yours and the CLI-generated steps. `upgrade` promises no arbitrary application migration.
- **The upstream CLI performs the writes**: `vibestart_run apply=true` just starts `npx vibestart-cli` with the arguments you confirmed. File contents, installation and check results are the upstream CLI's responsibility; the plugin reports `status` / `files` / `nextSteps` as returned.
- **Not a security sandbox**: `allowExec` / `allowApply` are configuration gates against accidental triggering, not permission isolation. `create` generates code in the target directory and (by default) installs dependencies and initializes Git.
- **The offline catalog has a version boundary**: kinds or values absent from the snapshot are unsupported by the pinned release; upgrade the snapshot to get new capabilities.
- **Upstream quality and licensing belong to upstream**: VibeStart is maintained upstream; template contents, CLI behavior and release cadence are outside this plugin's control.

## License and third-party attribution

The plugin code is MIT-licensed ([LICENSE](LICENSE)).

The skill text (`skills/vibestart/`) is adapted from VibeStart's official skill. VibeStart is MIT-licensed, Copyright (c) 2026 VinkyDev and contributors (<https://github.com/Eunsolfs/vibestart>); `data/snapshot.json` is generated from public `vibestart-cli` output. `vibestart-cli` itself is not distributed with this plugin — `npx` downloads it at run time, and its license and copyright remain upstream's. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for details.
