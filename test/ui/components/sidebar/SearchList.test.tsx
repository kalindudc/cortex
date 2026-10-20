// SearchList — the Search view's list: every task (every lane, done tasks
// included, the task list's filters ignored) with highlighted matches, a
// click or Enter opening a result beside the list while the view stays on
// Search, and the task list's query never touched.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// bun's mock.module is process-global: the canonical SidebarPane stub shape
// keeps a sibling test that triggers refresh.ts from reaching a missing method.
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

import { act, fireEvent, render } from "@testing-library/preact";
import { SearchList } from "../../../../src/ui/components/sidebar/SearchList.tsx";
import {
  filters,
  searchQuery,
  selectedId,
  showAllTasks,
  tasks,
  view,
  workspaceQuery,
} from "../../../../src/ui/state/signals.ts";
import { requestMode } from "../../../../src/ui/state/workspace.ts";
import type { Task } from "../../../../src/ui/api/types.ts";

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

// Widening reader: TS narrows view.value after a direct assignment.
const currentView = (): string => view.value;
const field = (c: Element): HTMLInputElement =>
  c.querySelector('input[type="search"][aria-label="Search all tasks"]') as HTMLInputElement;
const rowIds = (c: Element): string[] =>
  Array.from(c.querySelectorAll(".search-row .search-row-id")).map(el => el.textContent ?? "");

describe("SearchList", () => {
  beforeEach(() => {
    tasks.value = [
      mkTask(801, { lane: "elsewhere", title: "alpha", body: "a long body that hides the needle somewhere inside" }),
      mkTask(802, { title: "needle in the title", status: "done" }),
      mkTask(803, { title: "unrelated" }),
    ];
    filters.value = { status: "open", lane: "now", tag: [] };
    showAllTasks.value = false;
    workspaceQuery.value = "kept";
    searchQuery.value = "";
    selectedId.value = 803;
    view.value = "search";
  });
  afterEach(() => {
    searchQuery.value = "";
    workspaceQuery.value = "";
    filters.value = { status: null, lane: null, tag: [] };
    selectedId.value = null;
    tasks.value = [];
    view.value = "tasks";
  });

  test("the field is focused on mount, and an empty query explains the prefixes", () => {
    const { container } = render(<SearchList />);
    expect(document.activeElement).toBe(field(container));
    expect(field(container).placeholder).toBe("Search every task");
    const hint = container.querySelector(".search-meta")?.textContent ?? "";
    expect(hint).toContain("@12");
    expect(hint).toContain("@word");
    expect(hint).toContain("#tag");
    expect(container.querySelectorAll(".search-row").length).toBe(0);
  });

  test("every lane and done tasks match regardless of the filters, with highlights and a body excerpt", async () => {
    const { container } = render(<SearchList />);
    await act(() => {
      fireEvent.input(field(container), { target: { value: "needle" } });
    });
    expect(container.querySelector(".search-meta")?.textContent).toBe("2 results · every lane, done included");
    expect(rowIds(container).sort()).toEqual(["@801", "@802"]);

    const titleRow = Array.from(container.querySelectorAll(".search-row")).find(r =>
      r.textContent?.includes("@802"),
    ) as HTMLElement;
    expect(titleRow.querySelector(".search-row-title mark.search-hit")?.textContent).toBe("needle");
    expect(titleRow.querySelector(".dot.dot-status-done")).not.toBeNull();

    const bodyRow = Array.from(container.querySelectorAll(".search-row")).find(r =>
      r.textContent?.includes("@801"),
    ) as HTMLElement;
    expect(bodyRow.querySelector(".search-row-title")?.textContent).toBe("alpha");
    const excerpt = bodyRow.querySelector(".search-row-excerpt");
    expect(excerpt?.textContent).toContain("hides the needle somewhere");
    expect(excerpt?.querySelector("mark.search-hit")?.textContent).toBe("needle");

    expect(workspaceQuery.value).toBe("kept");
    expect(filters.value).toEqual({ status: "open", lane: "now", tag: [] });
  });

  test("ArrowDown then Enter opens that result, the view stays on Search and the results stay", async () => {
    const { container } = render(<SearchList />);
    await act(() => {
      fireEvent.input(field(container), { target: { value: "needle" } });
    });
    const before = rowIds(container);
    await act(() => {
      fireEvent.keyDown(field(container), { key: "ArrowDown" });
    });
    expect(container.querySelectorAll(".search-row.cursor").length).toBe(1);
    await act(() => {
      fireEvent.keyDown(field(container), { key: "Enter" });
    });
    expect(String(selectedId.value)).toBe((before[1] ?? "").slice(1));
    expect(currentView()).toBe("search");
    expect(rowIds(container)).toEqual(before);
    const current = container.querySelector('.search-row[aria-current="page"] .search-row-id');
    expect(current?.textContent).toBe(before[1]);
    expect(workspaceQuery.value).toBe("kept");
  });

  test("a click opens a result; acting on the task from Search keeps the Search view", async () => {
    const { container } = render(<SearchList />);
    await act(() => {
      fireEvent.input(field(container), { target: { value: "@801" } });
    });
    expect(rowIds(container)).toEqual(["@801"]);
    await act(() => {
      fireEvent.click(container.querySelector(".search-row") as HTMLElement);
    });
    expect(selectedId.value).toBe(801);
    expect(currentView()).toBe("search");
    requestMode("edit");
    expect(currentView()).toBe("search");
    expect(searchQuery.value).toBe("@801");
    expect(workspaceQuery.value).toBe("kept");
  });

  test("no match says so", async () => {
    const { container } = render(<SearchList />);
    await act(() => {
      fireEvent.input(field(container), { target: { value: "zzz-nothing" } });
    });
    expect(container.querySelector(".search-meta")?.textContent).toBe("0 results · every lane, done included");
    expect(container.querySelector(".search-empty")?.textContent).toBe("No task matches");
  });
});
