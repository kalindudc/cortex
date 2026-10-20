// ActivityPane — the Activity view of the document workspace: a
// newest-first thread of keyed expandable cards (summary, author, time,
// severity, rendered body + Markdown-source disclosure) with the
// '+ Post update' composer disclosure AFTER the thread in normal flow. The
// pane owns no tab strip — TaskDocument's tablist drives the `tab` signal.

import { describe, test, expect, mock, beforeEach } from "bun:test";

mock.module("../../../../src/ui/api/client.ts", () => ({
  api: {
    tasks: mock(() => Promise.resolve([])),
    lanes: mock(() => Promise.resolve([])),
    tags: mock(() => Promise.resolve([])),
    updates: mock(() => Promise.resolve([])),
    related: mock(() => Promise.resolve({ referencedBy: [], references: [], shared: [] })),
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
import { ActivityPane } from "../../../../src/ui/components/active/ActivityPane.tsx";
import { tasks, selectedId, tab, updates, modal, postUpdateOpen } from "../../../../src/ui/state/signals.ts";
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

describe("ActivityPane", () => {
  beforeEach(() => {
    tasks.value = [task({ id: 1 })];
    selectedId.value = 1;
    tab.value = "updates";
    updates.value = {};
    modal.value = null;
    postUpdateOpen.value = false;
  });

  test("no independent tab strip — TaskDocument's tablist owns tab switching", () => {
    const { container } = render(<ActivityPane />);
    expect(container.querySelector(".tabs")).toBeNull();
  });

  test("renders newest-first expandable cards with author/time/severity", () => {
    updates.value = {
      1: [
        update({ id: 1, summary: "first", created: 100 }),
        update({ id: 2, summary: "second", created: 200, severity: "blocked", author: "bob" }),
      ],
    };
    const { container } = render(<ActivityPane />);
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
    const { container } = render(<ActivityPane />);
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
    const { container } = render(<ActivityPane />);
    fireEvent.click(container.querySelector(".update-card-toggle") as HTMLButtonElement);
    await tick();
    expect(container.querySelector(".update-card .markdown-view")).toBeNull();
    expect(container.querySelector(".update-card")?.textContent).toContain("No body");
  });

  test("expanded state survives update-list churn (agent updates arriving)", async () => {
    updates.value = { 1: [update({ id: 7, summary: "keep me open", body: "content" })] };
    const { container } = render(<ActivityPane />);
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
    const { container } = render(<ActivityPane />);
    const ref = container.querySelector(".update-card .cortex-ref");
    expect(ref).not.toBeNull();
  });

  test("the '+ Post update' disclosure sits AFTER the thread in normal flow", () => {
    updates.value = { 1: [update({ id: 1 })] };
    const { container } = render(<ActivityPane />);
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
    const { container } = render(<ActivityPane />);
    const toggle = container.querySelector<HTMLButtonElement>(".activity-compose .post-update-toggle");
    if (!toggle) throw new Error("expected + Post update toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(postUpdateOpen.value).toBe(true);
    expect(container.querySelector("form.compose")).not.toBeNull();
  });
});
