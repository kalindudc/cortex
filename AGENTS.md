# Cortex — AGENTS.md

> Cortex is a single-binary, single-user, localhost-only task tracker for one
> human supervising several AI coding agents at once. This file is the
> always-loaded entry point for any agent working in this repo. Read it in
> full before touching code; for anything deeper, search the code on demand
> (`rg`, or a structural search) and read only the files that matter.

Spec: <https://agents.md/>. Linter: `pnpm run agents:check`.

## 1. Project overview

- One binary (`bin/cortex`) bundles CLI, REST + SSE API, and a Preact dashboard.
- Storage is a single SQLite WAL file at `~/.config/cortex/cortex.db` (NOT in this repo).
- The daemon (`cortex serve`) binds `127.0.0.1` only; there is no auth.
- Every `cortex update` REQUIRES `--as <session-id>` so multi-agent activity is attributable in the audit trail.
- Browser notifications fire ONLY on transitions into `blocked`.

## 2. Runtime & setup

- Bun is pinned to EXACTLY `1.4.2` (`devDependencies.bun`, `@types/bun`, CI). The compiled binary uses ESM bytecode (`--bytecode --format=esm`) because CJS bytecode fails on this module graph with newer Bun (verified on 1.3.14 and 1.4.2); see the rationale at the top of `scripts/build.sh` before changing the pin.
- Node is NOT used at runtime. `pnpm` is the package manager; install with `pnpm install --frozen-lockfile` (matches CI). The binary `bun` resolves via `pnpm exec bun` from `node_modules/.bin` — no global Bun required.
- Build output `bin/cortex` is produced by `pnpm run build`.

## 3. Commands

Every command below is a real script in `package.json` — the linter rule `commands.missing_script` fails CI if any drift sneaks in.

- `pnpm run build` — compile `bin/cortex` via `scripts/build.sh`.
- `pnpm test` — full suite: build + `bun test test/unit/ test/integration/` + `playwright install` + `playwright test`.
- `pnpm run test:unit` — unit tests only (fast; uses happy-dom preload).
- `pnpm run test:integration` — integration tests against the built binary.
- `pnpm run test:e2e` — Playwright + Chromium against the dev server.
- `pnpm run dev -- <cortex-args>` — run the CLI from source via Bun (no compile step); with no args on a TTY it opens the TUI. Uses the `tmp/dev/` data sandbox unless `CORTEX_DEV_REAL=1` (see `scripts/dev-env.sh`, `scripts/dev-cli.sh`).
- `pnpm run serve:dev` — live-reload dashboard (UI bundler watch + CSS watcher + `bun --watch` server) on port 7788, same `tmp/dev/` sandbox. See `scripts/dev.sh`.
- `pnpm run ui:build` / `pnpm run ui:watch` — produce `out/bundle.js` and `out/bundle.css`.
- `pnpm run style` — sync the `arch:src` block (as `agents:map`), then biome `--write` + `tsc --noEmit`.
- `pnpm run style:check` — same, read-only (CI-friendly).
- `pnpm run agents:check` — deterministic AGENTS.md drift linter (`scripts/check-agents.ts`).
- `pnpm run agents:map` — rewrite the `arch:src` block below from the immediate children of `src/` (`scripts/sync-arch-block.ts`).
- `pnpm run deploy` — local install: rebuild + copy to `~/bin/cortex`.

## 4. Architecture map

Layered: CLI (`src/cli.ts` + `src/commands/`) → Store (`src/store.ts`, SQLite WAL via `bun:sqlite`) → REST + SSE server (`src/server.ts`, hono) → Preact + signals dashboard (`src/ui/`) bundled into `out/` then embedded into `bin/cortex` via `with { type: "file" }` imports.

Top-level subdirectories of `src/` (auto-rewritten by `pnpm run agents:map` between the markers below — DO NOT hand-edit between the markers):

