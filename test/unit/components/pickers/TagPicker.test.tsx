import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

const setTagsMock = mock(() => Promise.resolve({}));
const addTaskTagMock = mock(() => Promise.resolve({}));
const removeTaskTagMock = mock(() => Promise.resolve({}));
// Full api surface to avoid cross-file mock pollution.
mock.module("../../../../src/ui/api/client.ts", () => ({
  api: {
    tasks: mock(() => Promise.resolve([])),
    lanes: mock(() => Promise.resolve([])),
    tags: mock(() => Promise.resolve([])),
    updates: mock(() => Promise.resolve([])),
    addTask: mock(() => Promise.resolve({})),
    editTask: mock(() => Promise.resolve({})),
    setStat: mock(() => Promise.resolve({})),
    moveLane: mock(() => Promise.resolve({})),
    delTask: mock(() => Promise.resolve(undefined)),
    postUpd: mock(() => Promise.resolve({})),
    addLane: mock(() => Promise.resolve({})),
    editLane: mock(() => Promise.resolve({})),
    delLane: mock(() => Promise.resolve(undefined)),
    setTags: setTagsMock,
    addTaskTag: addTaskTagMock,
    removeTaskTag: removeTaskTagMock,
    addTag: mock(() => Promise.resolve({})),
    editTag: mock(() => Promise.resolve({})),
    delTag: mock(() => Promise.resolve(undefined)),
  },
}));

import { render, fireEvent } from "@testing-library/preact";
import { TagPicker } from "../../../../src/ui/components/pickers/TagPicker.tsx";
import { tags, tagsPopover } from "../../../../src/ui/state/signals.ts";
import type { Task } from "../../../../src/ui/api/types.ts";

const fx: Task = {
  id: 11,
  lane: "todo",
  title: "t",
  body: null,
  status: "open",
  priority: 2,
  created: 0,
  updated: 0,
  tags: ["bug"],
};

const getSearch = () => document.querySelector(".tag-picker-search input") as HTMLInputElement;

describe("TagPicker", () => {
  beforeEach(() => {
    setTagsMock.mockClear();
    addTaskTagMock.mockClear();
    removeTaskTagMock.mockClear();
    tagsPopover.value = true;
    tags.value = [
      { name: "bug", color: null, created: 0, task_count: 1 },
      { name: "ui", color: null, created: 0, task_count: 3 },
    ];
  });
  afterEach(() => {
    tagsPopover.value = false;
    tags.value = [];
  });

  test("renders one row per known tag with attached-first ordering", () => {
    render(<TagPicker task={fx} />);
    const rows = document.querySelectorAll(".tag-picker-row");
    expect(rows.length).toBe(2);
    // attached "bug" should be first.
    expect(rows[0].textContent).toContain("bug");
    expect(rows[1].textContent).toContain("ui");
  });

  test("clicking an attached tag removes only that association (no stale whole-list overwrite)", async () => {
    render(<TagPicker task={fx} />);
    const rows = document.querySelectorAll(".tag-picker-row");
    fireEvent.click(rows[0]); // "bug" — currently attached
    await new Promise(r => setTimeout(r, 5));
    expect(removeTaskTagMock).toHaveBeenCalledTimes(1);
    expect(removeTaskTagMock).toHaveBeenCalledWith(11, "bug");
    expect(setTagsMock).not.toHaveBeenCalled();
  });

  test("typing a new tag + Enter adds that association without replacing other tags", async () => {
    render(<TagPicker task={fx} />);
    const input = getSearch();
    fireEvent.input(input, { target: { value: "newtag" } });
    await new Promise(r => setTimeout(r, 5));
    // After filtering, the create row is the only item — cursor sits at 0.
    fireEvent.keyDown(input, { key: "Enter" });
    await new Promise(r => setTimeout(r, 5));
    expect(addTaskTagMock).toHaveBeenCalledTimes(1);
    expect(addTaskTagMock).toHaveBeenCalledWith(11, "newtag");
    expect(setTagsMock).not.toHaveBeenCalled(); // no stale snapshot sent back
  });

  test("a failed add keeps the new-tag search text for retry", async () => {
    // Bun 1.1.12 (the pin when this was written) could eagerly create mockRejectedValueOnce's promise;
    // reject only at dispatch, after the SUT has installed its catch.
    addTaskTagMock.mockImplementationOnce(() => Promise.reject(new Error("offline")));
    render(<TagPicker task={fx} />);
    const input = getSearch();
    fireEvent.input(input, { target: { value: "retrytag" } });
    await new Promise(resolve => setTimeout(resolve, 5));
    fireEvent.keyDown(input, { key: "Enter" });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(input.value).toBe("retrytag");
  });

  test("catalog search shows all rows and finds late keyword matches without mutating tags", () => {
    tags.value = Array.from({ length: 2000 }, (_, index) => ({
      name: `queue-${String(index).padStart(4, "0")}-ui`,
      color: null,
      created: 0,
      task_count: 1,
    }));
    const { container } = render(<TagPicker task={{ ...fx, tags: ["queue-1999-ui"] }} />);
    expect(container.querySelectorAll(".tag-picker-row").length).toBe(2000);
    expect(container.querySelector(".tag-picker-row.selected")?.textContent).toContain("queue-1999-ui");
    expect(container.querySelector(".catalog-search-hint")?.textContent).toContain("2000 of 2000 entries");
    fireEvent.input(getSearch(), { target: { value: "1999 UI QuE" } });
    expect(container.querySelectorAll(".tag-picker-row").length).toBe(1);
    expect(container.querySelector(".tag-picker-row.selected")?.textContent).toContain("queue-1999-ui");
    expect(addTaskTagMock).not.toHaveBeenCalled();
    expect(removeTaskTagMock).not.toHaveBeenCalled();
    expect(setTagsMock).not.toHaveBeenCalled();
  });

  test("ArrowDown cycles cursor among rows", async () => {
    render(<TagPicker task={fx} />);
    const input = getSearch();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    await new Promise(r => setTimeout(r, 5));
    const cursorRow = document.querySelector(".tag-picker-row.cursor");
    expect(cursorRow).toBeTruthy();
    expect(cursorRow?.textContent).toContain("ui");
  });
});
