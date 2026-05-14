import { describe, expect, test, mock, beforeEach } from "bun:test";

const addLane = mock(() => Promise.resolve({ name: "newlane", color: null, sort: 0 }));
const addTask = mock(() =>
  Promise.resolve({
    id: 1,
    lane: "now",
    title: "t",
    body: null,
    status: "open",
    priority: 0,
    created: 0,
    updated: 0,
    tags: [],
  }),
);
const moveLane = mock(() => Promise.resolve({}));

mock.module("../../../../src/ui/api/client.ts", () => ({
  api: {
    addLane,
    addTask,
    moveLane,
    editLane: mock(() => Promise.resolve({})),
    delLane: mock(() => Promise.resolve()),
    // Stubs for refresh.ts side-effects that fire whenever selectedId/tasks
    // change in any sibling test (mock.module is process-global in bun:test
    // so a partial api leaks to InboxPane etc.).
    tasks: mock(() => Promise.resolve([])),
    lanes: mock(() => Promise.resolve([])),
    tags: mock(() => Promise.resolve([])),
    updates: mock(() => Promise.resolve([])),
    editTask: mock(() => Promise.resolve({})),
    setStat: mock(() => Promise.resolve({})),
    delTask: mock(() => Promise.resolve()),
    postUpd: mock(() => Promise.resolve({})),
    setTags: mock(() => Promise.resolve({})),
    addTag: mock(() => Promise.resolve({})),
    editTag: mock(() => Promise.resolve({})),
    delTag: mock(() => Promise.resolve()),
  },
}));

import { render, fireEvent } from "@testing-library/preact";

import { LanesPane } from "../../../../src/ui/components/sidebar/LanesPane.tsx";
import { lanes, tasks, selectedLane, selectedId, newLaneOpen, sidebarView } from "../../../../src/ui/state/signals.ts";

describe("LanesPane", () => {
  beforeEach(() => {
    sidebarView.value = "lanes";
    selectedLane.value = null;
    selectedId.value = null;
    newLaneOpen.value = false;
    tasks.value = [];
    lanes.value = [
      { name: "now", color: "#888", sort: 0 },
      { name: "next", color: "#444", sort: 1 },
    ];
    addLane.mockClear();
    addTask.mockClear();
  });

  test("renders one .lane-row per lane in lanes.value", () => {
    const { container } = render(<LanesPane />);
    const rows = container.querySelectorAll(".lane-row");
    expect(rows.length).toBe(2);
    expect(rows[0].querySelector(".lane-name")?.textContent).toBe("now");
    expect(rows[1].querySelector(".lane-name")?.textContent).toBe("next");
  });

  test("clicking a lane row sets selectedLane.value", () => {
    const { container } = render(<LanesPane />);
    const rows = container.querySelectorAll(".lane-row");
    fireEvent.click(rows[1]);
    expect(selectedLane.value).toBe("next");
  });

  test("clicking the same selected lane row toggles selectedLane back to null", () => {
    selectedLane.value = "now";
    const { container } = render(<LanesPane />);
    const firstRow = container.querySelector(".lane-row");
    if (!firstRow) throw new Error("expected a .lane-row to render");
    fireEvent.click(firstRow);
    expect(selectedLane.value).toBeNull();
  });

  test("clicking the All-tasks view-row clears selectedLane", () => {
    selectedLane.value = "now";
    const { container } = render(<LanesPane />);
    const viewRow = container.querySelector(".view-row");
    if (!viewRow) throw new Error("expected a .view-row to render");
    fireEvent.click(viewRow);
    expect(selectedLane.value).toBeNull();
  });

  test("submitting the new-lane form calls api.addLane with the trimmed name", async () => {
    newLaneOpen.value = true;
    const { container } = render(<LanesPane />);
    const input = container.querySelector('input[placeholder="lane name"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    fireEvent.input(input, { target: { value: "  later  " } });
    const form = input.closest("form");
    if (!form) throw new Error("expected input to be inside a form");
    fireEvent.submit(form);
    // tryApi awaits the promise; flush microtasks.
    await Promise.resolve();
    await Promise.resolve();
    expect(addLane).toHaveBeenCalledTimes(1);
    expect(addLane).toHaveBeenCalledWith({ name: "later" });
  });

  test("empty new-lane submission is a no-op", async () => {
    newLaneOpen.value = true;
    const { container } = render(<LanesPane />);
    const form = container.querySelector("form");
    if (!form) throw new Error("expected a form to render");
    fireEvent.submit(form);
    await Promise.resolve();
    expect(addLane).not.toHaveBeenCalled();
  });
});
