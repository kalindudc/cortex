import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

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
    setTags: mock(() => Promise.resolve({})),
    addTag: mock(() => Promise.resolve({})),
    editTag: mock(() => Promise.resolve({})),
    delTag: mock(() => Promise.resolve(undefined)),
  },
}));

import { render, fireEvent } from "@testing-library/preact";
import { LaneChipButton } from "../../../../src/ui/components/chips/LaneChipButton.tsx";
import { lanes, lanePopover } from "../../../../src/ui/state/signals.ts";
import type { Task } from "../../../../src/ui/api/types.ts";

const fx: Task = {
  id: 3,
  lane: "todo",
  title: "t",
  body: null,
  status: "open",
  priority: 2,
  created: 0,
  updated: 0,
  tags: [],
};

describe("LaneChipButton", () => {
  beforeEach(() => {
    lanePopover.value = false;
    lanes.value = [
      { name: "todo", color: "#ff0000", sort: 0 },
      { name: "doing", color: null, sort: 1 },
    ];
  });
  // Don't leak popover state into the next test file in the shared bun process.
  afterEach(() => {
    lanePopover.value = false;
    lanes.value = [];
  });

  test("renders a quiet labeled trigger (Lane: <name>) with a chevron, still draggable", () => {
    render(<LaneChipButton task={fx} />);
    const btn = document.querySelector("button.lane-chip-button") as HTMLButtonElement;
    expect(btn).toBeTruthy();
    // H1: quiet property trigger — explicit label + value + chevron.
    expect(btn.querySelector(".prop-label")?.textContent).toBe("Lane:");
    expect(btn.textContent).toContain("todo");
    expect(btn.querySelector(".icon")).not.toBeNull(); // chevron affordance
    // W5: the header chip remains the drag source with the task-id MIME.
    expect(btn.getAttribute("draggable")).toBe("true");
  });

  test("renders the lane color swatch when the lane has a color", () => {
    render(<LaneChipButton task={fx} />);
    const swatch = document.querySelector(".lane-color") as HTMLElement;
    expect(swatch).toBeTruthy();
    expect(swatch.getAttribute("style") || "").toContain("#ff0000");
  });

  test("clicking the chip toggles the lanePopover signal open", () => {
    render(<LaneChipButton task={fx} />);
    const btn = document.querySelector("button.lane-chip-button") as HTMLButtonElement;
    fireEvent.click(btn);
    expect(lanePopover.value).toBe(true);
  });
});
