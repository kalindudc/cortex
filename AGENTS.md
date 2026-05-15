# Cortex — AGENTS.md

> Cortex is a single-binary, single-user, localhost-only task tracker for one
> human supervising several AI coding agents at once. This file is the
> always-loaded entry point for any agent working in this repo. Read it in
> full before touching code; consult `.cortex/repo-map.md` on demand for a
> deep structural view.

Spec: <https://agents.md/>. Linter: `pnpm run agents:check`.

## 1. Project overview

- One binary (`bin/cortex`) bundles CLI, REST + SSE API, and a Preact dashboard.
- Storage is a single SQLite WAL file at `~/.config/cortex/cortex.db` (NOT in this repo — `.cortex/` here is repo-data, not user-data).
- The daemon (`cortex serve`) binds `127.0.0.1` only; there is no auth.
- Every `cortex update` REQUIRES `--as <session-id>` so multi-agent activity is attributable in the audit trail.
- Browser notifications fire ONLY on transitions into `blocked`.

## 2. Runtime & setup

- Bun is pinned to EXACTLY `1.1.12` in `package.json` `devDependencies.bun`. Newer Bun (≥1.3) regresses `--bytecode` on bundles with CJS deps; see the full rationale at the top of `scripts/build.sh` before bumping.
- Node is NOT used at runtime. `pnpm` is the package manager; install with `pnpm install --frozen-lockfile` (matches CI). The binary `bun` resolves via `pnpm exec bun` from `node_modules/.bin` — no global Bun required.
- Build output `bin/cortex` is produced by `pnpm run build`.
- `.cortex/` is THIS repo's auto-generated agent-metadata directory. It is unrelated to `~/.config/cortex/` (the SQLite home). Do not confuse them.

## 3. Commands

Every command below is a real script in `package.json` — the linter rule `commands.missing_script` fails CI if any drift sneaks in.

- `pnpm run build` — compile `bin/cortex` via `scripts/build.sh`.
- `pnpm test` — full suite: build + `bun test test/unit/ test/integration/` + `playwright install` + `playwright test`.
- `pnpm run test:unit` — unit tests only (fast; uses happy-dom preload).
- `pnpm run test:integration` — integration tests against the built binary.
- `pnpm run test:e2e` — Playwright + Chromium against the dev server.
- `pnpm run dev -- <cortex-args>` — run the CLI from source via Bun (no compile step).
- `pnpm run serve:dev` — live-reload dashboard (UI bundler watch + CSS watcher + `bun --watch` server). See `scripts/dev.sh`.
- `pnpm run ui:build` / `pnpm run ui:watch` — produce `out/bundle.js` and `out/bundle.css`.
- `pnpm run style` — biome `--write` + `tsc --noEmit`.
- `pnpm run style:check` — same, read-only (CI-friendly).
- `pnpm run agents:check` — deterministic AGENTS.md drift linter (`scripts/check-agents.ts`).
- `pnpm run agents:map` — regenerate `.cortex/repo-map.md` AND the `arch:src` block below (`scripts/build-repo-map.sh`).
- `pnpm run deploy` — local install: rebuild + copy to `~/bin/cortex`.

## 4. Architecture map

Layered: CLI (`src/cli.ts` + `src/commands/`) → Store (`src/store.ts`, SQLite WAL via `bun:sqlite`) → REST + SSE server (`src/server.ts`, hono) → Preact + signals dashboard (`src/ui/`) bundled into `out/` then embedded into `bin/cortex` via `with { type: "file" }` imports.

Top-level subdirectories of `src/` (auto-rewritten by `pnpm run agents:map` between the markers below — DO NOT hand-edit between the markers):

<!-- arch:src:begin -->
- src/commands/   — citty subcommands (one file per `cortex <verb>`)
- src/extensions/   — pi extension(s) embedded as Bun file assets
- src/skills/   — embedded agent skills (cortex, cortex-planner, cortex-implementer)
- src/ui/   — Preact + signals dashboard (state/, components/, styles/)
<!-- arch:src:end -->

Other notable single-file modules (curated; not auto-rewritten):

- `src/client.ts` — typed REST client used by the CLI to talk to the daemon.
- `src/events.ts` — SSE event types + helpers shared by server and UI.
- `src/skills.ts` — resolves embedded skill files for `cortex init`.
- `src/extensions.ts` — registers the pi extension surface.
- `src/paths.ts` — central source of truth for `CORTEX_DB` + config paths.

For a deep, tree-sitter-extracted signature view of every TS file in `src/`, `scripts/`, and `test/`, read `.cortex/repo-map.md`.
Note: If a `repo-map` does not exist, run `pnpm run agents:map` to generate one. The repo is excluded from version control.

## 5. Code conventions

