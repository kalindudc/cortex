// Unit tests for the lastTask persistence module.
//
// happy-dom (preloaded via bunfig.toml [test] preload) provides a real
// localStorage. The module under test reads localStorage at module load
// and registers an effect() over activeTask, so the SEED is captured by
// pre-setting localStorage BEFORE the dynamic import, and effect behavior
// is verified by mutating signals after the import.
//
// Bun caches ESM modules per-process, so one test FILE can only assert one
// seed outcome. The valid-seed path is covered here; the garbage-seed gate
// is covered in test/unit/state/lastTask.seed-invalid.test.ts.

import { describe, test, expect, beforeEach } from "bun:test";
import { tasks, filters, selectedId, showAllTasks } from "../../../src/ui/state/signals.ts";
import type { Task } from "../../../src/ui/api/types.ts";

const KEY = "cortex-last-task";

const mkTask = (id: number, lane: string, status: Task["status"]): Task => ({
  id,
  lane,
  title: `task ${id}`,
  body: null,
  status,
  priority: 0,
  created: 0,
  updated: 0,
  tags: [],
});

// Pre-seed BEFORE importing the module under test — the seed runs at
// module load. Capture selectedId immediately after import so beforeEach
// resets in subsequent tests don't clobber the assertion target.
localStorage.setItem(KEY, "42");
await import("../../../src/ui/state/lastTask.ts");
const seededAfterImport = selectedId.value;

describe("state/lastTask", () => {
  beforeEach(() => {
    tasks.value = [];
    filters.value = { status: null, lane: null, tag: [] };
    selectedId.value = null;
    showAllTasks.value = false;
    localStorage.removeItem(KEY);
  });

  test("seed restores selectedId from a valid stored id at module load", () => {
    expect(seededAfterImport).toBe(42);
  });

  test("effect writes activeTask.id to localStorage when it changes", () => {
    tasks.value = [mkTask(7, "live", "open")];
    filters.value = { ...filters.value, lane: "live" };
    // activeTask resolves to id=7 via the priority fallback.
    expect(localStorage.getItem(KEY)).toBe("7");

    tasks.value = [mkTask(7, "live", "open"), mkTask(9, "live", "open")];
    selectedId.value = 9;
    expect(localStorage.getItem(KEY)).toBe("9");
  });

  test("effect preserves the prior stored value when activeTask becomes null", () => {
    tasks.value = [mkTask(7, "live", "open")];
    filters.value = { ...filters.value, lane: "live" };
    expect(localStorage.getItem(KEY)).toBe("7");
    // Force activeTask → null by emptying the candidate pool.
    tasks.value = [];
    // Effect skips the null branch; the prior value is preserved.
    expect(localStorage.getItem(KEY)).toBe("7");
  });

  test("effect de-dupes writes when activeTask.id is unchanged across recomputations", () => {
    // Use a fresh id (8) so lastWritten — which persists across tests in
    // this file because it lives in the module's closure — must advance to
    // 8 here. The first write proves that, then an unrelated recomputation
    // that yields the same id is what we expect to be deduped.
    tasks.value = [mkTask(8, "live", "open")];
    filters.value = { ...filters.value, lane: "live" };
    expect(localStorage.getItem(KEY)).toBe("8");
    // Clear storage, then trigger an activeTask recomputation that still
    // yields id=8 (toggling showAllTasks re-runs the computed). Effect must
    // see at.id === lastWritten and short-circuit before setItem.
    localStorage.removeItem(KEY);
    showAllTasks.value = true;
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});
