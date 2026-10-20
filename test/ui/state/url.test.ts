// Unit tests for the URL ⇄ selectedId persistence module — valid path.
//
// happy-dom (preloaded by `pnpm run test:ui`) provides a real
// window.history (pushState/replaceState) and dispatches popstate. The
// module under test reads location.pathname at module load and registers
// an effect() over selectedId, so the SEED is captured by pre-setting
// window.location BEFORE the dynamic import.
//
// Bun caches ESM modules per-process and batches all *.test.ts files in
// test/ui/ into ONE process, so we cache-bust the dynamic import with a
// unique query suffix (`?b=url-test`). This gives this file its own fresh
// instance of state/url.ts (its own `seeded` flag, its own effect closure,
// its own popstate listener) so the seed-block runs deterministically here
// regardless of which other test file loaded url.ts first.
//
// Companion files:
//   - test/ui/state/url.seed-invalid.test.ts — garbage-URL seed gate
//   - test/ui/state/url.popstate.test.ts    — Back/Forward via popstate

import { describe, test, expect, beforeEach, spyOn } from "bun:test";
import { selectedId, filters, workspaceQuery, pendingHeadingFragment, view } from "../../../src/ui/state/signals.ts";

// happy-dom defaults the document location to `about:blank`, an opaque
// origin where History.replaceState/pushState silently no-op (pathname
// stays "blank"). Set a real origin BEFORE any history mutation so the
// URL effect under test can observe its own writes.
// biome-ignore lint/suspicious/noExplicitAny: happy-dom-only helper, not in lib.dom
(window as any).happyDOM?.setURL?.("http://localhost/");

// Pre-seed BEFORE importing the module under test — the seed runs at
// module load and the synchronous first effect tick runs immediately
// after. Reset selectedId first so a value leaked from a previously-run
// test file does not pollute the capture. Cache-bust the import (see
// header comment) so the seed-block runs in this file's own module copy.
selectedId.value = null;
window.history.replaceState(null, "", "/task/42");
// @ts-expect-error — cache-bust query suffix has no .d.ts; runtime-only.
const loaded = await import("../../../src/ui/state/url.ts?b=url-test");
const urlModule = loaded as typeof import("../../../src/ui/state/url.ts");
// Read through .peek() so TS doesn't narrow .value to `null` based on the
// reset above — the dynamic import re-seeds selectedId before this line.
const seededAfterImport: number | null = selectedId.peek();

describe("state/url", () => {
  beforeEach(() => {
    // Reset BOTH the signal and the URL so each test starts from a known
    // baseline. Use replaceState (not pushState) so we don't accumulate
    // history entries across tests.
    selectedId.value = null;
    window.history.replaceState(null, "", "/");
  });

  test("seed sets selectedId from /task/<n> at module load", () => {
    expect(seededAfterImport).toBe(42);
  });

  test("user selection updates the pathname to /task/<id>", () => {
    selectedId.value = 7;
    expect(window.location.pathname).toBe("/task/7");
  });

  test("clearing selectedId reverts the pathname to /", () => {
    selectedId.value = 7;
    expect(window.location.pathname).toBe("/task/7");
    selectedId.value = null;
    expect(window.location.pathname).toBe("/");
  });

  test("no-op write (assigning the current id) does NOT change pathname", () => {
    selectedId.value = 11;
    expect(window.location.pathname).toBe("/task/11");
    // @preact/signals dedupes equal writes — effect does not fire, and the
    // pathname-equality short-circuit in the effect would catch it anyway.
    selectedId.value = 11;
    expect(window.location.pathname).toBe("/task/11");
  });

  test("filter/query changes NEVER push task history or alter the task URL", () => {
    selectedId.value = 7;
    const push = spyOn(window.history, "pushState");
    push.mockClear();
    filters.value = { status: "review", lane: "next", tag: ["bug"] };
    workspaceQuery.value = "outside current lane";
    expect(window.location.pathname).toBe("/task/7");
    expect(push).not.toHaveBeenCalled();
    push.mockRestore();
  });

  test("clearing a deleted selection clears its stale heading target", () => {
    selectedId.value = 7;
    pendingHeadingFragment.value = { taskId: 7, id: "deleted-heading" };
    selectedId.value = null;
    expect(window.location.pathname).toBe("/");
    expect(pendingHeadingFragment.value).toBeNull();
  });

  test("a launch link for the task already open returns to Tasks from the Lanes view", () => {
    const currentView = (): string => view.value;
    selectedId.value = 7;
    view.value = "lanes";
    urlModule.openTask(7, null);
    expect(selectedId.value).toBe(7);
    expect(window.location.pathname).toBe("/task/7");
    expect(currentView()).toBe("tasks");
  });
});

// ---- heading fragments ----
describe("state/url parseHeadingFragment", () => {
  test("valid fragment alongside a task id passes through", async () => {
    const { parseHeadingFragment } = await import("../../../src/ui/state/url.ts");
    expect(parseHeadingFragment("#task-5-beta", 5)).toBe("task-5-beta");
  });

  test("fragment WITHOUT a task path is rejected (no second router)", async () => {
    const { parseHeadingFragment } = await import("../../../src/ui/state/url.ts");
    expect(parseHeadingFragment("#task-5-beta", null)).toBeNull();
  });

  test("empty and non-slug fragments are rejected", async () => {
    const { parseHeadingFragment } = await import("../../../src/ui/state/url.ts");
    expect(parseHeadingFragment("", 5)).toBeNull();
    expect(parseHeadingFragment("#", 5)).toBeNull();
    expect(parseHeadingFragment("#<script>", 5)).toBeNull();
    expect(parseHeadingFragment("#a b", 5)).toBeNull();
  });
});