- TypeScript `strict`. ESM only (`"type": "module"`). Imports use the `.ts` extension (`allowImportingTsExtensions` is on per `tsconfig.json`).
- Preact JSX via `jsxImportSource: "preact"`. No React.
- Biome formats AND lints: `pnpm run style` writes, `pnpm run style:check` is read-only. Markdown is excluded by `biome.json` — do not "fix" it.
- ALL SQLite access goes through the `Store` class in `src/store.ts`. Never open `bun:sqlite` from anywhere else.
- Author tags on `cortex update` follow `<role>-<8 hex>` (legacy fallback) OR `pi-<full-uuidv7>` (when issued via the `cortex_update` pi tool — preferred because pi-attributed updates are resumable).
- `scripts/` are Bun scripts when they need type-checking or stdlib parity (`scripts/watch-css.ts` is the precedent); thin orchestration stays in bash. macOS bash 3.2 must keep working — no associative arrays, no GNU awk extensions.

## 6. Testing

Three concentric layers — the boundary matters because each layer makes
different I/O assumptions:

- `test/unit/` — `bun:test`, fast, isolated. Preloads `test/setup-happy-dom.ts` via `bunfig.toml` so DOM tests run without a browser. NEVER import `src/store.ts` directly here without giving the test its own tmp `CORTEX_DB` (see `test/unit/paths.test.ts` for the env-swap pattern). Aim for one unit test file per source file.
- `test/integration/` — `bun:test` against the COMPILED `bin/cortex`. Requires `pnpm run build` first; `pnpm run test:integration` does this.
- `test/e2e/` — `@playwright/test` + Chromium against the live dev server.

`pnpm test` runs all three. Snapshot tests live alongside their unit file; do not commit Playwright traces.

## 7. Commits & PRs

- Small, focused PRs. One concern per PR.
- Locally green BEFORE pushing: `pnpm run style:check && pnpm test && pnpm run agents:check`.
- CI runs the same three plus Playwright (`.github/workflows/test.yml`); `agents:check` is the FIRST gate — fast-fail on AGENTS.md drift.
- Never commit `out/`, `bin/`, or `tmp/` — `.gitignore` excludes them.
- DO commit `.cortex/repo-map.md` (sidecar is reviewed in the diff; agents on first clone get it without running `agents:map`).

## 8. Where to look

- `src/store.ts` — SQLite schema, queries, transactions.
- `src/server.ts` — REST routes, SSE event stream, dev-reload route.
- `src/ui/components/App.tsx` — UI entry; routes signals into views.
- `src/ui/state/signals.ts` — global signal store + derived computed.
- `src/skills/` — markdown skill bodies embedded by `cortex init`.
- `src/extensions/pi.ts` — pi extension surface (custom tools).
- `.cortex/repo-map.md` — full tree-sitter signature dump (deep search).
- `.github/workflows/test.yml` — CI definition (single `test` job).

## 9. Maintenance loop

This file plus `.cortex/repo-map.md` form an auto-improving contract. Any agent that touches the repo MUST keep them honest; the linter makes it enforceable, not aspirational.

Update AGENTS.md (and run `pnpm run agents:map`) IN THE SAME PR when you:

- add or rename a `pnpm run <X>` script → list it in §3 Commands;
- add a new immediate child of `src/` → run `pnpm run agents:map`, then replace the new `— TODO` description in the marker block above;
- introduce a new convention (lint rule, file-layout rule, test rule) → add a bullet under §5, §6, or §8 as appropriate;
- add or remove a top-level path that this file cites in backticks (`paths.missing` will fail CI otherwise);
- bump or unpin a runtime version (Bun, Node, pnpm) → update §2.

`pnpm run agents:check` is the deterministic gate; six rules are spec'd at the top of `scripts/check-agents.ts`. Spec: <https://agents.md/>.

---

## Rules

- NEVER bump Bun above `1.1.12` without first re-reading the rationale in `scripts/build.sh` and verifying `--bytecode` + CJS still works.
- NEVER inline `cortex update --as <id>` in skills when the `cortex_update` pi tool is available — manual attribution is not resumable.
- NEVER add husky / lefthook / pre-commit infrastructure without an issue first; CI + `pnpm run agents:check` covers the lint surface.
- NEVER hand-edit files under `out/`, `bin/`, `tmp/`, or `.cortex/repo-map.md` — all are generated.
- NEVER inline `.cortex/repo-map.md` into this file. The sidecar exists to keep the always-loaded budget small (Codex truncates AGENTS.md silently above 32 KiB; Claude Code's first-200-line load matters).
- NEVER open `bun:sqlite` outside `src/store.ts`.
- NEVER add new top-level dirs to `src/` without running `pnpm run agents:map` and filling in the new `— TODO` line.
- NEVER add research findings or temporary metadata to the root of the project, ALWAYS us the `./tmp/` directory for temporary files and research notes
- NEVER test in the production database: `~/.config/cortex/*`, ALWAYS setup a temporary database for tests
