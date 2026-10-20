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
const setStatus = mock(() => Promise.resolve({}));
const editTask = mock(() => Promise.resolve({}));
const setMemory = mock((_id: number, _body: { excluded: boolean }) => Promise.resolve({}));
// state/refresh.ts registers a top-level `effect()` that watches activeTask
// and calls api.updates(id) every time the selected task changes. Other test
// files (e.g. ActivityPane) cause refresh.ts to be loaded earlier in the same
// process, which registers that effect with our mocked api. Seeding tasks +
// selectedId in a test here therefore triggers api.updates() — so the stub
// must include it (along with anything else the refresh layer might touch).
mock.module("../../../../src/ui/api/client.ts", () => ({
  api: {
    versioned: { setStatus, setMemory, changeTags: mock(() => Promise.resolve({})) },
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
  view,
  postUpdateOpen,
  postUpdateFocusRequest,
  pendingBodyFocus,
  pendingTitleFocus,
  tagsPopover,
  sidebarFilter,
  navigationOpen,
  narrowViewport,
  focusReading,
  selectedLane,
  selectedTag,
} from "../../../../src/ui/state/signals.ts";
import type { Task, Lane } from "../../../../src/ui/api/types.ts";
import type { TagWithCount } from "../../../../src/ui/api/client.ts";
import { appearance, setTheme, theme } from "../../../../src/ui/state/theme.ts";
import { collapsedGroups, taskGroup, taskSort } from "../../../../src/ui/state/settings.ts";
import { updates } from "../../../../src/ui/state/signals.ts";
import { notice } from "../../../../src/ui/state/notice.ts";
import { contextOpen, contextTab } from "../../../../src/ui/state/context.ts";

// Widening readers — TS narrows signal .value literals after assignment.
const currentMode = (): string => readerMode.value;
const currentTab = (): string => tab.value;
const currentView = (): string => view.value;
const currentContextTab = (): string => contextTab.value;
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
    memory_excluded: false,
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
    setStatus.mockClear();
    editTask.mockClear();
    setMemory.mockClear();
    notice.value = null;
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
    // Management modes are one command away.
    expect(labels).toContain("Manage lanes");
    expect(labels).toContain("Manage tags");
    // "New tag…" command was removed: tag creation now flows through the
    // active-task TagPicker (type a new name → "Create #foo" row appears).
    expect(labels).not.toContain("New tag\u2026");
  });

  test("retargets: reading/editing commands drive the workspace, not modals", () => {
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

  test("side-panel hides or shows the side panel at its last tab, like the toolbar button", () => {
    contextOpen.value = true;
    contextTab.value = "outline";
    const hide = buildCommands().find(c => c.id === "side-panel");
    expect(hide?.label).toBe("Hide the side panel");
    hide?.action?.();
    expect(contextOpen.value).toBe(false);
    const show = buildCommands().find(c => c.id === "side-panel");
    expect(show?.label).toBe("Show the side panel");
    show?.action?.();
    expect(contextOpen.value).toBe(true);
    expect(currentContextTab()).toBe("outline");
    contextTab.value = "details";
  });

  test("management commands enter the explicit sidebar modes without touching filters", () => {
    filters.value = { status: "open", lane: "now", tag: ["bug"] };
    const cmds = buildCommands();
    cmds.find(c => c.id === "manage-lanes")?.action?.();
    expect(currentView()).toBe("lanes");
    cmds.find(c => c.id === "manage-tags")?.action?.();
    expect(currentView()).toBe("tags");
    expect(filters.value).toEqual({ status: "open", lane: "now", tag: ["bug"] });
    view.value = "tasks";
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

  test("'Set status…' submenu omits the current status and dispatches api.versioned.setStatus", async () => {
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
    // Calling one of the sub actions invokes api.versioned.setStatus with the right args.
    await sub.find(s => s.id === "status-done")?.action?.();
    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledWith(9, { status: "done" });
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
      view.value = "lanes";
      const cmd = buildCommands().find(c => c.id === "filter-tags-modal");
      if (!cmd) throw new Error("expected filter-tags-modal command");
      cmd.action?.();
      expect(modal.value).toBeNull();
      expect(paletteOpen.value).toBe(false);
      expect(sidebarFilter.value).toBe("tags");
      expect(currentView()).toBe("tasks");
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

    const laneEntry = cmds.find(c => c.id === "edit-lane")?.submenu?.()[1];
    expect(laneEntry?.id).toBe("lane-open-next");
    laneEntry?.action?.();
    expect(currentModal()).toBeNull();
    expect(selectedLane.value).toBe("next");
    expect(currentView()).toBe("lanes");
    view.value = "tasks";
    cmds
      .find(c => c.id === "delete-lane")
      ?.submenu?.()[0]
      ?.action?.();
    expect(currentModal()).toEqual({ kind: "confirm-lane-delete", name: "next" });
    modal.value = null;
    cmds.find(c => c.id === "new-lane")?.action?.();
    expect(currentModal()).toEqual({ kind: "new-lane" });
    modal.value = null;
    const tagEntry = cmds.find(c => c.id === "edit-tag")?.submenu?.()[0];
    expect(tagEntry?.id).toBe("tag-open-bug");
    tagEntry?.action?.();
    expect(currentModal()).toBeNull();
    expect(selectedTag.value).toBe("bug");
    expect(currentView()).toBe("tags");
    view.value = "tasks";

    cmds.find(c => c.id === "backup")?.action?.();
    expect(cmds.find(c => c.id === "backup")?.label).toBe("Backup\u2026");
    expect(currentView()).toBe("backup");
    view.value = "tasks";

    cmds = buildCommands();
    expect(theme.value).toBe("light");
    cmds.find(c => c.id === "theme-toggle")?.action?.();
    expect(theme.value).toBe("dark");
  });

  test("Collapse all and Expand all exist only while the list shows groups", () => {
    tasks.value = [task({ id: 1, lane: "now" }), task({ id: 2, lane: "later" })];
    const ids = () => buildCommands().map(c => c.id);
    expect(ids()).not.toContain("collapse-groups");
    taskGroup.value = "lane";
    try {
      const cmds = buildCommands();
      expect(cmds.find(c => c.id === "collapse-groups")?.label).toBe("Collapse all lanes");
      cmds.find(c => c.id === "collapse-groups")?.action?.();
      expect([...collapsedGroups.value.lane].sort()).toEqual(["later", "now"]);
      cmds.find(c => c.id === "expand-groups")?.action?.();
      expect(collapsedGroups.value.lane).toEqual([]);
      taskGroup.value = "status";
      expect(buildCommands().find(c => c.id === "expand-groups")?.label).toBe("Expand all statuses");
    } finally {
      taskGroup.value = "none";
      collapsedGroups.value = { lane: [], status: [] };
    }
  });

  test("settings commands: sort and group, appearance, and the settings pane", () => {
    const cmds = buildCommands();
    const sortGroup = cmds.find(c => c.id === "sort-group");
    expect(sortGroup?.label).toBe("Sort and group\u2026");
    taskSort.value = "id";
    taskGroup.value = "none";
    const entries = sortGroup?.submenu?.() ?? [];
    expect(entries.map(e => e.id)).toEqual([
      "sort-id",
      "sort-title",
      "sort-lane",
      "sort-status",
      "sort-priority",
      "sort-updated",
      "sort-ascending",
      "sort-descending",
      "group-none",
      "group-lane",
      "group-status",
    ]);
    expect(entries.filter(e => e.hint === "current").map(e => e.id)).toEqual([
      "sort-id",
      "sort-ascending",
      "group-none",
    ]);
    entries.find(e => e.id === "sort-descending")?.action?.();
    expect(String(taskSort.value)).toBe("-id");
    // A field keeps the direction.
    entries.find(e => e.id === "sort-title")?.action?.();
    entries.find(e => e.id === "group-status")?.action?.();
    expect(String(taskSort.value)).toBe("-title");
    expect(String(taskGroup.value)).toBe("status");
    taskSort.value = "id";
    taskGroup.value = "none";

    const looks = cmds.find(c => c.id === "appearance")?.submenu?.() ?? [];
    expect(looks.map(e => e.id)).toEqual([
      "appearance-system",
      "appearance-light",
      "appearance-dark",
      "appearance-high-contrast",
    ]);
    looks.find(e => e.id === "appearance-high-contrast")?.action?.();
    expect(appearance.value).toBe("high-contrast");

    const settings = cmds.find(c => c.id === "settings");
    expect(settings?.label).toBe("Settings");
    settings?.action?.();
    expect(currentView()).toBe("settings");
    expect(currentModal()).toBeNull();
    view.value = "tasks";
  });

  test("memory-off and memory-on write through versioned.setMemory with the terminal's notices", async () => {
    tasks.value = [task({ id: 4 })];
    selectedId.value = 4;
    const find = (id: string) => buildCommands().find(c => c.id === id);
    expect(find("memory-off")?.label).toBe("Keep out of agent memory");
    expect(find("memory-on")?.label).toBe("Let agent memory offer this task");

    await find("memory-off")?.action?.();
    expect(setMemory.mock.calls).toEqual([[4, { excluded: true }]]);
    expect(notice.value?.text).toBe("@4 is out of agent memory; reading it by id still works");

    await find("memory-on")?.action?.();
    expect(setMemory.mock.calls.length).toBe(1);
    expect(notice.value?.text).toBe("@4 is already in agent memory");

    tasks.value = [task({ id: 4, memory_excluded: true })];
    await find("memory-off")?.action?.();
    expect(setMemory.mock.calls.length).toBe(1);
    expect(notice.value?.text).toBe("@4 is already out of agent memory");

    await find("memory-on")?.action?.();
    expect(setMemory.mock.calls[1]).toEqual([4, { excluded: false }]);
    expect(notice.value?.text).toBe("@4 is back in agent memory");
  });

  test("the memory commands need an active task", () => {
    const ids = buildCommands().map(c => c.id);
    expect(ids).not.toContain("memory-off");
    expect(ids).not.toContain("memory-on");
  });

  test("Resume a session appears only when the active task has a pi or bb author", () => {
    tasks.value = [task({ id: 5 })];
    selectedId.value = 5;
    updates.value = {};
    expect(buildCommands().some(c => c.id === "resume-session")).toBe(false);
    const update = (author: string, created: number) => ({
      id: created,
      task_id: 5,
      author,
      summary: "s",
      body: null,
      severity: "progress" as const,
      created,
    });
    updates.value = { 5: [update("alice", 1), update("bb-thr_2qj8qzdqqr", 2)] };
    const resume = buildCommands().find(c => c.id === "resume-session");
    expect(resume?.submenu?.().map(e => e.id)).toEqual(["resume-bb-thr_2qj8qzdqqr"]);
    updates.value = {};
  });

  test("resuming a session from the palette shows the side panel's Details", async () => {
    tasks.value = [task({ id: 5 })];
    selectedId.value = 5;
    updates.value = {
      5: [
        { id: 1, task_id: 5, author: "bb-thr_2qj8qzdqqr", summary: "s", body: null, severity: "progress", created: 1 },
      ],
    };
    contextOpen.value = false;
    contextTab.value = "inbox";
    const resumeIpc = mock(() =>
      Promise.resolve({ ok: true, harness: "bb", author: "bb-thr_2qj8qzdqqr", command: "" }),
    );
    const bridge = window as unknown as { cortex?: unknown };
    const saved = bridge.cortex;
    bridge.cortex = { resume: resumeIpc };
    try {
      const entry = buildCommands()
        .find(c => c.id === "resume-session")
        ?.submenu?.()
        .find(e => e.id === "resume-bb-thr_2qj8qzdqqr");
      await entry?.action?.();
      expect(currentContextTab()).toBe("details");
      expect(contextOpen.value).toBe(true);
      expect(resumeIpc).toHaveBeenCalledWith({ taskId: 5, author: "bb-thr_2qj8qzdqqr" });
    } finally {
      bridge.cortex = saved;
      updates.value = {};
    }
  });
});
