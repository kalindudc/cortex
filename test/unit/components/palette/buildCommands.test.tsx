// buildCommands — assembles the live command list for the command palette.
// Verifies the root list contains the expected labels and that branch
// commands lazily expand into the right sub-entries.

import { describe, test, expect, mock, beforeEach } from "bun:test";

// api.* methods are pulled into a few command actions. Stub the client so
// nothing actually hits the wire when an action is invoked.
const setStat = mock(() => Promise.resolve({}));
const editTask = mock(() => Promise.resolve({}));
// state/refresh.ts registers a top-level `effect()` that watches activeTask
// and calls api.updates(id) every time the selected task changes. Other test
// files (e.g. InboxPane) cause refresh.ts to be loaded earlier in the same
// process, which registers that effect with our mocked api. Seeding tasks +
// selectedId in a test here therefore triggers api.updates() — so the stub
// must include it (along with anything else the refresh layer might touch).
mock.module("../../../../src/ui/api/client.ts", () => ({
  api: {
    setStat,
    editTask,
    editLane: mock(() => Promise.resolve({})),
    editTag: mock(() => Promise.resolve({})),
    delLane: mock(() => Promise.resolve()),
    delTag: mock(() => Promise.resolve()),
    delTask: mock(() => Promise.resolve()),
    updates: mock(() => Promise.resolve([])),
    tasks: mock(() => Promise.resolve([])),
    lanes: mock(() => Promise.resolve([])),
    tags: mock(() => Promise.resolve([])),
  },
}));

import { buildCommands } from "../../../../src/ui/components/palette/buildCommands.ts";
import {
  tasks,
  lanes,
  tags,
  selectedId,
  selectedLane,
  selectedTag,
  sidebarView,
  modal,
} from "../../../../src/ui/state/signals.ts";
import type { Task, Lane } from "../../../../src/ui/api/types.ts";
import type { TagWithCount } from "../../../../src/ui/api/client.ts";

function task(over: Partial<Task> = {}): Task {
  return {
    id: 1,
    lane: "now",
    title: "t",
    body: "",
    status: "open",
    priority: 3,
    created: 0,
    updated: 0,
    tags: [],
    ...over,
  };
}

function lane(over: Partial<Lane> = {}): Lane {
  return { name: "now", color: null, sort: 0, ...over };
}

function tag(over: Partial<TagWithCount> = {}): TagWithCount {
  return { name: "bug", color: null, created: 0, task_count: 0, ...over };
}

describe("buildCommands", () => {
  beforeEach(() => {
    tasks.value = [];
    lanes.value = [];
    tags.value = [];
    selectedId.value = null;
    selectedLane.value = null;
    selectedTag.value = null;
    sidebarView.value = "lanes";
    modal.value = null;
    setStat.mockClear();
    editTask.mockClear();
  });

  test("always-available commands appear in the root list", () => {
    const cmds = buildCommands();
    const labels = cmds.map(c => c.label);
    expect(labels).toContain("New task");
    expect(labels).toContain("Focus post-update box");
    expect(labels).toContain("Next task");
    expect(labels).toContain("Previous task");
    expect(labels).toContain("New lane\u2026");
    expect(labels).toContain("New tag\u2026");
  });

  test("active-task commands only appear when there is an active task", () => {
    let labels = buildCommands().map(c => c.label);
    expect(labels).not.toContain("Set status\u2026");

    tasks.value = [task({ id: 5 })];
    selectedId.value = 5;
    labels = buildCommands().map(c => c.label);
    expect(labels).toContain("Set status\u2026");
    expect(labels).toContain("Set priority\u2026");
    expect(labels).toContain("Tags\u2026");
  });

  test("'Set status…' submenu omits the current status and dispatches api.setStat", async () => {
    tasks.value = [task({ id: 9, status: "open" })];
    selectedId.value = 9;
    const cmd = buildCommands().find(c => c.id === "set-status");
    expect(cmd).toBeTruthy();
    expect(cmd?.submenu).toBeTruthy();
    const sub = cmd?.submenu?.();
    if (!sub) throw new Error("set-status submenu did not return commands");
    const subIds = sub.map(s => s.id);
    expect(subIds).not.toContain("status-open");
    expect(subIds).toContain("status-review");
    expect(subIds).toContain("status-blocked");
    expect(subIds).toContain("status-done");
    // Calling one of the sub actions invokes api.setStat with the right args.
    await sub.find(s => s.id === "status-done")?.action?.();
    expect(setStat).toHaveBeenCalledTimes(1);
    expect(setStat).toHaveBeenCalledWith(9, "done");
  });

  test("lane verbs appear only when lanes exist", () => {
    lanes.value = [lane({ name: "now" }), lane({ name: "next", sort: 1 })];
    const labels = buildCommands().map(c => c.label);
    expect(labels).toContain("Filter by lane\u2026");
    expect(labels).toContain("Edit lane\u2026");
    // 'next' is empty (no tasks) and != 'now' so Delete lane is available.
    expect(labels).toContain("Delete lane\u2026");
  });

  test("tag verbs appear only when tags exist", () => {
    let labels = buildCommands().map(c => c.label);
    expect(labels).not.toContain("Filter by tag\u2026");
    expect(labels).not.toContain("Edit tag\u2026");

    tags.value = [tag({ name: "bug" }), tag({ name: "ui", task_count: 2 })];
    labels = buildCommands().map(c => c.label);
    expect(labels).toContain("Filter by tag\u2026");
    expect(labels).toContain("Edit tag\u2026");
  });

  test("sidebar-mode toggle label reflects the current sidebarView", () => {
    sidebarView.value = "lanes";
    expect(buildCommands().find(c => c.id === "sidebar-mode")?.label).toBe("Switch to tag mode");
    sidebarView.value = "tags";
    expect(buildCommands().find(c => c.id === "sidebar-mode")?.label).toBe("Switch to lane mode");
  });

  test("'Delete task…' opens the confirm-delete modal", () => {
    tasks.value = [task({ id: 42 })];
    selectedId.value = 42;
    const cmd = buildCommands().find(c => c.id === "delete-task");
    if (!cmd) throw new Error("expected delete-task command to be registered");
    cmd.action?.();
    expect(modal.value).toEqual({ kind: "confirm-delete", id: 42 });
  });
});
