// ActiveTaskPane — after task 330 it is the workspace shell for the active
// task: empty state when nothing is selected, an outside-filter notice with
// a Clear-filters action (W4), and the TaskDocument keyed by task id.

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, render } from "@testing-library/preact";

mock.module("../../../../src/ui/api/client.ts", () => ({
  api: {
    tasks: mock(() => Promise.resolve([])),
    lanes: mock(() => Promise.resolve([])),
    tags: mock(() => Promise.resolve([])),
    updates: mock(() => Promise.resolve([])),
    related: mock(() => Promise.resolve({ referencedBy: [], references: [], shared: [] })),
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

// Passthrough sanitizer (broken under happy-dom; e2e certifies scrubbing).
mock.module("dompurify", () => ({
  default: {
    isSupported: true,
    sanitize: (html: string) => html,
    addHook: () => {},
    removeHook: () => {},
  },
}));

import { ActiveTaskPane } from "../../../../src/ui/components/active/ActiveTaskPane.tsx";
import {
  lanes,
  modal,
  selectedId,
  filters,
  statusPopover,
  tags,
  tasks,
  workspaceQuery,
  tab,
  readerMode,
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

describe("ActiveTaskPane", () => {
  beforeEach(() => {
    tasks.value = [];
    lanes.value = [];
    tags.value = [];
    selectedId.value = null;
    filters.value = { status: null, lane: null, tag: [] };
    workspaceQuery.value = "";
    tab.value = "document";
    readerMode.value = "read";
    statusPopover.value = false;
    modal.value = null;
  });

  test("renders the empty 'All caught up' placeholder when no active task", () => {
    const { container } = render(<ActiveTaskPane />);
    expect(container.querySelector(".pane.pane-active")).toBeTruthy();
    expect(container.querySelector(".empty")).toBeTruthy();
    expect(container.textContent).toContain("All caught up");
  });

  test("renders the TaskDocument (title display + id) for the active task", () => {
    tasks.value = [makeTask({ id: 42, title: "Wire up routing" })];
    selectedId.value = 42;
    const { container } = render(<ActiveTaskPane />);
    expect(container.querySelector(".empty")).toBeFalsy();
    expect(container.querySelector(".task-document")).toBeTruthy();
    expect(container.querySelector(".task-title-display")?.textContent).toBe("Wire up routing");
    expect(container.querySelector(".task-id")?.textContent).toBe("[42]");
  });

  test("status pill click toggles the StatusPopover open", () => {
    tasks.value = [makeTask({ id: 1, status: "open" })];
    selectedId.value = 1;
    const { container } = render(<ActiveTaskPane />);
    expect(statusPopover.value).toBe(false);
    const pill = container.querySelector(".status-pill") as HTMLButtonElement;
    expect(pill).toBeTruthy();
    fireEvent.click(pill);
    expect(statusPopover.value).toBe(true);
    expect(container.querySelector(".popover")).toBeTruthy();
  });

  test("explains an active task outside the current filters and offers Clear filters (W4)", () => {
    tasks.value = [makeTask({ id: 7, lane: "a" }), makeTask({ id: 8, lane: "b", title: "other" })];
    selectedId.value = 7;
    filters.value = { status: null, lane: "b", tag: [] };
    const { container } = render(<ActiveTaskPane />);
    const notice = container.querySelector(".outside-filter-notice");
    if (!notice) throw new Error("expected outside-filter notice");
    expect(notice.textContent).toContain("outside the current filters");
    const clear = notice.querySelector("button");
    if (!clear) throw new Error("expected Clear filters action");
    fireEvent.click(clear);
    expect(filters.value).toEqual({ status: null, lane: null, tag: [] });
    // The task itself never changed.
    expect(selectedId.value).toBe(7);
  });

  test("no notice when the active task is inside the visible rows", () => {
    tasks.value = [makeTask({ id: 7 })];
    selectedId.value = 7;
    const { container } = render(<ActiveTaskPane />);
    expect(container.querySelector(".outside-filter-notice")).toBeNull();
  });
});
