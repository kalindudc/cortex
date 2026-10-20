// SidebarPane — the workspace navigation column: the
// system bar, ONE WorkspaceFilters surface, and the task list. Lane/tag
// MANAGEMENT are explicit sidebar modes ('Manage lanes' / 'Manage tags')
// with their own panes; opening them never changes filters. During an
// actual task drag a transient 'Move to lane' tray appears — it is a
// drop surface, not a filter list.

import { describe, test, expect, mock, beforeEach } from "bun:test";

// Stub the api before SidebarPane (and any module it pulls in transitively,
// notably state/refresh.ts which registers a top-level effect over
// activeTask that calls api.updates() whenever the selection changes) is
// imported. The stub must cover every method any sibling component might
// invoke — bun's mock.module is process-global, so an undercount here only
// surfaces when an unrelated test triggers the refresh effect.
mock.module("../../../../src/ui/api/client.ts", () => ({
  api: {
    tasks: mock(() => Promise.resolve([])),
    lanes: mock(() => Promise.resolve([])),
    tags: mock(() => Promise.resolve([])),
    updates: mock(() => Promise.resolve([])),
    addLane: mock(() => Promise.resolve({})),
    addTag: mock(() => Promise.resolve({})),
    addTask: mock(() => Promise.resolve({})),
    moveLane: mock(() => Promise.resolve({})),
    editLane: mock(() => Promise.resolve({})),
    editTag: mock(() => Promise.resolve({})),
    delLane: mock(() => Promise.resolve()),
    delTag: mock(() => Promise.resolve()),
    delTask: mock(() => Promise.resolve()),
    versioned: { setStatus: mock(() => Promise.resolve({})), changeTags: mock(() => Promise.resolve({})) },
    editTask: mock(() => Promise.resolve({})),
    postUpd: mock(() => Promise.resolve({})),
  },
}));

import { render, fireEvent } from "@testing-library/preact";
import { SidebarPane } from "../../../../src/ui/components/sidebar/SidebarPane.tsx";
import {
  tasks,
  lanes,
  tags,
  filters,
  sectionOpen,
  sidebarMode,
  selectedId,
  showAllTasks,
  workspaceQuery,
  draggedTaskId,
  modal,
  paletteOpen,
  statusPopover,
  sidebarFilter,
} from "../../../../src/ui/state/signals.ts";
import type { Task, Lane } from "../../../../src/ui/api/types.ts";
import { taskGroup, taskSort } from "../../../../src/ui/state/settings.ts";

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

