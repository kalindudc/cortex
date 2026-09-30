# Cortex — AGENTS.md

> Cortex is a single-binary, single-user, localhost-only task tracker for one
> human supervising several AI coding agents at once. This file is the
> always-loaded entry point for any agent working in this repo. Read it in
> full before touching code; the WHY behind each rule lives in `docs/`, and
> the code is the truth (search it on demand with `rg` or a structural search).

Spec: <https://agents.md/>. Linter: `pnpm run docs:check`.

## 1. Project overview

- One binary (`bin/cortex`) bundles the CLI, the TUI and the daemon (HTTP API + SSE over a private Unix socket).
- Storage is a single SQLite WAL file at `~/.config/cortex/cortex.db` (NOT in this repo).
- The daemon (`cortex serve`) listens only on a private Unix socket; there is no TCP listener and no auth.
- Every `cortex update` REQUIRES `--as <session-id>` so multi-agent activity is attributable in the audit trail.
- The TUI signals ONLY on transitions into `blocked`.

## 2. Runtime & setup

- Bun is pinned to EXACTLY `1.4.2` (`devDependencies.bun`, `@types/bun`, CI). The compiled binary uses ESM bytecode (`--bytecode --format=esm`) because CJS bytecode fails on this module graph with newer Bun (verified on 1.3.14 and 1.4.2); see the rationale at the top of `scripts/build.sh` before changing the pin.
- Node is NOT used at runtime. `pnpm` (pinned by `packageManager` in `package.json`) is the package manager; install with `pnpm install --frozen-lockfile` (matches CI). The binary `bun` resolves via `pnpm exec bun` from `node_modules/.bin` — no global Bun required.
- Build output `bin/cortex` is produced by `pnpm run build`.

## 3. Commands

Every command below is a real script in `package.json` (`docs:check` fails on a reference to a missing one).

- `pnpm run build` — compile `bin/cortex` via `scripts/build.sh`.
- `pnpm test` — full suite: build + `bun test test/unit/ test/integration/`.
- `pnpm run test:unit` — unit tests only (fast).
- `pnpm run test:integration` — integration tests against the built binary.
- `pnpm run dev -- <cortex-args>` — run the CLI from source via Bun (no compile step); with no args on a TTY it opens the TUI. Uses the `tmp/dev/` data sandbox unless `CORTEX_DEV_REAL=1` (see `scripts/dev-env.sh`, `scripts/dev-cli.sh`).
- `pnpm run style` — biome `--write` + `tsc --noEmit`.
- `pnpm run style:check` — biome + `tsc --noEmit` + `scripts/check-docs.ts`, read-only (CI-friendly).
- `pnpm run docs:check` — `scripts/check-docs.ts`: doc budgets, cited paths and `path#Symbol`s, links and scripts; `--base <ref>` also warns on docs whose sources changed since `<ref>`.
- `pnpm run deploy` — local install: rebuild + copy to `~/bin/cortex`.

## 4. Architecture map

CLI (`src/cli.ts` + `src/commands/`) → `withClient` → the Hono app (`src/server.ts`) → Store (`src/store.ts`); the TUI (`src/tui/`) → the daemon socket + SSE. Why, and the invariants: [docs/architecture.md](docs/architecture.md).

Top-level subdirectories of `src/` (hand-written; update in the same PR when you add one):

