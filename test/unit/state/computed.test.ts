// Unit tests for activeTask's interaction with the showAllTasks gate.
//
// Regression coverage for plan 130: when a lane contains only `done` tasks,
// `activeTask` previously returned the done task via its fallback branch
// even though the sidebar (which applies the showAllTasks filter locally)
// hid it. The fix gates the candidate pool by showAllTasks at the top of
// the computed, so both the selectedId-match branch and the priority-
// fallback branch agree with what the sidebar shows.
//
// Mirrors test/unit/state/notifications.test.ts: direct signal imports,
// `beforeEach` reset to a known baseline.

import { describe, test, expect, beforeEach } from "bun:test";
import { tasks, filters, selectedId, showAllTasks } from "../../../src/ui/state/signals.ts";
import { activeTask } from "../../../src/ui/state/computed.ts";
import type { Task } from "../../../src/ui/api/types.ts";

const mkTask = (id: number, lane: string, status: Task["status"], priority = 0): Task => ({
  id,
  lane,
  title: `task ${id}`,
  body: null,
  status,
  priority,
  created: 0,
  updated: 0,
  tags: [],
});

describe("state/computed activeTask × showAllTasks", () => {
  beforeEach(() => {
    tasks.value = [];
    filters.value = { status: null, lane: null, tag: [] };
    selectedId.value = null;
    showAllTasks.value = false;
  });

  test("lane with only done tasks + showAllTasks=false → activeTask is null", () => {
    tasks.value = [mkTask(1, "ghosts", "done"), mkTask(2, "ghosts", "done")];
    filters.value = { ...filters.value, lane: "ghosts" };
    expect(activeTask.value).toBeNull();
  });

  test("lane with only done tasks + showAllTasks=true → activeTask returns a done task", () => {
    tasks.value = [mkTask(1, "ghosts", "done"), mkTask(2, "ghosts", "done")];
    filters.value = { ...filters.value, lane: "ghosts" };
    showAllTasks.value = true;
    expect(activeTask.value?.id).toBe(1);
  });

  test("selectedId points at a done task while showAllTasks=false → done task is honored (user-explicit selection wins over the gate)", () => {
    tasks.value = [mkTask(1, "ghosts", "done")];
    filters.value = { ...filters.value, lane: "ghosts" };
    selectedId.value = 1;
    // An explicit selection is sacred — the showAllTasks gate only applies
    // to the priority fallback. Toggling the eye off while reading a done
    // task must not yank it from the active pane, and a stored selectedId
    // pointing at a done task must restore on reload.
    expect(activeTask.value?.id).toBe(1);
  });

  test("selectedId points at an open task in the current lane → activeTask returns it (positive control)", () => {
    tasks.value = [mkTask(1, "live", "open"), mkTask(2, "live", "open")];
    filters.value = { ...filters.value, lane: "live" };
    selectedId.value = 2;
    expect(activeTask.value?.id).toBe(2);
  });
});
