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
