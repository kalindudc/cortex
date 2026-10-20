// state/context.ts — the side panel's open state, tab and persistence. Each
// seed scenario loads a FRESH module instance (cache-bust query suffix) so
// its initializer runs against the storage it sets up.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { focusReading, narrowViewport, view } from "../../../src/ui/state/signals.ts";

type ContextModule = typeof import("../../../src/ui/state/context.ts");

const KEY = "cortex-context-v1";

async function load(tag: string): Promise<ContextModule> {
  return (await import(`../../../src/ui/state/context.ts?seed=${tag}`)) as ContextModule;
}

describe("state/context", () => {
  beforeEach(() => {
    localStorage.clear();
    narrowViewport.value = false;
    focusReading.value = false;
    view.value = "tasks";
  });
  afterEach(() => {
    localStorage.clear();
    narrowViewport.value = false;
    focusReading.value = false;
    view.value = "tasks";
  });

  test("defaults: open on Details, sheet closed, no outline", async () => {
    const mod = await load("defaults");
    expect(mod.CONTEXT_KEY).toBe(KEY);
    expect(mod.contextOpen.value).toBe(true);
    expect(mod.contextTab.value).toBe("details");
    expect(mod.contextSheetOpen.value).toBe(false);
    expect(mod.docOutline.value).toBeNull();
    expect(mod.contextShown()).toBe(true);
  });

  test("a valid stored value seeds both signals and storage keeps it", async () => {
    localStorage.setItem(KEY, JSON.stringify({ open: false, tab: "inbox" }));
    const mod = await load("stored");
    expect(mod.contextOpen.value).toBe(false);
    expect(mod.contextTab.value).toBe("inbox");
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toEqual({ open: false, tab: "inbox" });
  });

  test("garbage, an unknown tab and an over-long string keep the defaults", async () => {
    const mod = await load("parser");
    expect(mod.parseStoredContext(null)).toBeNull();
    expect(mod.parseStoredContext("not json")).toBeNull();
    expect(mod.parseStoredContext("[]")).toBeNull();
    expect(mod.parseStoredContext(JSON.stringify({ open: "yes", tab: "details" }))).toBeNull();
    expect(mod.parseStoredContext(JSON.stringify({ open: true, tab: "authors" }))).toBeNull();
    expect(mod.parseStoredContext(JSON.stringify({ open: true, tab: "outline", pad: "x".repeat(400) }))).toBeNull();
    expect(mod.parseStoredContext(JSON.stringify({ open: false, tab: "outline" }))).toEqual({
      open: false,
      tab: "outline",
    });

    localStorage.setItem(KEY, JSON.stringify({ open: false, tab: "related" }));
    const seeded = await load("invalid");
    expect(seeded.contextOpen.value).toBe(true);
    expect(seeded.contextTab.value).toBe("details");
  });

  test("changes persist", async () => {
    const mod = await load("persist");
    mod.contextOpen.value = false;
    mod.contextTab.value = "outline";
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toEqual({ open: false, tab: "outline" });
  });

  test("showContext on a narrow viewport opens only the sheet; the stored open state is unchanged", async () => {
    localStorage.setItem(KEY, JSON.stringify({ open: false, tab: "details" }));
    const mod = await load("narrow");
    narrowViewport.value = true;
    mod.showContext("inbox");
    expect(mod.contextSheetOpen.value).toBe(true);
    expect(mod.contextOpen.value).toBe(false);
    expect(mod.contextShown()).toBe(true);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null").open).toBe(false);
    mod.hideContext();
    expect(mod.contextSheetOpen.value).toBe(false);
    expect(mod.contextOpen.value).toBe(false);
  });

  test("toggleContext at the same tab twice ends hidden; another tab switches instead", async () => {
    const mod = await load("toggle");
    mod.contextOpen.value = false;
    mod.toggleContext("inbox");
    expect(mod.contextShown()).toBe(true);
    expect(mod.contextTab.value).toBe("inbox");
    mod.toggleContext("inbox");
    expect(mod.contextShown()).toBe(false);
    expect(mod.contextOpen.value).toBe(false);

    mod.showContext("details");
    mod.toggleContext("inbox");
    expect(mod.contextShown()).toBe(true);
    expect(mod.contextTab.value).toBe("inbox");
  });

  test("showContext on a wide viewport turns focus reading off", async () => {
    const mod = await load("focus");
    focusReading.value = true;
    expect(mod.contextShown()).toBe(false);
    mod.showContext("outline");
    expect(focusReading.value).toBe(false);
    expect(mod.contextOpen.value).toBe(true);
    expect(mod.contextShown()).toBe(true);
  });

  test("the panel is never shown outside Tasks, and showing or toggling it from a panel returns to Tasks", async () => {
    const mod = await load("views");
    const currentView = (): string => view.value;
    view.value = "lanes";
    expect(mod.contextOpen.value).toBe(true);
    expect(mod.contextShown()).toBe(false);
    view.value = "backup";
    mod.showContext("inbox");
    expect(currentView()).toBe("tasks");
    expect(mod.contextTab.value).toBe("inbox");
    expect(mod.contextShown()).toBe(true);
    view.value = "tags";
    mod.toggleContext("inbox");
    expect(currentView()).toBe("tasks");
    expect(mod.contextShown()).toBe(true);
  });
});
