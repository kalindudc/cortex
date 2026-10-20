import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

const moveLaneMock = mock(() => Promise.resolve({}));
// Full api surface to avoid cross-file mock pollution.
mock.module("../../../../src/ui/api/client.ts", () => ({
  api: {
    tasks: mock(() => Promise.resolve([])),
    lanes: mock(() => Promise.resolve([])),
    tags: mock(() => Promise.resolve([])),
    updates: mock(() => Promise.resolve([])),
    addTask: mock(() => Promise.resolve({})),
    editTask: mock(() => Promise.resolve({})),
    versioned: { setStatus: mock(() => Promise.resolve({})), changeTags: mock(() => Promise.resolve({})) },
    moveLane: moveLaneMock,
    delTask: mock(() => Promise.resolve(undefined)),
    postUpd: mock(() => Promise.resolve({})),
    addLane: mock(() => Promise.resolve({})),
    editLane: mock(() => Promise.resolve({})),
    delLane: mock(() => Promise.resolve(undefined)),
    setTags: mock(() => Promise.resolve({})),
    addTag: mock(() => Promise.resolve({})),
    editTag: mock(() => Promise.resolve({})),
    delTag: mock(() => Promise.resolve(undefined)),
  },
}));

import { render, fireEvent } from "@testing-library/preact";
import { LanePicker } from "../../../../src/ui/components/pickers/LanePicker.tsx";
import { lanes, lanePopover } from "../../../../src/ui/state/signals.ts";
import type { Task } from "../../../../src/ui/api/types.ts";

const fx: Task = {
  id: 4,
  lane: "todo",
  title: "t",
  body: null,
  status: "open",
  priority: 2,
  created: 0,
  updated: 0,
  tags: [],
  memory_excluded: false,
};

describe("LanePicker", () => {
  beforeEach(() => {
    moveLaneMock.mockClear();
    lanePopover.value = true;
    lanes.value = [
      { name: "todo", color: null, sort: 0 },
      { name: "doing", color: null, sort: 1 },
      { name: "done", color: null, sort: 2 },
    ];
  });
  afterEach(() => {
    lanePopover.value = false;
    lanes.value = [];
  });

  test("renders one row per lane (sorted alphabetically)", () => {
    render(<LanePicker task={fx} />);
    const rows = document.querySelectorAll(".picker-row");
    expect(rows.length).toBe(3);
    // alphabetical: doing, done, todo
    expect(rows[0].textContent).toContain("doing");
    expect(rows[1].textContent).toContain("done");
    expect(rows[2].textContent).toContain("todo");
  });

  test("clicking a different lane calls api.moveLane and closes the popover", async () => {
    render(<LanePicker task={fx} />);
    const rows = document.querySelectorAll(".picker-row");
    fireEvent.click(rows[1]); // "done"
    await new Promise(r => setTimeout(r, 5));
    expect(moveLaneMock).toHaveBeenCalledTimes(1);
    expect(moveLaneMock).toHaveBeenCalledWith(4, "done");
    expect(lanePopover.value).toBe(false);
  });

  test("clicking the current lane closes the picker but does NOT call moveLane", async () => {
    render(<LanePicker task={fx} />);
    const rows = document.querySelectorAll(".picker-row");
    fireEvent.click(rows[2]); // "todo" — the current lane
    await new Promise(r => setTimeout(r, 5));
    expect(moveLaneMock).not.toHaveBeenCalled();
    expect(lanePopover.value).toBe(false);
  });
});
