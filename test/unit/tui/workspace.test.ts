import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { CortexClient, DaemonIdentity, WorkspaceSnapshot } from "../../../src/contracts.ts";
import type { Lane, Task } from "../../../src/store.ts";
import { UNTAGGED } from "../../../src/lib/taskView.ts";
import { DEFAULT_CONFIG } from "../../../src/tui/config.ts";
import { DEFAULT_KEYS } from "../../../src/tui/keys.ts";
import { openPreferences } from "../../../src/tui/preferences.ts";
import { type SessionOptions, TuiSession } from "../../../src/tui/session.ts";
import { resolveTheme } from "../../../src/tui/theme.ts";
import {
  appendTagFilter,
  clearFilters,
  createWorkspace,
  filterChips,
  filterCounts,
  followTagRef,
  followTaskRef,
  hasFilters,
  moveWithin,
  NO_FILTER,
  selectWorkspace,
  type WorkspaceView,
} from "../../../src/tui/workspace.ts";

// Plan @400 Task 8 (P1/P2): the terminal workspace list reuses the shared
// PURE search/filter logic (src/lib/fuzzy.ts, src/lib/taskView.ts). The list
// order is :sort and :group (ascending id by default); a search still ranks
// by relevance.

const task = (id: number, over: Partial<Task> = {}): Task => ({
  id,
  lane: "now",
  title: `task ${id}`,
  body: null,
  status: "open",
  priority: null,
  created: 0,
  updated: 0,
  tags: [],
  ...over,
});

const view = (over: Partial<WorkspaceView> = {}): WorkspaceView => ({
  query: "",
  filter: NO_FILTER,
  includeDone: false,
  selectedId: null,
  ...over,
});

const rowIds = (tasks: readonly Task[], v: WorkspaceView) => selectWorkspace(tasks, v).rows.map(t => t.id);

describe("P1 search: full-pool title/body/tag AND-words; @id, @title and exact #tag first", () => {
  test("every word must match a title, tag or body; titles outrank tags outrank bodies", () => {
    const tasks = [
      task(1, { title: "Fix the bug" }),
      task(2, { title: "Fix the leak" }),
      task(3, { title: "Refactor", body: "fix a bug in the parser" }),
      task(4, { title: "Alpha", tags: ["bug"], body: "fix later" }),
    ];
    expect(rowIds(tasks, view({ query: "fix bug" }))).toEqual([1, 4, 3]);
  });

  test("@<digits> is an exact id lookup; @<words> searches titles only", () => {
    const tasks = [
      task(12, { title: "Twelve" }),
      task(123, { title: "Parser" }),
      task(7, { title: "Other", body: "parser" }),
    ];
    expect(rowIds(tasks, view({ query: "@123" }))).toEqual([123]);
    expect(rowIds(tasks, view({ query: "@9999" }))).toEqual([]);
    expect(rowIds(tasks, view({ query: "@parser" }))).toEqual([123]);
  });

  test("an exact #tag lists every carrier (priority order) before any substring fallback", () => {
    const tasks = [
      task(1, { title: "A", tags: ["bug", "ui"], priority: 1 }),
      task(2, { title: "B", tags: ["bug"], priority: 0 }),
      task(3, { title: "C", tags: ["bugfix"] }),
    ];
    expect(rowIds(tasks, view({ query: "#bug" }))).toEqual([2, 1]);
    expect(rowIds(tasks, view({ query: "#bugf" }))).toEqual([3]);
  });

  test("exact #tag resolution runs against the FULL pool before the lane filter intersects", () => {
    const tasks = [task(1, { lane: "a", tags: ["feature-x"] }), task(2, { lane: "b", tags: ["feature"] })];
    expect(rowIds(tasks, view({ query: "#feature", filter: { ...NO_FILTER, lane: "a" } }))).toEqual([]);
  });
});