<!-- arch:src:begin -->
- src/commands/   — citty subcommands (one file per `cortex <verb>`)
- src/extensions/   — pi extension(s) embedded as Bun file assets
- src/skills/   — embedded agent skills (cortex, cortex-planner, cortex-implementer)
- src/tui/   — pi-tui terminal workspace (app shell + per-TUI session, keys/modes, tui.toml config, themes, safe text, view state)
- src/ui/   — Preact + signals dashboard (state/, components/, styles/)
<!-- arch:src:end -->

Other notable single-file modules (curated; not auto-rewritten):

- `src/client.ts` — typed REST client used by the CLI to talk to the daemon.
- `src/args.ts` — argv pre-normalizer run before citty parses: rewrites `--flag -value` into `--flag=-value` for known string flags of the detected subcommand, because citty 0.1.x never consumes a dash-leading token as a flag value (it leaves the flag boolean-true and can hijack aliases like `-b`).
- `src/events.ts` — SSE event types + helpers shared by server and UI.
- `src/skills.ts` — resolves embedded skill files for `cortex init`.
- `src/extensions.ts` — registers the pi extension surface.
- `src/paths.ts` — central source of truth for `CORTEX_DB` + config paths.

There is deliberately no generated repo map (removed after it proved too large to read and almost never used, research @416): find signatures and call sites on demand with `rg` or a structural (tree-sitter) search, then read only the files you need.

## 5. Code conventions

