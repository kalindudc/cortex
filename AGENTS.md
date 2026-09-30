# Cortex — AGENTS.md

> Cortex is a single-binary, single-user, localhost-only task tracker for one
> human supervising several AI coding agents at once. This file is the
> always-loaded entry point for any agent working in this repo. Read it in
> full before touching code; for anything deeper, search the code on demand
> (`rg`, or a structural search) and read only the files that matter.

Spec: <https://agents.md/>. Linter: `pnpm run agents:check`.

## 1. Project overview

- One binary (`bin/cortex`) bundles the CLI, the TUI and the daemon (HTTP API + SSE over a private Unix socket).
- Storage is a single SQLite WAL file at `~/.config/cortex/cortex.db` (NOT in this repo).
- The daemon (`cortex serve`) listens only on a private Unix socket; there is no TCP listener and no auth.
- Every `cortex update` REQUIRES `--as <session-id>` so multi-agent activity is attributable in the audit trail.
- The TUI signals ONLY on transitions into `blocked`.

## 2. Runtime & setup

- Bun is pinned to EXACTLY `1.4.2` (`devDependencies.bun`, `@types/bun`, CI). The compiled binary uses ESM bytecode (`--bytecode --format=esm`) because CJS bytecode fails on this module graph with newer Bun (verified on 1.3.14 and 1.4.2); see the rationale at the top of `scripts/build.sh` before changing the pin.
- Node is NOT used at runtime. `pnpm` is the package manager; install with `pnpm install --frozen-lockfile` (matches CI). The binary `bun` resolves via `pnpm exec bun` from `node_modules/.bin` — no global Bun required.
- Build output `bin/cortex` is produced by `pnpm run build`.

## 3. Commands

Every command below is a real script in `package.json` — the linter rule `commands.missing_script` fails CI if any drift sneaks in.

- `pnpm run build` — compile `bin/cortex` via `scripts/build.sh`.
- `pnpm test` — full suite: build + `bun test test/unit/ test/integration/`.
- `pnpm run test:unit` — unit tests only (fast).
- `pnpm run test:integration` — integration tests against the built binary.
- `pnpm run dev -- <cortex-args>` — run the CLI from source via Bun (no compile step); with no args on a TTY it opens the TUI. Uses the `tmp/dev/` data sandbox unless `CORTEX_DEV_REAL=1` (see `scripts/dev-env.sh`, `scripts/dev-cli.sh`).
- `pnpm run style` — sync the `arch:src` block (as `agents:map`), then biome `--write` + `tsc --noEmit`.
- `pnpm run style:check` — same, read-only (CI-friendly).
- `pnpm run agents:check` — deterministic AGENTS.md drift linter (`scripts/check-agents.ts`).
- `pnpm run agents:map` — rewrite the `arch:src` block below from the immediate children of `src/` (`scripts/sync-arch-block.ts`).
- `pnpm run deploy` — local install: rebuild + copy to `~/bin/cortex`.

## 4. Architecture map

Layered: CLI (`src/cli.ts` + `src/commands/`) → Store (`src/store.ts`, SQLite WAL via `bun:sqlite`) → HTTP + SSE server (`src/server.ts`, hono) on the daemon's socket → TUI (`src/tui/`).

Top-level subdirectories of `src/` (auto-rewritten by `pnpm run agents:map` between the markers below — DO NOT hand-edit between the markers):