describe("P1 filters: slots AND together, tags OR (+ untagged), the done exception", () => {
  const tasks = [
    task(1, { title: "needle one", tags: ["bug"] }),
    task(2, { title: "needle two" }),
    task(3, { lane: "b", title: "needle three", tags: ["bug"] }),
    task(4, { status: "blocked", title: "needle four", tags: ["bug"] }),
    task(5, { title: "haystack", tags: ["bug"] }),
    task(6, { title: "needle six", tags: ["ui"] }),
    task(7, { title: "needle done", status: "done", tags: ["bug"] }),
  ];

  test("query AND status AND lane AND tags", () => {
    const filter = { status: "open" as const, lane: "now", tags: ["bug"] };
    expect(rowIds(tasks, view({ query: "needle", filter }))).toEqual([1]);
    expect(rowIds(tasks, view({ query: "needle", filter: { ...filter, tags: ["bug", "ui"] } }))).toEqual([1, 6]);
    expect(rowIds(tasks, view({ filter: { ...NO_FILTER, tags: [UNTAGGED] } }))).toEqual([2]);
  });

  test("done tasks hide unless included; a done status filter shows them anyway", () => {
    expect(rowIds(tasks, view({ query: "needle done" }))).toEqual([]);
    expect(rowIds(tasks, view({ query: "needle done", includeDone: true }))).toEqual([7]);
    const doneView = view({ filter: { ...NO_FILTER, status: "done" } });
    expect(rowIds(tasks, doneView)).toEqual([7]);
    expect(selectWorkspace(tasks, doneView).includeDone).toBe(true);
  });

  test(":clear semantics clear the query and every slot but keep include-done and the selection", () => {
    const busy = view({
      query: "x",
      filter: { status: "open", lane: "b", tags: ["bug"] },
      includeDone: true,
      selectedId: 3,
    });
    expect(hasFilters(busy)).toBe(true);
    const cleared = clearFilters(busy);
    expect(cleared).toEqual({ query: "", filter: NO_FILTER, includeDone: true, selectedId: 3 });
    expect(hasFilters(cleared)).toBe(false);
  });
});

describe("P2 ordering and selection", () => {
  test("ascending id without a query (the default sort); relevance order with one", () => {
    const tasks = [task(12, { title: "task-12", priority: 0 }), task(2, { title: "task-2", priority: 5 })];
    expect(rowIds(tasks, view())).toEqual([2, 12]);
    const ranked = [task(1, { title: "zzz", body: "needle in body" }), task(2, { title: "needle title" })];
    expect(rowIds(ranked, view({ query: "needle" }))).toEqual([2, 1]);
  });

  test("an explicit selection survives the filter that excludes it (activeIndex -1)", () => {
    const tasks = [task(1, { lane: "a" }), task(2, { lane: "b" })];
    const s = selectWorkspace(tasks, view({ selectedId: 1, filter: { ...NO_FILTER, lane: "b" } }));
    expect(s.active?.id).toBe(1);
    expect(s.activeIndex).toBe(-1);
    expect(s.rows.map(t => t.id)).toEqual([2]);
  });

  test("without a selection the fallback is the first non-done task in server order, not display order", () => {
    const tasks = [task(2, { title: "beta" }), task(1, { title: "alpha" })];
    const s = selectWorkspace(tasks, view());
    expect(s.rows.map(t => t.id)).toEqual([1, 2]);
    expect(s.active?.id).toBe(2);
    expect(s.activeIndex).toBe(1);
    expect(selectWorkspace([task(1, { status: "done" })], view()).active).toBeNull();
  });

  test("motions clamp inside the rows; from outside they enter at the edge of travel", () => {
    const rows = [task(1), task(2), task(3), task(4)];
    expect(moveWithin(rows, 2, 1)).toBe(3);
    expect(moveWithin(rows, 2, 5)).toBe(4);
    expect(moveWithin(rows, 1, -1)).toBe(1);
    expect(moveWithin(rows, 99, 1)).toBe(1);
    expect(moveWithin(rows, 99, -1)).toBe(4);
    expect(moveWithin([], 1, 1)).toBeNull();
  });

  test("@id refs clear every filter and select; a missing task changes nothing", () => {
    const tasks = [task(1), task(2)];
    const busy = view({ query: "zzz", filter: { status: "done", lane: "x", tags: ["bug"] }, includeDone: true });
    expect(followTaskRef(busy, tasks, 2)).toEqual({ query: "", filter: NO_FILTER, includeDone: true, selectedId: 2 });
    expect(followTaskRef(busy, tasks, 99)).toBeNull();
  });

  test("#tag refs REPLACE the tag slot; header labels APPEND to it (idempotently)", () => {
    const start = view({ query: "q", filter: { status: "open", lane: "now", tags: ["a", "b"] } });
    expect(followTagRef(start, "c").filter).toEqual({ status: "open", lane: "now", tags: ["c"] });
    expect(followTagRef(start, "c").query).toBe("q");
    expect(appendTagFilter(start, "c").filter.tags).toEqual(["a", "b", "c"]);
    expect(appendTagFilter(start, "a").filter.tags).toEqual(["a", "b"]);
  });

  test("the result set is never capped (virtualization limits only painted rows)", () => {
    const many = Array.from({ length: 10_000 }, (_, i) => task(i + 1, { title: `item ${i + 1}` }));
    expect(selectWorkspace(many, view()).rows.length).toBe(10_000);
    expect(selectWorkspace(many, view({ query: "item" })).rows.length).toBe(10_000);
  });
});