- TypeScript `strict`. ESM only (`"type": "module"`). Imports use the `.ts` extension (`allowImportingTsExtensions` is on per `tsconfig.json`).
- Preact JSX via `jsxImportSource: "preact"`. No React.
- Biome formats AND lints: `pnpm run style` writes, `pnpm run style:check` is read-only. Markdown is excluded by `biome.json` — do not "fix" it.
- ALL SQLite access goes through the `Store` class in `src/store.ts`. Never open `bun:sqlite` from anywhere else.
- CLI output goes through `console.*`, which `src/cli.ts` routes through the stdout/stderr streams (`src/stdio.ts`): under Bun 1.4.2 a raw `console.log`, `fs.writeSync(1, ...)` or `Bun.write(Bun.stdout, ...)` silently truncates (or repeats) output beyond 64 KiB on a pipe. Never add those raw writes; `test/integration/cli/large-output.test.ts` pins the real-pipe path.
- Every file-backed `Store.open` owns its database: it acquires the ownership lease unless handed the caller's `owner` lease (`:memory:` is exempt; there is no opt-out). flock is per open file description, so a second open of the same file in one process is refused as busy: share the Store or pass the lease. Code that must not own the database (dry-runs, `doctor`, tests beside a live daemon) reads through `Store.readSnapshot`. Commands never open the Store directly for normal work: they go through `withClient`, releasing it before any prompt, fzf or launched program.
- The dashboard reaches the daemon ONLY through `src/ui/api/client.ts` (relative fetch over the environment-neutral `src/api.ts`) and follows changes ONLY through `connectLive` in `src/ui/state/refresh.ts` (snapshot after every `ready`, apply frames past the snapshot cursor, desktop alerts only on `task.blocked`). Never import `src/client.ts`, `src/store.ts`, `node:*` or Bun from `src/ui/`: `test/unit/api/client.test.ts` bundles the dashboard and fails if they enter the graph.
- Author tags on `cortex update` follow `<role>-<8 hex>` (legacy fallback) OR `pi-<full-uuidv7>` (when issued via the `cortex_update` pi tool — preferred because pi-attributed updates are resumable).
- `scripts/` are Bun scripts when they need type-checking or stdlib parity (`scripts/watch-css.ts` is the precedent); thin orchestration stays in bash. macOS bash 3.2 must keep working — no associative arrays, no GNU awk extensions.
- Daemons are database-scoped (`src/daemon.ts`): a daemon holds its canonical database's ownership lease for its whole life and publishes `<db>.daemon.json` only once its listeners are ready; clients attach only after `/api/health` answers with the matching identity, recover stale metadata/sockets only while holding the lease, and NEVER signal a pid read from metadata (stop is the instance-bound IPC shutdown route). Control routes (`CONTROL_PATHS` in `src/api.ts`) exist ONLY on the IPC (Unix socket) app. `withClient` is the one CLI boundary: the verified daemon over its socket, else the same Hono handlers in-process under a temporary lease, with no fallback after a dispatched remote request.
- ONE sanitized rendering boundary for untrusted Markdown: `src/ui/lib/markdown.ts` (marked → DOMPurify HTML profile; Mermaid → `mermaid.render` in an inert staging element → DOMPurify SVG profile) consumed only through `src/ui/components/active/MarkdownView.tsx`. Never insert parsed HTML anywhere else, never concatenate untrusted HTML after sanitizing, and fail CLOSED (source view) when `DOMPurify.isSupported` is false.
- The rich draft preview (the TUI's `:preview`, `src/tui/bridge.ts`): tokens are created ONLY over IPC (`CONTROL_PATHS.preview`) into the daemon's bounded in-memory store `src/preview.ts` (random 128-bit token, 10-minute TTL, 1 MiB each, 8 MiB total, explicit errors) and never write a task; loopback reads need the exact token. `/preview/<token>` boots from `src/ui/index.tsx` WITHOUT the workspace: every workspace side effect lives in `src/ui/dashboard.tsx` (persisting the first-load theme included: importing `src/ui/state/theme.ts` only applies it), and `src/ui/components/Preview.tsx` renders only through MarkdownView with an injected `onRef`.
- The terminal renders Markdown ONLY through `src/tui/reader.ts`: the web's `marked` options on a private instance, every string escaped by `src/tui/safety.ts` before theme `style()`, OSC 8 only around `safeUrl` destinations, raw HTML as text. pi-tui's Markdown component is a renderer, not a security boundary (it emits unvalidated hyperlinks): never use it for task text. `@id`/`#tag` refs share the import-free grammar `src/ui/lib/refGrammar.ts`.
- Every actual modal surface (management/confirmation dialogs, the command palette, the mobile navigation drawer) renders through `src/ui/components/modals/DialogFrame.tsx` (native `<dialog>` + `showModal`). Sidebar filtering uses the nonmodal `src/ui/components/sidebar/SidebarFilterPanel.tsx`; the legacy filter-tags modal kind redirects there. Do not add ad-hoc overlay/`role="dialog"` wrappers.
- Interactive per-tag membership changes use `api.addTaskTag` / `api.removeTaskTag` (existing PATCH add/remove modes), not whole-list replacement from a stale UI snapshot. Removing a header pill MUST NOT delete the tag definition.
- The terminal mouse: `src/tui/mouse.ts` is the ONE parser of mouse reports (its input filter drops every unsupported one before pi-tui dispatches) and the shell owns DECSET 1002/1006 on every take/restore path (`TuiAltScreen` runs with `mouse: false`: it would enable any-motion 1003). Mouse selections ARE vi VISUAL (`selectRange`/`selectWord` on the editor and reader), and the mouse is never the only path to an action. The wheel moves a list (task list, `:commands`, dialog rows/fields) ONLY through `session.wheelNotch` (`WheelNotches`: one step a notch; Ghostty sends `mouse-scroll-multiplier` reports per notch); scrolled text takes every report.
- TUI help has three single sources: the `COMMANDS` registry (`src/tui/commands.ts`), the key table (`src/tui/keys.ts`) and `THEME_TOKENS` (`src/tui/theme.ts`). The help view renders ONLY through `src/tui/help.ts` (rows wrapped under the description column, never cut; `/` and n/N search it while it is open, never the task list). README's TUI reference tables (commands, default keys, tui.toml settings, bundled themes, theme tokens) are hand-written, with NO generator: `test/unit/tui/docs.test.ts` fails on drift, and `test/unit/tui/commands.test.ts` holds the FIXED P1–P10 command list and maps every key action to a command or a shell case. `tui.toml` (`leader`, `[keys.normal|leader|insert|visual]`, `mouse`, `theme`, `theme_dark`/`theme_light`, `appearance`, `colors`, `transparent_background`, `flash`, `bell`, `density`) and `themes/*.toml` are user-authored and never written: an invalid section keeps its defaults and reports to `:messages`.
- The SSE heartbeat (`DEFAULT_STREAM_LIMITS.heartbeatMs` in `src/server.ts`, 5 s) MUST stay under Bun.serve's 10 s default idle timeout; a longer gap lets Bun close idle streams and every client sees spurious reconnects.
- Title/body drafts (`src/ui/lib/useTaskDraft.ts`, like `src/tui/drafts.ts`) enable editing only after an atomic `api.taskState` baseline and save ONLY through `api.versioned.editTask` guarded by that field's token. A 412 keeps both versions behind the existing Apply / Keep my changes banner (Keep rebases on the displayed token and writes conditionally); live task copies are hints that trigger a re-read, never adopted text. Unguarded CLI/API writes stay last-writer-wins by design.
- Lane/tag dropdown search is OPTIONAL: `src/ui/lib/catalogSearch.ts` returns every entry for an empty query and every literal, case-insensitive AND-keyword match otherwise. NEVER impose a result cap or forced-refinement policy.
- Agent memory (`src/memory.ts`, `Store.searchMemory`): `_memory_sections`/`_memory_section_map` are DERIVED (one row per body/update-log section, each carrying its task title and tags; search coverage is decided per section so scattered terms in long documents do not qualify) — created on the first search (never in `migrate()`), reconciled by the `entity` revision token on every search, never backed up. `_body_edits` records BODY changes only (createTask/editTask); staleness and breadcrumbs are measured from it, never from `updated`. Never pass raw text to FTS5 MATCH (only quoted `memoryTerms()`); staleness runs in the CLI process (`cortex memory show`), never in the daemon.
- Mode shortcut matching/hints live in `src/ui/lib/keys.ts`; route actions through `requestMode`, preserve common browser shortcuts and AltGr text input, and suspend mode changes behind overlays. Browser coverage lives in `test/e2e/workspace-shortcuts.spec.ts`.
- `preferredReaderMode` is the browser-persisted Read/Edit/Split choice; `readerMode` is the effective view (heading links may temporarily show Read). NEVER reset the preference on task navigation or title editing; only explicit mode choices update it.
- `src/ui/styles/motion.css` owns shared motion (90/140/180ms; opacity/transform keyframes; localized tag-remove width transitions; the clamped title's in-flow `max-height` reveal is the ONLY sanctioned animation that moves document panels). NEVER defer state/focus or remount editors just to animate. Respect live reduced-motion changes and keep sidebar filter sessions alive during fallback-task changes; explicit task navigation still dismisses them.

## 6. Testing

Three concentric layers — the boundary matters because each layer makes
different I/O assumptions:

- `test/unit/` — `bun:test`, fast, isolated. Preloads `test/setup-happy-dom.ts` via `bunfig.toml` so DOM tests run without a browser. NEVER import `src/store.ts` directly here without giving the test its own tmp `CORTEX_DB` (see `test/unit/paths.test.ts` for the env-swap pattern). Aim for one unit test file per source file.
- `test/integration/` — `bun:test` against the COMPILED `bin/cortex`. Requires `pnpm run build` first; `pnpm run test:integration` does this. Lifecycle tests start daemons through `test/integration/fixtures/daemon.ts` (tracks and reaps every process it spawns); `cortex stop` is instance-bound, so it is safe inside a sandbox env. TUI tests drive the compiled binary in a real PTY through `test/integration/fixtures/pty.ts` (`Bun.Terminal`, no python3): it drains output continuously (a non-draining harness blocks the app and merges `Esc` with the next key) and checks termios restoration from the parent, with a SIGKILL control. `test/integration/tui.test.ts` covers rendering, modes, signals and restoration; `test/integration/tui-concurrency.test.ts` runs several TUIs and CLI writers against one daemon.
- `test/e2e/` — `@playwright/test` + Chromium against the compiled binary (per-test isolated daemon, see `test/e2e/fixtures/cortex-server.ts`). Sanitizer behavior is certified ONLY here: happy-dom cannot run DOMPurify, so `test/unit/` mocks `dompurify` as a passthrough and `test/e2e/document-safety.spec.ts` carries the real hostile-Markdown / Mermaid probes. Browser-only geometry, inertness and focus behavior live in `test/e2e/document-workspace.spec.ts`; `test/e2e/workspace-presentation.spec.ts` checks prototype layout/control geometry and `test/e2e/workspace-motion.spec.ts` checks rapid interactions, reduced motion and unchanged-SSE identity; `test/e2e/workspace-preferences.spec.ts` checks saved-mode navigation, reloads and temporary heading views. Attached sidebar filtering is covered by `test/e2e/sidebar-filters.spec.ts`; live convergence and transition-only blocked alerts by `test/e2e/live-sync.spec.ts`; guarded browser drafts racing a TUI-style guarded writer or the unguarded CLI (the fixture's `cli` runner) by `test/e2e/guarded-drafts.spec.ts`. The rich draft preview (exact unsaved source, zero writes, expiry/limits, hostile content, unsupported sanitizer, the Mermaid matrix, its own full-width scrolling layout, no stored preference) is certified by `test/e2e/tui-preview.spec.ts`; its probe documents are shared with the workspace specs through `test/e2e/fixtures/markdown-probes.ts`.

`pnpm test` runs all three. Snapshot tests live alongside their unit file; do not commit Playwright traces.

## 7. Commits & PRs

- Small, focused PRs. One concern per PR.
- Locally green BEFORE pushing: `pnpm run style:check && pnpm test && pnpm run agents:check`.
- CI runs the same three plus Playwright (`.github/workflows/test.yml`); `agents:check` is the FIRST gate — fast-fail on AGENTS.md drift.
- Never commit `out/`, `bin/`, or `tmp/` — `.gitignore` excludes them.

## 8. Where to look

- `src/store.ts` — SQLite schema, queries, transactions.
- `src/server.ts` — REST routes, SSE event stream, dev-reload route.
- `src/ui/components/App.tsx` — UI entry; routes signals into views.
- `src/ui/state/signals.ts` — global signal store + derived computed.
- `src/ui/state/workspace.ts` — document-workspace controller (query/body-mode preference persistence, Document entry, `requestMode` / `requestPostUpdate` / `revealSidebarFilter`, transient-state reset, narrow-viewport tracking).
- `src/ui/components/active/TaskToolbar.tsx` — workspace actions and Read/Edit/Split; `TaskHeader` owns only the document identity/metadata and shared title draft. Its pinned display title clamps to `TITLE_CLAMP_LINES`; a reveal (pointer rests on the title for `TITLE_REVEAL_INTENT_MS`, stays until it leaves the header; or keyboard focus-visible) grows the title IN FLOW so the metadata row and reader/editor move down with it — never as an overlay. `TaskHeader` owns the reveal state and measurement; `document.css` + `motion.css` own the look. The title textarea is never clamped.
- `src/ui/lib/markdown.ts` — the sanitized Markdown/Mermaid rendering boundary (see §5).
- `src/memory.ts` — agent-memory helpers (terms, cited paths, lane from git's common dir, staleness, breadcrumbs, rendering); `src/commands/memory.ts` is the `cortex memory` CLI.
- `src/skills/` — markdown skill bodies embedded by `cortex init`.
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
- NEVER hand-edit files under `out/`, `bin/`, or `tmp/` — all are generated.
- NEVER paste generated structure dumps (file trees, signature maps, repo overviews) into this file or the repo: Codex truncates AGENTS.md silently above 32 KiB, Claude Code's first-200-line load matters, and repository overviews do not improve agent task success (research @416).
- NEVER open `bun:sqlite` outside `src/store.ts`.
- NEVER add new top-level dirs to `src/` without running `pnpm run agents:map` and filling in the new `— TODO` line.
- NEVER add research findings or temporary metadata to the root of the project, ALWAYS us the `./tmp/` directory for temporary files and research notes
- NEVER test in the production database: `~/.config/cortex/*`, ALWAYS setup a temporary database for tests
