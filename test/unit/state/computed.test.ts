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
import { tasks, filters, selectedId, showAllTasks, workspaceQuery } from "../../../src/ui/state/signals.ts";
import { activeTask, visibleTasks, orderedVisibleTasks } from "../../../src/ui/state/computed.ts";
import type { Task } from "../../../src/ui/api/types.ts";

const mkTask = (id: number, lane: string, status: Task["status"], priority = 0, over: Partial<Task> = {}): Task => ({
  id,
  lane,
  title: `task ${id}`,
  body: null,
  status,
  priority,
  created: 0,
  updated: 0,
  tags: [],
  ...over,
});

describe("state/computed activeTask × showAllTasks", () => {
  beforeEach(() => {
    tasks.value = [];
    filters.value = { status: null, lane: null, tag: [] };
    selectedId.value = null;
    showAllTasks.value = false;
    workspaceQuery.value = "";
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

  // Regression coverage for plan 137: applying a filter that excludes the
  // active task must NOT yank the user onto a different one. The right pane
  // is invariant under filter changes; the filter only governs the sidebar
  // list. Two tests cover the same one-line fix from distinct angles
  // (lane-filter exclusion vs. status-filter exclusion via task transition)
  // so a future refactor cannot silently regress either.
  test("selectedId points at a task whose lane is excluded by the current filter → activeTask still returns the selected task (filter changes never yank the user off the active task)", () => {
    tasks.value = [mkTask(1, "a", "open"), mkTask(2, "b", "open")];
    selectedId.value = 1;
    filters.value = { ...filters.value, lane: "b" };
    expect(activeTask.value?.id).toBe(1);
  });

  test("active task transitions to a status excluded by the current status filter → activeTask still returns the selected task (status flips never yank the user off the active task)", () => {
    tasks.value = [mkTask(1, "a", "done"), mkTask(2, "a", "open")];
    selectedId.value = 1;
    filters.value = { ...filters.value, status: "open" };
    expect(activeTask.value?.id).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Workspace-plan (task 330) coverage: W3 full-pool search intersection and
// W4 Done-view exception + display ordering.
// ---------------------------------------------------------------------------

describe("state/computed workspace query intersection (W3)", () => {
  beforeEach(() => {
    tasks.value = [];
    filters.value = { status: null, lane: null, tag: [] };
    selectedId.value = null;
    showAllTasks.value = false;
    workspaceQuery.value = "";
  });

  test("empty query means no search restriction", () => {
    tasks.value = [mkTask(1, "a", "open"), mkTask(2, "b", "open")];
    workspaceQuery.value = "   ";
    expect(visibleTasks.value.length).toBe(2);
  });

  test("query AND status AND lane AND tag compose predictably", () => {
    tasks.value = [
      mkTask(1, "a", "open", 0, { title: "needle one", tags: ["bug"] }),
      mkTask(2, "a", "open", 0, { title: "needle two" }),
      mkTask(3, "b", "open", 0, { title: "needle three", tags: ["bug"] }),
      mkTask(4, "a", "blocked", 0, { title: "needle four", tags: ["bug"] }),
      mkTask(5, "a", "open", 0, { title: "haystack", tags: ["bug"] }),
    ];
    workspaceQuery.value = "needle";
    filters.value = { status: "open", lane: "a", tag: ["bug"] };
    expect(visibleTasks.value.map(t => t.id)).toEqual([1]);
  });

  test("exact #tag resolution runs against the FULL pool before lane intersection", () => {
    // Full pool carries an exact 'feature' tag (task 2, lane b). With the
    // lane-a filter active, a pool-after-filter search would MISS the exact
    // tag and fall through to substring fuzzy, wrongly matching task 1
    // ('feature-x'). Full-pool exact resolution → [task 2] ∩ lane a = [].
    tasks.value = [
      mkTask(1, "a", "open", 0, { tags: ["feature-x"] }),
      mkTask(2, "b", "open", 0, { tags: ["feature"] }),
    ];
    filters.value = { ...filters.value, lane: "a" };
    workspaceQuery.value = "#feature";
    expect(visibleTasks.value).toEqual([]);
  });

  test("@id lookup bypasses fuzzy and intersects with filters", () => {
    tasks.value = [mkTask(9, "a", "open"), mkTask(10, "b", "open")];
    workspaceQuery.value = "@9";
    expect(visibleTasks.value.map(t => t.id)).toEqual([9]);
    filters.value = { ...filters.value, lane: "b" };
    expect(visibleTasks.value).toEqual([]);
  });
});

describe("state/computed Done-view exception (W4)", () => {
  beforeEach(() => {
    tasks.value = [];
    filters.value = { status: null, lane: null, tag: [] };
    selectedId.value = null;
    showAllTasks.value = false;
    workspaceQuery.value = "";
  });

  test("status filter 'done' shows done tasks even when showAllTasks=false", () => {
    tasks.value = [mkTask(1, "a", "done"), mkTask(2, "a", "open")];
    filters.value = { ...filters.value, status: "done" };
    expect(visibleTasks.value.map(t => t.id)).toEqual([1]);
  });

  test("activeTask fallback honors the Done-view exception", () => {
    tasks.value = [mkTask(1, "a", "done")];
    filters.value = { ...filters.value, status: "done" };
    // No explicit selection; fallback pool must include the done task in
    // the Done view even though showAllTasks is false.
    expect(activeTask.value?.id).toBe(1);
  });

  test("outside the Done view the include-done toggle keeps its meaning", () => {
    tasks.value = [mkTask(1, "a", "done"), mkTask(2, "a", "open")];
    expect(visibleTasks.value.map(t => t.id)).toEqual([2]);
    showAllTasks.value = true;
    // visibleTasks preserves server order ([1(done), 2(open)]) — display
    // ordering is orderedVisibleTasks' concern.
    expect(visibleTasks.value.map(t => t.id)).toEqual([1, 2]);
  });
});

describe("state/computed orderedVisibleTasks display order (W4)", () => {
  beforeEach(() => {
    tasks.value = [];
    filters.value = { status: null, lane: null, tag: [] };
    selectedId.value = null;
    showAllTasks.value = false;
    workspaceQuery.value = "";
  });

  test("empty query → natural title order (task-2 before task-12), server priority discarded", () => {
    tasks.value = [mkTask(12, "a", "open", 0, { title: "task-12" }), mkTask(2, "a", "open", 5, { title: "task-2" })];
    expect(orderedVisibleTasks.value.map(t => t.id)).toEqual([2, 12]);
  });

  test("nonempty query → search relevance order", () => {
    tasks.value = [
      mkTask(1, "a", "open", 0, { title: "zzz", body: "needle in body" }),
      mkTask(2, "a", "open", 0, { title: "needle title" }),
    ];
    workspaceQuery.value = "needle";
    // Title match outscores body match regardless of title sort order.
    expect(orderedVisibleTasks.value.map(t => t.id)).toEqual([2, 1]);
  });

  test("activeTask fallback keeps server-priority order, not display order", () => {
    // 'beta' has the better (lower) priority but sorts after 'alpha' by
    // title. With no explicit selection the fallback must follow server
    // priority order (W4: preserve server-priority fallback).
    tasks.value = [mkTask(1, "a", "open", 0, { title: "beta" }), mkTask(2, "a", "open", 5, { title: "alpha" })];
    expect(activeTask.value?.id).toBe(1);
  });
});
