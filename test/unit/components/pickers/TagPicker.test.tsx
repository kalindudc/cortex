import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

const setTagsMock = mock(() => Promise.resolve({}));
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

  test("clicking an attached tag detaches it via api.setTags (without it)", async () => {
    render(<TagPicker task={fx} />);
    const rows = document.querySelectorAll(".tag-picker-row");
    fireEvent.click(rows[0]); // "bug" — currently attached
    await new Promise(r => setTimeout(r, 5));
    expect(setTagsMock).toHaveBeenCalledTimes(1);
    expect(setTagsMock).toHaveBeenCalledWith(11, []);
  });

  test("typing a brand-new tag name + Enter triggers api.setTags with appended name", async () => {
    render(<TagPicker task={fx} />);
    const input = getSearch();
    fireEvent.input(input, { target: { value: "newtag" } });
    await new Promise(r => setTimeout(r, 5));
    // After filtering, the create row is the only item — cursor sits at 0.
    fireEvent.keyDown(input, { key: "Enter" });
    await new Promise(r => setTimeout(r, 5));
    expect(setTagsMock).toHaveBeenCalledTimes(1);
    const [taskId, names] = setTagsMock.mock.calls[0] as unknown as [number, string[]];
    expect(taskId).toBe(11);
    expect(names).toContain("newtag");
    expect(names).toContain("bug"); // attached preserved
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
