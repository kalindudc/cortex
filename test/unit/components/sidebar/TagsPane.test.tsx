import { describe, expect, test, mock, beforeEach } from "bun:test";

const addTag = mock(() => Promise.resolve({ name: "bug", color: null, created: 0 }));

mock.module("../../../../src/ui/api/client.ts", () => ({
  api: {
    addTag,
    editTag: mock(() => Promise.resolve({})),
    delTag: mock(() => Promise.resolve()),
    setTags: mock(() => Promise.resolve({})),
    // Stubs for refresh.ts side-effects (mock.module is process-global so a
    // partial api leaks into sibling tests like InboxPane).
    tasks: mock(() => Promise.resolve([])),
    lanes: mock(() => Promise.resolve([])),
    tags: mock(() => Promise.resolve([])),
    updates: mock(() => Promise.resolve([])),
    addTask: mock(() => Promise.resolve({})),
    editTask: mock(() => Promise.resolve({})),
    setStat: mock(() => Promise.resolve({})),
    moveLane: mock(() => Promise.resolve({})),
    delTask: mock(() => Promise.resolve()),
    postUpd: mock(() => Promise.resolve({})),
    addLane: mock(() => Promise.resolve({})),
    editLane: mock(() => Promise.resolve({})),
    delLane: mock(() => Promise.resolve()),
  },
}));

import { render, fireEvent } from "@testing-library/preact";

import { TagsPane } from "../../../../src/ui/components/sidebar/TagsPane.tsx";
import { tags, tasks, selectedTag, selectedId, newTagOpen, sidebarView } from "../../../../src/ui/state/signals.ts";

describe("TagsPane", () => {
  beforeEach(() => {
    sidebarView.value = "tags";
    selectedTag.value = null;
    selectedId.value = null;
    newTagOpen.value = false;
    tasks.value = [];
    tags.value = [
      { name: "bug", color: "#e11", created: 0, task_count: 3 },
      { name: "feat", color: "#1a1", created: 0, task_count: 1 },
    ];
    addTag.mockClear();
  });

  test("renders one .lane-row per tag in tags.value (sorted)", () => {
    const { container } = render(<TagsPane />);
    const rows = container.querySelectorAll(".lane-row");
    expect(rows.length).toBe(2);
    // Sorted alphabetically: bug, feat
    expect(rows[0].textContent).toContain("bug");
    expect(rows[1].textContent).toContain("feat");
  });

  test("clicking a tag row sets selectedTag.value to that tag name", () => {
    const { container } = render(<TagsPane />);
    const rows = container.querySelectorAll(".lane-row");
    fireEvent.click(rows[0]);
    expect(selectedTag.value).toBe("bug");
  });

  test("clicking the currently-selected tag row toggles it back to null", () => {
    selectedTag.value = "bug";
    const { container } = render(<TagsPane />);
    const rows = container.querySelectorAll(".lane-row");
    fireEvent.click(rows[0]);
    expect(selectedTag.value).toBeNull();
  });

  test("submitting the new-tag form calls api.addTag with the trimmed name", async () => {
    newTagOpen.value = true;
    const { container } = render(<TagsPane />);
    const input = container.querySelector('input[placeholder^="tag name"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    fireEvent.input(input, { target: { value: "  perf  " } });
    const form = input.closest("form");
    if (!form) throw new Error("expected input to be inside a form");
    fireEvent.submit(form);
    await Promise.resolve();
    await Promise.resolve();
    expect(addTag).toHaveBeenCalledTimes(1);
    expect(addTag).toHaveBeenCalledWith({ name: "perf" });
  });

  test("empty new-tag submission is a no-op", async () => {
    newTagOpen.value = true;
    const { container } = render(<TagsPane />);
    const form = container.querySelector("form");
    if (!form) throw new Error("expected a form to render");
    fireEvent.submit(form);
    await Promise.resolve();
    expect(addTag).not.toHaveBeenCalled();
  });

  test("renders empty-state when tags is empty", () => {
    tags.value = [];
    const { container } = render(<TagsPane />);
    expect(container.querySelector(".lane-row")).toBeNull();
    expect(container.textContent).toContain("no tags yet");
  });
});
