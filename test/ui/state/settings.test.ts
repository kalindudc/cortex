// state/settings.ts — the desktop settings registry and the persisted task
// sort and grouping. Each seed scenario loads a FRESH module instance
// (cache-bust query suffix) so its initializer runs against the storage it
// sets up.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SORT_FIELDS, TASK_GROUPS } from "../../../src/lib/taskOrder.ts";
import { preferredReaderMode, showAllTasks } from "../../../src/ui/state/signals.ts";
import { appearance } from "../../../src/ui/state/theme.ts";

type SettingsModule = typeof import("../../../src/ui/state/settings.ts");

const SORT_KEY = "cortex-sort-v1";
const GROUP_KEY = "cortex-group-v1";
const BACKUP_KEEP_KEY = "cortex-backup-keep-v1";
const DENSITY_KEY = "cortex-density-v1";
const BLOCKED_ALERT_KEY = "cortex-blocked-alert-v1";

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
    expect(mod.backupKeep.value).toBe(0);
    expect(mod.density.value).toBe("comfortable");
    expect(mod.blockedAlert.value).toBe("on");
  });

  test("valid stored values seed the signals", async () => {
    localStorage.setItem(SORT_KEY, "-updated");
    localStorage.setItem(GROUP_KEY, "status");
    localStorage.setItem(BACKUP_KEEP_KEY, "10");
    localStorage.setItem(DENSITY_KEY, "compact");
    localStorage.setItem(BLOCKED_ALERT_KEY, "off");
    const mod = await load("stored");
    expect(mod.taskSort.value).toBe("-updated");
    expect(mod.taskGroup.value).toBe("status");
    expect(mod.backupKeep.value).toBe(10);
    expect(mod.density.value).toBe("compact");
    expect(mod.blockedAlert.value).toBe("off");
    // Seeding before the effect keeps storage as it was.
    expect(localStorage.getItem(SORT_KEY)).toBe("-updated");
    expect(localStorage.getItem(BACKUP_KEEP_KEY)).toBe("10");
    expect(localStorage.getItem(DENSITY_KEY)).toBe("compact");
    expect(localStorage.getItem(BLOCKED_ALERT_KEY)).toBe("off");
  });

  test("invalid stored values keep the defaults", async () => {
    localStorage.setItem(SORT_KEY, "random");
    localStorage.setItem(GROUP_KEY, "lanes");
    localStorage.setItem(BACKUP_KEEP_KEY, "7");
    localStorage.setItem(DENSITY_KEY, "tiny");
    localStorage.setItem(BLOCKED_ALERT_KEY, "maybe");
    const mod = await load("invalid");
    expect(mod.taskSort.value).toBe("id");
    expect(mod.taskGroup.value).toBe("none");
    expect(mod.backupKeep.value).toBe(0);
    expect(mod.density.value).toBe("comfortable");
    expect(mod.blockedAlert.value).toBe("on");
  });

  test("changes persist", async () => {
    const mod = await load("persist");
    mod.taskSort.value = "title";
    mod.taskGroup.value = "lane";
    mod.backupKeep.value = 20;
    mod.density.value = "compact";
    mod.blockedAlert.value = "off";
    expect(localStorage.getItem(SORT_KEY)).toBe("title");
    expect(localStorage.getItem(GROUP_KEY)).toBe("lane");
    expect(localStorage.getItem(BACKUP_KEEP_KEY)).toBe("20");
    expect(localStorage.getItem(DENSITY_KEY)).toBe("compact");
    expect(localStorage.getItem(BLOCKED_ALERT_KEY)).toBe("off");
  });

  test("the density effect sets data-density on the root element", async () => {
    const mod = await load("density");
    expect(document.documentElement.dataset.density).toBe("comfortable");
    mod.density.value = "compact";
    expect(document.documentElement.dataset.density).toBe("compact");
    mod.density.value = "comfortable";
    expect(document.documentElement.dataset.density).toBe("comfortable");
  });

  test("every setting has a unique key, a valid default and set() binds its signal", async () => {
    const mod = await load("registry");
    const keys = mod.SETTINGS.map(s => s.key);
    expect(keys).toEqual(["appearance", "density", "sort", "direction", "group", "done", "mode", "alert", "backup"]);
    for (const s of mod.SETTINGS) {
      expect(s.choices.map(c => c.value)).toContain(s.defaultValue);
      expect(new Set(s.choices.map(c => c.value)).size).toBe(s.choices.length);
      // A switch's choices are exactly off, then on.
      if (s.control === "switch") expect(s.choices.length).toBe(2);
    }
    expect(mod.SETTINGS.map(s => [s.key, s.section, s.control])).toEqual([
      ["appearance", "Appearance", "cards"],
      ["density", "Appearance", "segmented"],
      ["sort", "Task list", "select"],
      ["direction", "Task list", "segmented"],
      ["group", "Task list", "select"],
      ["done", "Task list", "switch"],
      ["mode", "Documents", "segmented"],
      ["alert", "Notifications", "switch"],
      ["backup", "Backup", "select"],
    ]);
    const byKey = Object.fromEntries(mod.SETTINGS.map(s => [s.key, s]));
    // Each field once; its direction is a setting of its own.
    expect(byKey.sort?.choices.map(c => c.value)).toEqual([...SORT_FIELDS]);
    expect(byKey.direction?.choices.map(c => c.value)).toEqual(["asc", "desc"]);
    expect(byKey.group?.choices.map(c => c.value)).toEqual([...TASK_GROUPS]);

    byKey.sort?.set("priority");
    expect(mod.taskSort.value).toBe("priority");
    expect(byKey.sort?.current()).toBe("priority");
    expect(byKey.direction?.current()).toBe("asc");
    byKey.direction?.set("desc");
    expect(mod.taskSort.value).toBe("-priority");
    expect(byKey.sort?.current()).toBe("priority");
    expect(byKey.direction?.current()).toBe("desc");
    // A new field keeps the direction.
    byKey.sort?.set("title");
    expect(mod.taskSort.value).toBe("-title");
    byKey.direction?.set("asc");
    expect(mod.taskSort.value).toBe("title");
    byKey.group?.set("status");
    expect(mod.taskGroup.value).toBe("status");
    byKey.done?.set("show");
    expect(showAllTasks.value).toBe(true);
    expect(byKey.done?.current()).toBe("show");
    byKey.mode?.set("split");
    expect(preferredReaderMode.value).toBe("split");
    byKey.backup?.set("5");
    expect(mod.backupKeep.value).toBe(5);
    expect(byKey.backup?.current()).toBe("5");
    byKey.density?.set("compact");
    expect(mod.density.value).toBe("compact");
    expect(byKey.density?.current()).toBe("compact");
    byKey.density?.set("comfortable");
    byKey.alert?.set("off");
    expect(mod.blockedAlert.value).toBe("off");
    expect(byKey.alert?.current()).toBe("off");
    byKey.appearance?.set("high-contrast");
    expect(appearance.value).toBe("high-contrast");
    expect(localStorage.getItem("cortex-theme")).toBe("high-contrast");
    byKey.appearance?.set("system");
  });

  test("folded task-list groups seed, toggle per grouping and persist", async () => {
    localStorage.setItem("cortex-collapsed-groups-v1", JSON.stringify({ lane: ["later"], status: [] }));
    const mod = await load("folds");
    expect(mod.collapsedKeys("lane")).toEqual(["later"]);
    expect(mod.collapsedKeys("none")).toEqual([]);
    mod.toggleGroupCollapsed("status", "done");
    mod.toggleGroupCollapsed("lane", "later");
    expect(mod.collapsedKeys("lane")).toEqual([]);
    expect(mod.collapsedKeys("status")).toEqual(["done"]);
    expect(JSON.parse(localStorage.getItem("cortex-collapsed-groups-v1") ?? "null")).toEqual({
      lane: [],
      status: ["done"],
    });
  });

  test("collapse all folds the shown groups and keeps earlier folds; expand all clears the grouping", async () => {
    const mod = await load("folds-all");
    mod.toggleGroupCollapsed("lane", "hidden-lane");
    mod.toggleGroupCollapsed("status", "done");
    mod.collapseGroups("lane", ["now", "later", "hidden-lane"]);
    expect(mod.collapsedKeys("lane")).toEqual(["hidden-lane", "now", "later"]);
    mod.expandAllGroups("lane");
    expect(mod.collapsedKeys("lane")).toEqual([]);
    // The other grouping keeps its folds.
    expect(mod.collapsedKeys("status")).toEqual(["done"]);
  });

  test("stored folds that are not two string lists are ignored", async () => {
    const mod = await load("folds-parse");
    expect(mod.parseCollapsedGroups(null)).toBeNull();
    expect(mod.parseCollapsedGroups("not json")).toBeNull();
    expect(mod.parseCollapsedGroups(JSON.stringify({ lane: ["a"] }))).toBeNull();
    expect(mod.parseCollapsedGroups(JSON.stringify({ lane: [1], status: [] }))).toBeNull();
    expect(mod.parseCollapsedGroups("x".repeat(70_000))).toBeNull();
    expect(mod.parseCollapsedGroups(JSON.stringify({ lane: ["a"], status: ["done"] }))).toEqual({
      lane: ["a"],
      status: ["done"],
    });
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
