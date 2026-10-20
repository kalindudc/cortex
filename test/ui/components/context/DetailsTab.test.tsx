// DetailsTab — the side panel's Details tab: the active task's properties,
// its authors with Resume on resumable ones, and the three related-task
// groups with their loading, retry and confirmed-empty states.

import { describe, test, expect, mock, beforeEach } from "bun:test";

const relatedMock = mock(() => Promise.resolve({ referencedBy: [], references: [], shared: [] }));
mock.module("../../../../src/ui/api/client.ts", () => ({
  api: {
    tasks: mock(() => Promise.resolve([])),
    lanes: mock(() => Promise.resolve([])),
    tags: mock(() => Promise.resolve([])),
    updates: mock(() => Promise.resolve([])),
    related: relatedMock,
    notifications: mock(() => Promise.resolve([])),
  },
}));

import { render, fireEvent } from "@testing-library/preact";
import { STATUS_LABEL } from "../../../../src/lib/constants.ts";
import { DetailsTab } from "../../../../src/ui/components/context/DetailsTab.tsx";
import {
  tasks,
  lanes,
  selectedId,
  updates,
  relatedTasks,
  relatedLoading,
  relatedError,
} from "../../../../src/ui/state/signals.ts";
import type { Task, Update } from "../../../../src/ui/api/types.ts";

function task(over: Partial<Task> = {}): Task {
  return {
    id: 1,
    lane: "now",
    title: "t",
    body: "",
    status: "open",
    priority: 3,
    created: 0,
    updated: 0,
    tags: [],
    memory_excluded: false,
    ...over,
  };
}

function update(over: Partial<Update> = {}): Update {
  return {
    id: 1,
    task_id: 1,
    author: "alice",
    summary: "did stuff",
    body: null,
    severity: "progress",
    created: 1700000000,
    ...over,
  };
}

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0));

function props(container: ParentNode): Record<string, string> {
  const out: Record<string, string> = {};
  for (const dt of Array.from(container.querySelectorAll(".ctx-props dt"))) {
    out[dt.textContent ?? ""] = dt.nextElementSibling?.textContent ?? "";
  }
  return out;
}

describe("DetailsTab", () => {
  beforeEach(() => {
    tasks.value = [task({ id: 1 })];
    lanes.value = [{ name: "now", color: "#ff8800", sort: 0 }];
    selectedId.value = 1;
    updates.value = {};
    relatedTasks.value = { referencedBy: [], references: [], shared: [] };
    relatedLoading.value = null;
    relatedError.value = null;
    relatedMock.mockClear();
  });

  test("no active task shows an empty state", () => {
    tasks.value = [];
    selectedId.value = null;
    const { container } = render(<DetailsTab />);
    expect(container.textContent).toContain("Select a task to see its details.");
    expect(container.querySelector(".ctx-props")).toBeNull();
  });

  test("properties list status, lane, priority, memory, created and updated", () => {
    tasks.value = [task({ id: 1, status: "review", priority: 1, created: Date.UTC(2026, 9, 20, 9, 12, 4) })];
    const { container } = render(<DetailsTab />);
    const p = props(container);
    expect(Object.keys(p)).toEqual(["Status", "Lane", "Priority", "Memory", "Created", "Updated"]);
    expect(p.Status).toBe(STATUS_LABEL.review);
    expect(container.querySelector(".ctx-props .dot-status-review")).not.toBeNull();
    expect(p.Lane).toBe("now");
    expect(container.querySelector<HTMLElement>(".ctx-props .lane-color")?.getAttribute("style")).toContain("#ff8800");
    expect(p.Priority).toBe("P1");
    expect(container.querySelector(".ctx-props .priority-chip.high")).not.toBeNull();
    expect(p.Memory).toBe("Agents can recall it");
    expect(p.Created).toBe(new Date(Date.UTC(2026, 9, 20, 9, 12, 4)).toLocaleString());
    expect(p.Updated).toMatch(/ago$/);
    // Read-only: editing stays in the document header's chips.
    expect(container.querySelector(".ctx-props button, .ctx-props input")).toBeNull();
  });

  test("a task without priority reads None, and one kept out of memory says so", () => {
    tasks.value = [task({ id: 1, priority: null, memory_excluded: true })];
    const { container } = render(<DetailsTab />);
    const p = props(container);
    expect(p.Priority).toBe("None");
    expect(container.querySelector(".ctx-props .priority-chip")).toBeNull();
    expect(p.Memory).toBe("Kept out of agent memory");
  });

  test("authors render the scoped per-task aggregation", () => {
    updates.value = {
      1: [
        update({ id: 1, author: "alice", created: 100 }),
        update({ id: 2, author: "alice", created: 300 }),
        update({ id: 3, author: "bob", created: 200 }),
      ],
    };
    const { container } = render(<DetailsTab />);
    const rows = Array.from(container.querySelectorAll(".author-list .author-row"));
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain("alice"); // most recent first
    expect(rows[0].textContent).toContain("2 updates"); // post count
    expect(rows[1].textContent).toContain("1 update");
  });

  test("only a resumable author gets a named Resume button, above an empty outcome line", () => {
    updates.value = {
      1: [update({ id: 1, author: "bb-thr_abc123", created: 200 }), update({ id: 2, author: "alice", created: 100 })],
    };
    const { container, getByRole, queryByRole } = render(<DetailsTab />);
    const resume = getByRole("button", { name: "Resume bb-thr_abc123" });
    expect(resume.textContent).toBe("Resume");
    expect(queryByRole("button", { name: "Resume alice" })).toBeNull();
    expect(container.querySelector(".resume-outcome[role='status']")?.textContent).toBe("");
  });

  test("related distinguishes loading from confirmed empty", async () => {
    relatedTasks.value = null;
    relatedLoading.value = { taskId: 1, generation: 4 };
    const { container, rerender } = render(<DetailsTab />);
    expect(container.textContent).toContain("Loading…");

    relatedLoading.value = null;
    relatedTasks.value = { referencedBy: [], references: [], shared: [] };
    rerender(<DetailsTab />);
    await tick();
    const text = container.textContent ?? "";
    expect(text).toContain("Referenced by");
    expect(text).toContain("References");
    expect(text).toContain("Shared tags");
    expect(text).not.toContain("Loading…");
  });

  test("related error is task-keyed and exposes an explicit retry", async () => {
    relatedTasks.value = null;
    relatedError.value = { taskId: 1, message: "backend unavailable" };
    const { container } = render(<DetailsTab />);
    expect(container.querySelector("[role='alert']")?.textContent).toContain("backend unavailable");
    fireEvent.click(container.querySelector(".related-error button") as HTMLButtonElement);
    await tick();
    expect(relatedMock).toHaveBeenCalledWith(1);
  });

  test("a stale keyed error from another task is never shown", () => {
    relatedTasks.value = null;
    relatedError.value = { taskId: 99, message: "wrong task" };
    relatedLoading.value = { taskId: 1, generation: 8 };
    const { container } = render(<DetailsTab />);
    expect(container.textContent).not.toContain("wrong task");
    expect(container.textContent).toContain("Loading…");
  });
});