describe("the terminal's list order: :sort and :group (ties by ascending id)", () => {
  const lanes: Lane[] = [
    { name: "now", color: null, sort: 0 },
    { name: "later", color: null, sort: 1 },
  ];
  const tasks = [
    task(3, { title: "task-12", lane: "later", status: "review", priority: 1, updated: 30 }),
    task(1, { title: "task-2", lane: "now", status: "blocked", priority: null, updated: 10 }),
    task(4, { title: "Alpha", lane: "now", status: "draft", priority: 0, updated: 20 }),
    task(2, { title: "task-2", lane: "later", status: "open", priority: 1, updated: 10 }),
  ];
  const by = (over: Partial<WorkspaceView>) => selectWorkspace(tasks, view(over), lanes);

  test("the default is ascending task id; the selection reports its order", () => {
    const sel = by({});
    expect(sel.rows.map(t => t.id)).toEqual([1, 2, 3, 4]);
    expect(sel.order).toBe("id");
    expect(sel.group).toBe("none");
    expect(sel.groups).toEqual([]);
  });

  test("every order, each tie broken by ascending id", () => {
    const ids = (sort: WorkspaceView["sort"]) => by({ sort }).rows.map(t => t.id);
    expect(ids("id")).toEqual([1, 2, 3, 4]);
    expect(ids("-id")).toEqual([4, 3, 2, 1]);
    expect(ids("title")).toEqual([4, 1, 2, 3]); // natural: Alpha, task-2, task-2, task-12
    expect(ids("-title")).toEqual([3, 1, 2, 4]);
    expect(ids("lane")).toEqual([1, 4, 2, 3]); // the lane catalog order: now, later
    expect(ids("status")).toEqual([4, 2, 3, 1]); // draft, open, review, blocked, done
    expect(ids("priority")).toEqual([4, 2, 3, 1]); // P0 first, unset last
    expect(ids("updated")).toEqual([1, 2, 4, 3]);
    expect(ids("-updated")).toEqual([3, 4, 1, 2]);
  });

  test("groups: one header per lane (catalog order, unknown lanes after by name) or status, with counts", () => {
    const lane = by({ group: "lane", sort: "-id" });
    expect(lane.rows.map(t => t.id)).toEqual([4, 1, 3, 2]);
    expect(lane.groups.map(g => [g.key, g.label, g.start, g.count])).toEqual([
      ["now", "now", 0, 2],
      ["later", "later", 2, 2],
    ]);
    const status = by({ group: "status" });
    expect(status.rows.map(t => t.id)).toEqual([4, 2, 3, 1]);
    expect(status.groups.map(g => [g.key, g.status, g.count])).toEqual([
      ["draft", "draft", 1],
      ["open", "open", 1],
      ["review", "review", 1],
      ["blocked", "blocked", 1],
    ]);
    const stray = selectWorkspace([...tasks, task(9, { lane: "archive" })], view({ group: "lane" }), lanes);
    expect(stray.groups.map(g => g.key)).toEqual(["now", "later", "archive"]);
  });

  test("motions step over the rows only: group headers are never selected", () => {
    const lane = by({ group: "lane" });
    expect(lane.rows.map(t => t.id)).toEqual([1, 4, 2, 3]);
    expect(moveWithin(lane.rows, 4, 1)).toBe(2);
    expect(moveWithin(lane.rows, 2, -1)).toBe(4);
  });

  test("a search ranks by relevance in one flat list, whatever the sort and group (P1/P2 parity)", () => {
    const ranked = [task(1, { title: "zzz", body: "needle in body" }), task(2, { title: "needle title" })];
    const sel = selectWorkspace(ranked, view({ query: "needle", sort: "-id", group: "lane" }), lanes);
    expect(sel.rows.map(t => t.id)).toEqual([2, 1]);
    expect(sel.order).toBe("relevance");
    expect(sel.group).toBe("none");
    expect(sel.groups).toEqual([]);
  });
});

