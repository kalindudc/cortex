import { beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, render } from "@testing-library/preact";

// Stub the api before the component pulls it in. We don't assert on these
// calls in this file — but ActiveTaskPane's children (LaneChip / StatusPopover
// / PostUpdateForm / EditableTaskBody) all import the api at module load.
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

import { ActiveTaskPane } from "../../../../src/ui/components/active/ActiveTaskPane.tsx";
import {
  lanes,
  modal,
  selectedId,
  selectedLane,
  selectedTag,
  statusPopover,
  tags,
  tasks,
} from "../../../../src/ui/state/signals.ts";

const makeTask = (over: Record<string, unknown> = {}) => ({
  id: 7,
  lane: "inbox",
  title: "Wire up routing",
  body: "A description",
  status: "open" as const,
  priority: 50,
  created: 1700000000,
  updated: 1700000000,
  tags: [],
  ...over,
});

const _findButton = (root: ParentNode, text: string): HTMLButtonElement | null => {
  for (const btn of Array.from(root.querySelectorAll<HTMLButtonElement>("button"))) {
    if (btn.textContent?.includes(text)) return btn;
  }
  return null;
};

describe("ActiveTaskPane", () => {
  beforeEach(() => {
    tasks.value = [];
    lanes.value = [];
    tags.value = [];
    selectedId.value = null;
    selectedLane.value = null;
    selectedTag.value = null;
    statusPopover.value = false;
    modal.value = null;
  });

  test("renders the empty 'All caught up' placeholder when no active task", () => {
    const { container } = render(<ActiveTaskPane />);
    expect(container.querySelector(".pane.pane-active")).toBeTruthy();
    expect(container.querySelector(".empty")).toBeTruthy();
    expect(container.textContent).toContain("All caught up");
  });

  test("renders the task title and id chip when activeId points at a task", () => {
    tasks.value = [makeTask({ id: 42, title: "Wire up routing" })];
    selectedId.value = 42;
    const { container } = render(<ActiveTaskPane />);
    expect(container.querySelector(".empty")).toBeFalsy();
    const titleInput = container.querySelector(".title-input") as HTMLInputElement;
    expect(titleInput).toBeTruthy();
    expect(titleInput.value).toBe("Wire up routing");
    const chip = container.querySelector(".meta.num");
    expect(chip?.textContent).toBe("[42]");
  });

  test("status pill click toggles the StatusPopover open", () => {
    tasks.value = [makeTask({ id: 1, status: "open" })];
    selectedId.value = 1;
    const { container } = render(<ActiveTaskPane />);
    expect(statusPopover.value).toBe(false);
    expect(container.querySelector(".popover")).toBeFalsy();
    const pill = container.querySelector(".status-pill") as HTMLButtonElement;
    expect(pill).toBeTruthy();
    fireEvent.click(pill);
    expect(statusPopover.value).toBe(true);
    // Popover renders after the signal flips.
    expect(container.querySelector(".popover")).toBeTruthy();
  });
});
