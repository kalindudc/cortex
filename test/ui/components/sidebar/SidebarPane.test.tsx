// SidebarPane — the list column: ONE WorkspaceFilters surface and the
// task list. The Lanes and Tags views (opened from the rail) list their
// entries beside their panels; a row selects the entry, and opening them
// never changes filters. During an
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

import { act, render, fireEvent } from "@testing-library/preact";
import { SidebarPane } from "../../../../src/ui/components/sidebar/SidebarPane.tsx";
import {
  tasks,
  lanes,
  tags,
  filters,
  sectionOpen,
  view,
  selectedId,
  showAllTasks,
  workspaceQuery,
  draggedTaskId,
  modal,
  paletteOpen,
  statusPopover,
  sidebarFilter,
  selectedLane,
  selectedTag,
  navigationOpen,
} from "../../../../src/ui/state/signals.ts";
import type { Task, Lane } from "../../../../src/ui/api/types.ts";
import { collapsedGroups, taskGroup, taskSort } from "../../../../src/ui/state/settings.ts";

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
    collapsedGroups.value = { lane: [], status: [] };
    draggedTaskId.value = null;
    modal.value = null;
    paletteOpen.value = false;
    statusPopover.value = false;
    sidebarFilter.value = null;
    view.value = "tasks";
    selectedLane.value = null;
    selectedTag.value = null;
    navigationOpen.value = false;
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

  test("a group header folds its rows away and back, and the fold is kept per grouping", () => {
    lanes.value = [lane({ name: "now", sort: 0 }), lane({ name: "later", sort: 1 })];
    tasks.value = [task({ id: 1, lane: "later" }), task({ id: 2, lane: "now" }), task({ id: 3, lane: "later" })];
    taskGroup.value = "lane";
    const { container } = render(<SidebarPane />);
    const header = (label: string) =>
      Array.from(container.querySelectorAll<HTMLButtonElement>("button.task-group-header")).find(
        el => el.querySelector(".task-group-label")?.textContent === label,
      );
    const listed = () => Array.from(container.querySelectorAll(".task-row .num")).map(el => el.textContent);
    expect(header("later")?.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(header("later") as HTMLButtonElement);
    expect(listed()).toEqual(["@2"]);
    expect(header("later")?.getAttribute("aria-expanded")).toBe("false");
    // The folded header still shows its count.
    expect(header("later")?.querySelector(".task-group-count")?.textContent).toBe("2");
    expect(collapsedGroups.value).toEqual({ lane: ["later"], status: [] });

    // Another grouping has its own folds.
    act(() => {
      taskGroup.value = "status";
    });
    expect(listed()).toEqual(["@1", "@2", "@3"]);
    act(() => {
      taskGroup.value = "lane";
    });
    expect(listed()).toEqual(["@2"]);
    fireEvent.click(header("later") as HTMLButtonElement);
    expect(listed()).toEqual(["@2", "@1", "@3"]);
  });

  test("the order line opens the sort and group panel, whose choices change the list", () => {
    tasks.value = [task({ id: 1 }), task({ id: 2 })];
    const { container } = render(<SidebarPane />);
    const trigger = container.querySelector<HTMLButtonElement>("#sidebar-filter-order-trigger");
    if (!trigger) throw new Error("expected the order trigger");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(sidebarFilter.value).toBe("order");
    const panel = container.querySelector("#sidebar-filter-order-panel");
    expect(panel?.querySelector("h2")?.textContent).toBe("Sort and group");
    expect(
      Array.from(panel?.querySelectorAll("[data-setting]") ?? []).map(el => el.getAttribute("data-setting")),
    ).toEqual(["sort", "direction", "group"]);
    // Each field is listed once; the direction is its own control.
    const sort = panel?.querySelector<HTMLSelectElement>("#setting-sort");
    if (!sort) throw new Error("expected the sort select");
    expect(Array.from(sort.options).map(o => o.value)).toEqual([
      "id",
      "title",
      "lane",
      "status",
      "priority",
      "updated",
    ]);
    const descending = panel?.querySelector<HTMLInputElement>('#setting-direction input[value="desc"]');
    if (!descending) throw new Error("expected the descending radio");
    fireEvent.click(descending);
    expect(taskSort.value).toBe("-id");
    expect(Array.from(container.querySelectorAll(".task-row .num")).map(el => el.textContent)).toEqual(["@2", "@1"]);
    // A choice keeps the panel open: sort, direction and group are chosen together.
    expect(sidebarFilter.value).toBe("order");
    expect(container.querySelector(".task-order")?.textContent).toBe("Sorted by id descending");
  });

  test("Collapse all and Expand all fold every shown group, and only show while the list is grouped", () => {
    lanes.value = [lane({ name: "now", sort: 0 }), lane({ name: "later", sort: 1 })];
    tasks.value = [task({ id: 1, lane: "later" }), task({ id: 2, lane: "now" }), task({ id: 3, lane: "later" })];
    const { container } = render(<SidebarPane />);
    const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    const listed = () => Array.from(container.querySelectorAll(".task-row .num")).map(el => el.textContent);
    expect(button("Collapse all lanes")).toBeNull();

    act(() => {
      taskGroup.value = "lane";
    });
    expect(button("Expand all lanes")?.disabled).toBe(true);
    fireEvent.click(button("Collapse all lanes") as HTMLButtonElement);
    expect(listed()).toEqual([]);
    expect(container.querySelectorAll('button.task-group-header[aria-expanded="false"]').length).toBe(2);
    expect(button("Collapse all lanes")?.disabled).toBe(true);
    fireEvent.click(button("Expand all lanes") as HTMLButtonElement);
    expect(listed()).toEqual(["@2", "@1", "@3"]);

    act(() => {
      taskGroup.value = "status";
    });
    expect(button("Collapse all lanes")).toBeNull();
    fireEvent.click(button("Collapse all statuses") as HTMLButtonElement);
    expect(listed()).toEqual([]);
    expect(collapsedGroups.value).toEqual({ lane: [], status: ["open"] });
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

  test("a task row shows a labelled status glyph, its id, tags and age, and no status word", () => {
    tasks.value = [
      task({ id: 4, title: "compact", status: "review", tags: ["bug", "ui"], updated: Date.now() - 3 * 3_600_000 }),
    ];
    const { container } = render(<SidebarPane />);
    const row = container.querySelector<HTMLButtonElement>(".task-row");
    if (!row) throw new Error("expected a task row");
    const glyph = row.querySelector(".dot.dot-status-review");
    expect(glyph?.getAttribute("role")).toBe("img");
    expect(glyph?.getAttribute("aria-label")).toBe("In review");
    expect(row.querySelector(".num")?.textContent).toBe("@4");
    expect(Array.from(row.querySelectorAll(".task-row-tag")).map(el => el.textContent)).toEqual(["#bug", "#ui"]);
    expect(row.querySelector(".task-row-trail .priority-chip")?.textContent).toBe("P3");
    expect(row.querySelector(".task-row-trail .task-row-time")?.textContent).toBe("3h");
    expect(row.textContent).not.toContain("In review");
    expect(row.textContent).not.toContain("·");
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

  test("view='tags' renders the Tags list without changing filters", () => {
    filters.value = { status: "open", lane: "now", tag: ["bug"] };
    view.value = "tags";
    tags.value = [{ name: "bug", color: null, created: 0, task_count: 2 }];
    const { container } = render(<SidebarPane />);
    expect(container.querySelector(".section-head h1")?.textContent).toBe("Tags");
    expect(container.querySelectorAll('button[aria-label="New tag"]').length).toBe(1);
    // Opening management never changes filters.
    expect(filters.value).toEqual({ status: "open", lane: "now", tag: ["bug"] });
  });

  test("tags: '+' opens the new-tag modal; a row selects its tag, marks it and closes the drawer", () => {
    view.value = "tags";
    tags.value = [
      { name: "bug", color: null, created: 0, task_count: 2 },
      { name: "alpha", color: null, created: 0, task_count: 0 },
    ];
    navigationOpen.value = true;
    const { container } = render(<SidebarPane />);
    fireEvent.click(container.querySelector<HTMLButtonElement>('button[aria-label="New tag"]') as HTMLButtonElement);
    expect(modal.value).toEqual({ kind: "new-tag" });
    modal.value = null;
    const rows = () => Array.from(container.querySelectorAll<HTMLButtonElement>(".lane-row"));
    // Sorted by name; with no selection the first tag is the one shown.
    expect(rows().map(r => r.querySelector(".tag-pill")?.textContent)).toEqual(["alpha", "bug"]);
    expect(rows()[0]?.getAttribute("aria-current")).toBe("true");
    fireEvent.click(rows()[1] as HTMLButtonElement);
    expect(selectedTag.value).toBe("bug");
    expect(modal.value).toBeNull();
    expect(navigationOpen.value).toBe(false);
    expect(rows()[1]?.classList.contains("selected")).toBe(true);
    expect(rows()[0]?.getAttribute("aria-current")).toBeNull();
  });

  test("view='lanes' renders the Lanes list: '+' opens new-lane, a row selects its lane, no filtering", () => {
    filters.value = { status: null, lane: "now", tag: [] };
    view.value = "lanes";
    lanes.value = [lane({ name: "now" }), lane({ name: "later", sort: 1 })];
    tasks.value = [task({ id: 1, lane: "later" }), task({ id: 2, lane: "later", status: "done" })];
    const { container } = render(<SidebarPane />);
    expect(container.querySelector(".section-head h1")?.textContent).toBe("Lanes");

    fireEvent.click(container.querySelector<HTMLButtonElement>('button[aria-label="New lane"]') as HTMLButtonElement);
    expect(modal.value).toEqual({ kind: "new-lane" });
    modal.value = null;

    const rowFor = (name: string) =>
      Array.from(container.querySelectorAll<HTMLButtonElement>(".lane-row")).find(
        b => b.querySelector(".lane-name")?.textContent === name,
      );
    expect(rowFor("now")?.querySelector(".lane-default")?.textContent).toBe("default");
    expect(rowFor("now")?.getAttribute("aria-current")).toBe("true");
    // Counts stay "not done".
    expect(rowFor("later")?.querySelector(".lane-count")?.textContent).toBe("1");
    fireEvent.click(rowFor("later") as HTMLButtonElement);
    expect(selectedLane.value).toBe("later");
    expect(modal.value).toBeNull();
    expect(rowFor("later")?.getAttribute("aria-current")).toBe("true");
    // Management rows never touch filters.
    expect(filters.value.lane).toBe("now");
  });

  test("the lane and tag searches narrow the rows", () => {
    view.value = "lanes";
    lanes.value = [lane({ name: "now" }), lane({ name: "later", sort: 1 }), lane({ name: "research", sort: 2 })];
    const { container, unmount } = render(<SidebarPane />);
    const find = container.querySelector<HTMLInputElement>('input[aria-label="Find a lane"]') as HTMLInputElement;
    fireEvent.input(find, { target: { value: "LA" } });
    expect(Array.from(container.querySelectorAll(".lane-row .lane-name")).map(n => n.textContent)).toEqual(["later"]);
    fireEvent.input(find, { target: { value: "zzz" } });
    expect(container.querySelectorAll(".lane-row").length).toBe(0);
    expect(container.querySelector(".section-body .meta")?.textContent).toBe("no lane matches");
    unmount();

    view.value = "tags";
    tags.value = [
      { name: "bug", color: null, created: 0, task_count: 2 },
      { name: "plan", color: null, created: 0, task_count: 1 },
    ];
    const tagsView = render(<SidebarPane />);
    const findTag = tagsView.container.querySelector<HTMLInputElement>(
      'input[aria-label="Find a tag"]',
    ) as HTMLInputElement;
    fireEvent.input(findTag, { target: { value: "pl" } });
    expect(Array.from(tagsView.container.querySelectorAll(".lane-row .tag-pill")).map(n => n.textContent)).toEqual([
      "plan",
    ]);
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
