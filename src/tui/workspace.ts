// The terminal workspace list.
//
// - selectWorkspace is the PURE list model: the shared search/filter/
//   fallback functions (src/lib/fuzzy.ts, src/lib/taskView.ts) applied to
//   one session's view:
//     - Search: full-pool title/body/tag AND-word search; @id, @title and
//       exact #tag before any substring fallback; slots AND together, tags
//       OR (plus untagged); a done status filter shows done tasks anyway.
//     - Selection: relevance order with a query (one flat list); an explicit
//       selection survives the filters that exclude it; without one, the
//       first non-done task in server order.
//   Without a query the list follows `:sort` (ascending id by default; ties
//   always by ascending id) and `:sort group` (a header row per lane, in lane-catalog
//   order, or per status, draft to done). Headers are not rows: motions
//   step over tasks only.
// - filterCounts: the filter picker's per-choice counts, each slot over the
//   search and the OTHER slots; filterChips: the header's compact filters.
// - The view reducers encode the navigation rules: :clear keeps
//   include-done, @id refs clear every filter, #tag refs replace the tag
//   slot, header tag labels append to it.
// - createWorkspace renders the list pane: a header with the count (its
//   label inverse while the list has the focus), the order line, the filter
//   chips, a blank row in the comfortable density, then one row per task
//   (status glyph AND label color, never tint alone) under their group
//   headers: the @id column as wide as the widest id of the list, the title,
//   the lane dim and right-aligned when the whole title fits beside it, and a
//   blank last cell. The selected row shows its whole title, wrapped on up to
//   SELECTED_TITLE_LINES lines. Only the lines that fit are painted (scrolling
//   counts rendered lines); the result set is never capped. Titles and lanes
//   cross src/tui/safety.ts first.

import { type Component, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Lane, Task, TaskStatus } from "../store.ts";
import { STATUS, STATUS_LABEL } from "../lib/constants.ts";
import type { TaskSearchResult } from "../lib/fuzzy.ts";
import {
  UNTAGGED,
  filterTasks,
  gateDone,
  includesDone,
  orderTasks,
  pickActiveTask,
  searchPool,
} from "../lib/taskView.ts";
import type { TaskGroup, TaskSort } from "./config.ts";
import { actionKeyLabels } from "./keys.ts";
import { displayWidth, escapeTerminalText, fitWidth } from "./safety.ts";
import type { TuiSession } from "./session.ts";
import { type ContrastPair, paint, type Seg, seg, style } from "./theme.ts";

/** The list's filter slots (a session's own: they never outlive it). */
export interface TaskFilter {
  readonly status: TaskStatus | null;
  readonly lane: string | null;
  /** OR-composed tag names (the untagged sentinel, src/lib/taskView.ts UNTAGGED, is just a string). */
  readonly tags: readonly string[];
}

/** The empty list's hint: the key that shows done tasks for this session, else the setting. */
function doneHint(s: TuiSession): string {
  const key = actionKeyLabels(s.keys.keys, "toggle_done")[0];
  return key === undefined ? " :config done shows done tasks at every start" : ` ${key} shows done tasks`;
}

/** No structured filter at all. */
export const NO_FILTER: TaskFilter = Object.freeze({ status: null, lane: null, tags: Object.freeze([]) });

/** One session's list view: the search, the filter slots, include-done, the explicit selection and the order. */
export interface WorkspaceView {
  readonly query: string;
  readonly filter: TaskFilter;
  readonly includeDone: boolean;
  readonly selectedId: number | null;
  /** The order without a query (default ascending id). */
  readonly sort?: TaskSort;
  /** The grouping without a query (default none). */
  readonly group?: TaskGroup;
}

/** One group header of a grouped list: `count` rows from `start`. */
export interface WorkspaceGroup {
  /** The lane name or the status. */
  readonly key: string;
  /** Raw text (a lane name is untrusted: escape it before rendering). */
  readonly label: string;
  readonly status: TaskStatus | null;
  readonly start: number;
  readonly count: number;
}

