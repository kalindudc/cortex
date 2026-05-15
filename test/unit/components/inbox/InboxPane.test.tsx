// InboxPane — two-tab pane (Updates / Authors). Authors tab now derives
// from `taskAuthors` (computed from the active task's loaded updates) so
// there's no lazy /api/authors fetch to mock anymore.

import { describe, test, expect, beforeEach } from "bun:test";
import { render, fireEvent } from "@testing-library/preact";
import { InboxPane } from "../../../../src/ui/components/inbox/InboxPane.tsx";
import { tasks, selectedId, tab, updates, modal } from "../../../../src/ui/state/signals.ts";
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

describe("InboxPane", () => {
  beforeEach(() => {
    tasks.value = [task({ id: 1 })];
    selectedId.value = 1;
    tab.value = "updates";
    updates.value = {};
  });

  test("renders the updates list for the active task", () => {
    updates.value = { 1: [update({ id: 1, summary: "first" }), update({ id: 2, summary: "second" })] };
    const { container } = render(<InboxPane />);
    const rows = container.querySelectorAll(".inbox-row");
    expect(rows.length).toBe(2);
  });

  test("shows the empty state when the active task has no updates", () => {
    const { container } = render(<InboxPane />);
    expect(container.querySelector(".empty")).toBeTruthy();
    expect(container.querySelector(".empty-title")?.textContent).toContain("No updates");
  });

  test("clicking the Authors tab switches the tab signal", () => {
    const { container } = render(<InboxPane />);
    const buttons = container.querySelectorAll(".tabs button");
    // [0] = Updates, [1] = Authors
    fireEvent.click(buttons[1]);
    expect(tab.value).toBe("authors");
  });

  test("Authors tab shows 'No authors on this task yet.' when the active task has no updates", () => {
    tab.value = "authors";
    const { container } = render(<InboxPane />);
    expect(container.querySelector(".empty")).toBeTruthy();
    expect(container.querySelector(".empty-title")?.textContent).toBe("No authors on this task yet.");
  });

  test("clicking an update row opens the update-detail modal with that row's payload", () => {
    updates.value = { 1: [update({ id: 42, summary: "longform", body: "# hi" })] };
    modal.value = null;
    const { container } = render(<InboxPane />);
    const row = container.querySelector(".inbox-row");
    expect(row).toBeTruthy();
    fireEvent.click(row as Element);
    const m = modal.value as { kind: string; update: Update } | null;
    expect(m?.kind).toBe("update-detail");
    expect(m?.update.id).toBe(42);
  });

  test("Authors tab renders one row per distinct author derived from updates", () => {
    updates.value = {
      1: [
        update({ id: 1, author: "alice", created: 1700 }),
        update({ id: 2, author: "alice", created: 1800 }),
        update({ id: 3, author: "bob", created: 1750 }),
      ],
    };
    tab.value = "authors";
    const { container } = render(<InboxPane />);
    const trs = container.querySelectorAll(".authors-table tbody tr");
    expect(trs.length).toBe(2);
    // Sorted by last_seen DESC: alice(1800) before bob(1750).
    expect(trs[0].textContent).toContain("alice");
    const aliceCells = trs[0].querySelectorAll("td");
    expect(aliceCells[2].textContent).toBe("2");
    expect(trs[1].textContent).toContain("bob");
    const bobCells = trs[1].querySelectorAll("td");
    expect(bobCells[2].textContent).toBe("1");
  });
});