- src/commands/   — citty subcommands (one file per `cortex <verb>`)
- src/extensions/   — pi extension(s) embedded as Bun file assets
- src/lib/   — pure helpers shared by the TUI and CLI (task search/ordering, status constants, time formatting, @id/#tag grammar)
- src/skills/   — embedded agent skills (cortex, cortex-planner, cortex-implementer, cortex-research)
- src/tui/   — pi-tui terminal workspace (app shell + per-TUI session, keys/modes, tui.toml config, themes, safe text, view state)

Other notable single-file modules (curated; the full ownership list is in [docs/architecture.md](docs/architecture.md#module-ownership)):

- `src/client.ts` — typed REST client used by the CLI to talk to the daemon.
- `src/args.ts` — argv pre-normalizer run before citty parses: rewrites `--flag -value` into `--flag=-value` for known string flags (citty 0.1.x never consumes a dash-leading token as a flag value).
- `src/events.ts` — SSE event types + helpers shared by the server and its clients.
- `src/skills.ts` — resolves embedded skill files for `cortex agents install`.
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
- Author tags on `cortex update` follow `<role>-<8 hex>` (legacy fallback) OR `pi-<full-uuidv7>` (when issued via the `cortex_update` pi tool — preferred because pi-attributed updates are resumable).
- `scripts/` are Bun scripts when they need type-checking or stdlib parity (`scripts/check-docs.ts` is the precedent); thin orchestration stays in bash. macOS bash 3.2 must keep working — no associative arrays, no GNU awk extensions.
- The terminal renders Markdown ONLY through `src/tui/reader.ts`, every stored string escaped by `src/tui/safety.ts` first; pi-tui's Markdown component is not a security boundary ([TUI](docs/tui.md#terminal-safety)).
- TUI help single sources: `src/tui/commands.ts#COMMANDS`, `src/tui/keys.ts#KEY_ACTIONS`, `src/tui/theme.ts#THEME_TOKENS`, `src/tui/config.ts#SETTING_HELP`; rendered only through `src/tui/help.ts`; `test/unit/tui/commands.test.ts` fixes the list; docs never copy these lists ([TUI](docs/tui.md#help-settings-and-themes)).
- Title/body drafts save ONLY through guarded versioned writes; tag membership changes are `versioned.changeTags` deltas, and removing a tag from a task NEVER deletes its definition ([TUI](docs/tui.md#drafts-and-guarded-writes)).
- The mouse has ONE parser (`src/tui/mouse.ts`), the Shell owns the tracking modes, and the mouse is never the only path to an action ([TUI](docs/tui.md#mouse-and-pickers)).
- Lane/tag picker search (`src/lib/catalogSearch.ts`) NEVER caps results or forces refinement ([TUI](docs/tui.md#mouse-and-pickers)).
- `tui.toml` and `themes/*.toml` are user-authored and never written; an invalid section keeps its defaults and reports to `:messages` ([TUI](docs/tui.md#help-settings-and-themes)).
- Agent memory: the derived index is created on the first search (never in `migrate()`) and never backed up; never pass raw text to FTS5 MATCH; staleness runs in the CLI process, never the daemon ([memory](docs/memory.md)).
- The pi extension (`src/extensions/pi.ts`) keeps memory overhead bounded (at most one `cortex memory context` spawn per prompt, a frozen primer, budgeted `cortex_recall`); tool failures THROW; UI renders only through `src/extensions/memory-view.ts` ([memory](docs/memory.md#the-pi-extension)).
- `cortex init`/`cortex reset` touch ONLY the datastore; agent skills and the pi extension belong to `cortex agents install|reset` (`src/commands/agents.ts`).

## 6. Testing

Two concentric layers; the boundary matters because each makes different I/O assumptions.

- `test/unit/` — `bun:test`, fast, pure in-process, no DOM: `Store.open(":memory:")` (or its own tmp `CORTEX_DB`), routes via `buildApp(store).fetch(new Request(...))`. NEVER spawn `bin/cortex`, import the integration helpers or call `runCli` / `startServer`.
- Pin `XDG_CONFIG_HOME` / `CORTEX_DB` / `CORTEX_SKILL_DIR` / `CORTEX_PI_EXTENSION_DIR` to a `fs.mkdtempSync` dir BEFORE calling code that reads them, and restore them afterwards (`test/unit/paths.test.ts` shows the pattern). NEVER write to the real `~/.config/cortex`.
- One mirror unit test per `src/` file (except `src/commands/`, `src/extensions/`, `src/types.d.ts`); `test/unit/_layout.test.ts` enforces the mirror, tier and hermetic rules.
- `test/integration/` — `bun:test` against the COMPILED `bin/cortex` (`pnpm run test:integration` builds it). Every spawn goes through `runCli` or receives the scrubbed env from `mkTmpEnv()` (`test/integration/helpers.ts`); NEVER inherit the parent env.
- Daemons start through `test/integration/fixtures/daemon.ts` (tracks and reaps every process it spawns; `cortex stop` is instance-bound, so it is safe in a sandbox). `startServer` is only for in-process route tests. `test/integration/isolation.test.ts` is the runtime canary that the real config stays untouched.
- TUI tests drive the compiled binary in a real PTY through `test/integration/fixtures/pty.ts` (drains output continuously, checks termios restoration from the parent): `test/integration/tui.test.ts` for rendering, modes, signals and restoration; `test/integration/tui-concurrency.test.ts` for several TUIs and CLI writers on one daemon.

`pnpm test` runs both. Snapshot tests live alongside their unit file. There is no browser UI; do not add one without an issue.

## 7. Commits & PRs

- Small, focused PRs. One concern per PR.
- Locally green BEFORE pushing: `pnpm run style:check && pnpm test && pnpm run docs:check`.
- CI runs the same gates (`.github/workflows/test.yml`); `docs:check` is the FIRST gate — fast-fail on doc drift.
- Never commit `bin/` or `tmp/` — `.gitignore` excludes them.

## 8. Doc map

- `README.md` — the front door: what cortex is, install, quick start, where the reference lives, development.
- [docs/tui.md](docs/tui.md) — using the terminal workspace, then how it is built and the rules that keep it safe.
- [docs/memory.md](docs/memory.md) — how agents remember across sessions, then the index, ranking, staleness and the pi extension.
- [docs/architecture.md](docs/architecture.md) — how the CLI, daemon and storage fit together, live sync, write conflicts, and the invariants.
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