export interface WorkspaceSelection {
  /** Full-pool search results (relevance order), or null without a query. */
  readonly results: readonly TaskSearchResult[] | null;
  /** Tasks passing the query and every slot, in server order, before the include-done gate. */
  readonly filtered: readonly Task[];
  /** The displayed rows in display order. Never capped. */
  readonly rows: readonly Task[];
  /** The explicit selection when it exists (even outside the rows), else the fallback. */
  readonly active: Task | null;
  /** Index of `active` in `rows`; -1 when it is outside them. */
  readonly activeIndex: number;
  /** Whether done tasks show (the toggle, or the Done-view exception). */
  readonly includeDone: boolean;
  /** The order shown: the view's sort, or relevance while a query ranks the results. */
  readonly order: TaskSort | "relevance";
  /** The grouping shown (none while a query ranks the results). */
  readonly group: TaskGroup;
  /** The group headers in display order (empty without grouping). */
  readonly groups: readonly WorkspaceGroup[];
}

/**
 * The list model for `view` over the full task pool. `lanes` is the
 * lane catalog (its order ranks the lane sort and the lane groups).
 */
export function selectWorkspace(
  tasks: readonly Task[],
  view: WorkspaceView,
  lanes: readonly Lane[] = [],
): WorkspaceSelection {
  // The shared src/lib helpers are typed over mutable arrays; none mutates.
  const pool = tasks as Task[];
  const results = searchPool(pool, view.query);
  const { status, lane, tags } = view.filter;
  const filtered = filterTasks(pool, results, { status, lane, tag: tags });
  const includeDone = includesDone(view.includeDone, view.filter);
  const gated = gateDone(filtered, includeDone);
  const base = { results, filtered, active: null, activeIndex: -1, includeDone };
  if (results !== null) {
    // A search keeps the relevance ranking, in one flat list.
    const rows = orderTasks(gated, results);
    return withSelection({ ...base, rows, order: "relevance", group: "none", groups: [] }, pool, view.selectedId);
  }
  const sort = view.sort ?? "id";
  const group = view.group ?? "none";
  const rank = laneRanks(lanes);
  const sorted = sortTasks(gated, sort, lanes, rank);
  const { rows, groups } = groupTasks(sorted, group, rank);
  return withSelection({ ...base, rows, order: sort, group, groups }, pool, view.selectedId);
}

type LaneRank = ReadonlyMap<string, number>;

const laneRanks = (lanes: readonly Lane[]): LaneRank => new Map(lanes.map((l, i) => [l.name, i]));

