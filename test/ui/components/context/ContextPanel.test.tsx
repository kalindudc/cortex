// ContextPanel — the side panel's tablist (Details, Inbox, Outline) over one
// tabpanel: tab switching through contextTab, the Inbox tab's unread badge,
// the Outline tab (only the active task's headings; a click hands the
// heading to pendingHeadingFragment) and the APG keyboard. The last block
// reads the real stylesheet for the panel's paper look in every appearance.

import { describe, test, expect, mock, beforeEach } from "bun:test";

mock.module("../../../../src/ui/api/client.ts", () => ({
  api: {
    tasks: mock(() => Promise.resolve([])),
    lanes: mock(() => Promise.resolve([])),
    tags: mock(() => Promise.resolve([])),
    updates: mock(() => Promise.resolve([])),
    related: mock(() => Promise.resolve({ referencedBy: [], references: [], shared: [] })),
    notifications: mock(() => Promise.resolve([])),
    markNotifRead: mock(() => Promise.resolve()),
  },
}));

import { render, fireEvent } from "@testing-library/preact";
import { ContextPanel } from "../../../../src/ui/components/context/ContextPanel.tsx";
import { contextTab, docOutline } from "../../../../src/ui/state/context.ts";
import { notifications, localErrors } from "../../../../src/ui/state/notifications.ts";
import { tasks, selectedId, pendingHeadingFragment, relatedTasks } from "../../../../src/ui/state/signals.ts";
import type { Notification, Task } from "../../../../src/ui/api/types.ts";
import {
  SANS,
  SERIF,
  declared,
  family,
  noBorder,
  noFill,
  noShadow,
  paintsNothing,
  rootToken,
  style,
  withStyles,
} from "./paper.ts";

function task(over: Partial<Task> = {}): Task {
  return {
    id: 5,
    lane: "now",
    title: "t",
    body: "# Alpha\n\n## Beta",
    status: "open",
    priority: null,
    created: 0,
    updated: 0,
    tags: [],
    memory_excluded: false,
    ...over,
  };
}

function notif(over: Partial<Notification> = {}): Notification {
  return {
    id: 1,
    task_id: 5,
    author: null,
    title: "n",
    message: "m",
    status: "open",
    read: false,
    created: 1,
    ...over,
  };
}

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0));
// Widening reader: TS narrows a signal's literal type after an assignment.
const currentTab = (): string => contextTab.value;

const HEADINGS = [
  { id: "task-5-alpha", text: "Alpha", level: 1 },
  { id: "task-5-beta", text: "Beta", level: 2 },
];

