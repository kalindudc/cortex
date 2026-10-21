// DetailsTab — the side panel's Details tab: the active task's properties,
// its authors with Resume on resumable ones, and the three related-task
// groups with their loading, retry and confirmed-empty states. On paper the
// three are index cards; the last block reads the real stylesheet.

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
import { MONO, SANS, SERIF, family, noFill, paintsNothing, rootToken, style, withStyles } from "./paper.ts";
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

describe("DetailsTab on paper", () => {
  withStyles();
  beforeEach(() => {
    tasks.value = [task({ id: 1, status: "review" }), task({ id: 9, title: "Gift cards at checkout" })];
    lanes.value = [{ name: "now", color: "#ff8800", sort: 0 }];
    selectedId.value = 1;
    updates.value = { 1: [update({ id: 1, author: "bb-thr_abc123", created: 200 })] };
    relatedTasks.value = { referencedBy: [], references: [], shared: [tasks.value[1]] };
    relatedLoading.value = null;
    relatedError.value = null;
  });

  const cards = (root: ParentNode): HTMLElement[] => Array.from(root.querySelectorAll<HTMLElement>(".ctx-card"));

  test("Properties, Authors and Related are three separate cards, each painted by a plain PaperLayer card", () => {
    const { container } = render(<DetailsTab />);
    // The three cards are the tab's only children.
    expect(Array.from(container.children).map(c => c.className)).toEqual([
      "ctx-card paper-host",
      "ctx-card paper-host",
      "ctx-card paper-host",
    ]);
    const all = cards(container);
    expect(all.map(c => c.children[1]?.textContent?.replace(/\s+\d+$/, ""))).toEqual([
      "Properties",
      "Authors",
      "Related",
    ]);
    expect(all[0].querySelector(".ctx-props")).not.toBeNull();
    expect(all[1].querySelector(".author-list")).not.toBeNull();
    expect(all[1].querySelector(".resume-outcome")).not.toBeNull();
    expect(all[2].querySelectorAll(".related-section")).toHaveLength(3);
    for (const card of all) {
      // The layer comes first and holds nothing; no dots on a card.
      const layer = card.firstElementChild;
      expect(layer?.className).toBe("paper-layer is-card");
      expect(layer?.getAttribute("aria-hidden")).toBe("true");
      expect(layer?.childNodes).toHaveLength(0);
      expect(card.querySelectorAll(".paper-layer")).toHaveLength(1);
      // The card's own box paints nothing: the layer is its paper.
      const s = style(card);
      expect(paintsNothing(s)).toBe(true);
      expect(["", "none"]).toContain(s.filter);
      expect([s.position, s.isolation]).toEqual(["relative", "isolate"]);
      expect([s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft]).toEqual(["13px", "15px", "13px", "15px"]);
      expect(style(layer).filter).toBe(rootToken("--card-lift"));
    }
    expect(all.slice(1).map(c => style(c).marginTop)).toEqual(["10px", "10px"]);
  });

  test("card headings are 10.5px uppercase sans in --text-3, and property values are in --text", () => {
    const { container } = render(<DetailsTab />);
    const headings = Array.from(container.querySelectorAll(".ctx-card > .ctx-section-title"));
    expect(headings).toHaveLength(3);
    for (const heading of headings) {
      const h = style(heading);
      expect([family(h.fontFamily), h.fontSize, h.textTransform, h.color]).toEqual([
        SANS(),
        "10.5px",
        "uppercase",
        rootToken("--text-3"),
      ]);
      expect(h.marginTop).toBe("0px");
    }
    expect(style(container.querySelector(".ctx-props dt")).color).toBe(rootToken("--text-3"));
    for (const dd of Array.from(container.querySelectorAll(".ctx-props dd"))) {
      expect(style(dd).color).toBe(rootToken("--text"));
    }
  });

  test("author ids are monospace and Resume is outlined", () => {
    const { container } = render(<DetailsTab />);
    const name = style(container.querySelector(".author-name"));
    expect([family(name.fontFamily), name.color]).toEqual([MONO(), rootToken("--text")]);
    expect(container.querySelector(".author-row .avatar")).toBeNull();
    const button = container.querySelector(".author-row button.author-resume");
    expect(button?.getAttribute("aria-label")).toBe("Resume bb-thr_abc123");
    const resume = style(button);
    expect([resume.borderTopWidth, resume.borderTopStyle, resume.borderTopColor]).toEqual([
      "1px",
      "solid",
      rootToken("--rule-strong"),
    ]);
    expect(resume.backgroundColor).toBe("transparent");
  });

  test("related task titles are the serif at 14px, on rows with no fill or rule of their own", () => {
    const { container } = render(<DetailsTab />);
    const row = container.querySelector(".related-section .related-row");
    expect(row?.textContent).toContain("Gift cards at checkout");
    const r = style(row);
    expect(noFill(r)).toBe(true);
    expect(["", "0px"]).toContain(r.borderBottomWidth);
    const title = style(row?.querySelector(".related-title"));
    expect([family(title.fontFamily), title.fontSize, title.color]).toEqual([SERIF(), "14px", rootToken("--text")]);
    const id = style(row?.querySelector(".chip-id"));
    expect(family(id.fontFamily)).toBe(MONO());
    // The three groups are sub-headings of the Related card.
    expect(Array.from(container.querySelectorAll(".related-section h3")).map(h => h.textContent)).toEqual([
      "Referenced by",
      "References",
      "Shared tags",
    ]);
  });
});