/** Lanes by the catalog order; lanes missing from it after, by name. */
function compareLanes(a: string, b: string, rank: LaneRank): number {
  const ra = rank.get(a) ?? Number.POSITIVE_INFINITY;
  const rb = rank.get(b) ?? Number.POSITIVE_INFINITY;
  if (ra !== rb) return ra < rb ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

const statusRank = (status: TaskStatus): number => (STATUS as readonly TaskStatus[]).indexOf(status);
// Natural title collation (numeric-aware: task-2 before task-12).
const compareTitles = (a: Task, b: Task): number =>
  a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" });

/**
 * `list` in a `:sort` order (a new array): id, title (natural), lane (the
 * catalog order), status (draft, open, review, blocked, done), priority (P0
 * first, unset last) or updated; a leading `-` reverses the key. Ties always
 * break by ascending id.
 */
export function sortTasks(
  list: readonly Task[],
  sort: TaskSort,
  lanes: readonly Lane[] = [],
  rank: LaneRank = laneRanks(lanes),
): Task[] {
  const desc = sort.startsWith("-");
  const key = (desc ? sort.slice(1) : sort) as "id" | "title" | "lane" | "status" | "priority" | "updated";
  const compare = (a: Task, b: Task): number => {
    switch (key) {
      case "id":
        return a.id - b.id;
      case "title":
        return compareTitles(a, b);
      case "lane":
        return compareLanes(a.lane, b.lane, rank);
      case "status":
        return statusRank(a.status) - statusRank(b.status);
      case "priority": {
        const pa = a.priority ?? Number.POSITIVE_INFINITY;
        const pb = b.priority ?? Number.POSITIVE_INFINITY;
        return pa === pb ? 0 : pa < pb ? -1 : 1;
      }
      case "updated":
        return a.updated - b.updated;
    }
  };
  return [...list].sort((a, b) => {
    const primary = compare(a, b);
    if (primary !== 0) return desc ? -primary : primary;
    return a.id - b.id;
  });
}

/** Stable-group sorted rows by lane (catalog order) or status, with one header per group. */
function groupTasks(sorted: Task[], group: TaskGroup, rank: LaneRank): { rows: Task[]; groups: WorkspaceGroup[] } {
  if (group === "none" || sorted.length === 0) return { rows: sorted, groups: [] };
  const keyOf = (t: Task): string => (group === "lane" ? t.lane : t.status);
  const buckets = new Map<string, Task[]>();
  for (const t of sorted) {
    const bucket = buckets.get(keyOf(t));
    if (bucket === undefined) buckets.set(keyOf(t), [t]);
    else bucket.push(t);
  }
  const keys = [...buckets.keys()].sort((a, b) =>
    group === "lane" ? compareLanes(a, b, rank) : statusRank(a as TaskStatus) - statusRank(b as TaskStatus),
  );
  const rows: Task[] = [];
  const groups: WorkspaceGroup[] = [];
  for (const key of keys) {
    const members = buckets.get(key) ?? [];
    const status = group === "status" ? (key as TaskStatus) : null;
    groups.push({
      key,
      label: status === null ? key : STATUS_LABEL[status],
      status,
      start: rows.length,
      count: members.length,
    });
    rows.push(...members);
  }
  return { rows, groups };
}

/** `selection` with the active task recomputed for an explicit selection; the searched rows are reused. */
export function withSelection(
  selection: WorkspaceSelection,
  tasks: readonly Task[],
  selectedId: number | null,
): WorkspaceSelection {
  const active = pickActiveTask(tasks, selection.filtered as Task[], selectedId, selection.includeDone);
  const activeIndex = active === null ? -1 : selection.rows.findIndex(t => t.id === active.id);
  return { ...selection, active, activeIndex };
}

/** A search or any filter slot is active (include-done is a display preference, not a filter). */
export function hasFilters(view: WorkspaceView): boolean {
  const f = view.filter;
  return view.query.trim() !== "" || f.status !== null || f.lane !== null || f.tags.length > 0;
}

/** :clear — the search and every slot, keeping include-done and the selection. */
export function clearFilters(view: WorkspaceView): WorkspaceView {
  return { ...view, query: "", filter: NO_FILTER };
}

/** An @id reference: clear every filter and select the task; null (no change) when it does not exist. */
export function followTaskRef(view: WorkspaceView, tasks: readonly Task[], id: number): WorkspaceView | null {
  if (!tasks.some(t => t.id === id)) return null;
  return { ...clearFilters(view), selectedId: id };
}

/** A #tag reference: the tag slot becomes exactly that tag. */
export function followTagRef(view: WorkspaceView, name: string): WorkspaceView {
  return { ...view, filter: { ...view.filter, tags: [name] } };
}

/** A header tag label: widen the tag slot with it (idempotent). */
export function appendTagFilter(view: WorkspaceView, name: string): WorkspaceView {
  if (view.filter.tags.includes(name)) return view;
  return { ...view, filter: { ...view.filter, tags: [...view.filter.tags, name] } };
}

/**
 * A motion (j/k, counts, half pages) through the rows: clamped at the ends;
 * from outside the rows it enters at the edge in the direction of travel.
 */
export function moveWithin(rows: readonly Task[], activeId: number | null, delta: number): number | null {
  if (rows.length === 0) return null;
  const at = activeId === null ? -1 : rows.findIndex(t => t.id === activeId);
  const target = at < 0 ? (delta < 0 ? rows.length - 1 : 0) : Math.max(0, Math.min(rows.length - 1, at + delta));
  return rows[target]?.id ?? null;
}

/** The filter picker's counts: per status, lane and tag (plus untagged). */
export interface FilterCounts {
  readonly statuses: Readonly<Record<TaskStatus, number>>;
  /** Lane name -> count, in the pool's order of first appearance. */
  readonly lanes: ReadonlyMap<string, number>;
  /** Tag name -> count, in the pool's order of first appearance. */
  readonly tags: ReadonlyMap<string, number>;
  readonly untagged: number;
}

/**
 * Per-choice counts for the filter picker: each slot's choices are counted
 * over the tasks that pass the search and the OTHER slots, so a count is what
 * choosing it alone in its slot shows. Lanes and tags follow the include-done
 * gate; statuses count done tasks (a done status filter shows them anyway).
 */
export function filterCounts(tasks: readonly Task[], view: WorkspaceView): FilterCounts {
  const pool = tasks as Task[];
  const results = searchPool(pool, view.query);
  const { status, lane, tags } = view.filter;
  const gate = (list: Task[]): Task[] => gateDone(list, includesDone(view.includeDone, view.filter));
  const statuses: Record<TaskStatus, number> = { draft: 0, open: 0, review: 0, blocked: 0, done: 0 };
  for (const t of filterTasks(pool, results, { status: null, lane, tag: tags })) statuses[t.status]++;
  const lanes = new Map<string, number>();
  for (const t of gate(filterTasks(pool, results, { status, lane: null, tag: tags }))) {
    lanes.set(t.lane, (lanes.get(t.lane) ?? 0) + 1);
  }
  const tagCounts = new Map<string, number>();
  let untagged = 0;
  for (const t of gate(filterTasks(pool, results, { status, lane, tag: [] }))) {
    if (t.tags.length === 0) untagged++;
    for (const name of t.tags) tagCounts.set(name, (tagCounts.get(name) ?? 0) + 1);
  }
  return { statuses, lanes, tags: tagCounts, untagged };
}

/** The active search and filter slots as compact chips: `/query status:review lane:x #tag untagged` (raw text). */
export function filterChips(view: WorkspaceView): string[] {
  const chips: string[] = [];
  const q = view.query.trim();
  if (q !== "") chips.push(`/${q}`);
  if (view.filter.status !== null) chips.push(`status:${view.filter.status}`);
  if (view.filter.lane !== null) chips.push(`lane:${view.filter.lane}`);
  for (const name of view.filter.tags) chips.push(tagLabel(name));
  return chips;
}

/** A tag-slot entry as written: `#name`, or `untagged` for the sentinel. */
export function tagLabel(name: string): string {
  return name === UNTAGGED ? "untagged" : `#${name}`;
}

// ---------- the list pane ----------

export const STATUS_MARK: Readonly<Record<TaskStatus, string>> = {
  draft: "○",
  open: "●",
  review: "◐",
  blocked: "■",
  done: "✓",
};

export const statusPair = (status: TaskStatus, surface: "bg" | "panel" | "selection"): ContrastPair =>
  `status.${status}@${surface}`;

/** What the last render drew on a row of the list pane (the shell routes the mouse by it). */
export type ListHit =
  | { readonly kind: "task"; readonly id: number }
  /** The order line: the sort label (a click opens the sort and group picker). */
  | { readonly kind: "sort" }
  /** The filter line: the chips (a click opens the filter picker). */
  | { readonly kind: "filters" }
  /** Anything else in the pane (its label, group headers, blank rows). */
  | { readonly kind: "pane" };

export interface WorkspaceComponent extends Component {
  /** Rows to fill: the shell sets it before each render. */
  height: number;
  /** What row `y` (relative to the pane's top) showed at the last render. */
  hitAt(y: number): ListHit;
}

const PANE: ListHit = { kind: "pane" };

/** The selected row shows its whole title on at most this many lines (R4). */
const SELECTED_TITLE_LINES = 4;

const esc = escapeTerminalText;

/** One painted line of the list: its segments, the surface they sit on, and what a click on it reaches. */
interface ListLine {
  readonly segs: readonly Seg[];
  readonly fill: ContrastPair;
  readonly hit: ListHit;
  /** A task row: its last cell stays blank (the right padding). */
  readonly padded?: boolean;
}

/** A header above each group (never selectable), a blank line around a group, or a row of `rows`. */
type ListEntry = { readonly group: WorkspaceGroup } | { readonly gap: true } | { readonly row: number };

class TaskList implements WorkspaceComponent {
  height = 0;
  /** The first entry (group header or row) shown. */
  #scroll = 0;
  /** What each rendered line shows, for the mouse. */
  #rowHits: ListHit[] = [];
  readonly #session: TuiSession;

  constructor(session: TuiSession) {
    this.#session = session;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const s = this.#session;
    const theme = s.theme;
    const height = Math.max(0, this.height);
    if (theme === null) return Array.from({ length: height }, () => "");
    const fill: ContrastPair = "text@panel";
    const out: string[] = [];
    const rowHits: ListHit[] = [];
    const push = ({ segs, fill: surface, hit, padded }: ListLine): void => {
      // R2: a task row paints one cell short of the width and ends in a blank cell of its surface.
      const inner = padded === true ? Math.max(0, width - 1) : width;
      out.push(
        paint(theme, segs, inner, surface) + (inner < width ? style(theme, surface, " ".repeat(width - inner)) : ""),
      );
      rowHits.push(hit);
    };
    const line = (segs: readonly Seg[], hit: ListHit = PANE): void => push({ segs, fill, hit });
    const sel = s.workspace();
    // The focused pane's label is inverse (never color alone); unfocused, the shell greys the pane.
    const focused = s.focus === "tasks";
    line([
      focused ? seg("accent@panel", " TASKS ", { bold: true, inverse: true }) : seg("muted@panel", " TASKS "),
      seg("dim@panel", ` ${sel.rows.length} shown`),
    ]);
    line(this.#orderLine(sel), { kind: "sort" });
    line(this.#filterLine(sel), { kind: "filters" });
    // S1: comfortable leaves one blank row between the header and whatever follows it.
    if (s.density === "comfortable") line([]);
    const body = Math.max(0, height - out.length);
    if (!s.loaded) line([seg("muted@panel", " Loading…")]);
    else if (sel.rows.length === 0) {
      const empty =
        s.tasks.length === 0
          ? [" No tasks yet", ' cortex add "<title>" creates one']
          : hasFilters(s.listView)
            ? [" No tasks match the filters", " :clear clears them"]
            : [" No open tasks", doneHint(s)];
      for (const text of empty) line([seg("muted@panel", text)]);
    } else {
      for (const entry of this.#visibleLines(sel, width, body)) push(entry);
    }
    while (out.length < height) line([]);
    this.#rowHits = rowHits.slice(0, height);
    return out.slice(0, height);
  }

  /**
   * The body's lines: group headers and task rows from the scroll position.
   * For readability a group never touches what is around it: a blank line
   * above each header and after the last group. Scrolling counts rendered
   * lines (R5): the selected row, expanded, stays whole in view (with its
   * group header and the blank line above when it opens the group, the blank
   * line below when it ends one), and a move past the bottom scrolls just
   * enough.
   */
  #visibleLines(sel: WorkspaceSelection, width: number, body: number): ListLine[] {
    const s = this.#session;
    const entries: ListEntry[] = [];
    let next = 0;
    sel.rows.forEach((_t, i) => {
      const group = sel.groups[next];
      if (group !== undefined && group.start === i) {
        entries.push({ gap: true }, { group });
        next++;
      }
      entries.push({ row: i });
    });
    if (sel.groups.length > 0) entries.push({ gap: true });
    // Comfortable already leaves a blank row above the body (S1): a blank line on top would double it.
    const blankAbove = s.density === "comfortable";
    const selected = sel.activeIndex < 0 ? -1 : entries.findIndex(e => "row" in e && e.row === sel.activeIndex);
    // R1: the @id column fits the widest id of ALL the rows, so it never shifts while scrolling.
    const idWidth = sel.rows.reduce((n, t) => Math.max(n, `@${t.id}`.length), 0);
    const lane = s.listView.filter.lane === null && sel.group !== "lane";
    const active = sel.rows[sel.activeIndex];
    const block =
      selected >= 0 && active !== undefined
        ? this.#taskLines(active, true, idWidth, lane, width, Math.max(1, Math.min(SELECTED_TITLE_LINES, body)))
        : [];
    const heightOf = (i: number): number => (i === selected ? block.length : 1);
    let scroll = this.#scroll;
    if (selected >= 0) {
      let top = selected;
      if ("group" in (entries[top - 1] ?? {})) top--;
      if (top < selected && "gap" in (entries[top - 1] ?? {})) top--;
      const end = "gap" in (entries[selected + 1] ?? {}) ? selected + 1 : selected;
      if (top < scroll) scroll = top;
      let used = 0;
      for (let i = scroll; i <= end; i++) used += heightOf(i);
      while (used > body && scroll < selected) used -= heightOf(scroll++);
    }
    // Never scrolled further than the point from which the rest fills the body.
    let last = entries.length;
    for (let i = entries.length - 1, rest = 0; i >= 0; i--) {
      rest += heightOf(i);
      if (rest > body) break;
      last = i;
    }
    scroll = Math.max(0, Math.min(scroll, last));
    this.#scroll = scroll;
    const lines: ListLine[] = [];
    for (let i = scroll; i < entries.length && lines.length < body; i++) {
      const entry = entries[i];
      if (entry === undefined) continue;
      if ("gap" in entry) {
        if (lines.length > 0 || !blankAbove) lines.push({ segs: [], fill: "text@panel", hit: PANE });
        continue;
      }
      if ("group" in entry) {
        lines.push({ segs: this.#groupHeader(entry.group, width), fill: "text@panel", hit: PANE });
        continue;
      }
      const t = sel.rows[entry.row];
      if (t === undefined) continue;
      lines.push(...(i === selected ? block : this.#taskLines(t, false, idWidth, lane, width, 1)));
    }
    return lines.slice(0, body);
  }

  /**
   * One task's lines: the marker (`▌` when selected), the status glyph, the
   * @id column (`idWidth` cells) and two spaces, then the title (R1); the
   * lane dim and right-aligned when the whole title fits beside it, else
   * omitted (R3); a blank last cell (R2). The selected row wraps its whole
   * title under the title column on at most `limit` lines, the last cut with
   * an ellipsis (R4); other rows are one line, cut with an ellipsis.
   */
  #taskLines(t: Task, selected: boolean, idWidth: number, withLane: boolean, width: number, limit: number): ListLine[] {
    const surface = selected ? "selection" : "panel";
    const fill: ContrastPair = selected ? "text@selection" : "text@panel";
    const hit: ListHit = { kind: "task", id: t.id };
    const lead: Seg[] = [
      selected ? seg("accent@selection", "▌") : seg("text@panel", " "),
      seg(statusPair(t.status, surface), STATUS_MARK[t.status]),
      seg(selected ? "text@selection" : "dim@panel", ` ${`@${t.id}`.padEnd(idWidth)}  `),
    ];
    const leadWidth = lead.reduce((n, x) => n + displayWidth(x.text), 0);
    const room = Math.max(1, width - 1 - leadWidth);
    const title = esc(t.title);
    const wrapped = selected && limit > 1 ? wrapTextWithAnsi(title, room) : [title];
    const texts = wrapped.length === 0 ? [""] : wrapped.slice(0, limit);
    const last = texts.length - 1;
    const cut = wrapped.length > limit || displayWidth(texts[last] ?? "") > room;
    // A cut line ends in an ellipsis right after its last word, never after a space.
    const ellipsis = (text: string): string => `${fitWidth(text, room).slice(0, -1).trimEnd()}…`;
    if (wrapped.length > limit) {
      const lastText = (texts[last] ?? "").trimEnd();
      texts[last] = displayWidth(lastText) < room ? `${lastText}…` : ellipsis(`${lastText}…`);
    } else if (cut) texts[last] = ellipsis(texts[last] ?? "");
    const laneText = withLane ? esc(t.lane) : "";
    return texts.map((text, i) => {
      const segs: Seg[] =
        i === 0 ? [...lead] : [seg("accent@selection", "▌"), seg("text@selection", " ".repeat(leadWidth - 1))];
      segs.push(seg(fill, text, selected ? { bold: true } : undefined));
      // R3 (on the last line): the lane only beside the WHOLE title, ending at the right padding.
      const used = displayWidth(text);
      if (i === texts.length - 1 && laneText !== "" && !cut && used + 2 + displayWidth(laneText) <= room) {
        segs.push(
          seg(fill, " ".repeat(room - used - displayWidth(laneText))),
          seg(selected ? "muted@selection" : "dim@panel", laneText),
        );
      }
      return { segs, fill, hit, padded: true };
    });
  }

  /** `── <label> · <count> ──…` above a group's rows (a status group carries its glyph). */
  #groupHeader(group: WorkspaceGroup, width: number): Seg[] {
    const segs: Seg[] = [seg("border@panel", "── ")];
    if (group.status !== null) segs.push(seg(statusPair(group.status, "panel"), `${STATUS_MARK[group.status]} `));
    segs.push(seg("muted@panel", esc(group.label), { bold: true }), seg("dim@panel", ` · ${group.count} `));
    const used = segs.reduce((n, x) => n + displayWidth(x.text), 0);
    if (used < width) segs.push(seg("border@panel", "─".repeat(width - used)));
    return segs;
  }

  /** The order line: the sort and grouping, or relevance while a search ranks the list. */
  #orderLine(sel: WorkspaceSelection): Seg[] {
    if (sel.order === "relevance") return [seg("text@panel", " "), seg("info@panel", "by relevance (search)")];
    const segs: Seg[] = [seg("text@panel", " "), seg("muted@panel", `sort ${sel.order}`)];
    if (sel.group !== "none") segs.push(seg("muted@panel", ` · group ${sel.group}`));
    return segs;
  }

  #filterLine(sel: WorkspaceSelection): Seg[] {
    const s = this.#session;
    const chips = filterChips(s.listView);
    const segs: Seg[] = [seg("text@panel", " ")];
    if (chips.length === 0) {
      const pick = actionKeyLabels(s.keys.keys, "filters")[0];
      segs.push(seg("dim@panel", `no filters · ${pick === undefined ? ":filter" : `${pick} picks`} · / search`));
    } else segs.push(seg("info@panel", esc(chips.join(" "))));
    if (sel.includeDone) segs.push(seg("muted@panel", " +done"));
    return segs;
  }

  hitAt(y: number): ListHit {
    return this.#rowHits[y] ?? PANE;
  }
}

/** The task-list pane of one session (height set by the shell before rendering). */
export function createWorkspace(session: TuiSession): WorkspaceComponent {
  return new TaskList(session);
}
