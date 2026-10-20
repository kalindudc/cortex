// state/settings.ts — the desktop settings registry and the persisted task
// sort and grouping. Each seed scenario loads a FRESH module instance
// (cache-bust query suffix) so its initializer runs against the storage it
// sets up.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TASK_GROUPS, TASK_SORTS } from "../../../src/lib/taskOrder.ts";
import { preferredReaderMode, showAllTasks } from "../../../src/ui/state/signals.ts";
import { appearance } from "../../../src/ui/state/theme.ts";

type SettingsModule = typeof import("../../../src/ui/state/settings.ts");

const SORT_KEY = "cortex-sort-v1";
const GROUP_KEY = "cortex-group-v1";

async function load(tag: string): Promise<SettingsModule> {
  return (await import(`../../../src/ui/state/settings.ts?seed=${tag}`)) as SettingsModule;
}

describe("state/settings", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    localStorage.clear();
    showAllTasks.value = false;
    preferredReaderMode.value = "read";
  });

  test("defaults: ascending id, no grouping", async () => {
    const mod = await load("defaults");
    expect(mod.taskSort.value).toBe("id");
    expect(mod.taskGroup.value).toBe("none");
  });

  test("valid stored values seed the signals", async () => {
    localStorage.setItem(SORT_KEY, "-updated");
    localStorage.setItem(GROUP_KEY, "status");
    const mod = await load("stored");
    expect(mod.taskSort.value).toBe("-updated");
    expect(mod.taskGroup.value).toBe("status");
    // Seeding before the effect keeps storage as it was.
    expect(localStorage.getItem(SORT_KEY)).toBe("-updated");
  });

  test("invalid stored values keep the defaults", async () => {
    localStorage.setItem(SORT_KEY, "random");
    localStorage.setItem(GROUP_KEY, "lanes");
    const mod = await load("invalid");
    expect(mod.taskSort.value).toBe("id");
    expect(mod.taskGroup.value).toBe("none");
  });

  test("changes persist", async () => {
    const mod = await load("persist");
    mod.taskSort.value = "title";
    mod.taskGroup.value = "lane";
    expect(localStorage.getItem(SORT_KEY)).toBe("title");
    expect(localStorage.getItem(GROUP_KEY)).toBe("lane");
  });

  test("every setting has a unique key, a valid default and set() binds its signal", async () => {
    const mod = await load("registry");
    const keys = mod.SETTINGS.map(s => s.key);
    expect(keys).toEqual(["appearance", "sort", "group", "done", "mode"]);
    for (const s of mod.SETTINGS) {
      expect(s.choices.map(c => c.value)).toContain(s.defaultValue);
      expect(new Set(s.choices.map(c => c.value)).size).toBe(s.choices.length);
    }
    const byKey = Object.fromEntries(mod.SETTINGS.map(s => [s.key, s]));
    expect(byKey.sort?.choices.map(c => c.value)).toEqual([...TASK_SORTS]);
    expect(byKey.group?.choices.map(c => c.value)).toEqual([...TASK_GROUPS]);

    byKey.sort?.set("priority");
    expect(mod.taskSort.value).toBe("priority");
    expect(byKey.sort?.current()).toBe("priority");
    byKey.group?.set("status");
    expect(mod.taskGroup.value).toBe("status");
    byKey.done?.set("show");
    expect(showAllTasks.value).toBe(true);
    expect(byKey.done?.current()).toBe("show");
    byKey.mode?.set("split");
    expect(preferredReaderMode.value).toBe("split");
    byKey.appearance?.set("high-contrast");
    expect(appearance.value).toBe("high-contrast");
    expect(localStorage.getItem("cortex-theme")).toBe("high-contrast");
    byKey.appearance?.set("system");
  });

  test("set() rejects a value outside the choices and changes nothing", async () => {
    const mod = await load("reject");
    for (const s of mod.SETTINGS) {
      const before = s.current();
      expect(() => s.set("not-a-choice")).toThrow();
      expect(s.current()).toBe(before);
    }
  });
});
