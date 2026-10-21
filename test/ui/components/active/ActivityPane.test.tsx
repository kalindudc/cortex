// ActivityPane — the Activity view of the document workspace: a
// newest-first thread of keyed expandable cards (summary, author, time,
// severity, rendered body + Markdown-source disclosure) with the
// '+ Post update' composer disclosure AFTER the thread in normal flow. The
// pane owns no tab strip — TaskDocument's tablist drives the `tab` signal.
// On paper the cards are dated notes down the sheet; the last block reads
// the real stylesheet for their declared fonts, sizes, rules and columns.

import { describe, test, expect, mock, beforeEach, beforeAll, afterAll, afterEach } from "bun:test";

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
import { mountStyles, rootToken } from "../modals/styles.ts";

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

type Viewport = { setViewport(size: { width: number; height: number }): void };
const happyDOM = (globalThis as unknown as { happyDOM: Viewport }).happyDOM;
const WIDE = { width: 1280, height: 800 };
const NARROW = { width: 900, height: 800 };

const style = (el: Element | null): CSSStyleDeclaration => {
  if (!el) throw new Error("expected an element");
  return getComputedStyle(el);
};
/** The first family of a font-family list, without quotes. */
const family = (list: string): string => (list.split(",")[0] ?? "").replace(/["']/g, "").trim();
const SERIF = (): string => family(rootToken("--font-serif"));
const SANS = (): string => family(rootToken("--font-sans"));
const MONO = (): string => family(rootToken("--font-mono"));
/** The first track of a grid template: the margin column. */
const firstTrack = (template: string): string => template.trim().split(/\s+/)[0] ?? "";

describe("ActivityPane on paper", () => {
  let unmountStyles: () => void;
  beforeAll(() => {
    happyDOM.setViewport(WIDE);
    unmountStyles = mountStyles();
  });
  afterAll(() => unmountStyles());
  afterEach(() => happyDOM.setViewport(WIDE));
  beforeEach(() => {
    tasks.value = [task({ id: 1 })];
    selectedId.value = 1;
    tab.value = "updates";
    modal.value = null;
    postUpdateOpen.value = false;
    updates.value = {
      1: [
        update({ id: 11, summary: "older note", created: 100, body: "## Detail\n\ntext" }),
        update({ id: 12, summary: "newer note", created: 200, severity: "review", author: "pi-0192f3a4" }),
      ],
    };
  });

  test("updates are notes separated by thin rules, with no card border or background", () => {
    const { container } = render(<ActivityPane />);
    const notes = Array.from(container.querySelectorAll(".update-card"));
    expect(notes.length).toBe(2);
    for (const note of notes) {
      const s = style(note);
      expect([s.borderTopWidth, s.borderTopStyle, s.borderTopColor]).toEqual(["1px", "solid", rootToken("--rule")]);
      for (const side of [s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth]) {
        expect(["", "0px", "initial"]).toContain(side);
      }
      expect(["", "transparent", "initial"]).toContain(s.backgroundColor);
      expect(["", "none", "initial"]).toContain(s.boxShadow);
      const toggle = style(note.querySelector(".update-card-toggle"));
      expect(toggle.backgroundColor).toBe("transparent");
      expect([toggle.paddingTop, toggle.paddingBottom]).toEqual(["12px", "12px"]);
    }
  });

  test("the time sits in a 68px left margin column, and the summary is set in the serif", () => {
    const { container } = render(<ActivityPane />);
    const toggle = style(container.querySelector(".update-card-toggle"));
    expect(toggle.display).toBe("grid");
    expect(firstTrack(toggle.gridTemplateColumns)).toBe("68px");
    expect(toggle.gridTemplateAreas).toContain("time");
    // The byline and main spans step aside so the time is the grid's margin item.
    expect(style(container.querySelector(".update-card-main")).display).toBe("contents");
    expect(style(container.querySelector(".update-card-byline")).display).toBe("contents");
    expect(style(container.querySelector(".update-card-toggle > .avatar")).display).toBe("none");

    const time = style(container.querySelector(".update-card time"));
    expect(time.gridArea).toBe("time");
    expect([family(time.fontFamily), time.fontSize, time.textAlign, time.color]).toEqual([
      SANS(),
      "12px",
      "right",
      rootToken("--text-3"),
    ]);
    const author = style(container.querySelector(".update-card-author"));
    expect([family(author.fontFamily), author.fontSize, author.color]).toEqual([MONO(), "11px", rootToken("--text-3")]);
    const summary = style(container.querySelector(".update-card-summary"));
    expect([family(summary.fontFamily), summary.fontSize, summary.lineHeight, summary.color]).toEqual([
      SERIF(),
      "16.5px",
      "1.6",
      rootToken("--text"),
    ]);
    const kind = style(container.querySelector(".update-card-meta"));
    expect([family(kind.fontFamily), kind.fontSize, kind.color]).toEqual([SANS(), "11.5px", rootToken("--text-3")]);
  });

  test("the heading is the serif at 22px with its count; 'Newest first' is small sans", () => {
    const { container } = render(<ActivityPane />);
    const h2 = style(container.querySelector(".activity-title h2"));
    expect([family(h2.fontFamily), h2.fontSize, h2.fontWeight]).toEqual([SERIF(), "22px", "600"]);
    expect(container.querySelector(".activity-title .tab-count")?.textContent).toBe("2");
    const order = style(container.querySelector(".activity-order"));
    expect([family(order.fontFamily), order.fontSize]).toEqual([SANS(), "11.5px"]);
  });

  test("expanding shows the 15px serif body in the right column, collapsing hides it, aria-expanded follows", async () => {
    const { container } = render(<ActivityPane />);
    const note = Array.from(container.querySelectorAll(".update-card")).find(c =>
      (c.textContent ?? "").includes("older note"),
    );
    const toggle = note?.querySelector<HTMLButtonElement>(".update-card-toggle");
    if (!note || !toggle) throw new Error("expected the older note");
    fireEvent.click(toggle);
    await tick();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(note.classList.contains("expanded")).toBe(true);
    // The body follows the toggle, so the margin column stays empty beside it.
    const body = note.querySelector(".update-card-body");
    expect(body?.previousElementSibling).toBe(toggle);
    const markdown = style(note.querySelector(".update-card-body .markdown-view"));
    expect([family(markdown.fontFamily), markdown.fontSize]).toEqual([SERIF(), "15px"]);
    expect(note.querySelector(".update-card-body details.update-source")).not.toBeNull();

    fireEvent.click(toggle);
    await tick();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(note.classList.contains("expanded")).toBe(false);
    expect(note.querySelector(".update-card-body")).toBeNull();
  });

  test("the expanded body is indented to the right column", async () => {
    const { container } = render(<ActivityPane />);
    const note = Array.from(container.querySelectorAll(".update-card")).find(c =>
      (c.textContent ?? "").includes("older note"),
    );
    fireEvent.click(note?.querySelector(".update-card-toggle") as HTMLButtonElement);
    await tick();
    const indent = style(note?.querySelector(".update-card-body") ?? null).paddingLeft;
    // The margin column and its gap: happy-dom keeps the calc(), Chromium computes 86px.
    expect(["86px", "calc(68px + 18px)"]).toContain(indent);
  });

  test("the composer follows the notes under a dashed rule, in the notes' two columns", () => {
    postUpdateOpen.value = true;
    const { container } = render(<ActivityPane />);
    const compose = style(container.querySelector(".activity-compose"));
    expect([compose.borderTopWidth, compose.borderTopStyle, compose.borderTopColor]).toEqual([
      "1px",
      "dashed",
      rootToken("--rule-strong"),
    ]);
    expect(compose.display).toBe("grid");
    expect(firstTrack(compose.gridTemplateColumns)).toBe("68px");
    expect(style(container.querySelector(".activity-compose .post-update-toggle")).gridColumn).toBe("2");

    const form = style(container.querySelector("form.compose"));
    expect(form.display).toBe("grid");
    expect(firstTrack(form.gridTemplateColumns)).toBe("68px");
    expect(["", "0px", "initial"]).toContain(form.borderTopWidth);
    expect(["", "transparent", "initial"]).toContain(form.backgroundColor);
    expect(style(container.querySelector(".compose-label")).gridColumn).toBe("1");

    const textarea = style(container.querySelector("form.compose textarea"));
    expect(textarea.gridColumn).toBe("2");
    expect(textarea.backgroundColor).toBe("transparent");
    expect(family(textarea.fontFamily)).toBe(SERIF());
    const foot = style(container.querySelector(".compose-foot"));
    expect([foot.gridColumn, family(foot.fontFamily)]).toEqual(["2", SANS()]);
    expect(family(style(container.querySelector(".compose-foot input.author")).fontFamily)).toBe(SANS());
    // Buttons take `font: inherit`, which happy-dom leaves unresolved; the foot above is what they inherit.
    expect([SANS(), "inherit"]).toContain(family(style(container.querySelector(".compose-submit")).fontFamily));
  });

  test("the composer's placeholder is italic", () => {
    const sheet = Array.from(document.styleSheets).flatMap(s => Array.from(s.cssRules));
    const rule = sheet.find(
      (r): r is CSSStyleRule => r instanceof CSSStyleRule && r.selectorText === ".compose textarea::placeholder",
    );
    expect(rule?.style.fontStyle).toBe("italic");
  });

  test("at 900px the composer keeps its 44px touch targets", () => {
    happyDOM.setViewport(NARROW);
    postUpdateOpen.value = true;
    const { container } = render(<ActivityPane />);
    for (const selector of [".activity-compose .post-update-toggle", ".compose-foot input.author", ".compose-submit"]) {
      expect(style(container.querySelector(selector)).minHeight, selector).toBe("44px");
    }
  });

  test("the empty state keeps its dashed outline in --rule-strong", () => {
    updates.value = {};
    const { container } = render(<ActivityPane />);
    const empty = style(container.querySelector(".activity-thread .empty"));
    expect([empty.borderTopStyle, empty.borderTopColor]).toEqual(["dashed", rootToken("--rule-strong")]);
  });
});
