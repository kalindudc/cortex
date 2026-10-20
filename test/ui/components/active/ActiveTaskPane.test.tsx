// ActiveTaskPane — it is the workspace shell for the active
// task: empty state when nothing is selected, an outside-filter notice with
// a Clear-filters action, and the TaskDocument keyed by task id.

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
    taskState: mock((id: number) =>
      Promise.resolve({
        task: makeTask({ id, body: "base" }),
        updates: [],
        versions: { title: `title-${id}`, body: `body-${id}` },
        cursor: "e1:1",
      }),
    ),
    versioned: {
      setStatus: mock(() => Promise.resolve({})),
      editTask: mock(() => Promise.reject(new Error("offline"))),
    },
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
import type { DraftExport } from "../../../../src/desktop/ipc.ts";
import type { Task } from "../../../../src/ui/api/types.ts";
import {
  discardOrphan,
  orphanedDrafts,
  pruneTaskDrafts,
  useTaskDraft,
  type TaskDraft,
} from "../../../../src/ui/lib/useTaskDraft.ts";
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

const makeTask = (over: Record<string, unknown> = {}): Task => ({
  id: 7,
  lane: "inbox",
  title: "Wire up routing",
  body: "A description",
  status: "open" as const,
  priority: 50,
  created: 1700000000,
  updated: 1700000000,
  tags: [],
  memory_excluded: false,
  ...over,
});

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0));

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
    expect(container.querySelector(".task-id")?.textContent).toBe("@42");
  });

  test("hidden hides the pane in both states and keeps the document mounted", () => {
    const empty = render(<ActiveTaskPane hidden={true} />);
    expect((empty.container.querySelector("section.pane-active") as HTMLElement).hidden).toBe(true);
    empty.unmount();
    tasks.value = [makeTask({ id: 42 })];
    selectedId.value = 42;
    const { container } = render(<ActiveTaskPane hidden={true} />);
    expect((container.querySelector("section.pane-active") as HTMLElement).hidden).toBe(true);
    expect(container.querySelector(".task-document")).toBeTruthy();
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

  test("explains an active task outside the current filters and offers Clear filters", () => {
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

  test("unsaved text of a deleted task is listed in every state; Export and Discard remove its row", async () => {
    // Start from empty draft memory: other test/ui files run in this process too.
    pruneTaskDrafts([]);
    for (const o of orphanedDrafts.value) discardOrphan(o.taskId, o.field);
    const exports: DraftExport[] = [];
    const w = window as unknown as { cortex?: unknown };
    const previous = w.cortex;
    w.cortex = {
      drafts: {
        export: async (d: DraftExport) => {
          exports.push(d);
          return { saved: true };
        },
      },
    };
    try {
      let draft: TaskDraft | null = null;
      const Harness = ({ task }: { task: Task }) => {
        draft = useTaskDraft(task);
        return null;
      };
      const harness = render(<Harness task={makeTask({ id: 41, body: "base" })} />);
      await tick();
      await tick();
      const d = draft as TaskDraft | null;
      if (!d?.ready) throw new Error("expected a ready draft");
      d.set("title", "rescued title");
      d.set("body", "rescued text");
      await d.flush(); // the daemon is unreachable: both saves fail
      harness.unmount();
      pruneTaskDrafts([7]); // task 41 was deleted

      const empty = render(<ActiveTaskPane />);
      const region = empty.getByRole("region", { name: "Unsaved text from deleted tasks" });
      expect(region.querySelectorAll("li").length).toBe(2);
      expect(empty.container.querySelector(".empty")).toBeTruthy();
      empty.unmount();

      tasks.value = [makeTask({ id: 7 })];
      selectedId.value = 7;
      const view = render(<ActiveTaskPane />);
      const rows = () => [...view.container.querySelectorAll<HTMLElement>(".orphan-draft")];
      expect(rows().map(r => r.textContent)).toEqual([
        expect.stringContaining("rescued title"),
        expect.stringContaining("rescued text"),
      ]);
      const body = rows()[1];
      fireEvent.click(body.querySelector<HTMLButtonElement>("button:nth-of-type(1)") as HTMLButtonElement);
      await tick();
      expect(exports).toEqual([{ taskId: 41, field: "body", text: "rescued text" }]);
      expect(rows().length).toBe(1);
      const discard = [...rows()[0].querySelectorAll("button")].find(b => b.textContent === "Discard");
      fireEvent.click(discard as HTMLButtonElement);
      expect(view.container.querySelector(".orphan-drafts")).toBeNull();
    } finally {
      w.cortex = previous;
    }
  });
});
