# Cortex — AGENTS.md

> Cortex is a single-binary, single-user, localhost-only task tracker for one
> human supervising several AI coding agents at once. This file is the
> always-loaded entry point for any agent working in this repo. Read it in
> full before touching code; the WHY behind each rule lives in `docs/`, and
> the code is the truth (search it on demand with `rg` or a structural search).

Spec: <https://agents.md/>. Linter: `pnpm run docs:check`.

## 1. Project overview

- One binary (`bin/cortex`) bundles the CLI and the daemon (HTTP API + SSE over a private Unix socket).
- Storage is a single SQLite WAL file at `~/.config/cortex/cortex.db` (NOT in this repo).
- The daemon (`cortex serve`) listens only on a private Unix socket; there is no TCP listener and no auth.
- The desktop app (`integrations/desktop`, Electron) is an independent package. Its main process is Node and the only part that talks to the daemon, over that socket; the renderer talks to the main process over Electron IPC.
- Every update has an author: valid `BB_THREAD_ID` defaults to `bb-<thread id>`; explicit `--as` wins; outside bb, update without `--as` fails.
- The desktop app signals ONLY on transitions into `blocked`.

## 2. Runtime & setup

- Bun is pinned to EXACTLY `1.4.2` (`devDependencies.bun`, `@types/bun`, CI). The compiled binary uses ESM bytecode (`--bytecode --format=esm`) because CJS bytecode fails on this module graph with newer Bun (verified on 1.3.14 and 1.4.2); see the rationale at the top of `scripts/build.sh` before changing the pin.
- Node is NOT used at runtime by `bin/cortex`; only the desktop app runs on Node (Electron's own). `pnpm` (pinned by `packageManager` in `package.json`) is the package manager; install with `pnpm install --frozen-lockfile` (matches CI). The binary `bun` resolves via `pnpm exec bun` from `node_modules/.bin` — no global Bun required.
- Build output `bin/cortex` is produced by `pnpm run build`.

## 3. Commands

Every command below is a real script in `package.json` (`docs:check` fails on a reference to a missing one).

- `pnpm run build` — compile `bin/cortex` via `scripts/build.sh`.
- `pnpm test` — full suite: build + `bun test test/unit/ test/integration/`, then `pnpm run test:ui`.
- `pnpm run test:unit` — unit tests only (fast).
- `pnpm run test:ui` — renderer tests in `test/ui/` under happy-dom; the only script that preloads `test/ui/setup-happy-dom.ts`. Each file runs in a fresh global (`--isolate`), because their `mock.module` mocks are process-wide.
- `pnpm run test:integration` — integration tests against the built binary.
- `pnpm run test:bb` — tests and typechecks `integrations/bb/`, the independent Node bb plugin that reads only the Cortex CLI (install its npm dependencies first).
- `pnpm run dev -- <cortex-args>` — run the CLI from source via Bun (no compile step); with no args on a TTY it runs `cortex app`. Uses the `tmp/dev/` data sandbox unless `CORTEX_DEV_REAL=1` (see `scripts/dev-env.sh`, `scripts/dev-cli.sh`).
- `pnpm run ui:build` / `pnpm run desktop:build` — bundle the renderer, its stylesheet (`scripts/build-css.sh`) and the lazily loaded mermaid runtime (`scripts/copy-mermaid.ts`) into `out/ui/`, and the Electron main and preload into `out/desktop/`; `pnpm run desktop:dev` builds and opens the app on the `tmp/dev/` sandbox (`scripts/dev-desktop.sh`, same `CORTEX_DEV_REAL=1` opt-out as `pnpm run dev`).
- `pnpm run test:desktop` — build, then typecheck and run the real-Chromium tests of `integrations/desktop/` (`scripts/test-desktop.sh`; not part of `pnpm test`).
- `pnpm run style` — biome `--write` + `tsc --noEmit`.
- `pnpm run style:check` — biome + `tsc --noEmit` + `scripts/check-docs.ts`, read-only (CI-friendly).
- `pnpm run docs:check` — `scripts/check-docs.ts`: doc budgets, cited paths and `path#Symbol`s, links and scripts; `--base <ref>` also warns on docs whose sources changed since `<ref>`.
- `pnpm run deploy` — local install: rebuild the CLI to `~/bin/cortex` and install the newest `desktop:dist` package on this machine (`scripts/deploy.sh`).
- `pnpm run desktop:dist` — package the desktop app for this OS into `integrations/desktop/dist/` (`scripts/desktop-dist.sh`; `CORTEX_DESKTOP_ARCHS=arm64` builds one macOS architecture; installs nothing).

## 4. Architecture map

CLI (`src/cli.ts` + `src/commands/`) → `withClient` → the Hono app (`src/server.ts`) → Store (`src/store.ts`); the desktop app (`src/desktop/`, `src/ui/`) → the daemon socket + SSE. Why, and the invariants: [docs/architecture.md](docs/architecture.md).

Top-level subdirectories of `src/` (hand-written; update in the same PR when you add one):

- src/commands/   — citty subcommands (one file per `cortex <verb>`)
- src/desktop/   — the desktop main process's Node-side half: socket transport, daemon connection, IPC contract and guards, live bridge, UI file lookup, resume and launch links (never imports Electron)
- src/extensions/   — pi extension(s) embedded as Bun file assets
- src/lib/   — helpers shared by the CLI, daemon and desktop renderer (task search/ordering, status constants, time formatting, @id/#tag grammar, the user's author name, agent tool status)
- src/skills/   — embedded agent skills (cortex, cortex-planner, cortex-implementer, cortex-research)
- src/ui/   — the desktop renderer, bundled for the browser and loaded only over the app's `cortex://` scheme

Other notable single-file modules (curated; the full ownership list is in [docs/architecture.md](docs/architecture.md#module-ownership)):

- `src/client.ts` — typed REST client used by the CLI to talk to the daemon.
- `src/args.ts` — argv pre-normalizer run before citty parses: rewrites `--flag -value` into `--flag=-value` for known string flags (citty 0.1.x never consumes a dash-leading token as a flag value).
- `src/events.ts` — SSE event types + helpers shared by the server and its clients.
- `src/skills.ts` — resolves embedded skill files for `cortex agents install`.
- `src/bbPlugin.ts` — installs the bb plugin for `cortex agents install|reset`; its source is embedded by the Bun macro in `src/bbPluginSource.ts`.
- `src/extensions.ts` — registers the pi extension surface.
- `src/paths.ts` — central source of truth for `CORTEX_DB` + config paths.

There is deliberately no generated repo map: it proved too large to read and almost never used. Find signatures and call sites on demand with `rg` or a structural (tree-sitter) search, then read only the files you need.

## 5. Code conventions

One line per rule; the linked doc holds the why. A code comment states its reason in words, never a cortex plan or task id (those resolve only in one person's cortex).

- TypeScript `strict`. ESM only (`"type": "module"`). Imports use the `.ts` extension (`allowImportingTsExtensions` is on per `tsconfig.json`).
- Biome formats AND lints: `pnpm run style` writes, `pnpm run style:check` is read-only. Markdown is excluded by `biome.json` — do not "fix" it.
- ALL SQLite access goes through `src/store.ts#Store`. The one known exception is `src/backup.ts#exportData` (a readonly connection); do not copy it ([architecture](docs/architecture.md#rules-to-keep)).
- CLI output goes through `console.*`, which `src/cli.ts` routes through `src/stdio.ts`: under Bun 1.4.2 a raw `console.log`, `fs.writeSync(1, ...)` or `Bun.write(Bun.stdout, ...)` truncates output beyond 64 KiB on a pipe. Never add those raw writes; `test/integration/cli/large-output.test.ts` pins the real-pipe path.
- Every file-backed `Store.open` owns its database (lease acquired or handed in via `owner`); non-owners read through `Store.readSnapshot`; commands never open the Store for normal work, they go through `withClient` and release it before any prompt, fzf or launched program ([architecture](docs/architecture.md#the-cli-boundary-withclient)).
- Daemons are database-scoped: metadata is published only once the listener is ready, only the lease holder recovers stale state, a pid read from metadata is NEVER signalled, control routes (`CONTROL_PATHS` in `src/api.ts`) exist only on the IPC app ([architecture](docs/architecture.md#ownership-and-daemon-lifecycle)).
- The SSE heartbeat (`DEFAULT_STREAM_LIMITS.heartbeatMs` in `src/server.ts`) MUST stay under Bun.serve's default idle timeout ([architecture](docs/architecture.md#live-sync)).
- Author tags are `<role>-<8 hex>` (standalone fallback), `pi-<full-uuidv7>` (plain pi), or `bb-<thread id>` (bb). The last two resume via their own harness.
- `scripts/` are Bun scripts when they need type-checking or stdlib parity (`scripts/check-docs.ts` is the precedent); thin orchestration stays in bash. macOS bash 3.2 must keep working — no associative arrays, no GNU awk extensions.
- Desktop help single sources: `src/ui/state/settings.ts#SETTINGS`, `src/ui/lib/help.ts#SHORTCUTS` and `src/ui/components/palette/buildCommands.ts#buildCommands`, rendered only by `src/ui/components/panels/SettingsPanel.tsx`, and each setting only by `src/ui/components/panels/SettingRow.tsx`; desktop settings live in the window's `localStorage` and never touch `tui.toml` or `themes/*.toml`; `integrations/desktop/test/settings-help.test.ts` presses every shortcut ([desktop](docs/desktop.md#help-and-settings)).
- Task-list order is `src/lib/taskOrder.ts#arrangeTasks`, and resume candidates are `src/lib/resume.ts#resumeCandidates`; the desktop resumes only through the checked `cortex:resume` channel, with an argv, never a shell string, and runs agent tools only through `cortex:agents`, as one of `src/desktop/agents.ts#AGENTS_ARGV`.
- Title/body drafts save ONLY through guarded versioned writes; tag membership changes are `versioned.changeTags` deltas, and removing a tag from a task NEVER deletes its definition ([desktop](docs/desktop.md#drafts-and-guarded-writes)).
- The desktop renderer renders Markdown ONLY through `src/ui/lib/markdown.ts` (`marked` then DOMPurify, failing closed), certified in real Chromium by `integrations/desktop/test/document-safety.test.ts`; a draft is NEVER dropped silently: close, reload and quit go through `src/desktop/draftGuard.ts`, and unsaved text of a deleted task is kept for export ([desktop](docs/desktop.md#document-safety)).
- Lane/tag picker search (`src/lib/catalogSearch.ts`) NEVER caps results or forces refinement ([desktop](docs/desktop.md#pickers)).
- Agent memory: the derived index is created on the first search (never in `migrate()`) and never backed up; never pass raw text to FTS5 MATCH; staleness runs in the CLI process, never the daemon; every memory read hides `memory_exclusions` tasks unless the caller passes `withExcluded` (the user's own views only), and a load by id never filters ([memory](docs/memory.md)).
- The pi extension (`src/extensions/pi.ts`) keeps memory overhead bounded (at most one `cortex memory context` spawn per prompt, a frozen primer, budgeted `cortex_recall`, in bb one bounded report per prompt to the Cortex plugin); tool failures THROW; UI renders only through `src/extensions/memory-view.ts` ([memory](docs/memory.md#the-pi-extension)).
- `cortex init`/`cortex reset` touch ONLY the datastore; agent skills, the pi extension and the bb plugin belong to `cortex agents install|reset` (`src/commands/agents.ts`). The plugin's files are embedded by a Bun macro, never imported, so the root tsc never compiles them.
- The desktop renderer's browser graph never reaches `src/store.ts`, `src/client.ts`, `src/lib/userAuthor.ts` or a `node:`/`bun:` module (`test/unit/ui/browser-graph.test.ts`); it reaches the daemon only through `window.cortex`, and main validates every bridge call (`src/desktop/guard.ts#parseBridgeRequest`). The app starts the daemon only by running `cortex serve`, leaves it running on quit, and never signals a pid or posts shutdown.
- `src/ui/` imports helpers from `src/lib/`, `src/api.ts` and `src/events.ts`, and `src/store.ts` and `src/contracts.ts` only as types; nothing in `src/lib/` imports `src/ui/` (`test/unit/ui/browser-graph.test.ts` enforces the runtime half).
- Bundled skills (`src/skills/`) depend on nothing outside cortex: no user skills or agents, and other tools are described by use case, never by name; a user's skills may build on cortex's, never the reverse (`test/unit/skills.test.ts`).
- The desktop app carries one compiled `cortex` per architecture (`CORTEX_BUILD_TARGET=bun-<os>-<arch>` writes `bin/cortex-<os>-<arch>`; a native build wipes them). electron-builder does not fail on a missing binary, so `scripts/desktop-dist.sh` checks first. The packaged app finds its `ui` and `cortex` resources only through `src/desktop/uiFiles.ts#resolveUiDir` and `src/desktop/daemon.ts#resolveCortexBin`.

## 6. Testing

Two concentric layers plus the renderer tier; the boundary matters because each makes different I/O assumptions.

- `test/unit/` — `bun:test`, fast, pure in-process, no DOM: `Store.open(":memory:")` (or its own tmp `CORTEX_DB`), routes via `buildApp(store).fetch(new Request(...))`. NEVER spawn `bin/cortex`, import the integration helpers or call `runCli`.
- Pin `XDG_CONFIG_HOME` / `CORTEX_DB` / `CORTEX_SKILL_DIR` / `CORTEX_PI_EXTENSION_DIR` to a `fs.mkdtempSync` dir BEFORE calling code that reads them, and restore them afterwards (`test/unit/paths.test.ts` shows the pattern); set `CORTEX_BB_CLI=""` before anything that may reach `installAll`. NEVER write to the real `~/.config/cortex`, and NEVER run the real bb or npm (fakes: `test/integration/fixtures/fake-bb.ts`).
- `test/ui/` — renderer state and component tests under happy-dom plus `@testing-library/preact`, run only through `pnpm run test:ui`; no binary spawns, and never in `test/unit/`.
- `test/unit/_layout.test.ts` enforces the tier and hermetic rules (a new `src/` file needs tests where behaviour needs them, not a mirror file per source).
- `test/integration/` — `bun:test` against the COMPILED `bin/cortex` (`pnpm run test:integration` builds it). Every spawn goes through `runCli` or receives the scrubbed env from `mkTmpEnv()` (`test/integration/helpers.ts`); NEVER inherit the parent env.
- Daemons start through `test/integration/fixtures/daemon.ts` (tracks and reaps every process it spawns; `cortex stop` is instance-bound, so it is safe in a sandbox). `test/integration/isolation.test.ts` is the runtime canary that the real config stays untouched.
- `integrations/desktop/test/` — `vitest` + `playwright-core` drive the built Electron app in real Chromium (on Linux without a display, under `xvfb-run`); `harness.ts` gives every test temporary database, config, runtime and profile directories and stops its daemon with `cortex stop`.

`pnpm test` runs all three. Snapshot tests live alongside their unit file. The daemon serves no pages and listens on no TCP port; the desktop renderer (`src/ui`) is the one browser surface, so do not add a web server for it without an issue.

## 7. Commits & PRs

- Small, focused PRs. One concern per PR.
- Locally green BEFORE pushing: `pnpm run style:check && pnpm test && pnpm run docs:check`.
- CI runs the same gates (`.github/workflows/test.yml`); `docs:check` is the FIRST gate — fast-fail on doc drift.
- `.github/workflows/desktop.yml` tests, packages and smoke-tests the desktop app on macOS and Linux and keeps the artifacts 7 days; it never publishes. macOS builds are ad-hoc signed; a release overrides the identity and sets the `APPLE_*` notarisation variables outside the repo, and none of them is ever committed.
- Never commit `bin/` or `tmp/` — `.gitignore` excludes them.

## 8. Doc map

- `README.md` — the front door: what cortex is, install, quick start, where the reference lives, development.
- [docs/desktop.md](docs/desktop.md) — using the desktop app, then how it is built and the rules that keep it safe.
- [docs/memory.md](docs/memory.md) — how agents remember across sessions, then the index, ranking, staleness and the pi extension.
- [docs/architecture.md](docs/architecture.md) — how the CLI, daemon and storage fit together, live sync, write conflicts, and the invariants.
- [docs/bb.md](docs/bb.md) — the bb plugin in `integrations/bb/` (its own npm package and Vitest tests): install, what pi and other providers get, the Cortex tab, and its rules.
- Each doc runs user-first: plain-language sections, then "Under the hood" (how and why, citing `path#Symbol`), then "Rules to keep" (invariants and the test that enforces each).
- `.agents/skills/docs/SKILL.md` — the `docs` skill that keeps all of the above true (sync, audit).
- `src/skills/` — the product manual for agents USING cortex; `cortex schema` is the authoritative CLI contract.

## 9. Maintenance loop

Run `pnpm run docs:check`; on a warning, or before a PR, run the `docs` skill (sync). Update this file in the same PR when you add a script (§3), a `src/` child directory (§4) or a convention (§5/§6). A design choice and the option it rejected go into the doc they belong to (a short "Why not ...?"), not here.

---

## Rules

- NEVER change the Bun pin without re-reading `scripts/build.sh` and re-verifying the compiled `--bytecode --format=esm` binary and the full suite.
- NEVER inline `cortex update --as <id>` in skills when the `cortex_update` pi tool is available — manual attribution is not resumable.
- NEVER add husky / lefthook / pre-commit infrastructure without an issue first; CI + `pnpm run docs:check` covers the lint surface.
- NEVER hand-edit files under `bin/` or `tmp/` — both are generated.
- NEVER paste generated structure dumps (file trees, signature maps, repo overviews) into this file or the repo: Codex truncates AGENTS.md silently above 32 KiB, Claude Code's first-200-line load matters, and repository overviews do not improve agent task success.
- NEVER open `bun:sqlite` outside `src/store.ts` (the one known exception is recorded in §5).
- NEVER add a new top-level dir to `src/` without updating §4 by hand in the same PR.
- NEVER put research, plans or progress in repo files or `tmp/`: they live in cortex tasks; `tmp/` holds only throwaway build and test output (the dev sandbox).
- NEVER test in the production database: `~/.config/cortex/*`, ALWAYS set up a temporary database for tests.
