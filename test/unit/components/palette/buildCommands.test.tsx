// buildCommands — assembles the live command list for the command palette.
// Verifies the root list contains the expected labels and that branch
// commands lazily expand into the right sub-entries.

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

// The 'New task' command delegates to createUntitledTask in lib/createTask.ts.
// Mock the module BEFORE importing buildCommands so the SUT picks up the
// spy at module-eval time. We deliberately don't run the real flow here —
// it's covered by createTask.test.ts.
const createUntitledTaskSpy = mock((_lane: string) => Promise.resolve());
mock.module("../../../../src/ui/lib/createTask.ts", () => ({
  createUntitledTask: createUntitledTaskSpy,
}));

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
  filters,
  modal,
  paletteOpen,
  readerMode,
  preferredReaderMode,
  tab,
  sidebarMode,
  postUpdateOpen,
  postUpdateFocusRequest,
  pendingBodyFocus,
  pendingTitleFocus,
  tagsPopover,
  sidebarFilter,
  navigationOpen,
  narrowViewport,
  focusReading,
} from "../../../../src/ui/state/signals.ts";
import type { Task, Lane } from "../../../../src/ui/api/types.ts";
import type { TagWithCount } from "../../../../src/ui/api/client.ts";
import { setTheme, theme } from "../../../../src/ui/state/theme.ts";

