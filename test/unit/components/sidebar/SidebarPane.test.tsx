// SidebarPane — the unified left sidebar (Views + Lanes section, FilterChips,
// task list). Tags are no longer a section: they live in the SidebarSystemBar
// tag-filter button (covered by SidebarSystemBar.test.tsx). These tests
// exercise the public surface: section headers, view/lane row clicks →
// filters wiring, FilterChips strip, and task-list filtering. Component is
// wired to global signals, so we reset every signal in beforeEach.

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
    setStat: mock(() => Promise.resolve({})),
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
  modal,
  paletteOpen,
  statusPopover,
} from "../../../../src/ui/state/signals.ts";
import type { Task, Lane } from "../../../../src/ui/api/types.ts";

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

describe("SidebarPane", () => {
  beforeEach(() => {
    tasks.value = [];
    lanes.value = [];
    tags.value = [];
    filters.value = { status: null, lane: null, tag: [] };
    sectionOpen.value = { views: true, lanes: true, tasks: true };
    selectedId.value = null;
    showAllTasks.value = false;
    modal.value = null;
    paletteOpen.value = false;
    statusPopover.value = false;
    sidebarMode.value = "main";
  });

  test("renders three section headers in main mode: Views, Lanes, Tasks", () => {
    const { container } = render(<SidebarPane />);
    const labels = Array.from(container.querySelectorAll(".section-toggle .section-label")).map(el => el.textContent);
    expect(labels).toContain("Views");
    expect(labels).toContain("Lanes");
    expect(labels).toContain("Tasks");
    // Tag-management lives in tags-mode, not as a main-mode section.
    expect(labels).not.toContain("Tags");
  });

  test("clicking the 'In review' view-row sets filters.value.status to 'review'", () => {
    tasks.value = [task({ status: "review" })];
    const { container } = render(<SidebarPane />);
    const viewRow = Array.from(container.querySelectorAll<HTMLButtonElement>(".section-body button")).find(b =>
      (b.textContent ?? "").includes("In review"),
    );
    if (!viewRow) throw new Error("expected an 'In review' view-row");
    fireEvent.click(viewRow);
    expect(filters.value.status).toBe("review");
  });

  test("clicking the 'All tasks' view-row clears every filter slot (including tag array)", () => {
    filters.value = { status: "blocked", lane: "now", tag: ["bug", "ui"] };
    const { container } = render(<SidebarPane />);
    const viewRow = Array.from(container.querySelectorAll<HTMLButtonElement>(".section-body button")).find(b =>
      (b.textContent ?? "").includes("All tasks"),
    );
    if (!viewRow) throw new Error("expected an 'All tasks' view-row");
    fireEvent.click(viewRow);
    expect(filters.value).toEqual({ status: null, lane: null, tag: [] });
  });

  test("clicking a lane row toggles filters.value.lane on/off", () => {
    lanes.value = [lane({ name: "next" })];
    const { container } = render(<SidebarPane />);
    const laneRow = Array.from(container.querySelectorAll<HTMLButtonElement>(".lane-row")).find(
      b => b.querySelector(".lane-name")?.textContent === "next",
    );
    if (!laneRow) throw new Error("expected a 'next' lane-row");
    fireEvent.click(laneRow);
    expect(filters.value.lane).toBe("next");
    fireEvent.click(laneRow);
    expect(filters.value.lane).toBeNull();
  });

  test("FilterChips strip renders one chip per active filter slot (3-tag array → 5 chips)", () => {
    filters.value = { status: "review", lane: "now", tag: ["bug", "ui", "infra"] };
    const { container } = render(<SidebarPane />);
    // status + lane + 3 tags = 5 chips
    expect(container.querySelectorAll(".filter-chip").length).toBe(5);
  });

  test("task list shows only filteredTasks (status filter narrows to 1 row)", () => {
    tasks.value = [task({ id: 1, status: "open" }), task({ id: 2, status: "blocked" })];
    filters.value = { status: "blocked", lane: null, tag: [] };
    const { container } = render(<SidebarPane />);
    expect(container.querySelectorAll(".task-row").length).toBe(1);
  });

  test("clicking the Tasks section '+' button creates a task and selects it", async () => {
    // The api stub's addTask returns Promise.resolve({}); override per-test
    // to return a fake created task with an id so the editTask + selection
    // flow can complete deterministically.
    const { api } = await import("../../../../src/ui/api/client.ts");
    const addTaskMock = api.addTask as unknown as ReturnType<typeof mock>;
    addTaskMock.mockImplementationOnce(() => Promise.resolve({ id: 42 }));
    const editTaskMock = api.editTask as unknown as ReturnType<typeof mock>;
    editTaskMock.mockClear();

    const { container } = render(<SidebarPane />);
    const newTaskBtn = container.querySelector<HTMLButtonElement>('button[aria-label="New task"]');
    if (!newTaskBtn) throw new Error("expected Tasks section '+' button");
    fireEvent.click(newTaskBtn);

    // createUntitledTask awaits TWO chained tryApi calls (POST then PATCH)
    // before setting selectedId. Each tryApi adds a couple of microtasks.
    // setTimeout(0) drains the microtask queue + advances one macrotask
    // tick — enough for the whole chain to settle.
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    expect(addTaskMock).toHaveBeenCalledTimes(1);
    expect(editTaskMock).toHaveBeenCalledTimes(1);
    expect(editTaskMock).toHaveBeenCalledWith(42, { title: "untitled-42" });
    expect(selectedId.value).toBe(42);
  });

  test("Tasks section toggle hides the task list body", () => {
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

  test("sidebarMode='tags' renders TagsModePane (single TAGS section, no Views/Lanes/Tasks)", () => {
    sidebarMode.value = "tags";
    const { container } = render(<SidebarPane />);
    // Eyebrow label of the only section is 'Tags'.
    expect(container.querySelector(".section-head .eyebrow")?.textContent).toBe("Tags");
    // Main-mode sections are absent.
    const labels = Array.from(container.querySelectorAll(".section-toggle .section-label")).map(el => el.textContent);
    expect(labels).not.toContain("Views");
    expect(labels).not.toContain("Lanes");
    // 'New tag' "+" button surfaces in the section header.
    expect(container.querySelector('button[aria-label="New tag"]')).not.toBeNull();
  });

  test("tags mode '+' button dispatches the new-tag modal", () => {
    sidebarMode.value = "tags";
    const { container } = render(<SidebarPane />);
    const newTagBtn = container.querySelector<HTMLButtonElement>('button[aria-label="New tag"]');
    if (!newTagBtn) throw new Error("expected '+ New tag' button");
    fireEvent.click(newTagBtn);
    expect(modal.value).toEqual({ kind: "new-tag" });
  });

  test("clicking the Lanes section's '+' button dispatches the new-lane modal", () => {
    const { container } = render(<SidebarPane />);
    // The trailing slot inside the Lanes SectionHeader holds a btn-icon
    // with aria-label="New lane". (The '+' affordance.)
    const newLaneBtn = container.querySelector<HTMLButtonElement>('button[aria-label="New lane"]');
    if (!newLaneBtn) throw new Error("expected New lane '+' button");
    fireEvent.click(newLaneBtn);
    expect(modal.value).toEqual({ kind: "new-lane" });
  });

  test("clicking the Views section toggle collapses the section body", () => {
    const { container } = render(<SidebarPane />);
    // Sanity: 5 view-rows render when the section is open (SMART_VIEWS).
    expect(container.querySelectorAll(".view-row").length).toBe(5);
    const viewsToggle = Array.from(container.querySelectorAll<HTMLButtonElement>(".section-toggle")).find(
      b => b.querySelector(".section-label")?.textContent === "Views",
    );
    if (!viewsToggle) throw new Error("expected a Views section-toggle");
    fireEvent.click(viewsToggle);
    expect(sectionOpen.value.views).toBe(false);
    // Body unmounts when sectionOpen.value.views flips false.
    expect(container.querySelectorAll(".view-row").length).toBe(0);
  });
});