describe("SidebarPane", () => {
  beforeEach(() => {
    tasks.value = [];
    lanes.value = [];
    tags.value = [];
    filters.value = { status: null, lane: null, tag: [] };
    sectionOpen.value = { views: true, lanes: true, tasks: true };
    selectedId.value = null;
    showAllTasks.value = false;
    workspaceQuery.value = "";
    taskSort.value = "id";
    taskGroup.value = "none";
    draggedTaskId.value = null;
    modal.value = null;
    paletteOpen.value = false;
    statusPopover.value = false;
    sidebarFilter.value = null;
    sidebarMode.value = "main";
  });

  test("main mode renders WorkspaceFilters + Tasks section; no Views/Lanes filter sections", () => {
    lanes.value = [lane({ name: "now" }), lane({ name: "later" })];
    const { container } = render(<SidebarPane />);
    // One workspace filtering surface.
    expect(container.querySelectorAll(".workspace-filters").length).toBe(1);
    // Tasks is the only collapsible section left.
    const labels = Array.from(container.querySelectorAll(".section-toggle .section-label")).map(el => el.textContent);
    expect(labels).toEqual(["Tasks"]);
    // The permanent Views/Lanes filter row lists are gone.
    expect(container.querySelector(".view-row")).toBeNull();
  });

  test("exactly one persistent lane selector and one tag-filter entry (validation-gate invariant)", () => {
    lanes.value = [lane({ name: "now" })];
    const { container } = render(<SidebarPane />);
    expect(container.querySelectorAll("button[aria-label='Lane filter']").length).toBe(1);
    expect(container.querySelectorAll("button[aria-label='Filter by tags']").length).toBe(1);
    expect(container.querySelectorAll(".filter-chip-add").length).toBe(0);
  });

  test("task list shows only visible tasks (status filter narrows to 1 row)", () => {
    tasks.value = [task({ id: 1, status: "open" }), task({ id: 2, status: "blocked" })];
    filters.value = { status: "blocked", lane: null, tag: [] };
    const { container } = render(<SidebarPane />);
    expect(container.querySelectorAll(".task-row").length).toBe(1);
  });

  test("task list defaults to ascending id order, sorted by id with no group headers", () => {
    tasks.value = [
      task({ id: 3, title: "alpha" }),
      task({ id: 1, title: "task-12" }),
      task({ id: 2, title: "task-2" }),
    ];
    const { container } = render(<SidebarPane />);
    const ids = Array.from(container.querySelectorAll(".task-row .num")).map(el => el.textContent);
    expect(ids).toEqual(["@1", "@2", "@3"]);
    expect(container.querySelector(".task-order")?.textContent).toBe("Sorted by id");
    expect(container.querySelector(".task-group-header")).toBeNull();
  });

  test("grouping renders one header per group, with its count, before its rows", () => {
    lanes.value = [lane({ name: "now", sort: 0 }), lane({ name: "later", sort: 1 })];
    tasks.value = [task({ id: 1, lane: "later" }), task({ id: 2, lane: "now" }), task({ id: 3, lane: "later" })];
    taskGroup.value = "lane";
    const { container } = render(<SidebarPane />);
    const body = container.querySelector(".section-tasks .section-body");
    const sequence = Array.from(body?.querySelectorAll(".task-group-header, .task-row") ?? []).map(el =>
      el.classList.contains("task-row") ? el.querySelector(".num")?.textContent : el.textContent,
    );
    expect(sequence).toEqual(["now1", "@2", "later2", "@1", "@3"]);
    expect(container.querySelector(".task-order")?.textContent).toBe("Sorted by id, grouped by lane");
  });

  test("task list follows orderedVisibleTasks: natural title order (task-2 before task-12)", () => {
    taskSort.value = "title";
    tasks.value = [
      task({ id: 1, title: "task-12" }),
      task({ id: 2, title: "task-2" }),
      task({ id: 3, title: "alpha" }),
    ];
    const { container } = render(<SidebarPane />);
    const titles = Array.from(container.querySelectorAll(".task-row .task-title")).map(el => el.textContent);
    expect(titles).toEqual(["alpha", "task-2", "task-12"]);
  });

  test("nonempty workspace query orders rows by search relevance", () => {
    tasks.value = [
      task({ id: 1, title: "zzz", body: "needle in body" }),
      task({ id: 2, title: "needle title" }),
      task({ id: 3, title: "unrelated" }),
    ];
    workspaceQuery.value = "needle";
    taskGroup.value = "status";
    const { container } = render(<SidebarPane />);
    const titles = Array.from(container.querySelectorAll(".task-row .task-title")).map(el => el.textContent);
    expect(titles).toEqual(["needle title", "zzz"]);
    expect(container.querySelector(".task-order")?.textContent).toBe("Sorted by relevance");
    expect(container.querySelector(".task-group-header")).toBeNull();
  });

  test("clicking a task row selects it", () => {
    tasks.value = [task({ id: 7, title: "pick me" })];
    const { container } = render(<SidebarPane />);
    const row = container.querySelector<HTMLButtonElement>(".task-row");
    if (!row) throw new Error("expected a task row");
    fireEvent.click(row);
    expect(selectedId.value).toBe(7);
  });

  test("clicking the Tasks section '+' button creates a task and selects it", async () => {
    const { api } = await import("../../../../src/ui/api/client.ts");
    const addTaskMock = api.addTask as unknown as ReturnType<typeof mock>;
    addTaskMock.mockImplementationOnce(() => Promise.resolve({ id: 42 }));
    const editTaskMock = api.editTask as unknown as ReturnType<typeof mock>;
    editTaskMock.mockClear();

    const { container } = render(<SidebarPane />);
    const newTaskBtn = container.querySelector<HTMLButtonElement>('button[aria-label="New task"]');
    if (!newTaskBtn) throw new Error("expected Tasks section '+' button");
    fireEvent.click(newTaskBtn);

    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    expect(addTaskMock).toHaveBeenCalledTimes(1);
    // One atomic create names it untitled-<id>: no follow-up PATCH.
    expect(addTaskMock).toHaveBeenCalledWith({ untitled: true, lane: "now" });
    expect(editTaskMock).not.toHaveBeenCalled();
    expect(selectedId.value).toBe(42);
  });

  test("new task is created in the selected lane filter (or 'now')", async () => {
    const { api } = await import("../../../../src/ui/api/client.ts");
    const addTaskMock = api.addTask as unknown as ReturnType<typeof mock>;
    addTaskMock.mockClear();
    addTaskMock.mockImplementationOnce(() => Promise.resolve({ id: 43 }));
    filters.value = { status: null, lane: "later", tag: [] };

    const { container } = render(<SidebarPane />);
    fireEvent.click(container.querySelector<HTMLButtonElement>('button[aria-label="New task"]') as HTMLButtonElement);
    await new Promise(r => setTimeout(r, 0));
    expect((addTaskMock.mock.calls[0]?.[0] as { lane?: string } | undefined)?.lane).toBe("later");
  });

  test("Tasks section toggle hides the task list body (collapse preference kept)", () => {
    tasks.value = [task({ id: 1 })];
    const { container } = render(<SidebarPane />);
    expect(container.querySelectorAll(".task-row").length).toBe(1);
    const tasksToggle = Array.from(container.querySelectorAll<HTMLButtonElement>(".section-toggle")).find(
      b => b.querySelector(".section-label")?.textContent === "Tasks",
    );
    if (!tasksToggle) throw new Error("expected a Tasks section-toggle");
    fireEvent.click(tasksToggle);
    expect(sectionOpen.value.tasks).toBe(false);
    expect(container.querySelectorAll(".task-row").length).toBe(0);
  });

  // ---- management modes ----

  test("sidebarMode='tags' renders the 'Manage tags' pane without changing filters", () => {
    filters.value = { status: "open", lane: "now", tag: ["bug"] };
    sidebarMode.value = "tags";
    tags.value = [{ name: "bug", color: null, created: 0, task_count: 2 }];
    const { container } = render(<SidebarPane />);
    expect(container.querySelector(".section-head .eyebrow")?.textContent).toBe("Manage tags");
    expect(container.querySelector('button[aria-label="New tag"]')).not.toBeNull();
    // Opening management never changes filters.
    expect(filters.value).toEqual({ status: "open", lane: "now", tag: ["bug"] });
  });

  test("tags mode '+' button dispatches the new-tag modal; row click opens tag-edit", () => {
    sidebarMode.value = "tags";
    tags.value = [{ name: "bug", color: null, created: 0, task_count: 2 }];
    const { container } = render(<SidebarPane />);
    fireEvent.click(container.querySelector<HTMLButtonElement>('button[aria-label="New tag"]') as HTMLButtonElement);
    expect(modal.value).toEqual({ kind: "new-tag" });
    const row = container.querySelector<HTMLButtonElement>(".lane-row");
    if (!row) throw new Error("expected a tag row");
    fireEvent.click(row);
    expect(modal.value).toEqual({ kind: "tag-edit", name: "bug" });
  });

  test("sidebarMode='lanes' renders the 'Manage lanes' pane: new-lane + lane-edit dispatch, no filtering", () => {
    filters.value = { status: null, lane: "now", tag: [] };
    sidebarMode.value = "lanes";
    lanes.value = [lane({ name: "now" }), lane({ name: "later" })];
    const { container } = render(<SidebarPane />);
    expect(container.querySelector(".section-head .eyebrow")?.textContent).toBe("Manage lanes");

    fireEvent.click(container.querySelector<HTMLButtonElement>('button[aria-label="New lane"]') as HTMLButtonElement);
    expect(modal.value).toEqual({ kind: "new-lane" });

    const row = Array.from(container.querySelectorAll<HTMLButtonElement>(".lane-row")).find(
      b => b.querySelector(".lane-name")?.textContent === "later",
    );
    if (!row) throw new Error("expected a 'later' lane row");
    fireEvent.click(row);
    expect(modal.value).toEqual({ kind: "lane-edit", name: "later" });
    // Management rows never touch filters.
    expect(filters.value.lane).toBe("now");
  });

  // ---- drag & drop ----

  test("dragging a task reveals the transient 'Move to lane' tray; dragend clears it", () => {
    tasks.value = [task({ id: 5, title: "drag me" })];
    lanes.value = [lane({ name: "now" }), lane({ name: "later" })];
    const { container } = render(<SidebarPane />);
    expect(container.querySelector("[aria-label='Move to lane']")).toBeNull();

    const row = container.querySelector<HTMLButtonElement>(".task-row");
    if (!row) throw new Error("expected a task row");
    fireEvent.dragStart(row);
    expect(draggedTaskId.value).toBe(5);
    const tray = container.querySelector("[aria-label='Move to lane']");
    if (!tray) throw new Error("expected the Move-to-lane tray during drag");
    expect(tray.querySelectorAll(".lane-drop-target").length).toBe(2);

    fireEvent.dragEnd(row);
    expect(draggedTaskId.value).toBeNull();
    expect(container.querySelector("[aria-label='Move to lane']")).toBeNull();
  });

  test("dropping a dragged task on a tray target moves it to that lane", async () => {
    const { api } = await import("../../../../src/ui/api/client.ts");
    const moveLaneMock = api.moveLane as unknown as ReturnType<typeof mock>;
    moveLaneMock.mockClear();

    tasks.value = [task({ id: 5, title: "drag me" })];
    lanes.value = [lane({ name: "now" }), lane({ name: "later" })];
    const { container } = render(<SidebarPane />);
    const row = container.querySelector<HTMLButtonElement>(".task-row");
    if (!row) throw new Error("expected a task row");
    fireEvent.dragStart(row);

    const target = Array.from(container.querySelectorAll<HTMLElement>(".lane-drop-target")).find(el =>
      (el.textContent ?? "").includes("later"),
    );
    if (!target) throw new Error("expected a 'later' drop target");
    fireEvent.drop(target);
    await new Promise(r => setTimeout(r, 0));
    expect(moveLaneMock).toHaveBeenCalledTimes(1);
    expect(moveLaneMock).toHaveBeenCalledWith(5, "later");
    // Drop clears the transient drag state.
    expect(draggedTaskId.value).toBeNull();
    // Dropping on the tray is a MOVE, not a filter change.
    expect(filters.value.lane).toBeNull();
  });
});