describe("the filter picker's counts and the header chips", () => {
  const tasks = [
    task(1, { lane: "now", status: "open", tags: ["ui"] }),
    task(2, { lane: "now", status: "review" }),
    task(3, { lane: "later", status: "review", tags: ["ui", "bug"] }),
    task(4, { lane: "later", status: "done", tags: ["bug"] }),
  ];

  test("each slot counts its choices over the search and the OTHER slots; statuses count done tasks", () => {
    const c = filterCounts(tasks, view({ filter: { status: "review", lane: null, tags: [] } }));
    expect(c.statuses).toEqual({ draft: 0, open: 1, review: 2, blocked: 0, done: 1 });
    expect([...c.lanes]).toEqual([
      ["now", 1],
      ["later", 1],
    ]);
    expect([...c.tags]).toEqual([
      ["ui", 1],
      ["bug", 1],
    ]);
    expect(c.untagged).toBe(1);
    // Lanes and tags follow the include-done gate (and the done-view exception).
    const all = filterCounts(tasks, view({ includeDone: true }));
    expect(all.lanes.get("later")).toBe(2);
    expect(filterCounts(tasks, view()).lanes.get("later")).toBe(1);
    expect(filterCounts(tasks, view({ query: "task 3" })).statuses.review).toBe(1);
  });

  test("chips name the search and every slot compactly", () => {
    expect(
      filterChips(view({ query: "fix", filter: { status: "review", lane: "cortex", tags: ["ui", UNTAGGED] } })),
    ).toEqual(["/fix", "status:review", "lane:cortex", "#ui", "untagged"]);
    expect(filterChips(view())).toEqual([]);
  });
});

// ---------- the list component ----------

const DB = "0b6a2f4e-0c1d-4e5f-8a9b-1c2d3e4f5a6b";
const IDENTITY: DaemonIdentity = {
  protocol: 1,
  instanceId: "instance-1",
  databaseId: DB,
  databasePath: "/tmp/cortex.db",
  endpoint: { kind: "unix", socketPath: "/tmp/cortex-x.sock" },
  pid: 4242,
};
const LANES: Lane[] = [
  { name: "now", color: null, sort: 0 },
  { name: "later", color: null, sort: 1 },
];

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-tui-workspace-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function session(tasks: Task[], over: Partial<SessionOptions> = {}): TuiSession {
  const snapshot: WorkspaceSnapshot = {
    identity: IDENTITY,
    cursor: "e:1",
    tasks,
    lanes: LANES,
    tags: [],
    notifications: [],
  };
  const s = new TuiSession({
    client: { workspace: async () => snapshot } as unknown as CortexClient,
    identity: IDENTITY,
    keys: DEFAULT_KEYS,
    preferences: openPreferences(path.join(dir, "tui", "default.state.json")),
    schedule: () => () => {},
    ...over,
  });
  s.applySnapshot(snapshot);
  s.setTheme(resolveTheme({ config: DEFAULT_CONFIG, env: { NO_COLOR: "1", TERM: "xterm-256color" } }));
  return s;
}

