// Unit tests for state/workspace.ts — the workspace controller introduced by
// the document-first workspace plan.
//
// Covers the workspace query (single query signal + versioned preference key, Clear-all
// semantics), the requestMode/requestPostUpdate/clearWorkspaceTransientState
// actions, and the browser body-mode preference / Document entry effect.
//
// workspace.ts is a side-effect module (seeds + effects registered at import
// time, mirroring state/filters.ts). The pure parser is exercised directly;
// effect behaviour is asserted through signal writes. Because bun:test runs
// all files in one process, the module effects registered here persist for
// the remainder of the run — tests below only assert behaviour that is
// deterministic under that model (synchronous signal effects).

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  tasks,
  filters,
  selectedId,
  showAllTasks,
  workspaceQuery,
  readerMode,
  preferredReaderMode,
  pendingHeadingFragment,
  navigationOpen,
  draggedTaskId,
  tab,
  postUpdateOpen,
  pendingTitleFocus,
  postUpdateFocusRequest,
  clearAllFilters,
  hasActiveFilters,
  sidebarFilter,
  view,
  narrowViewport,
  settingsFocusRequest,
} from "../../../src/ui/state/signals.ts";
import {
  QUERY_KEY,
  READER_MODE_KEY,
  parseStoredReaderMode,
  parseStoredQuery,
  requestMode,
  requestPostUpdate,
  clearWorkspaceTransientState,
  openSettings,
} from "../../../src/ui/state/workspace.ts";
import { contextOpen, contextSheetOpen } from "../../../src/ui/state/context.ts";
import type { Task } from "../../../src/ui/api/types.ts";

// Widening readers: TS narrows a signal's .value literal type after a
// direct assignment in the same scope and cannot see that requestMode /
// module effects mutate it — read through these to keep the union type.
const currentTab = (): string => tab.value;
const currentMode = (): string => readerMode.value;

const mkTask = (id: number, over: Partial<Task> = {}): Task => ({
  id,
  lane: "now",
  title: `task ${id}`,
  body: null,
  status: "open",
  priority: null,
  created: 0,
  updated: 0,
  tags: [],
  memory_excluded: false,
  ...over,
});

afterEach(() => {
  preferredReaderMode.value = "read";
  pendingHeadingFragment.value = null;
});

function reset(): void {
  preferredReaderMode.value = "read";
  pendingHeadingFragment.value = null;
  tasks.value = [];
  filters.value = { status: null, lane: null, tag: [] };
  selectedId.value = null;
  showAllTasks.value = false;
  workspaceQuery.value = "";
  readerMode.value = "read";
  tab.value = "document";
  navigationOpen.value = false;
  contextSheetOpen.value = false;
  contextOpen.value = true;
  draggedTaskId.value = null;
  sidebarFilter.value = null;
  postUpdateOpen.value = false;
  pendingTitleFocus.value = null;
  view.value = "tasks";
}

describe("workspace preference parsing (W3)", () => {
  test("QUERY_KEY is versioned and distinct from the legacy filter key", () => {
    expect(QUERY_KEY).toBe("cortex-workspace-query-v1");
  });

  test("parseStoredQuery: null → null (no stored preference)", () => {
    expect(parseStoredQuery(null)).toBeNull();
  });

  test("parseStoredQuery: stored string passes through verbatim", () => {
    expect(parseStoredQuery("#bug in lane")).toBe("#bug in lane");
  });

  test("parseStoredQuery: empty string is a valid 'no query' preference", () => {
    expect(parseStoredQuery("")).toBe("");
  });

  test("parseStoredQuery: absurdly long payload is rejected", () => {
    expect(parseStoredQuery("x".repeat(10_000))).toBeNull();
  });
});

describe("clearAllFilters / hasActiveFilters include the workspace query (W3)", () => {
  beforeEach(reset);

  test("clearAllFilters clears query + status + lane + tags in one batch", () => {
    filters.value = { status: "open", lane: "now", tag: ["bug"] };
    workspaceQuery.value = "needle";
    clearAllFilters();
    expect(filters.value).toEqual({ status: null, lane: null, tag: [] });
    expect(workspaceQuery.value).toBe("");
  });

  test("clearAllFilters does NOT reset the include-done preference", () => {
    showAllTasks.value = true;
    workspaceQuery.value = "needle";
    clearAllFilters();
    expect(showAllTasks.value).toBe(true);
  });

  test("hasActiveFilters is true when only the query is set", () => {
    expect(hasActiveFilters()).toBe(false);
    workspaceQuery.value = "needle";
    expect(hasActiveFilters()).toBe(true);
  });

  test("hasActiveFilters trims the query — whitespace-only is inactive", () => {
    workspaceQuery.value = "   ";
    expect(hasActiveFilters()).toBe(false);
  });
});

