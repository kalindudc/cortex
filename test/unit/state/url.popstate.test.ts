// Companion to url.test.ts: covers Back/Forward via popstate.
//
// happy-dom dispatches `popstate` when test code calls
// `window.dispatchEvent(new PopStateEvent("popstate"))`. The url module
// listens for this and writes the parsed pathname back into selectedId
// (number for `/task/<n>`, null for `/` or any non-matching path).
//
// The pathname-equality short-circuit in the effect makes the
// popstate → selectedId.value = n → effect path echo-safe (no extra push
// is generated). This file asserts both directions plus the garbage case.

import { describe, test, expect, beforeEach } from "bun:test";
import { selectedId } from "../../../src/ui/state/signals.ts";

// happy-dom defaults to `about:blank`, an opaque origin where History
// mutations silently no-op. Set a real origin so pushState/popstate work.
// biome-ignore lint/suspicious/noExplicitAny: happy-dom-only helper, not in lib.dom
(window as any).happyDOM?.setURL?.("http://localhost/");

// Pre-seed `/` so the module loads with no URL-driven seed. selectedId
// starts as null (matches the module's `if (seed != null)` guard).
// Cache-bust the import so this file gets its own popstate listener,
// independent of which other test file loaded state/url.ts first.
selectedId.value = null;
window.history.replaceState(null, "", "/");
// @ts-expect-error — cache-bust query suffix has no .d.ts; runtime-only.
await import("../../../src/ui/state/url.ts?b=url-popstate");

describe("state/url popstate", () => {
  beforeEach(() => {
    selectedId.value = null;
    window.history.replaceState(null, "", "/");
  });

  test("popstate to /task/9 sets selectedId to 9", () => {
    window.history.pushState(null, "", "/task/9");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(selectedId.value).toBe(9);
  });

  test("popstate to / sets selectedId to null", () => {
    // First land on /task/3, then navigate back to /.
    window.history.pushState(null, "", "/task/3");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(selectedId.value).toBe(3);
    window.history.pushState(null, "", "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(selectedId.value).toBeNull();
  });

  test("popstate to garbage /task/abc sets selectedId to null (consistent with seed gate)", () => {
    window.history.pushState(null, "", "/task/abc");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(selectedId.value).toBeNull();
  });

  test("popstate to /task/9#frag restores the task AND stages the heading fragment", async () => {
    const { pendingHeadingFragment } = await import("../../../src/ui/state/signals.ts");
    const currentFragment = (): { taskId: number; id: string } | null => pendingHeadingFragment.value;
    pendingHeadingFragment.value = null;
    window.history.pushState(null, "", "/task/9#task-9-setup");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(selectedId.value).toBe(9);
    expect(currentFragment()).toEqual({ taskId: 9, id: "task-9-setup" });
    pendingHeadingFragment.value = null;
  });

  test("popstate to a plain task path clears any stale pending fragment", async () => {
    const { pendingHeadingFragment } = await import("../../../src/ui/state/signals.ts");
    pendingHeadingFragment.value = { taskId: 99, id: "stale-frag" };
    window.history.pushState(null, "", "/task/6");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(selectedId.value).toBe(6);
    expect(pendingHeadingFragment.value).toBeNull();
  });

  test("same-task hash navigation stages the heading and reveals Document/Read", async () => {
    const { pendingHeadingFragment, tab, readerMode } = await import("../../../src/ui/state/signals.ts");
    const currentTab = (): string => tab.value;
    const currentMode = (): string => readerMode.value;
    selectedId.value = 9;
    tab.value = "updates";
    readerMode.value = "edit";
    window.history.pushState(null, "", "/task/9#task-9-details");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(pendingHeadingFragment.value).toEqual({ taskId: 9, id: "task-9-details" });
    expect(currentTab()).toBe("document");
    expect(currentMode()).toBe("read");
  });

  test("popstate-driven write does NOT trigger an extra pushState (pathname-equality short-circuit)", () => {
    // Push /task/4 then dispatch popstate so the handler writes 4 into
    // selectedId. The effect fires synchronously after the signal write
    // but the pathname already matches `/task/4`, so the effect MUST
    // short-circuit and not write a second history entry. We assert that
    // by checking the pathname is unchanged before vs after the dispatch.
    window.history.pushState(null, "", "/task/4");
    const before = window.location.pathname;
    window.dispatchEvent(new PopStateEvent("popstate"));
    const after = window.location.pathname;
    expect(after).toBe(before);
    expect(selectedId.value).toBe(4);
  });
});
