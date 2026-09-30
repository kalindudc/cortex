# Unit tests (`test/unit/`)

Fast, isolated, in-process tests under plain `bun:test`: no DOM and no
spawned `bin/cortex`.

Run: `pnpm run test:unit` (or `pnpm test` for the full unit + integration suite).

## File layout: one mirror test per source

Every `src/**/*.ts` (excluding `src/commands/`, `src/extensions/` and
`src/types.d.ts`) has a matching `test/unit/<same path>.test.ts`:

| Source                     | Unit test                          |
| -------------------------- | ---------------------------------- |
| `src/store.ts`             | `test/unit/store.test.ts`          |
| `src/server.ts`            | `test/unit/server.test.ts`         |
| `src/client.ts`            | `test/unit/client.test.ts`         |
| `src/lib/fuzzy.ts`         | `test/unit/lib/fuzzy.test.ts`      |
| `src/tui/reader.ts`        | `test/unit/tui/reader.test.ts`     |

Commands are covered by integration tests under `test/integration/cli/`
(or the round-trip `test/integration/cli.test.ts`). Focused unit files for
cross-cutting validators may sit beside the mirrors, for example
`test/unit/author.test.ts` (`validateAuthorTag`, exported from `src/store.ts`).

## Conventions

Unit tests are PURE in-process by definition:

- Use `Store.open(":memory:")` for store-touching tests — no tmp dirs.
- Use `buildApp(store).fetch(new Request(...))` for HTTP route tests —
  no port binding, no `startServer`.
- Never spawn the cortex binary: that is the integration tier's job
  (`test/integration/helpers.ts`, `runCli`).
- Pin `process.env.XDG_CONFIG_HOME` (and `CORTEX_DB`,
  `CORTEX_PI_EXTENSION_DIR`, `CORTEX_SKILL_DIR` as relevant) to a
  `fs.mkdtempSync()` directory BEFORE calling any function that reads
  those envs. Restore via `try/finally` or `afterEach`. Files that test
  default-fallback behavior MUST assert only on returned path strings
  — NEVER call a function that writes to disk while pointing at the
  real `~/.config/cortex` or `~/.pi/agent/extensions`.

The layout invariants (mirror, no-binary-spawn, hermetic) are enforced by
`test/unit/_layout.test.ts` — a guard test that scans every test file in
the tree and fails CI on drift. Adding a new `src/` file without its
matching unit test fails this guard.