describe("requestMode", () => {
  beforeEach(reset);

  test("sets readerMode and reveals the Document tab", () => {
    tab.value = "updates";
    requestMode("split");
    expect(currentMode()).toBe("split");
    expect(currentTab()).toBe("document");
  });

  test("focus='title' routes pendingTitleFocus to the active task", () => {
    tasks.value = [mkTask(7)];
    selectedId.value = 7;
    requestMode("edit", "title");
    expect(readerMode.value).toBe("edit");
    expect(pendingTitleFocus.value).toBe(7);
  });

  test("focus request without an active task is a no-op on focus signals", () => {
    requestMode("edit", "title");
    expect(pendingTitleFocus.value).toBeNull();
  });
});

describe("requestPostUpdate (A3 state contract)", () => {
  beforeEach(reset);

  test("no active task → complete no-op", () => {
    const before = postUpdateFocusRequest.value;
    requestPostUpdate();
    expect(tab.value).toBe("document");
    expect(postUpdateOpen.value).toBe(false);
    expect(postUpdateFocusRequest.value).toBe(before);
  });

  test("active task → Activity tab selected, composer expanded, focus requested", () => {
    tasks.value = [mkTask(3)];
    selectedId.value = 3;
    const before = postUpdateFocusRequest.value;
    requestPostUpdate();
    expect(tab.value).toBe("updates");
    expect(postUpdateOpen.value).toBe(true);
    expect(postUpdateFocusRequest.value).toBe(before + 1);
  });

  test("closes lower transient layers before revealing Activity", async () => {
    const { taskActionsPopover } = await import("../../../src/ui/state/signals.ts");
    tasks.value = [mkTask(3)];
    selectedId.value = 3;
    navigationOpen.value = true;
    draggedTaskId.value = 3;
    taskActionsPopover.value = true;
    requestPostUpdate();
    expect(navigationOpen.value).toBe(false);
    expect(draggedTaskId.value).toBeNull();
    expect(taskActionsPopover.value).toBe(false);
    expect(currentTab()).toBe("updates");
  });
});

describe("acting on a task returns to the Tasks view", () => {
  beforeEach(reset);
  // Widening reader, as above: the panel views are set directly in each test.
  const currentView = (): string => view.value;

  test("Mod+/ (requestPostUpdate) from the Tags view", () => {
    tasks.value = [mkTask(3)];
    selectedId.value = 3;
    view.value = "tags";
    requestPostUpdate();
    expect(currentView()).toBe("tasks");
    expect(currentTab()).toBe("updates");
  });

  test("a mode shortcut (requestMode) from the Backup view", () => {
    view.value = "backup";
    requestMode("edit");
    expect(currentView()).toBe("tasks");
  });

  test("selecting another task from the Lanes view; a fallback change does not", () => {
    tasks.value = [mkTask(1, { status: "open" }), mkTask(2, { status: "blocked" })];
    view.value = "lanes";
    filters.value = { status: "blocked", lane: null, tag: [] }; // the fallback moves to task 2
    expect(currentView()).toBe("lanes");
    selectedId.value = 1;
    expect(currentView()).toBe("tasks");
  });
});

describe("openSettings", () => {
  beforeEach(reset);
  afterEach(() => {
    narrowViewport.value = false;
    navigationOpen.value = false;
    view.value = "tasks";
  });
  const currentView = (): string => view.value;

  test("shows the Settings view, asks its field for focus and keeps the drawer closed on a wide window", () => {
    draggedTaskId.value = 4;
    const before = settingsFocusRequest.value;
    openSettings();
    expect(currentView()).toBe("settings");
    expect(settingsFocusRequest.value).toBe(before + 1);
    expect(navigationOpen.value).toBe(false);
    expect(draggedTaskId.value).toBeNull();
    // Each call asks again, so a second Mod+, refocuses the field.
    openSettings();
    expect(settingsFocusRequest.value).toBe(before + 2);
  });

  test("opens the navigation drawer on a narrow window, where the search field lives", () => {
    narrowViewport.value = true;
    openSettings();
    expect(currentView()).toBe("settings");
    expect(navigationOpen.value).toBe(true);
  });

  test("selecting a task from Settings returns to Tasks", () => {
    tasks.value = [mkTask(1), mkTask(2)];
    openSettings();
    selectedId.value = 2;
    expect(currentView()).toBe("tasks");
  });
});

