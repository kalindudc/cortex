// TagsHeaderChip — actual named tag pills in the header property row:
// up to three visible TagPills, a labeled overflow trigger for
// the rest, and an explicit Add-tags affordance. NO 'tags: N' count proxy.
// The TagPicker keeps its fresh-mount gate (mounted only while open).

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

interface RemovalCall {
  id: number;
  name: string;
  resolve: (task: Task) => void;
  reject: (error: Error) => void;
}
const removalCalls: RemovalCall[] = [];
const changeTags = mock(
  (id: number, change: { remove?: string[] }) =>
    new Promise<Task>((resolve, reject) => {
      removalCalls.push({ id, name: change.remove?.[0] ?? "", resolve, reject });
    }),
);
const setTags = mock(() => Promise.resolve({}));
const delTag = mock(() => Promise.resolve());

// Full api surface to avoid cross-file mock pollution.
mock.module("../../../../src/ui/api/client.ts", () => ({
  api: {
    tasks: mock(() => Promise.resolve([])),
    lanes: mock(() => Promise.resolve([])),
    tags: mock(() => Promise.resolve([])),
    updates: mock(() => Promise.resolve([])),
    addTask: mock(() => Promise.resolve({})),
    editTask: mock(() => Promise.resolve({})),
    versioned: { setStatus: mock(() => Promise.resolve({})), changeTags },
    moveLane: mock(() => Promise.resolve({})),
    delTask: mock(() => Promise.resolve(undefined)),
    postUpd: mock(() => Promise.resolve({})),
    addLane: mock(() => Promise.resolve({})),
    editLane: mock(() => Promise.resolve({})),
    delLane: mock(() => Promise.resolve(undefined)),
    setTags,
    addTag: mock(() => Promise.resolve({})),
    editTag: mock(() => Promise.resolve({})),
    delTag,
  },
}));

import { render, fireEvent } from "@testing-library/preact";
import { TagsHeaderChip } from "../../../../src/ui/components/chips/TagsHeaderChip.tsx";
import { tags, tagsPopover, filters, workspaceQuery } from "../../../../src/ui/state/signals.ts";
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
  memory_excluded: false,
};