describe("ContextPanel", () => {
  beforeEach(() => {
    tasks.value = [task()];
    selectedId.value = 5;
    relatedTasks.value = { referencedBy: [], references: [], shared: [] };
    contextTab.value = "details";
    docOutline.value = null;
    pendingHeadingFragment.value = null;
    notifications.value = [];
    localErrors.value = [];
  });

  test("a named aside with a Details, Inbox and Outline tablist over one tabpanel", () => {
    const { container, getByRole } = render(<ContextPanel />);
    const aside = container.querySelector("aside.context-panel");
    expect(aside?.getAttribute("aria-label")).toBe("Side panel");
    const list = getByRole("tablist", { name: "Side panel" });
    const tabs = Array.from(list.querySelectorAll("[role='tab']"));
    expect(tabs.map(t => t.textContent)).toEqual(["Details", "Inbox", "Outline"]);
    expect(tabs.map(t => t.id)).toEqual(["ctx-tab-details", "ctx-tab-inbox", "ctx-tab-outline"]);
    expect(tabs.map(t => t.getAttribute("aria-controls"))).toEqual([
      "ctx-panel-details",
      "ctx-panel-inbox",
      "ctx-panel-outline",
    ]);
    const panels = container.querySelectorAll("[role='tabpanel']");
    expect(panels.length).toBe(1);
    expect(panels[0].id).toBe("ctx-panel-details");
    expect(panels[0].getAttribute("aria-labelledby")).toBe("ctx-tab-details");
    expect(container.querySelector(".ctx-props")).not.toBeNull();
  });

  test("clicking a tab switches contextTab and the panel's content", async () => {
    const { container, getByRole } = render(<ContextPanel />);
    fireEvent.click(getByRole("tab", { name: "Inbox" }));
    await tick();
    expect(currentTab()).toBe("inbox");
    expect(getByRole("tab", { name: "Inbox" }).getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector("[role='tabpanel']")?.id).toBe("ctx-panel-inbox");
    expect(container.textContent).toContain("No notifications.");
    fireEvent.click(getByRole("tab", { name: "Outline" }));
    await tick();
    expect(currentTab()).toBe("outline");
    expect(container.querySelector(".ctx-props")).toBeNull();
  });

  test("the Inbox tab's badge follows unreadCount and stays out of its name", async () => {
    const { container, getByRole } = render(<ContextPanel />);
    expect(container.querySelector(".ctx-tab-badge")).toBeNull();
    notifications.value = [notif({ id: 1 }), notif({ id: 2 }), notif({ id: 3, read: true })];
    await tick();
    const badge = container.querySelector(".ctx-tab-badge");
    expect(badge?.textContent).toBe("2");
    expect(badge?.getAttribute("aria-hidden")).toBe("true");
    expect(getByRole("tab", { name: "Inbox" })).toBeTruthy();
  });

  test("the outline lists only the active task's headings, and a click sets pendingHeadingFragment", async () => {
    contextTab.value = "outline";
    docOutline.value = { taskId: 99, headings: HEADINGS, active: null };
    const { container } = render(<ContextPanel />);
    // A stale entry from another task never shows.
    expect(container.querySelector(".doc-outline")).toBeNull();
    expect(container.textContent).toContain("No outline");

    docOutline.value = { taskId: 5, headings: HEADINGS, active: "task-5-beta" };
    await tick();
    const nav = container.querySelector("nav.doc-outline");
    expect(nav?.getAttribute("aria-label")).toBe("Document outline");
    const links = Array.from(container.querySelectorAll<HTMLButtonElement>(".doc-outline-link"));
    expect(links.map(l => l.textContent)).toEqual(["Alpha", "Beta"]);
    expect(links.map(l => l.className)).toEqual(["doc-outline-link level-1", "doc-outline-link level-2"]);
    expect(links[1].getAttribute("aria-current")).toBe("location");
    expect(links[0].hasAttribute("aria-current")).toBe(false);
    fireEvent.click(links[0]);
    expect(pendingHeadingFragment.value).toEqual({ taskId: 5, id: "task-5-alpha" });
  });

  test("an outline without headings shows the empty state", () => {
    contextTab.value = "outline";
    docOutline.value = { taskId: 5, headings: [], active: null };
    const { container } = render(<ContextPanel />);
    expect(container.querySelector(".doc-outline")).toBeNull();
    expect(container.textContent).toContain("Read and Split modes");
  });

  test("tablist keyboard: arrows, Home and End move focus (roving), Enter and Space activate", async () => {
    const { getByRole, container } = render(<ContextPanel />);
    const [details, inbox, outline] = Array.from(
      getByRole("tablist", { name: "Side panel" }).querySelectorAll<HTMLButtonElement>("[role='tab']"),
    );
    details.focus();
    fireEvent.keyDown(details, { key: "ArrowRight" });
    expect(document.activeElement).toBe(inbox);
    expect(currentTab()).toBe("details"); // manual activation: focus only
    fireEvent.keyDown(inbox, { key: "End" });
    expect(document.activeElement).toBe(outline);
    fireEvent.keyDown(outline, { key: "ArrowRight" }); // wraps
    expect(document.activeElement).toBe(details);
    fireEvent.keyDown(details, { key: "ArrowLeft" }); // wraps back
    expect(document.activeElement).toBe(outline);
    fireEvent.keyDown(outline, { key: "Home" });
    expect(document.activeElement).toBe(details);
    fireEvent.keyDown(inbox, { key: "Enter" });
    await tick();
    expect(currentTab()).toBe("inbox");
    fireEvent.keyDown(outline, { key: " " });
    await tick();
    expect(currentTab()).toBe("outline");
    const inSequence = Array.from(container.querySelectorAll("[role='tab']")).filter(
      t => t.getAttribute("tabindex") === "0",
    );
    expect(inSequence.map(t => t.id)).toEqual(["ctx-tab-outline"]);
  });
});

