// Registers happy-dom's Window as the global DOM for every bun:test process.
// Imported via bunfig.toml [test] preload BEFORE any *.test.tsx file imports
// a Preact component. After this runs: document, window, Element, KeyboardEvent
// etc. are real and component renders/events work in Node-style isolation.
//
// IMPORTANT: @happy-dom/global-registrator overwrites globalThis.fetch with a
// browser-shaped fetch backed by Node's http internals. Bun's native fetch is
// shadowed and breaks every backend test that hits the cortex daemon
// (test/ui.test.ts, test/concurrency.test.ts, etc.) with
//     TypeError: undefined is not a function  (at nodeRequest.end())
// We capture the native fetch BEFORE registering and put it back AFTER, so
// backend tests see Bun's fetch and unit tests see all the DOM globals.
//
// This is a known pinch-point with the global-preload approach. If we ever
// add unit tests that themselves call window.fetch, swap to a per-file opt-in
// model (each test/unit/**/*.test.tsx imports this setup directly) — see
// the "Future work" note in cortex task 27's plan body.
import { afterEach } from "bun:test";
import { cleanup } from "@testing-library/preact";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Snapshot Bun's native HTTP primitives BEFORE happy-dom replaces them.
// happy-dom installs browser-shaped fetch/Request/Response/Headers/XMLHttpRequest
// backed by Node's http internals, which crashes under Bun with
//     TypeError: undefined is not a function  (at nodeRequest.end())
// Restoring the natives keeps backend tests (test/ui.test.ts, test/concurrency.test.ts,
// etc.) talking to a real server while unit tests still get document, window,
// HTMLElement, KeyboardEvent, etc. from happy-dom.
const native = {
  fetch: globalThis.fetch,
  Request: globalThis.Request,
  Response: globalThis.Response,
  Headers: globalThis.Headers,
  FormData: globalThis.FormData,
  XMLHttpRequest: globalThis.XMLHttpRequest,
};
GlobalRegistrator.register();
for (const [k, v] of Object.entries(native)) {
  if (v) (globalThis as Record<string, unknown>)[k] = v;
}

// @testing-library/preact does NOT auto-clean between tests under bun:test
// (it relies on jest/vitest globals for that). Without this hook each test
// inherits the previous test's render, so document.querySelector returns the
// first match across tests instead of just the current one. cleanup() unmounts
// every render and resets document.body — cheap, idempotent, safe for
// non-render tests too.
afterEach(() => {
  cleanup();
});