// Widening readers — TS narrows signal .value literals after assignment.
const currentMode = (): string => readerMode.value;
const currentTab = (): string => tab.value;
const currentSidebarMode = (): string => sidebarMode.value;
const currentModal = (): { kind: string; [key: string]: unknown } | null => modal.value;

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
  afterEach(() => {
    preferredReaderMode.value = "read";
  });
  beforeEach(() => {
    preferredReaderMode.value = "read";
    tasks.value = [];
    lanes.value = [];
    tags.value = [];
    selectedId.value = null;
    filters.value = { status: null, lane: null, tag: [] };
    modal.value = null;
    paletteOpen.value = true;
    setStat.mockClear();
    editTask.mockClear();
    createUntitledTaskSpy.mockClear();
    tagsPopover.value = false;
    sidebarFilter.value = null;
    navigationOpen.value = false;
    narrowViewport.value = false;
    focusReading.value = false;
    setTheme("light");
  });

  test("always-available commands appear in the root list", () => {
    const cmds = buildCommands();
    const labels = cmds.map(c => c.label);
    expect(labels).toContain("New task");
    expect(labels).toContain("Post an update");
    expect(labels).toContain("Next task");
    expect(labels).toContain("Previous task");
    expect(labels).toContain("New lane\u2026");
    // Management modes are one command away (task 330 W2).
    expect(labels).toContain("Manage lanes");
    expect(labels).toContain("Manage tags");
    // "New tag…" command was removed: tag creation now flows through the
    // active-task TagPicker (type a new name → "Create #foo" row appears).
    expect(labels).not.toContain("New tag\u2026");
  });

  test("task 330 retargets: reading/editing commands drive the workspace, not modals", () => {
    tasks.value = [task({ id: 5 })];
    selectedId.value = 5;
    readerMode.value = "read";
    const cmds = buildCommands();

    // Old 'view-markdown' destination is now in-place Document/Read.
    const read = cmds.find(c => c.id === "view-markdown");
    if (!read?.action) throw new Error("expected read command");
    read.action();
    expect(modal.value).toBeNull(); // no render-markdown modal
    expect(currentMode()).toBe("read");
    expect(currentTab()).toBe("document");

    const edit = cmds.find(c => c.id === "edit-body");
    if (!edit?.action) throw new Error("expected edit command");
    edit.action();
    expect(currentMode()).toBe("edit");
    expect(pendingBodyFocus.value).toBe(5);
    pendingBodyFocus.value = null;

    const split = cmds.find(c => c.id === "split-view");
    if (!split?.action) throw new Error("expected split command");
    split.action();
    expect(currentMode()).toBe("split");

    const title = cmds.find(c => c.id === "edit-title");
    if (!title?.action) throw new Error("expected edit-title command");
    title.action();
    expect(currentMode()).toBe("split");
    expect(preferredReaderMode.value).toBe("split");
    expect(pendingTitleFocus.value).toBe(5);
    pendingTitleFocus.value = null;
  });

  test("'Post an update' routes through requestPostUpdate (Activity + composer)", () => {
    tasks.value = [task({ id: 5 })];
    selectedId.value = 5;
    postUpdateOpen.value = false;
    const before = postUpdateFocusRequest.value;
    const cmd = buildCommands().find(c => c.id === "post-update");
    if (!cmd?.action) throw new Error("expected post-update command");
    cmd.action();
    expect(currentTab()).toBe("updates");
    expect(postUpdateOpen.value).toBe(true);
    expect(postUpdateFocusRequest.value).toBe(before + 1);
  });

  test("management commands enter the explicit sidebar modes without touching filters", () => {
    filters.value = { status: "open", lane: "now", tag: ["bug"] };
    const cmds = buildCommands();
    cmds.find(c => c.id === "manage-lanes")?.action?.();
    expect(currentSidebarMode()).toBe("lanes");
    cmds.find(c => c.id === "manage-tags")?.action?.();
    expect(currentSidebarMode()).toBe("tags");
    expect(filters.value).toEqual({ status: "open", lane: "now", tag: ["bug"] });
    sidebarMode.value = "main";
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

  test("tag verbs at root: 'Filter by tags…' (modal) always; 'Edit tag…' only when tags exist; NO per-tag flat rows", () => {
    // 'Filter by tags…' (modal) is the canonical entry and renders
    // unconditionally so the affordance exists even with zero tags yet.
    let labels = buildCommands().map(c => c.label);
    expect(labels).toContain("Filter by tags\u2026");
    expect(labels).not.toContain("Edit tag\u2026");
    // Regression guard: NO per-tag flat commands at root — the modal
    // covers per-tag selection via search to keep palette uncluttered.
    expect(buildCommands().some(c => c.id.startsWith("filter-tag-"))).toBe(false);

    tags.value = [tag({ name: "bug" }), tag({ name: "ui", task_count: 2 })];
    labels = buildCommands().map(c => c.label);
    expect(labels).toContain("Filter by tags\u2026");
    expect(labels).toContain("Edit tag\u2026");
    // Still no per-tag flat rows even when tags exist.
    expect(labels).not.toContain("Filter tag: #bug");
    expect(labels).not.toContain("Filter tag: #ui");
    expect(labels).not.toContain("Filter tag: untagged");
  });

  test("smart-view filter shortcuts set filters.status (and 'Clear filters' zeroes every slot)", () => {
    // Replaces the old sidebar-mode toggle test — the unified pane has no
    // mode swap. The palette now has three top-level commands that flip
    // status filters directly, plus a Clear filters command.
    const cmds = buildCommands();
    const review = cmds.find(c => c.id === "filter-review");
    const blocked = cmds.find(c => c.id === "filter-blocked");
    const clear = cmds.find(c => c.id === "filter-clear");
    if (!review || !blocked || !clear) {
      throw new Error("expected filter-review, filter-blocked, filter-clear commands to be registered");
    }
    expect(review.label).toBe("Filter: In review");
    expect(blocked.label).toBe("Filter: Blocked");
    expect(clear.label).toBe("Clear filters");

    review.action?.();
    expect(filters.value.status).toBe("review");
    blocked.action?.();
    expect(filters.value.status).toBe("blocked");

    // Pre-load every slot then verify Clear wipes them all in one shot.
    filters.value = { status: "done", lane: "now", tag: ["bug", "ui"] };
    clear.action?.();
    expect(filters.value).toEqual({ status: null, lane: null, tag: [] });
  });

  test("lane filter submenu actions call setFilter (filters.lane)", () => {
    lanes.value = [lane({ name: "now" }), lane({ name: "next", sort: 1 })];
    const filterLane = buildCommands().find(c => c.id === "filter-lane");
    const laneSub = filterLane?.submenu?.();
    if (!laneSub) throw new Error("expected Filter by lane submenu");
    laneSub.find(s => s.id === "lane-next")?.action?.();
    expect(filters.value.lane).toBe("next");
    laneSub.find(s => s.id === "lane-all")?.action?.();
    expect(filters.value.lane).toBeNull();
  });

  test("'Filter by tags…' reveals the unified sidebar panel from focus reading and narrow layouts", () => {
    for (const narrow of [false, true]) {
      narrowViewport.value = narrow;
      focusReading.value = true;
      sidebarMode.value = "lanes";
      const cmd = buildCommands().find(c => c.id === "filter-tags-modal");
      if (!cmd) throw new Error("expected filter-tags-modal command");
      cmd.action?.();
      expect(modal.value).toBeNull();
      expect(paletteOpen.value).toBe(false);
      expect(sidebarFilter.value).toBe("tags");
      expect(currentSidebarMode()).toBe("main");
      expect(focusReading.value).toBe(false);
      expect(navigationOpen.value).toBe(narrow);
    }
  });

  test("sidebar-mode toggle command no longer exists", () => {
    // Regression guard: SidebarPane is unified, there is no swap target.
    const cmds = buildCommands();
    expect(cmds.find(c => c.id === "sidebar-mode")).toBeUndefined();
  });

  test("'New task' invokes createUntitledTask with the active filter lane (default 'now') and closes the palette", () => {
    // Default: filters.value.lane is null → falls back to 'now'.
    paletteOpen.value = true;
    const cmd = buildCommands().find(c => c.id === "new-task");
    if (!cmd) throw new Error("expected 'new-task' command");
    cmd.action?.();
    expect(createUntitledTaskSpy).toHaveBeenCalledTimes(1);
    expect(createUntitledTaskSpy).toHaveBeenLastCalledWith("now");
    expect(paletteOpen.value).toBe(false);

    // Explicit lane: filters.value.lane = 'next' → forwarded verbatim.
    paletteOpen.value = true;
    filters.value = { status: null, lane: "next", tag: [] };
    const cmd2 = buildCommands().find(c => c.id === "new-task");
    cmd2?.action?.();
    expect(createUntitledTaskSpy).toHaveBeenCalledTimes(2);
    expect(createUntitledTaskSpy).toHaveBeenLastCalledWith("next");
    expect(paletteOpen.value).toBe(false);
  });

  test("'Delete task…' opens the confirm-delete modal", () => {
    tasks.value = [task({ id: 42 })];
    selectedId.value = 42;
    const cmd = buildCommands().find(c => c.id === "delete-task");
    if (!cmd) throw new Error("expected delete-task command to be registered");
    cmd.action?.();
    expect(modal.value).toEqual({ kind: "confirm-delete", id: 42 });
  });

  test("retained active-task/navigation commands keep their destinations", async () => {
    tasks.value = [task({ id: 1, title: "Alpha", priority: 3 }), task({ id: 2, title: "Beta" })];
    selectedId.value = 1;
    const cmds = buildCommands();

    const priority = cmds
      .find(c => c.id === "set-priority")
      ?.submenu?.()
      .find(c => c.id === "priority-1");
    await priority?.action?.();
    expect(editTask).toHaveBeenCalledWith(1, { priority: 1 });

    paletteOpen.value = true;
    cmds.find(c => c.id === "edit-task-tags")?.action?.();
    expect(tagsPopover.value).toBe(true);
    expect(paletteOpen.value).toBe(false);

    cmds.find(c => c.id === "next")?.action?.();
    expect(selectedId.value).toBe(2);
    // Rebuild so active-task closures reflect task 2; Previous returns to 1.
    buildCommands()
      .find(c => c.id === "prev")
      ?.action?.();
    expect(selectedId.value).toBe(1);
  });

  test("retained lane/tag/system commands keep their modal and theme destinations", () => {
    lanes.value = [lane({ name: "now" }), lane({ name: "next", sort: 1 })];
    tags.value = [tag({ name: "bug" })];
    let cmds = buildCommands();

    cmds
      .find(c => c.id === "edit-lane")
      ?.submenu?.()[1]
      ?.action?.();
    expect(currentModal()).toEqual({ kind: "lane-edit", name: "next" });
    modal.value = null;
    cmds
      .find(c => c.id === "delete-lane")
      ?.submenu?.()[0]
      ?.action?.();
    expect(currentModal()).toEqual({ kind: "confirm-lane-delete", name: "next" });
    modal.value = null;
    cmds.find(c => c.id === "new-lane")?.action?.();
    expect(currentModal()).toEqual({ kind: "new-lane" });
    modal.value = null;
    cmds
      .find(c => c.id === "edit-tag")
      ?.submenu?.()[0]
      ?.action?.();
    expect(currentModal()).toEqual({ kind: "tag-edit", name: "bug" });

    cmds = buildCommands();
    expect(theme.value).toBe("light");
    cmds.find(c => c.id === "theme-toggle")?.action?.();
    expect(theme.value).toBe("dark");
  });
});
