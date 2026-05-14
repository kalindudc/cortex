// InboxPane — two-tab pane (Updates / Authors). Verifies tab switching and
// that opening the Authors tab triggers a lazy /api/authors fetch.

import { describe, test, expect, mock, beforeEach } from "bun:test";

// fetchAuthors uses window.fetch directly (not the api client), so we mock
// the refresh module to swap fetchAuthors out for a spy. Mock MUST be set up
// before the InboxPane import so the SUT sees the stub at module-eval time.
const fetchAuthorsSpy = mock(() => Promise.resolve());
mock.module("../../../../src/ui/state/refresh.ts", () => ({
  fetchAuthors: fetchAuthorsSpy,
  // refresh() is unused by InboxPane; expose a no-op so any other consumer
  // pulled in via the barrel doesn't crash.
  refresh: mock(() => Promise.resolve()),
}));

import { render, fireEvent } from "@testing-library/preact";
import { InboxPane } from "../../../../src/ui/components/inbox/InboxPane.tsx";
import { tasks, selectedId, tab, updates, authors } from "../../../../src/ui/state/signals.ts";
import type { Task, Update, Author } from "../../../../src/ui/api/types.ts";

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
    authors.value = [];
    fetchAuthorsSpy.mockClear();
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

  test("opening the Authors tab triggers fetchAuthors()", () => {
    const { container } = render(<InboxPane />);
    const authorsBtn = container.querySelectorAll(".tabs button")[1];
    fireEvent.click(authorsBtn);
    expect(fetchAuthorsSpy).toHaveBeenCalledTimes(1);
  });

  test("Authors tab renders the empty state when no authors are loaded", () => {
    tab.value = "authors";
    const { container } = render(<InboxPane />);
    expect(container.querySelector(".empty")).toBeTruthy();
    expect(container.querySelector(".empty-title")?.textContent).toContain("No author activity");
  });

  test("Authors tab renders one row per author", () => {
    tab.value = "authors";
    const rows: Author[] = [
      { author: "alice", last_seen: 1700000000, posts: 3 },
      { author: "bob", last_seen: 1700000010, posts: 1 },
    ];
    authors.value = rows;
    const { container } = render(<InboxPane />);
    const trs = container.querySelectorAll(".authors-table tbody tr");
    expect(trs.length).toBe(2);
    expect(trs[0].textContent).toContain("alice");
    expect(trs[1].textContent).toContain("bob");
  });
});