<!-- arch:src:begin -->
- src/commands/   — citty subcommands (one file per `cortex <verb>`)
- src/extensions/   — pi extension(s) embedded as Bun file assets
- src/lib/   — pure helpers shared by the TUI and CLI (task search/ordering, status constants, time formatting, @id/#tag grammar)
- src/skills/   — embedded agent skills (cortex, cortex-planner, cortex-implementer)
- src/tui/   — pi-tui terminal workspace (app shell + per-TUI session, keys/modes, tui.toml config, themes, safe text, view state)
<!-- arch:src:end -->

Other notable single-file modules (curated; not auto-rewritten):

- `src/client.ts` — typed REST client used by the CLI to talk to the daemon.
- `src/args.ts` — argv pre-normalizer run before citty parses: rewrites `--flag -value` into `--flag=-value` for known string flags of the detected subcommand, because citty 0.1.x never consumes a dash-leading token as a flag value (it leaves the flag boolean-true and can hijack aliases like `-b`).
- `src/events.ts` — SSE event types + helpers shared by the server and its clients.
- `src/skills.ts` — resolves embedded skill files for `cortex agents install`.
- `src/extensions.ts` — registers the pi extension surface.
- `src/paths.ts` — central source of truth for `CORTEX_DB` + config paths.

There is deliberately no generated repo map (removed after it proved too large to read and almost never used, research @416): find signatures and call sites on demand with `rg` or a structural (tree-sitter) search, then read only the files you need.

## 5. Code conventions

- TypeScript `strict`. ESM only (`"type": "module"`). Imports use the `.ts` extension (`allowImportingTsExtensions` is on per `tsconfig.json`).
- Biome formats AND lints: `pnpm run style` writes, `pnpm run style:check` is read-only. Markdown is excluded by `biome.json` — do not "fix" it.
- ALL SQLite access goes through the `Store` class in `src/store.ts`. Never open `bun:sqlite` from anywhere else.
- CLI output goes through `console.*`, which `src/cli.ts` routes through the stdout/stderr streams (`src/stdio.ts`): under Bun 1.4.2 a raw `console.log`, `fs.writeSync(1, ...)` or `Bun.write(Bun.stdout, ...)` silently truncates (or repeats) output beyond 64 KiB on a pipe. Never add those raw writes; `test/integration/cli/large-output.test.ts` pins the real-pipe path.
- Every file-backed `Store.open` owns its database: it acquires the ownership lease unless handed the caller's `owner` lease (`:memory:` is exempt; there is no opt-out). flock is per open file description, so a second open of the same file in one process is refused as busy: share the Store or pass the lease. Code that must not own the database (dry-runs, `doctor`, tests beside a live daemon) reads through `Store.readSnapshot`. Commands never open the Store directly for normal work: they go through `withClient`, releasing it before any prompt, fzf or launched program.
- Author tags on `cortex update` follow `<role>-<8 hex>` (legacy fallback) OR `pi-<full-uuidv7>` (when issued via the `cortex_update` pi tool — preferred because pi-attributed updates are resumable).
- `scripts/` are Bun scripts when they need type-checking or stdlib parity (`scripts/check-agents.ts` is the precedent); thin orchestration stays in bash. macOS bash 3.2 must keep working — no associative arrays, no GNU awk extensions.
- Daemons are database-scoped (`src/daemon.ts`): a daemon holds its canonical database's ownership lease for its whole life and publishes `<db>.daemon.json` only once its listener is ready; clients attach only after `/api/health` answers with the matching identity, recover stale metadata/sockets only while holding the lease, and NEVER signal a pid read from metadata (stop is the instance-bound IPC shutdown route). Control routes (`CONTROL_PATHS` in `src/api.ts`) exist ONLY on the IPC (Unix socket) app. `withClient` is the one CLI boundary: the verified daemon over its socket, else the same Hono handlers in-process under a temporary lease, with no fallback after a dispatched remote request.
- The terminal renders Markdown ONLY through `src/tui/reader.ts`: marked on a private instance, every string escaped by `src/tui/safety.ts` before theme `style()`, OSC 8 only around `safeUrl` destinations, raw HTML as text, Mermaid as source. pi-tui's Markdown component is a renderer, not a security boundary (it emits unvalidated hyperlinks): never use it for task text. `@id`/`#tag` refs share the import-free grammar `src/lib/refGrammar.ts`.
- Interactive per-tag membership changes (the TUI's `:tag` and tag picker) send add/remove deltas through `versioned.changeTags`, never whole-list replacement from a stale snapshot. Removing a tag from a task MUST NOT delete the tag definition.
- The terminal mouse: `src/tui/mouse.ts` is the ONE parser of mouse reports (its input filter drops every unsupported one before pi-tui dispatches) and the shell owns DECSET 1002/1006 on every take/restore path (`TuiAltScreen` runs with `mouse: false`: it would enable any-motion 1003). Mouse selections ARE vi VISUAL (`selectRange`/`selectWord` on the editor and reader), and the mouse is never the only path to an action. The wheel moves a list (task list, `:commands`, dialog rows/fields) ONLY through `session.wheelNotch` (`WheelNotches`: one step a notch; Ghostty sends `mouse-scroll-multiplier` reports per notch); scrolled text takes every report.
- TUI help has three single sources: the `COMMANDS` registry (`src/tui/commands.ts`), the key table (`src/tui/keys.ts`) and `THEME_TOKENS` (`src/tui/theme.ts`). The help view renders ONLY through `src/tui/help.ts` (rows wrapped under the description column, never cut; `/` and n/N search it while it is open, never the task list). README's TUI reference tables (commands, default keys, tui.toml settings, bundled themes, theme tokens) are hand-written, with NO generator: `test/unit/tui/docs.test.ts` fails on drift, and `test/unit/tui/commands.test.ts` holds the FIXED P1–P10 command list and maps every key action to a command or a shell case. `tui.toml` (`leader`, `[keys.normal|leader|insert|visual]`, `mouse`, `theme`, `theme_dark`/`theme_light`, `appearance`, `colors`, `transparent_background`, `flash`, `bell`, `density`) and `themes/*.toml` are user-authored and never written: an invalid section keeps its defaults and reports to `:messages`.
- The SSE heartbeat (`DEFAULT_STREAM_LIMITS.heartbeatMs` in `src/server.ts`, 5 s) MUST stay under Bun.serve's 10 s default idle timeout; a longer gap lets Bun close idle streams and every client sees spurious reconnects.
- Title/body drafts (`src/tui/drafts.ts`) enable editing only after an atomic `api.taskState` baseline and save ONLY through `api.versioned.editTask` guarded by that field's token. A 412 keeps both versions behind `:apply` / `:keep` (keep rebases on the displayed token and writes conditionally); live task copies are hints that trigger a re-read, never adopted text. Unguarded CLI/API writes stay last-writer-wins by design.
- Lane/tag picker search is OPTIONAL: `src/lib/catalogSearch.ts` returns every entry for an empty query and every literal, case-insensitive AND-keyword match otherwise. NEVER impose a result cap or forced-refinement policy.
- Agent memory (`src/memory.ts`, `Store.searchMemory`): `_memory_sections`/`_memory_section_map` are DERIVED (one row per body/update-log section, each carrying its task title and tags; search coverage is decided per section so scattered terms in long documents do not qualify) — created on the first search (never in `migrate()`), reconciled by the `entity` revision token on every search, never backed up. `_memory_links` (derived @id graph, reconciled with the sections) gives each stream its latest linked stream; search spans all lanes with the caller's lane boosted; recency words only re-order ties; activity time excludes status audits. `_body_edits` records BODY changes only (createTask/editTask); staleness and breadcrumbs are measured from it, never from `updated`. Never pass raw text to FTS5 MATCH (only quoted `memoryTerms()`); staleness runs in the CLI process (`cortex memory show`), never in the daemon.
- The pi extension (`src/extensions/pi.ts`) keeps memory overhead bounded: at most ONE `cortex memory context` spawn per user prompt (none under 2 content words, 3 s timeout, never throws), a primer frozen per session (refetched only after compaction or `/memory refresh`) so the system prompt stays byte-stable, only never-shown hits, at most 3 `cortex_recall` calls per request; tool failures THROW (pi ignores a returned isError). Roles: writer iff `ctx.hasUI` (else reader; `CORTEX_MEMORY=write|read|off` overrides); only writers checkpoint (at most 1 extra turn per request, deterministic triggers) and append compaction breadcrumbs; automation never rewrites a stream body; no harness-specific logic. The status and `/memory` render only through `src/extensions/memory-view.ts` (installed beside `index.ts` under the same name), with stored text control-character-cleaned; `/memory` costs one `cortex ls --json`, nothing else spawns for the UI.
- `cortex init`/`cortex reset` touch ONLY the datastore; agent skills and the pi extension belong to `cortex agents install|reset` (`src/commands/agents.ts`).

## 6. Testing

Two concentric layers — the boundary matters because each layer makes
different I/O assumptions:

- `test/unit/` — `bun:test`, fast, isolated, no DOM. NEVER import `src/store.ts` directly here without giving the test its own tmp `CORTEX_DB` (see `test/unit/paths.test.ts` for the env-swap pattern). Aim for one unit test file per source file.
- `test/integration/` — `bun:test` against the COMPILED `bin/cortex`. Requires `pnpm run build` first; `pnpm run test:integration` does this. Lifecycle tests start daemons through `test/integration/fixtures/daemon.ts` (tracks and reaps every process it spawns); `cortex stop` is instance-bound, so it is safe inside a sandbox env. TUI tests drive the compiled binary in a real PTY through `test/integration/fixtures/pty.ts` (`Bun.Terminal`, no python3): it drains output continuously (a non-draining harness blocks the app and merges `Esc` with the next key) and checks termios restoration from the parent, with a SIGKILL control. `test/integration/tui.test.ts` covers rendering, modes, signals and restoration; `test/integration/tui-concurrency.test.ts` runs several TUIs and CLI writers against one daemon.

`pnpm test` runs both. Snapshot tests live alongside their unit file. There is no browser UI; do not add one without an issue.

## 7. Commits & PRs

- Small, focused PRs. One concern per PR.
- Locally green BEFORE pushing: `pnpm run style:check && pnpm test && pnpm run agents:check`.
- CI runs the same gates (`.github/workflows/test.yml`); `agents:check` is the FIRST gate — fast-fail on AGENTS.md drift.
- Never commit `bin/` or `tmp/` — `.gitignore` excludes them.

## 8. Where to look

- `src/store.ts` — SQLite schema, queries, transactions.
- `src/server.ts` — REST routes and the SSE stream.
- `src/memory.ts` — agent-memory helpers (terms, cited paths, lane from git's common dir, staleness, breadcrumbs, rendering); `src/commands/memory.ts` is the `cortex memory` CLI.
- `src/skills/` — markdown skill bodies embedded by `cortex agents install`.
- `src/extensions/pi.ts` — pi extension surface (custom tools).
- `src/daemon.ts` — database-scoped daemon discovery/start/stop, the legacy-daemon fence and `withClient`; `src/commands/serve.ts` hosts the daemon.
- `src/tui/app.ts` — the terminal workspace (`runTui`, the `Shell`): pre-screen checks, theme detection before the first frame, pi-tui wiring, key routing and terminal restoration on every exit path; `src/tui/session.ts` holds one TUI's state, live sync and the `:` command table; PTY tests use `test/integration/fixtures/pty.ts`.
- `.github/workflows/test.yml` — CI definition (one `test` job on an ubuntu-latest + macos-latest matrix).

## 9. Maintenance loop

This file is an auto-improving contract. Any agent that touches the repo MUST keep it honest; the linter makes it enforceable, not aspirational.

Update AGENTS.md (and run `pnpm run agents:map`) IN THE SAME PR when you:

- add or rename a `pnpm run <X>` script → list it in §3 Commands;
- add a new immediate child of `src/` → run `pnpm run agents:map`, then replace the new `— TODO` description in the marker block above;
- introduce a new convention (lint rule, file-layout rule, test rule) → add a bullet under §5, §6, or §8 as appropriate;
- add or remove a top-level path that this file cites in backticks (`paths.missing` will fail CI otherwise);
- bump or unpin a runtime version (Bun, Node, pnpm) → update §2.

`pnpm run agents:check` is the deterministic gate; five rules are spec'd at the top of `scripts/check-agents.ts`. Spec: <https://agents.md/>.

---

## Rules

- NEVER change the Bun pin without re-reading `scripts/build.sh` and re-verifying the compiled `--bytecode --format=esm` binary and the full suite.
- NEVER inline `cortex update --as <id>` in skills when the `cortex_update` pi tool is available — manual attribution is not resumable.
- NEVER add husky / lefthook / pre-commit infrastructure without an issue first; CI + `pnpm run agents:check` covers the lint surface.
- NEVER hand-edit files under `bin/` or `tmp/` — both are generated.
- NEVER paste generated structure dumps (file trees, signature maps, repo overviews) into this file or the repo: Codex truncates AGENTS.md silently above 32 KiB, Claude Code's first-200-line load matters, and repository overviews do not improve agent task success (research @416).
- NEVER open `bun:sqlite` outside `src/store.ts`.
- NEVER add new top-level dirs to `src/` without running `pnpm run agents:map` and filling in the new `— TODO` line.
- NEVER add research findings or temporary metadata to the root of the project, ALWAYS us the `./tmp/` directory for temporary files and research notes
- NEVER test in the production database: `~/.config/cortex/*`, ALWAYS setup a temporary database for tests
