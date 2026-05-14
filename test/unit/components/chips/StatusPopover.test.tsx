import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

const setStatMock = mock(() => Promise.resolve({}));
// Full api surface — keeps the bun:test module cache consistent for any other
// test file that imports refresh.ts (which calls api.updates).
mock.module("../../../../src/ui/api/client.ts", () => ({
  api: {
    tasks: mock(() => Promise.resolve([])),
    lanes: mock(() => Promise.resolve([])),
    tags: mock(() => Promise.resolve([])),
    updates: mock(() => Promise.resolve([])),
    addTask: mock(() => Promise.resolve({})),
    editTask: mock(() => Promise.resolve({})),
    setStat: setStatMock,
    moveLane: mock(() => Promise.resolve({})),
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
import { StatusPopover } from "../../../../src/ui/components/chips/StatusPopover.tsx";
import { statusPopover } from "../../../../src/ui/state/signals.ts";
import type { Task } from "../../../../src/ui/api/types.ts";

const fx: Task = {
  id: 7,
  lane: "todo",
  title: "t",
  body: null,
  status: "open",
  priority: 2,
  created: 0,
  updated: 0,
  tags: [],
};

describe("StatusPopover", () => {
  beforeEach(() => {
    setStatMock.mockClear();
    statusPopover.value = false;
  });
  afterEach(() => {
    statusPopover.value = false;
  });

  test("renders nothing when popover signal is false", () => {
    render(<StatusPopover task={fx} />);
    expect(document.querySelector(".popover")).toBeNull();
  });

  test("renders all four status rows when open", () => {
    statusPopover.value = true;
    render(<StatusPopover task={fx} />);
    const rows = document.querySelectorAll(".popover-row");
    expect(rows.length).toBe(4);
  });

  test("clicking a status row calls api.setStat and closes popover", async () => {
    statusPopover.value = true;
    render(<StatusPopover task={fx} />);
    const rows = document.querySelectorAll(".popover-row");
    fireEvent.click(rows[1]); // "review"
    await new Promise(r => setTimeout(r, 5));
    expect(setStatMock).toHaveBeenCalledTimes(1);
    expect(setStatMock).toHaveBeenCalledWith(7, "review");
    expect(statusPopover.value).toBe(false);
  });
});