describe("ContextPanel on paper", () => {
  withStyles();
  beforeEach(() => {
    tasks.value = [task()];
    selectedId.value = 5;
    relatedTasks.value = { referencedBy: [], references: [], shared: [] };
    contextTab.value = "details";
    docOutline.value = null;
    notifications.value = [];
    localErrors.value = [];
  });

  test("the panel lies on the desk with a rule on its left, and the tab row has no bottom border", () => {
    const { container } = render(<ContextPanel />);
    const panel = style(container.querySelector("aside.context-panel"));
    expect(panel.backgroundColor).toBe(rootToken("--desk"));
    expect([panel.borderLeftWidth, panel.borderLeftStyle, panel.borderLeftColor]).toEqual([
      "1px",
      "solid",
      rootToken("--rule"),
    ]);
    expect(noBorder(style(container.querySelector(".ctx-head")).borderBottomWidth)).toBe(true);
  });

  // getByRole cannot see through the mounted stylesheet (happy-dom computes
  // display: none on <html>), so the tabs are found by id.
  const tabStyle = (root: ParentNode, id: string): CSSStyleDeclaration => style(root.querySelector(`#ctx-tab-${id}`));

  test("the active tab is a small straight-edged card, and the others are bare", async () => {
    const { container } = render(<ContextPanel />);
    const expectCard = (id: string): void => {
      const s = tabStyle(container, id);
      expect(s.backgroundColor).toBe(rootToken("--sheet"));
      expect(s.boxShadow).toBe(rootToken("--shadow-card"));
      expect(s.borderRadius).toBe("6px");
      expect(s.color).toBe(rootToken("--text"));
    };
    const expectBare = (id: string): void => {
      const s = tabStyle(container, id);
      expect(noFill(s)).toBe(true);
      expect(noShadow(s)).toBe(true);
      expect(s.color).toBe(rootToken("--text-3"));
      expect(family(s.fontFamily)).toBe(SANS());
    };
    expectCard("details");
    expectBare("inbox");
    expectBare("outline");
    fireEvent.click(container.querySelector("#ctx-tab-outline") as HTMLButtonElement);
    await tick();
    expectBare("details");
    expectCard("outline");
  });

  test("outline links are the serif at 13.5px in --text-2, and the current heading is --text with an --accent rule", () => {
    contextTab.value = "outline";
    docOutline.value = { taskId: 5, headings: HEADINGS, active: "task-5-beta" };
    const { container } = render(<ContextPanel />);
    const [other, current] = Array.from(container.querySelectorAll(".doc-outline-link")).map(style);
    for (const s of [other, current]) {
      expect([family(s.fontFamily), s.fontSize]).toEqual([SERIF(), "13.5px"]);
      expect([s.borderLeftWidth, s.borderLeftStyle]).toEqual(["2px", "solid"]);
      expect(noFill(s)).toBe(true);
    }
    expect([other.color, other.borderLeftColor]).toEqual([rootToken("--text-2"), rootToken("--rule")]);
    expect([current.color, current.borderLeftColor]).toEqual([rootToken("--text"), rootToken("--accent")]);
  });

  // happy-dom cannot switch appearances (see `declared`), so this reads the
  // declared rules: the cards paint no surface of their own, so the theme's
  // paper tokens alone draw them; dark has its own paper; high contrast drops
  // the grain, and its own rules outline the cards and the active tab.
  test("dark and high contrast draw the cards from that theme's tokens, with no grain in high contrast", () => {
    const { container } = render(<ContextPanel />);
    const cards = Array.from(container.querySelectorAll(".ctx-card"));
    expect(cards).toHaveLength(3);
    for (const card of cards) {
      expect(paintsNothing(style(card))).toBe(true);
      expect(card.firstElementChild?.className).toBe("paper-layer is-card");
    }
    const LIGHT = ":root";
    const DARK = ':root[data-theme="dark"]';
    const HIGH = ':root[data-contrast="high"]';
    for (const token of ["--sheet", "--card-lift", "--paper-grain"]) {
      expect(declared(DARK, token)).not.toBe(declared(LIGHT, token));
    }
    expect(declared(DARK, "--paper-grain")).toMatch(/^url\(/);
    expect(declared(HIGH, "--paper-grain")).toBe("none");
    expect(declared(HIGH, "--sheet")).toBe("var(--bg)");
    const edgeLine = ["1px 0", "-1px 0", "0 1px", "0 -1px"].map(o => `drop-shadow(${o} 0 var(--rule))`).join(" ");
    expect(declared(`${HIGH} .ctx-card > .paper-layer`, "filter")).toBe(edgeLine);
    expect(declared(`${HIGH} :is(.ctx-tab.active, .ctx-chip.is-on)`, "box-shadow")).toBe(
      "inset 0 0 0 1px var(--rule-strong)",
    );
  });
});
