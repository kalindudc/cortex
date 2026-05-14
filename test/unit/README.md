# Unit tests (`test/unit/`)

Component + state unit tests that run under `bun:test` with a happy-dom DOM.

Run: `pnpm run test:unit` (or `pnpm test` for the full backend + UI suite).

## Preact event-name gotchas

Preact does NOT use React's synthetic event names. Tests copied straight from
React-Testing-Library docs will silently misfire on Preact components.

- Typing into an `<input>` / `<textarea>`: Preact dispatches `onInput`, NOT `onChange`.
  Use `fireEvent.input(el, { target: { value: "x" } })`.
- Double-click: Preact dispatches `onDblClick`, NOT `onDoubleClick`.
  Use `fireEvent.dblClick(el)`.
- Before submitting a test PR, `grep -nE "fireEvent\.(change|doubleClick)"`
  inside `test/unit/` and convert any matches.

## File layout

`test/unit/components/<feature>/<Component>.test.tsx` mirrors
`src/ui/components/<feature>/<Component>.tsx`. State / lib helpers live
under `test/unit/state/` and `test/unit/lib/` respectively.

Tests live under `test/` (not co-located with sources) because the bundler
entrypoint is `src/ui/index.tsx` — Bun would happily pull `*.test.tsx`
files into the production bundle if they sat under `src/ui/`.

## Backend tests

Every `src/<file>.ts` (excluding `src/ui/`, `src/commands/`, `src/extensions/`,
and `src/types.d.ts`) has a matching `test/unit/<file>.test.ts`:

| Source                     | Unit test                          |
| -------------------------- | ---------------------------------- |
| `src/store.ts`             | `test/unit/store.test.ts`          |
| `src/server.ts`            | `test/unit/server.test.ts`         |
| `src/client.ts`            | `test/unit/client.test.ts`         |
| `src/events.ts`            | `test/unit/events.test.ts`         |
| `src/paths.ts`             | `test/unit/paths.test.ts`          |
| `src/skills.ts`            | `test/unit/skills.test.ts`         |
| `src/extensions.ts`        | `test/unit/extensions.test.ts`     |
| `src/cli.ts`               | `test/unit/cli.test.ts`            |

Plus focused unit files for cross-cutting validators that don't have a
dedicated source file:

- `test/unit/author.test.ts` — `validateAuthorTag` (exported from
  `src/store.ts`).

### Conventions

Backend unit tests are PURE in-process by definition:

- Use `Store.open(":memory:")` for store-touching tests — no tmp dirs.
- Use `buildApp(store).fetch(new Request(...))` for HTTP route tests —
  no port binding, no `startServer`.
- Pin `process.env.XDG_CONFIG_HOME` (and `CORTEX_DB`,
  `CORTEX_PI_EXTENSION_DIR`, `CORTEX_SKILL_DIR` as relevant) to a
  `fs.mkdtempSync()` directory BEFORE calling any function that reads
  those envs. Restore via `try/finally` or `afterEach`. Files that test
  default-fallback behavior MUST assert only on returned path strings
  — NEVER call a function that writes to disk while pointing at the
  real `~/.config/cortex` or `~/.pi/agent/extensions`.

The layout invariants (mirror, no-binary-spawn, hermetic) are enforced by
`test/unit/_layout.test.ts` — a guard test that scans every test file in
the tree and fails CI on drift. Adding a new backend `src/*.ts` without
its matching unit test fails this guard.

## API mocking

Mock the typed API client at module level:

```ts
import { mock } from "bun:test";
mock.module("../../../../src/ui/api/client.ts", () => ({
  api: {
    editTask: mock(() => Promise.resolve({})),
    // ...
  },
}));
```
