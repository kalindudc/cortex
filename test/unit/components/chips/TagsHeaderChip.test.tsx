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
import { TagsHeaderChip } from "../../../../src/ui/components/chips/TagsHeaderChip.tsx";
import { tags, tagsPopover } from "../../../../src/ui/state/signals.ts";
import type { Task } from "../../../../src/ui/api/types.ts";

const fx: Task = {
  id: 9,
  lane: "todo",
  title: "t",
  body: null,
  status: "open",
  priority: 2,
  created: 0,
  updated: 0,
  tags: ["bug", "ui"],
};

describe("TagsHeaderChip", () => {
  beforeEach(() => {
    tagsPopover.value = false;
    tags.value = [];
  });
  // Don't leak popover state into the next test file in the shared bun process.
  afterEach(() => {
    tagsPopover.value = false;
    tags.value = [];
  });

  test("renders the attached count", () => {
    render(<TagsHeaderChip task={fx} />);
    const btn = document.querySelector("button.tags-chip") as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(document.querySelector(".tags-chip-count")?.textContent).toBe("2");
    expect(btn.getAttribute("title")).toContain("#bug");
  });

  test("renders 0 and a hint title when task has no tags", () => {
    render(<TagsHeaderChip task={{ ...fx, tags: [] }} />);
    expect(document.querySelector(".tags-chip-count")?.textContent).toBe("0");
    expect(document.querySelector("button.tags-chip")?.getAttribute("title")).toContain("add tags");
  });

  test("clicking the chip toggles tagsPopover signal", () => {
    render(<TagsHeaderChip task={fx} />);
    const btn = document.querySelector("button.tags-chip") as HTMLButtonElement;
    fireEvent.click(btn);
    expect(tagsPopover.value).toBe(true);
  });
});