const plain = (lines: string[]) => lines.map(l => l.replace(/\x1b\[[0-9;]*m/g, ""));

describe("createWorkspace (the task list)", () => {
  test("fills exactly its height, never exceeds the width, shows the count, the order and the filter line", () => {
    const s = session([task(1, { title: "Fix the login flow" }), task(2, { title: "Draft docs", status: "draft" })]);
    const list = createWorkspace(s);
    list.height = 12;
    const lines = list.render(40);
    expect(lines.length).toBe(12);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
    const text = plain(lines).join("\n");
    expect(text).toContain("TASKS");
    expect(text).toContain("2 shown");
    expect(text).toContain("sort id");
    expect(text).toContain("no filters");
    expect(text).toMatch(/○ @2 {2}Draft docs/);
    expect(text).toMatch(/▌● @1 {2}Fix the login flow/);
  });

  test("grouped: a header row per group with its count; the rows below follow the sort", () => {
    const s = session([
      task(1, { title: "first", lane: "later" }),
      task(2, { title: "second" }),
      task(3, { title: "third", lane: "later" }),
    ]);
    s.setGroup("lane");
    const list = createWorkspace(s);
    list.height = 10;
    const lines = plain(list.render(40));
    expect(lines[1]).toContain("sort id · group lane");
    const now = lines.findIndex(l => /now · 1/.test(l));
    const later = lines.findIndex(l => /later · 2/.test(l));
    expect(now).toBeGreaterThan(-1);
    expect(later).toBeGreaterThan(now);
    expect(lines[now + 1]).toContain("@2  second");
    expect(lines[later + 1]).toContain("@1  first");
    expect(lines[later + 2]).toContain("@3  third");
    // j/k never land on a header: from the last row of `now` j selects the first of `later`.
    s.select(2);
    s.moveSelection(1);
    expect(s.selectedId).toBe(1);
    // A search shows the relevance order, flat, and the header says so.
    s.setQuery("third");
    const searched = plain(list.render(40)).join("\n");
    expect(searched).toContain("by relevance (search)");
    expect(searched).not.toMatch(/later · /);
  });

  test("the filter line shows the query, every slot and include-done as compact chips", () => {
    const s = session([task(1, { title: "needle", tags: ["bug"] })]);
    s.setQuery("needle");
    s.setFilter({ status: "open", lane: "now", tags: ["bug", UNTAGGED] });
    s.setIncludeDone(true);
    const list = createWorkspace(s);
    list.height = 6;
    const text = plain(list.render(80)).join("\n");
    expect(text).toContain("/needle status:open lane:now #bug untagged");
    expect(text).toContain("+done");
  });

  test("virtualization paints only the rows that fit, following the selection", () => {
    const s = session(
      Array.from({ length: 10_000 }, (_, i) => task(i + 1, { title: `item ${String(i + 1).padStart(5, "0")}` })),
    );
    const list = createWorkspace(s);
    list.height = 20;
    let text = plain(list.render(60)).join("\n");
    expect(text).toContain("10000 shown");
    expect(text).toContain("item 00001");
    expect(text).not.toContain("item 10000");
    s.selectEdge("last");
    text = plain(list.render(60)).join("\n");
    expect(text).toContain("item 10000");
    expect(text).not.toContain("item 00001");
  });

  test("empty states explain themselves", () => {
    const s = session([task(1, { title: "alpha" })]);
    s.setQuery("zzz");
    const list = createWorkspace(s);
    list.height = 6;
    const text = plain(list.render(60)).join("\n");
    expect(text).toContain("No tasks match");
    expect(text).toContain(":clear");
  });

  test("untrusted titles are escaped", () => {
    const s = session([task(1, { title: "evil\x1b]52;c;SGVsbG8=\x07\x1b[2J" })]);
    const list = createWorkspace(s);
    list.height = 5; // the header, the comfortable spacer, the row
    const joined = list.render(60).join("\n");
    expect(joined.replace(/\x1b\[[0-9;]*m/g, "")).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    expect(joined).toContain("evil^[]52;c;SGVsbG8=^G^[[2J");
  });

  test("the mouse map: each rendered row says what a click reaches (the shell routes it)", () => {
    const s = session([task(1, { title: "a" }), task(2, { title: "b" }), task(3, { title: "c" })]);
    const list = createWorkspace(s);
    list.height = 8;
    list.render(40);
    // Row 0 is the pane label, row 1 the order line (the sort label), row 2 the filter chips, row 3 the
    // (comfortable) spacer, rows 4.. the tasks.
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(y => list.hitAt(y))).toEqual([
      { kind: "pane" },
      { kind: "sort" },
      { kind: "filters" },
      { kind: "pane" },
      { kind: "task", id: 1 },
      { kind: "task", id: 2 },
      { kind: "task", id: 3 },
      { kind: "pane" },
    ]);
    expect(list.hitAt(-1)).toEqual({ kind: "pane" });
    expect(list.hitAt(99)).toEqual({ kind: "pane" });
  });
});

// ---------- the list's layout: density, the @id column, lanes and the expanded selection ----------

describe("the list layout: the density spacer, aligned ids, right-aligned lanes, the expanded selection", () => {
  const LONG = "Handover: fix PR-review round 2 (F9–F19) on the TUI-first branch (plan @400)";
  /** The rows (y) the last render gave to task `id`. */
  const rowsOf = (list: ReturnType<typeof createWorkspace>, id: number): number[] =>
    Array.from({ length: list.height }, (_, y) => y).filter(y => {
      const hit = list.hitAt(y);
      return hit.kind === "task" && hit.id === id;
    });
  /** The SGR parameters right before the first `text` on `line`. */
  const sgrBefore = (line: string, text: string): string[] => {
    const at = line.indexOf(text);
    expect(at, `${JSON.stringify(text)} on the row`).toBeGreaterThan(-1);
    return (/\x1b\[([0-9;]*)m$/.exec(line.slice(0, at))?.[1] ?? "").split(";");
  };

  test("S1: comfortable (the default) puts ONE blank row between the list header and its body; compact none", () => {
    const tasks = [task(1, { title: "alpha" }), task(2, { title: "beta" })];
    const roomy = createWorkspace(session(tasks));
    roomy.height = 8;
    let lines = plain(roomy.render(40));
    expect(lines[2]).toContain("no filters");
    expect(lines[3]?.trim()).toBe("");
    expect(roomy.hitAt(3)).toEqual({ kind: "pane" });
    expect(lines[4]).toContain("@1  alpha");
    expect(roomy.hitAt(4)).toEqual({ kind: "task", id: 1 });
    const dense = createWorkspace(session(tasks, { settings: { density: "compact" } }));
    dense.height = 8;
    lines = plain(dense.render(40));
    expect(lines[3]).toContain("@1  alpha");
    expect(dense.hitAt(3)).toEqual({ kind: "task", id: 1 });
    // The empty states and the loading line get the spacer too.
    const filtered = session(tasks);
    filtered.setQuery("zzz");
    const empty = createWorkspace(filtered);
    empty.height = 8;
    lines = plain(empty.render(40));
    expect(lines[3]?.trim()).toBe("");
    expect(lines[4]).toContain("No tasks match");
    // A density change shows on the next render.
    filtered.setDensity("compact");
    expect(plain(empty.render(40))[3]).toContain("No tasks match");
  });

  test("R1: the @id column is as wide as the widest @id of ALL the rows (scrolled away too), then two spaces", () => {
    const list = createWorkspace(
      session([task(1, { title: "one" }), task(7, { title: "seven" }), task(100, { title: "hundred" })]),
    );
    list.height = 10;
    const lines = plain(list.render(40));
    const rows = [1, 7, 100].map(id => lines[rowsOf(list, id)[0] ?? -1] ?? "");
    expect(rows[0]).toMatch(/^▌● @1 {4}one /);
    expect(rows[1]).toMatch(/^ ● @7 {4}seven /);
    expect(rows[2]).toMatch(/^ ● @100 {2}hundred /);
    // Every title starts in the same column: marker, glyph, space, the id column, two spaces.
    expect(rows.map((r, i) => r.indexOf(["one", "seven", "hundred"][i] ?? ""))).toEqual([9, 9, 9]);
    // The widest id sets the column even while it is scrolled out of view, so nothing shifts on scroll.
    const many = [...Array.from({ length: 9 }, (_, i) => task(i + 1, { title: `t${i + 1}` })), task(1000)];
    const short = createWorkspace(session(many));
    short.height = 7; // the header, the spacer and 3 rows
    const shown = plain(short.render(40));
    expect(shown.join("\n")).not.toContain("@1000");
    expect(shown[4]).toMatch(/^▌● @1 {5}t1 /);
    expect(shown[6]).toMatch(/^ ● @3 {5}t3 /);
  });

  test("R2: every task row leaves its last cell blank (a 1-cell right padding), cut titles and the selection too", () => {
    const s = session([task(1, { title: "short" }), task(2, { title: LONG }), task(3, { title: LONG, lane: "later" })]);
    const list = createWorkspace(s);
    list.height = 10;
    const width = 40;
    const lines = plain(list.render(width));
    const rows = [1, 2, 3].map(id => lines[rowsOf(list, id)[0] ?? -1] ?? "");
    for (const row of rows) {
      expect(row.length).toBe(width);
      expect(row[width - 1]).toBe(" ");
      expect(row[width - 2]).not.toBe(" ");
    }
    expect(rows[1]?.slice(-2)).toBe("… ");
    expect(rows[2]?.slice(-2)).toBe("… ");
    // The list alone (80 columns) keeps the same padding before the edge.
    for (const line of plain(list.render(80)).filter((_l, y) => list.hitAt(y).kind === "task")) {
      expect(line.length).toBe(80);
      expect(line[79]).toBe(" ");
    }
  });

  test("a cut title never leaves a space before its ellipsis (one row, and the selected row's last line)", () => {
    // 40 columns: 32 cells for the title; the cut keeps 31 of them, the 31st being the space before "yyyy".
    const spaced = `${"x".repeat(30)} yyyy zzzz`;
    const wrapped = Array.from({ length: 5 }, () => `${"w".repeat(30)} `).join("");
    const s = session([task(1, { title: wrapped }), task(2, { title: spaced })]);
    const list = createWorkspace(s);
    list.height = 12;
    const lines = plain(list.render(40));
    const one = lines[rowsOf(list, 2)[0] ?? -1] ?? "";
    expect(one).toBe(` ● @2  ${"x".repeat(30)}…${" ".repeat(2)}`);
    const block = rowsOf(list, 1).map(y => lines[y] ?? "");
    expect(block).toHaveLength(4);
    expect(block[3]).not.toMatch(/ …/);
    expect(block[3]).toMatch(/w…\s*$/);
  });

  test("R3: the lane shows dim and right-aligned when the whole title fits beside it; else the title gets the room", () => {
    // 40 columns: 39 before the padding, 7 for the marker, glyph and id column: 32 for the title and the lane.
    const fits = "x".repeat(32 - 2 - "later".length);
    const over = `${fits}y`;
    const s = session([
      task(1, { title: "short", lane: "later" }),
      task(2, { title: fits, lane: "later" }),
      task(3, { title: over, lane: "later" }),
      task(4, { title: LONG, lane: "later" }),
    ]);
    const list = createWorkspace(s);
    list.height = 10;
    const raw = list.render(40);
    const lines = plain(raw);
    const row = (id: number) => lines[rowsOf(list, id)[0] ?? -1] ?? "";
    expect(row(1)).toMatch(/^▌○? ?● @1 {2}short +later $/u);
    expect(row(2)).toBe(` ● @2  ${fits}  later `);
    // One cell more and the lane goes: the whole title shows, nothing is cut.
    expect(row(3)).toBe(` ● @3  ${over}${" ".repeat(40 - 7 - over.length)}`);
    // A title that does not fit even alone is cut with an ellipsis, without the lane.
    expect(row(4)).not.toContain("later");
    expect(row(4).endsWith("… ")).toBe(true);
    // Dim (never color alone: NO_COLOR here, so SGR dim).
    const rawRow = (id: number) => raw[rowsOf(list, id)[0] ?? -1] ?? "";
    expect(sgrBefore(rawRow(2), "later")).toContain("2");
    expect(sgrBefore(rawRow(1), "later")).toContain("2");
    // Unchanged condition: no lane beside the rows while a lane filter is set or the list is grouped by lane.
    s.setGroup("lane");
    list.render(40);
    expect(plain(list.render(40)).some(l => /later $/.test(l))).toBe(false);
    s.setGroup("none");
    s.setFilter({ status: null, lane: "later", tags: [] });
    expect(plain(list.render(40)).some(l => /later $/.test(l))).toBe(false);
  });

  test("R4: the selected row wraps its whole title under the title column (▌ and bold on every line), at most 4 lines", () => {
    const s = session([task(1, { title: LONG, lane: "cortex" }), task(2, { title: "next" })]);
    const list = createWorkspace(s);
    list.height = 12;
    const raw = list.render(40);
    const lines = plain(raw);
    const block = rowsOf(list, 1);
    // Room for the title: 40 - 1 (padding) - 7 (marker, glyph, id column) = 32 cells.
    expect(block).toEqual([4, 5, 6]);
    expect(block.map(y => lines[y])).toEqual([
      "▌● @1  Handover: fix PR-review round 2  ",
      "▌      (F9–F19) on the TUI-first branch ",
      "▌      (plan @400)               cortex ",
    ]);
    // The current selected-row look, just wrapped: the selection surface (inverse without color), a bold title.
    for (const [i, part] of ["Handover", "(F9", "(plan"].entries()) {
      const codes = sgrBefore(raw[block[i] ?? -1] ?? "", part);
      expect(codes).toContain("1");
      expect(codes).toContain("7");
    }
    // The next row follows the block; it stays one line.
    expect(rowsOf(list, 2)).toEqual([7]);
    expect(lines[7]).toMatch(/^ ● @2 {2}next /);
    // It is the selection highlight: it expands with the focus elsewhere too.
    s.setFocus("document");
    list.render(40);
    expect(rowsOf(list, 1)).toEqual([4, 5, 6]);
    // Another selection: the first row is one line again (cut), the new one expands.
    s.select(2);
    const after = plain(list.render(40));
    expect(rowsOf(list, 1)).toEqual([4]);
    expect(after[4]?.endsWith("… ")).toBe(true);
    expect(rowsOf(list, 2)).toEqual([5]);
  });

  test("R4: longer than 4 lines ends the 4th in an ellipsis (and drops the lane); never more lines than the body", () => {
    const words = "word ".repeat(400).trim();
    const s = session([task(1, { title: words, lane: "cortex" }), task(2)]);
    const list = createWorkspace(s);
    list.height = 12;
    let lines = plain(list.render(40));
    expect(rowsOf(list, 1)).toEqual([4, 5, 6, 7]);
    // Whole words per line (6 fit in 32 cells), the 4th then ends in the ellipsis.
    expect(lines[7]).toBe(`▌      ${"word ".repeat(6).trim()}…${" ".repeat(40 - 7 - 30)}`);
    expect(lines.join("\n")).not.toContain("cortex");
    expect(lines.join("\n")).not.toContain("……");
    // A body of two rows (6 - the header and the spacer) shows two lines; compact has one row more.
    list.height = 6;
    lines = plain(list.render(40));
    expect(rowsOf(list, 1)).toEqual([4, 5]);
    expect(lines[5]?.trimEnd().endsWith("word…")).toBe(true);
    s.setDensity("compact");
    list.render(40);
    expect(rowsOf(list, 1)).toEqual([3, 4, 5]);
  });

  test("R5: scrolling counts rendered rows: the expanded block stays whole in view; j at the bottom scrolls just enough", () => {
    const tasks = Array.from({ length: 30 }, (_, i) => task(i + 1, { title: `${LONG} ${i + 1}` }));
    const s = session(tasks);
    const list = createWorkspace(s);
    list.height = 12; // 3 header rows, the spacer, 8 body rows
    const body = [4, 5, 6, 7, 8, 9, 10, 11];
    let top = -1;
    for (let step = 0; step < 29; step++) {
      list.render(40);
      const id = s.selectedTask()?.id ?? -1;
      const block = rowsOf(list, id);
      // Whole (every title here wraps to 3 lines), contiguous, inside the body; every body row is a task.
      expect(block.length, `@${id}`).toBe(3);
      expect(block.at(-1)).toBe((block[0] ?? 0) + 2);
      expect(body).toEqual(expect.arrayContaining(block));
      for (const y of body) expect(list.hitAt(y).kind, `@${id} row ${y}`).toBe("task");
      const first = list.hitAt(4);
      const firstId = first.kind === "task" ? first.id : -1;
      // When the list scrolled, it scrolled just enough: the block ends on the last body row.
      if (step > 0 && firstId !== top) expect(block.at(-1), `@${id}`).toBe(11);
      top = firstId;
      s.moveSelection(1);
    }
    expect(top).toBeGreaterThan(1);
    // Back up with k: the block shows above without moving the list until it reaches the top row.
    const before = top;
    s.moveSelection(-1);
    list.render(40);
    expect(list.hitAt(4)).toEqual({ kind: "task", id: before });
    expect(rowsOf(list, s.selectedTask()?.id ?? -1).length).toBe(3);
  });

  test("R5: the expanded block that opens a group keeps its group header in view", () => {
    const tasks = Array.from({ length: 12 }, (_, i) =>
      task(i + 1, { title: `${LONG} ${i + 1}`, lane: i < 6 ? "now" : "later" }),
    );
    const s = session(tasks);
    s.setGroup("lane");
    const list = createWorkspace(s);
    list.height = 12;
    s.selectEdge("last");
    list.render(40);
    // Up from the bottom to the first row of `later`: its header stays right above the block.
    while (s.selectedTask()?.id !== 7) {
      s.moveSelection(-1);
      list.render(40);
    }
    const lines = plain(list.render(40));
    const block = rowsOf(list, 7);
    expect(block.length).toBe(3);
    expect(lines[(block[0] ?? 0) - 1]).toMatch(/── later · 6 /);
    // Down from the last row of `now` into it: the same.
    s.select(6);
    list.render(40);
    s.moveSelection(1);
    const again = plain(list.render(40));
    const next = rowsOf(list, 7);
    expect(next.length).toBe(3);
    expect(again[(next[0] ?? 0) - 1]).toMatch(/── later · 6 /);
  });
});
