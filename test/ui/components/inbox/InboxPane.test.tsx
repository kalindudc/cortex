// InboxPane — task-context content for TaskDocument:
// Activity is a newest-first thread of keyed expandable cards (summary,
// author, time, severity, rendered body + Markdown-source disclosure) with
// the '+ Post update' composer disclosure AFTER the thread in normal flow.
// Authors and Related keep their existing shapes. The pane no longer owns
// an independent tab strip — TaskDocument's tablist drives the `tab`
// signal.

import { describe, test, expect, mock, beforeEach } from "bun:test";

const relatedMock = mock(() => Promise.resolve({ referencedBy: [], references: [], shared: [] }));
mock.module("../../../../src/ui/api/client.ts", () => ({
  api: {
    tasks: mock(() => Promise.resolve([])),
    lanes: mock(() => Promise.resolve([])),
    tags: mock(() => Promise.resolve([])),
    updates: mock(() => Promise.resolve([])),
    related: relatedMock,
    addTask: mock(() => Promise.resolve({})),
    editTask: mock(() => Promise.resolve({})),
    versioned: { setStatus: mock(() => Promise.resolve({})), changeTags: mock(() => Promise.resolve({})) },
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

mock.module("dompurify", () => ({
  default: {
    isSupported: true,
    sanitize: (html: string) => html,
    addHook: () => {},
    removeHook: () => {},
  },
}));

import { render, fireEvent } from "@testing-library/preact";
import { InboxPane } from "../../../../src/ui/components/inbox/InboxPane.tsx";
import {
  tasks,
  selectedId,
  tab,
  updates,
  modal,
  postUpdateOpen,
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

describe("InboxPane (Activity)", () => {
  beforeEach(() => {
    tasks.value = [task({ id: 1 })];
    selectedId.value = 1;
    tab.value = "updates";
    updates.value = {};
    modal.value = null;
    postUpdateOpen.value = false;
    relatedTasks.value = { referencedBy: [], references: [], shared: [] };
    relatedLoading.value = null;
    relatedError.value = null;
    relatedMock.mockClear();
  });

  test("no independent tab strip — TaskDocument's tablist owns tab switching", () => {
    const { container } = render(<InboxPane />);
    expect(container.querySelector(".tabs")).toBeNull();
  });

  test("renders newest-first expandable cards with author/time/severity", () => {
    updates.value = {
      1: [
        update({ id: 1, summary: "first", created: 100 }),
        update({ id: 2, summary: "second", created: 200, severity: "blocked", author: "bob" }),
      ],
    };
    const { container } = render(<InboxPane />);
    const cards = Array.from(container.querySelectorAll(".update-card"));
    expect(cards.length).toBe(2);
    // Newest first (existing inboxList ordering).
    expect(cards[0].textContent).toContain("second");
    expect(cards[1].textContent).toContain("first");
    expect(cards[0].textContent).toContain("bob");
    expect(cards[0].textContent).toContain("blocked");
    expect(cards[0].querySelector(".dot-status-blocked")).not.toBeNull();
  });

  test("expanding a card renders the body through MarkdownView plus a source disclosure", async () => {
    updates.value = { 1: [update({ id: 5, summary: "with body", body: "## Detail\n\ntext" })] };
    const { container } = render(<InboxPane />);
    const toggle = container.querySelector<HTMLButtonElement>(".update-card .update-card-toggle");
    if (!toggle) throw new Error("expected card toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    await tick();
    const body = container.querySelector(".update-card .markdown-view");
    if (!body) throw new Error("expected rendered body");
    expect(body.querySelector("h2")?.textContent).toBe("Detail");
    // Markdown-source disclosure with the raw text.
    const source = container.querySelector(".update-card details.update-source");
    if (!source) throw new Error("expected source disclosure");
    expect(source.querySelector("pre")?.textContent).toContain("## Detail");
    // No modal was dispatched — in-place reading replaced row-to-popup.
    expect(modal.value).toBeNull();
  });

  test("summary-only updates expand without inventing a body", async () => {
    updates.value = { 1: [update({ id: 6, summary: "just a summary", body: null })] };
    const { container } = render(<InboxPane />);
    fireEvent.click(container.querySelector(".update-card-toggle") as HTMLButtonElement);
    await tick();
    expect(container.querySelector(".update-card .markdown-view")).toBeNull();
    expect(container.querySelector(".update-card")?.textContent).toContain("No body");
  });

  test("expanded state survives update-list churn (agent updates arriving)", async () => {
    updates.value = { 1: [update({ id: 7, summary: "keep me open", body: "content" })] };
    const { container } = render(<InboxPane />);
    fireEvent.click(container.querySelector(".update-card-toggle") as HTMLButtonElement);
    await tick();
    expect(container.querySelector(".update-card .markdown-view")).not.toBeNull();
    // A new agent update arrives via SSE refresh (list replaced).
    updates.value = {
      1: [update({ id: 7, summary: "keep me open", body: "content" }), update({ id: 8, summary: "new arrival" })],
    };
    await tick();
    const cards = Array.from(container.querySelectorAll(".update-card"));
    expect(cards.length).toBe(2);
    // The previously-expanded card is still expanded.
    const openCard = cards.find(c => (c.textContent ?? "").includes("keep me open"));
    expect(openCard?.querySelector(".markdown-view")).not.toBeNull();
  });

  test("summary refs stay clickable (RefText decoration)", () => {
    tasks.value = [task({ id: 1 }), task({ id: 33, title: "target" })];
    updates.value = { 1: [update({ id: 9, summary: "see @33 for detail" })] };
    const { container } = render(<InboxPane />);
    const ref = container.querySelector(".update-card .cortex-ref");
    expect(ref).not.toBeNull();
  });

  test("the '+ Post update' disclosure sits AFTER the thread in normal flow", () => {
    updates.value = { 1: [update({ id: 1 })] };
    const { container } = render(<InboxPane />);
    const compose = container.querySelector(".activity-compose");
    if (!compose) throw new Error("expected composer disclosure");
    const thread = container.querySelector(".activity-thread");
    if (!thread) throw new Error("expected activity thread");
    // AFTER: the thread precedes the composer in document order.
    expect(thread.compareDocumentPosition(compose) & Node.DOCUMENT_POSITION_FOLLOWING).toBeGreaterThan(0);
    // No fixed bottom dock class anywhere.
    expect(container.querySelector(".compose-dock")).toBeNull();
    // Collapsed by default (postUpdateOpen=false): no form mounted.
    expect(container.querySelector("form.compose")).toBeNull();
  });

  test("toggling the disclosure mounts the composer and honors the global preference", () => {
    const { container } = render(<InboxPane />);
    const toggle = container.querySelector<HTMLButtonElement>(".activity-compose .post-update-toggle");
    if (!toggle) throw new Error("expected + Post update toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(postUpdateOpen.value).toBe(true);
    expect(container.querySelector("form.compose")).not.toBeNull();
  });

  test("authors tab renders the scoped per-task aggregation", () => {
    tab.value = "authors";
    updates.value = {
      1: [
        update({ id: 1, author: "alice", created: 100 }),
        update({ id: 2, author: "alice", created: 300 }),
        update({ id: 3, author: "bob", created: 200 }),
      ],
    };
    const { container } = render(<InboxPane />);
    const rows = Array.from(container.querySelectorAll(".authors-table tbody tr"));
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain("alice"); // most recent first
    expect(rows[0].textContent).toContain("2"); // post count
  });

  test("related tab distinguishes loading from confirmed empty", async () => {
    tab.value = "related";
    relatedTasks.value = null;
    relatedLoading.value = { taskId: 1, generation: 4 };
    const { container, rerender } = render(<InboxPane />);
    expect(container.textContent).toContain("Loading…");

    relatedLoading.value = null;
    relatedTasks.value = { referencedBy: [], references: [], shared: [] };
    rerender(<InboxPane />);
    await tick();
    const text = container.textContent ?? "";
    expect(text).toContain("Referenced by");
    expect(text).toContain("References");
    expect(text).toContain("Shared tags");
    expect(text).not.toContain("Loading…");
  });

  test("related error is task-keyed and exposes an explicit retry", async () => {
    tab.value = "related";
    relatedTasks.value = null;
    relatedError.value = { taskId: 1, message: "backend unavailable" };
    const { container } = render(<InboxPane />);
    expect(container.querySelector("[role='alert']")?.textContent).toContain("backend unavailable");
    fireEvent.click(container.querySelector(".related-error button") as HTMLButtonElement);
    await tick();
    expect(relatedMock).toHaveBeenCalledWith(1);
  });

  test("a stale keyed error from another task is never shown", () => {
    tab.value = "related";
    relatedTasks.value = null;
    relatedError.value = { taskId: 99, message: "wrong task" };
    relatedLoading.value = { taskId: 1, generation: 8 };
    const { container } = render(<InboxPane />);
    expect(container.textContent).not.toContain("wrong task");
    expect(container.textContent).toContain("Loading…");
  });
});