describe("clearWorkspaceTransientState", () => {
  beforeEach(reset);

  test("resets drag + navigation drawer state", () => {
    draggedTaskId.value = 42;
    navigationOpen.value = true;
    clearWorkspaceTransientState();
    expect(draggedTaskId.value).toBeNull();
    expect(navigationOpen.value).toBe(false);
  });

  test("ONE reset path also closes open popovers (task 8)", async () => {
    const { statusPopover, taskActionsPopover } = await import("../../../src/ui/state/signals.ts");
    statusPopover.value = true;
    taskActionsPopover.value = true;
    draggedTaskId.value = 9;
    clearWorkspaceTransientState();
    expect(statusPopover.value).toBe(false);
    expect(taskActionsPopover.value).toBe(false);
    expect(draggedTaskId.value).toBeNull();
  });

  test("live filtering may replace or remove the fallback without closing sidebar filters or navigation", () => {
    tasks.value = [mkTask(1, { status: "open" }), mkTask(2, { status: "blocked" })];
    navigationOpen.value = true;
    sidebarFilter.value = "tags";
    filters.value = { status: "blocked", lane: null, tag: [] };
    expect(navigationOpen.value).toBe(true);
    expect(sidebarFilter.value).toBe("tags");
    filters.value = { status: "done", lane: null, tag: [] };
    expect(navigationOpen.value).toBe(true);
    expect(sidebarFilter.value).toBe("tags");
    clearAllFilters();
    expect(navigationOpen.value).toBe(true);
    expect(sidebarFilter.value).toBe("tags");
  });

  test("explicitly selecting the current fallback still dismisses sidebar filters", () => {
    tasks.value = [mkTask(1)];
    navigationOpen.value = true;
    sidebarFilter.value = "tags";
    selectedId.value = 1;
    expect(navigationOpen.value).toBe(false);
    expect(sidebarFilter.value).toBeNull();
  });

  test("the side panel's sheet closes with the drawer, never under preserveSidebar, and the inline panel stays", () => {
    contextSheetOpen.value = true;
    expect(clearWorkspaceTransientState({ preserveSidebar: true })).toBe(false);
    expect(contextSheetOpen.value).toBe(true);
    expect(clearWorkspaceTransientState()).toBe(true);
    expect(contextSheetOpen.value).toBe(false);
    expect(contextOpen.value).toBe(true);
  });

  test("opening a task closes the sheet; a fallback task change keeps it", () => {
    tasks.value = [mkTask(1, { status: "open" }), mkTask(2, { status: "blocked" })];
    contextSheetOpen.value = true;
    filters.value = { status: "blocked", lane: null, tag: [] }; // fallback moves to task 2
    expect(contextSheetOpen.value).toBe(true);
    selectedId.value = 2;
    expect(contextSheetOpen.value).toBe(false);
  });

  test("deliberate resets close sidebar filters even without a task change", () => {
    sidebarFilter.value = "lane";
    expect(clearWorkspaceTransientState()).toBe(true);
    expect(sidebarFilter.value).toBeNull();
  });

  test("task navigation closes stale popovers and drag state", async () => {
    const { lanePopover } = await import("../../../src/ui/state/signals.ts");
    tasks.value = [mkTask(1), mkTask(2)];
    selectedId.value = 1;
    lanePopover.value = true;
    draggedTaskId.value = 1;
    selectedId.value = 2; // task change → workspace effect resets transients
    expect(lanePopover.value).toBe(false);
    expect(draggedTaskId.value).toBeNull();
  });
});

describe("browser body-mode preference", () => {
  beforeEach(reset);

  test("only supported stored enum values are accepted", () => {
    for (const mode of ["read", "edit", "split"] as const) expect(parseStoredReaderMode(mode)).toBe(mode);
    for (const invalid of [null, "", "Edit", "split ", "unknown", '{"mode":"edit"}']) {
      expect(parseStoredReaderMode(invalid)).toBeNull();
    }
  });

  for (const mode of ["read", "edit", "split"] as const) {
    test(`${mode} is persisted and survives navigation while Document is revealed`, () => {
      tasks.value = [mkTask(1), mkTask(2)];
      selectedId.value = 1;
      requestMode(mode);
      expect(localStorage.getItem(READER_MODE_KEY)).toBe(mode);
      tab.value = "updates";
      selectedId.value = 2;
      expect(currentMode()).toBe(mode);
      expect(currentTab()).toBe("document");
      expect(preferredReaderMode.value).toBe(mode);
    });
  }

  test("a heading read override never becomes the saved preference", () => {
    tasks.value = [mkTask(1), mkTask(2)];
    selectedId.value = 1;
    requestMode("edit");
    pendingHeadingFragment.value = { taskId: 2, id: "task-2-details" };
    selectedId.value = 2;
    expect(currentMode()).toBe("read");
    expect(localStorage.getItem(READER_MODE_KEY)).toBe("edit");
    pendingHeadingFragment.value = null;
    selectedId.value = 1;
    expect(currentMode()).toBe("edit");
  });

  test("same-task signal churn does NOT reset an explicit mode choice", () => {
    tasks.value = [mkTask(1)];
    selectedId.value = 1;
    readerMode.value = "edit";
    tab.value = "updates";
    // Refresh-style churn: same task identity, new array reference.
    tasks.value = [mkTask(1, { title: "task 1 renamed" })];
    expect(currentMode()).toBe("edit");
    expect(currentTab()).toBe("updates");
  });
});
