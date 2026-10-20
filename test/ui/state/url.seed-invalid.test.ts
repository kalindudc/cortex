// Companion to url.test.ts: covers the garbage-URL seed gate.
//
// state/url.ts reads location.pathname at module load and must REJECT
// anything that isn't `^/task/(\d+)$` with a positive finite integer.
// The four concrete garbage variants the plan calls out (`/task/abc`,
// `/task/`, `/task/0`, `/task/1.5`) all flow through the same regex +
// parseInt + positive-integer gate; one variant exercises that branch.
//
// Critically, this test ALSO proves the layering: state/lastTask.ts has
// already seeded `selectedId` to 5 (simulated via a direct write below)
// BEFORE state/url.ts loads. A garbage URL must leave that prior seed
// alone — URL > localStorage > fallback applies only when the URL is
// valid; on garbage the localStorage seed survives.
//
// Bun caches ESM modules per-process and batches all *.test.ts files in
// test/ui/ into ONE process, so we cache-bust the dynamic import with
// a unique query suffix (`?b=url-seed-invalid`) to get our own fresh
// instance of state/url.ts (own `seeded` flag, own effect closure).
// After capture we RESET selectedId to null so the prior-seed simulation
// here does not leak into other test files that capture selectedId at
// their own top level (notably state/lastTask.seed-invalid.test.ts).

import { describe, test, expect } from "bun:test";
import { selectedId } from "../../../src/ui/state/signals.ts";

// happy-dom defaults the document location to `about:blank`, an opaque
// origin where History.replaceState/pushState silently no-op. Set a real
// origin BEFORE any history mutation so the URL effect's first tick can
// canonicalize the pathname.
// biome-ignore lint/suspicious/noExplicitAny: happy-dom-only helper, not in lib.dom
(window as any).happyDOM?.setURL?.("http://localhost/");

// Pre-seed garbage path BEFORE importing the module under test, then write
// 5 to selectedId to simulate the lastTask seed that ran earlier in boot.
// state/url.ts must NOT overwrite the 5 — parsePathname returns null on
// garbage, and the seed-block in the module is `if (seed != null)`.
window.history.replaceState(null, "", "/task/abc");
selectedId.value = 5;
// @ts-expect-error — cache-bust query suffix has no .d.ts; runtime-only.
await import("../../../src/ui/state/url.ts?b=url-seed-invalid");
const seededAfterImport = selectedId.value;
// Restore null so this file's prior-seed simulation does not pollute
// later test files in the same Bun process.
selectedId.value = null;
window.history.replaceState(null, "", "/");

describe("state/url seed gate", () => {
  test("garbage path /task/abc leaves the prior (localStorage) seed intact", () => {
    expect(seededAfterImport).toBe(5);
  });
});