describe("TagsHeaderChip", () => {
  beforeEach(() => {
    tagsPopover.value = false;
    tags.value = [];
    removalCalls.length = 0;
    changeTags.mockClear();
    setTags.mockClear();
    delTag.mockClear();
    filters.value = { status: null, lane: null, tag: [] };
    workspaceQuery.value = "";
  });
  afterEach(() => {
    tagsPopover.value = false;
    tags.value = [];
  });

  test("renders actual tag names as pills — no count proxy", () => {
    const { container } = render(<TagsHeaderChip task={fx} />);
    const pills = Array.from(container.querySelectorAll(".tag-pill")).map(p => p.textContent);
    expect(pills).toEqual(["bug", "ui"]);
    expect(container.textContent).not.toContain("tags:");
  });

  test("caps visible pills at three with a labeled overflow trigger", () => {
    const many = { ...fx, tags: ["a", "b", "c", "d", "e"] };
    const { container } = render(<TagsHeaderChip task={many} />);
    expect(container.querySelectorAll(".tag-pill").length).toBe(3);
    const overflow = container.querySelector<HTMLButtonElement>("button.tags-overflow");
    if (!overflow) throw new Error("expected overflow trigger");
    expect(overflow.textContent).toContain("2 more");
    fireEvent.click(overflow);
    expect(tagsPopover.value).toBe(true); // overflow opens the picker (full list)
  });

  test("zero tags → 'Add tags' affordance opens the picker", () => {
    const { container } = render(<TagsHeaderChip task={{ ...fx, tags: [] }} />);
    const add = container.querySelector<HTMLButtonElement>("button[aria-label='Add tags']");
    if (!add) throw new Error("expected Add-tags affordance");
    expect(add.textContent?.trim()).toBe("");
    expect(add.querySelector("svg")).not.toBeNull();
    fireEvent.click(add);
    expect(tagsPopover.value).toBe(true);
  });

  test("picker mount gate: TagPicker appears only while the popover is open", () => {
    const { container, rerender } = render(<TagsHeaderChip task={fx} />);
    expect(container.querySelector(".tag-picker")).toBeNull();
    // The same plus-only Add tags control is present with attached tags.
    const add = container.querySelector<HTMLButtonElement>("button[aria-label='Add tags']");
    if (!add) throw new Error("expected Add-tags affordance");
    expect(container.textContent).not.toContain("Edit tags");
    fireEvent.click(add);
    rerender(<TagsHeaderChip task={fx} />);
    expect(container.querySelector(".tag-picker")).not.toBeNull();
  });

  test("each visible pill removes only its task association without opening the picker or changing filters", async () => {
    filters.value = { status: "review", lane: "todo", tag: ["bug"] };
    workspaceQuery.value = "needle";
    const view = render(<TagsHeaderChip task={fx} />);
    const remove = view.getByRole("button", { name: "Remove tag bug", exact: true }) as HTMLButtonElement;
    fireEvent.click(remove);
    expect(changeTags).toHaveBeenCalledWith(9, { remove: ["bug"] });
    expect(removalCalls.length).toBe(1);
    expect(remove.disabled).toBe(true);
    expect(tagsPopover.value).toBe(false);
    expect(setTags).not.toHaveBeenCalled();
    expect(delTag).not.toHaveBeenCalled();
    expect(filters.value).toEqual({ status: "review", lane: "todo", tag: ["bug"] });
    expect(workspaceQuery.value).toBe("needle");
    removalCalls[0].resolve({ ...fx, tags: ["ui"] });
    await new Promise(resolve => setTimeout(resolve, 0));
    // Canonical task data (SSE) drives which pills render.
    view.rerender(<TagsHeaderChip task={{ ...fx, tags: ["ui"] }} />);
    expect(view.queryByRole("button", { name: "Remove tag bug", exact: true })).toBeNull();
    expect(view.getByRole("button", { name: "Remove tag ui", exact: true })).toBeTruthy();
  });

  test("clicking a tag pill appends it to the sidebar tag filter (idempotent) without mutating the task or opening the picker", () => {
    filters.value = { status: "open", lane: "todo", tag: ["existing"] };
    const view = render(<TagsHeaderChip task={fx} />);
    const filterBug = () => fireEvent.click(view.getByRole("button", { name: "Filter tasks by #bug", exact: true }));
    filterBug();
    expect(filters.value.tag).toEqual(["existing", "bug"]);
    // Idempotent: a second click never duplicates the entry.
    filterBug();
    expect(filters.value.tag).toEqual(["existing", "bug"]);
    // A different pill appends alongside the first.
    fireEvent.click(view.getByRole("button", { name: "Filter tasks by #ui", exact: true }));
    expect(filters.value.tag).toEqual(["existing", "bug", "ui"]);
    // status/lane preserved; no task-tag mutation; picker stays closed.
    expect(filters.value.status).toBe("open");
    expect(filters.value.lane).toBe("todo");
    expect(changeTags).not.toHaveBeenCalled();
    expect(setTags).not.toHaveBeenCalled();
    expect(tagsPopover.value).toBe(false);
  });

  test("repeated removal of a pending tag is guarded; different removals send independent deltas", () => {
    const view = render(<TagsHeaderChip task={fx} />);
    const bug = view.getByRole("button", { name: "Remove tag bug", exact: true });
    fireEvent.click(bug);
    fireEvent.click(bug);
    fireEvent.click(view.getByRole("button", { name: "Remove tag ui", exact: true }));
    expect(removalCalls.map(call => [call.id, call.name])).toEqual([
      [9, "bug"],
      [9, "ui"],
    ]);
    expect(setTags).not.toHaveBeenCalled();
  });

  test("failed removal leaves the pill in place and exposes an error", async () => {
    const view = render(<TagsHeaderChip task={fx} />);
    fireEvent.click(view.getByRole("button", { name: "Remove tag bug", exact: true }));
    removalCalls[0].reject(new Error("offline"));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(view.getByRole("alert").textContent).toContain("bug");
    expect((view.getByRole("button", { name: "Remove tag bug", exact: true }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  test("a delayed failure after task navigation cannot affect the new task's header", async () => {
    const first = render(<TagsHeaderChip task={fx} />);
    fireEvent.click(first.getByRole("button", { name: "Remove tag bug", exact: true }));
    first.unmount();
    const second = render(<TagsHeaderChip task={{ ...fx, id: 10, tags: ["other"] }} />);
    removalCalls[0].reject(new Error("old task failure"));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(second.queryByRole("alert")).toBeNull();
    expect(second.getByRole("button", { name: "Remove tag other", exact: true })).toBeTruthy();
    expect(removalCalls[0].id).toBe(9);
  });
});
