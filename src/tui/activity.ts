// The task panels and the update composer.
//
// - The panels (Document/Activity/Related/Authors) are one per-session
//   choice (session.panel):
//   `[`/`]` step through them and :activity/:related/:authors show one. A
//   panel replaces the document body in any Read/Edit/Split mode and at any
//   width; it never changes the saved mode preference.
// - Activity: the selected task's updates newest first, keyed by update id,
//   so the cursor and the expanded cards survive live churn and new cards
//   above keep the one being read in place. A card shows the full author,
//   the relative time and the severity (label and marker, never tint alone);
//   Enter expands it to the whole summary and the body rendered by the
//   terminal reader (src/tui/reader.ts renderDocument, the one safe Markdown
//   boundary), with the Markdown source behind :source. A thread is read
//   with GET /api/tasks/:id/updates (the newest request per task wins),
//   follows `update.posted` frames (deduped by id, kept across a read in
//   flight) and is read again after a snapshot, when frames may have been
//   missed. A failed read waits for an explicit retry (:activity or Enter).
// - Related: GET /api/tasks/:id/related under a request generation, so a
//   slow or failed answer for another task never shows: loading, a
//   task-keyed error with an explicit retry (:related or Enter), a confirmed
//   empty, and the three buckets; Enter follows a row like an @id reference
//   (the list filters clear). Task changes and posts mark it for a re-read.
// - Authors: the per-task rollup of the loaded thread, latest first.
// - The composer (c, ;c, :post): a dialog over the workspace; drafts are per
//   task and per session. Closing it (:q, or Esc then q) keeps the draft,
//   marked in the document header and on the status line; :q! in it
//   discards it. Submit is explicit only (:w or Ctrl-s; Enter is a new line).
//   The author and text are captured at submit, one request is in flight, an
//   identical retry reuses the mutation id (the daemon then posts once even
//   when an answer was lost), the 4096 limit has a visible count, failures
//   are kept beside newer typing, and the draft clears only when the post of
//   its exact revision is acknowledged. The post is a human's: an author
//   (the daemon's /api/me default unless changed) and no notify or status.
// - Every untrusted string (authors, summaries, bodies, titles, errors)
//   crosses src/tui/safety.ts before style().

import type { EditorState } from "@codemirror/state";
import {
  CURSOR_MARKER,
  type Component,
  type Focusable,
  type OverlayHandle,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { newMutationId, TransportError } from "../api.ts";
import type { LiveEvent, PostUpdateResult } from "../contracts.ts";
import type { RelatedTasks, Severity, Task, TaskStatus, Update } from "../store.ts";
import { fmtTime } from "../lib/format.ts";
import { type CommandLine, createCommandLine } from "./commandline.ts";
import { CommandError } from "./commands.ts";
import { DIALOG_MARGIN, DIALOG_WIDTH } from "./dialogs.ts";
import { createDocumentEditor, createEditorState, type DocumentEditor, editorText } from "./editor.ts";
import { insertKeyLabels, type KeyEvent, type KeyMode, printableKey } from "./keys.ts";
import { renderDocument } from "./reader.ts";
import { displayWidth, escapeTerminalLines, escapeTerminalText, fitWidth } from "./safety.ts";
import type { OverlayHost, SessionDialog, TaskPanel, TuiSession } from "./session.ts";
import { type ContrastPair, paint, type ResolvedTheme, type Seg, seg, style } from "./theme.ts";
import { STATUS_MARK, statusPair } from "./workspace.ts";

/** The composer's limit (the updates table checks the same 4096). */
export const MAX_SUMMARY = 4096;
/** The count warns from here. */
const WARN_SUMMARY = 4000;
/** Summary lines a collapsed card shows. */
const COLLAPSED_LINES = 3;
/** Card content indent (the byline has the cursor marker and the disclosure). */
const INDENT = 4;
const DIALOG_MIN_WIDTH = 40;
/** Invalidations inside this window share ONE Related re-read: a busy stream re-reads it at most this often. */
export const RELATED_COALESCE_MS = 250;

/** Severity as the status whose marker and color it borrows (blocked, review, else open). */
const SEVERITY_STATUS: Readonly<Record<Severity, TaskStatus>> = {
  progress: "open",
  review: "review",
  blocked: "blocked",
};

const esc = escapeTerminalText;
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// ---------- state ----------

interface Thread {
  /** Oldest first (the daemon's order); null until a read landed. */
  updates: Update[] | null;
  loading: boolean;
  error: string | null;
  /** A snapshot was applied after the last read: a frame may have been missed. */
  stale: boolean;
  /** The newest request: an older answer never replaces a newer one. */
  request: number;
  /** Frames that arrived while a read was in flight (its answer may predate them). */
  live: Update[];
}

interface RelatedState {
  readonly taskId: number;
  data: RelatedTasks | null;
  loading: boolean;
  error: string | null;
  stale: boolean;
}

/** One task's place in its panels, kept across panel and task switches. */
interface CardState {
  /** The Activity card with the cursor (an update id); null: the newest. */
  cursor: number | null;
  expanded: Set<number>;
  source: Set<number>;
  scroll: number;
  /** Rows between the cursor card and the top of the view, so cards arriving above keep it in place. */
  anchor: number | null;
  /** The cursor moved: bring its card into view. */
  reveal: boolean;
  /** The Related row with the cursor (a task id). */
  related: number | null;
  relatedScroll: number;
  authorsScroll: number;
}

interface Attempt {
  readonly author: string;
  readonly summary: string;
  readonly revision: number;
  readonly mutationId: string;
}

/** One task's unposted update: the composer text (with its cursor and undo), author and last attempt. */
interface PostDraft {
  readonly taskId: number;
  state: EditorState;
  /** Null: the default author at submit time. */
  author: string | null;
  /** Bumped by every text change: an acknowledgement clears only the revision it posted. */
  revision: number;
  /** A submit is in flight (one at a time). */
  busy: boolean;
  /** The last attempt that was not acknowledged: an identical retry reuses its mutation id. */
  attempt: Attempt | null;
  /** Why the last attempt failed, kept until the next attempt or an acknowledgement. */
  error: string | null;
  notice: string | null;
}

/** A composer draft that was not posted (the :q guard names it). */
export interface UnsentPost {
  readonly taskId: number;
  readonly state: "unsent" | "posting" | "failed";
  readonly length: number;
}

interface PanelRow {
  readonly text: string;
  /** The card (update id) or related task (task id) the row belongs to. */
  readonly item: number | null;
}

interface AuthorRollup {
  readonly author: string;
  readonly lastSeen: number;
  readonly posts: number;
}

const byCreated = (a: Update, b: Update): number => a.created - b.created || a.id - b.id;

/** `list` plus the updates of `extra` it lacks (by id), oldest first. */
function merge(list: readonly Update[], extra: readonly Update[]): Update[] {
  const byId = new Map<number, Update>();
  for (const u of list) byId.set(u.id, u);
  for (const u of extra) if (!byId.has(u.id)) byId.set(u.id, u);
  return [...byId.values()].sort(byCreated);
}

function isUpdate(value: unknown): value is Update {
  const u = value as Partial<Update> | null;
  return (
    typeof u === "object" &&
    u !== null &&
    typeof u.id === "number" &&
    typeof u.task_id === "number" &&
    typeof u.author === "string" &&
    typeof u.summary === "string" &&
    typeof u.created === "number"
  );
}

/** The per-task author rollup: posts per author and the latest post, latest first. */
function rollupAuthors(updates: readonly Update[]): AuthorRollup[] {
  const by = new Map<string, { lastSeen: number; posts: number }>();
  for (const u of updates) {
    const row = by.get(u.author);
    if (row === undefined) by.set(u.author, { lastSeen: u.created, posts: 1 });
    else {
      row.posts++;
      if (u.created > row.lastSeen) row.lastSeen = u.created;
    }
  }
  return [...by.entries()].map(([author, r]) => ({ author, ...r })).sort((a, b) => b.lastSeen - a.lastSeen);
}

/** The id `delta` places from `current` in `ids` (clamped); from none, the first. */
function step(ids: readonly number[], current: number | null, delta: number): number | null {
  if (ids.length === 0) return null;
  const at = current === null ? 0 : Math.max(0, ids.indexOf(current));
  return ids[Math.max(0, Math.min(ids.length - 1, at + delta))] ?? null;
}

/** `current` when it is still listed, else the first. */
function resolve(ids: readonly number[], current: number | null): number | null {
  return current !== null && ids.includes(current) ? current : (ids[0] ?? null);
}

/** A post's failure: an uncertain one may have been posted, and only the same text resends it safely. */
function postFailure(err: unknown): string {
  if (err instanceof TransportError && err.uncertain) {
    return `the answer was lost (${err.message}), so it may have been posted: :w with the same text sends it again safely (it is posted once)`;
  }
  return errorText(err);
}

/** Drop graphemes from the start until `text` fits in `width` cells. */
function tailFit(text: string, width: number): string {
  let out = text;
  while (displayWidth(out) > width && out !== "") {
    const first = graphemes.segment(out)[Symbol.iterator]().next();
    out = first.done ? "" : out.slice(first.value.segment.length);
  }
  return out;
}

// ---------- the panels ----------

/** The task panels of one session (the shell sets `height` before each render) and its update composer. */
export class Activity implements Component {
  /** Rows to fill: the shell sets it before each render. */
  height = 0;
  readonly #session: TuiSession;
  readonly #threads = new Map<number, Thread>();
  #related: RelatedState | null = null;
  #relatedGen = 0;
  /** The coalescing window of a stale Related panel (cancels it); null when none is open. */
  #relatedTimer: (() => void) | null = null;
  readonly #cards = new Map<number, CardState>();
  readonly #drafts = new Map<number, PostDraft>();
  #me: string | null = null;
  #meLoad: Promise<string> | null = null;
  #composer: Composer | null = null;
  /** Rendered update bodies by update, width and view, for one theme. */
  #bodies = new Map<string, readonly string[]>();
  #bodiesTheme: ResolvedTheme | null = null;
  /** The last render's rows (row scrolling finds the card at the top). */
  #layout: { taskId: number; panel: TaskPanel; rows: readonly PanelRow[] } | null = null;

  constructor(session: TuiSession) {
    this.#session = session;
  }

  invalidate(): void {
    this.#bodies.clear();
  }

  // ---------- session hooks ----------

  /** One applied live frame, in stream order: posts join their thread; task changes can move Related rows. */
  live(event: LiveEvent): void {
    switch (event.kind) {
      case "update.posted":
        if (isUpdate(event.payload)) this.#insert(event.payload);
        this.#relatedChanged();
        return;
      case "task.removed": {
        const id = (event.payload as { id?: unknown } | null)?.id;
        if (typeof id === "number") this.#forget(id, "was deleted");
        this.#relatedChanged();
        return;
      }
      case "task.added":
      case "task.updated":
        this.#relatedChanged();
        return;
      default:
        return;
    }
  }

  /**
   * A frame the applied workspace snapshot already covers (buffered while it
   * was read). A snapshot carries no updates, so a post still joins a thread
   * read (or being read) before it; nothing else of the frame applies again.
   */
  covered(event: LiveEvent): void {
    if (event.kind === "update.posted" && isUpdate(event.payload)) this.#insert(event.payload);
  }

  /**
   * A workspace snapshot was applied. When frames may have been missed, every
   * thread is read again when shown; a catalog-only snapshot (nothing missed)
   * can move only the Related buckets (shared tags).
   */
  refreshed(missed = true): void {
    if (missed) for (const thread of this.#threads.values()) thread.stale = true;
    this.#relatedChanged();
    const ids = new Set(this.#session.tasks.map(t => t.id));
    for (const id of new Set([...this.#threads.keys(), ...this.#drafts.keys(), ...this.#cards.keys()])) {
      if (!ids.has(id)) this.#forget(id, "was deleted");
    }
  }

  /** The database was replaced: nothing read or drafted here belongs to it. */
  reset(why: string): void {
    for (const id of [...this.#drafts.keys()]) this.#forget(id, why);
    this.#threads.clear();
    this.#cards.clear();
    this.#related = null;
    this.#relatedGen++;
    this.#relatedTimer?.();
    this.#relatedTimer = null;
    this.#layout = null;
  }

  /** Composer drafts that were not posted, by task (the application :q names them). */
  unsent(): UnsentPost[] {
    return [...this.#drafts.values()]
      .filter(d => d.busy || editorText(d.state).trim() !== "")
      .sort((a, b) => a.taskId - b.taskId)
      .map(d => ({
        taskId: d.taskId,
        state: d.busy ? "posting" : d.error !== null ? "failed" : "unsent",
        length: editorText(d.state).length,
      }));
  }

  /** The application :q!: drop every composer draft (a post in flight still lands). */
  discard(): void {
    this.#composer?.close();
    this.#drafts.clear();
  }

  #forget(taskId: number, why: string): void {
    const draft = this.#drafts.get(taskId);
    if (draft !== undefined) {
      this.#drafts.delete(taskId);
      const text = editorText(draft.state);
      if (text.trim() !== "") {
        this.#session.notify("warn", `@${taskId} ${why}; its unsent update was discarded: ${JSON.stringify(text)}`);
      }
    }
    if (this.#composer?.taskId === taskId) this.#composer.close();
    this.#threads.delete(taskId);
    this.#cards.delete(taskId);
  }

  /**
   * Something that can move the Related buckets changed: the shown answer is
   * stale. While the panel is shown, ONE re-read follows when the coalescing
   * window closes (the timer only asks for a frame; the render re-reads for
   * the task shown THEN, so a window opened for another task reads nothing
   * for it). Hidden, it is read when next shown.
   */
  #relatedChanged(): void {
    const r = this.#related;
    if (r === null) return;
    r.stale = true;
    if (this.#relatedTimer !== null || this.#session.panel !== "related") return;
    this.#relatedTimer = this.#session.schedule(() => {
      this.#relatedTimer = null;
      this.#session.redraw();
    }, RELATED_COALESCE_MS);
  }

  // ---------- reads ----------

  #thread(taskId: number): Thread {
    let thread = this.#threads.get(taskId);
    if (thread === undefined) {
      thread = { updates: null, loading: false, error: null, stale: false, request: 0, live: [] };
      this.#threads.set(taskId, thread);
    }
    return thread;
  }

  /** Read a thread that was never read or went stale; a failure waits for an explicit retry (`force`). */
  #ensureThread(taskId: number, force = false): Thread {
    const thread = this.#thread(taskId);
    if (thread.loading) return thread;
    if (!force && (thread.error !== null || (thread.updates !== null && !thread.stale))) return thread;
    thread.loading = true;
    thread.stale = false;
    thread.error = null;
    thread.live = [];
    const request = ++thread.request;
    let pending: Promise<Update[]>;
    try {
      pending = this.#session.client.updates(taskId);
    } catch (err) {
      pending = Promise.reject(err);
    }
    const current = () => this.#threads.get(taskId) === thread && thread.request === request;
    void pending
      .then(
        list => {
          if (!current()) return;
          thread.loading = false;
          thread.updates = merge(list, thread.live);
          thread.live = [];
        },
        err => {
          if (!current()) return;
          thread.loading = false;
          thread.error = errorText(err);
          thread.live = [];
        },
      )
      .finally(() => this.#session.redraw());
    return thread;
  }

  /** A post (a live frame or an acknowledgement) joins its thread once. */
  #insert(update: Update): void {
    const thread = this.#threads.get(update.task_id);
    if (thread === undefined) return; // never read: it is read when shown
    if (thread.loading && !thread.live.some(u => u.id === update.id)) thread.live.push(update);
    if (thread.updates !== null && !thread.updates.some(u => u.id === update.id)) {
      thread.updates = merge(thread.updates, [update]);
    }
  }

  /** Read Related for a task (one slot, under a generation); a failure waits for an explicit retry (`force`). */
  #ensureRelated(taskId: number, force = false): RelatedState {
    const current = this.#related;
    if (current !== null && current.taskId === taskId) {
      if (current.loading) return current;
      if (!force && (current.error !== null || (current.data !== null && !current.stale))) return current;
      // Stale: the answer shown stays until the coalescing window closes.
      if (!force && current.data !== null && this.#relatedTimer !== null) return current;
    }
    const gen = ++this.#relatedGen;
    const state: RelatedState = {
      taskId,
      data: current?.taskId === taskId ? current.data : null,
      loading: true,
      error: null,
      stale: false,
    };
    this.#related = state;
    let pending: Promise<RelatedTasks>;
    try {
      pending = this.#session.client.related(taskId);
    } catch (err) {
      pending = Promise.reject(err);
    }
    void pending
      .then(
        data => {
          if (gen !== this.#relatedGen) return; // superseded (another task, or a newer read)
          state.loading = false;
          state.data = data;
          // Changed while this read was in flight: one more read, after the window.
          if (state.stale) this.#relatedChanged();
        },
        err => {
          if (gen !== this.#relatedGen) return;
          state.loading = false;
          state.error = errorText(err);
        },
      )
      .finally(() => this.#session.redraw());
    return state;
  }

  /** :activity / :related / :authors (and Enter on a failure): read what the panel needs now, retrying a failure. */
  retry(panel: TaskPanel): void {
    const task = this.#session.selectedTask();
    if (task === null) return;
    if (panel === "related") {
      const r = this.#related;
      this.#ensureRelated(task.id, r !== null && r.taskId === task.id && r.error !== null);
    } else if (panel !== "document") this.#ensureThread(task.id, this.#threads.get(task.id)?.error != null);
    this.#session.redraw();
  }

  // ---------- navigation ----------

  #card(taskId: number): CardState {
    let card = this.#cards.get(taskId);
    if (card === undefined) {
      card = {
        cursor: null,
        expanded: new Set(),
        source: new Set(),
        scroll: 0,
        anchor: null,
        reveal: false,
        related: null,
        relatedScroll: 0,
        authorsScroll: 0,
      };
      this.#cards.set(taskId, card);
    }
    return card;
  }

  #newestFirst(taskId: number): Update[] {
    return [...(this.#threads.get(taskId)?.updates ?? [])].reverse();
  }

  #relatedIds(taskId: number): number[] {
    const r = this.#related;
    if (r === null || r.taskId !== taskId || r.data === null) return [];
    return [...r.data.referencedBy, ...r.data.references, ...r.data.shared].map(t => t.id);
  }

  /** j/k (with a count): the next or previous card or related task; Authors scrolls. */
  move(delta: number): void {
    const task = this.#session.selectedTask();
    if (task === null) return;
    const card = this.#card(task.id);
    const panel = this.#session.panel;
    if (panel === "activity") {
      const ids = this.#newestFirst(task.id).map(u => u.id);
      card.cursor = step(ids, resolve(ids, card.cursor), delta);
      card.reveal = true;
    } else if (panel === "related") {
      const ids = this.#relatedIds(task.id);
      card.related = step(ids, resolve(ids, card.related), delta);
    } else if (panel === "authors") card.authorsScroll = Math.max(0, card.authorsScroll + delta);
    this.#session.redraw();
  }

  /** g/G, Home/End: the first or last entry. */
  edge(edge: "first" | "last"): void {
    this.move(edge === "first" ? -Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER);
  }

  /** Ctrl-d/Ctrl-u, PageUp/PageDown: scroll by rows (Activity puts the cursor on the card at the top). */
  scroll(delta: number): void {
    const task = this.#session.selectedTask();
    if (task === null) return;
    const panel = this.#session.panel;
    if (panel === "related") {
      this.move(delta);
      return;
    }
    const card = this.#card(task.id);
    if (panel === "authors") card.authorsScroll = Math.max(0, card.authorsScroll + delta);
    else if (panel === "activity") {
      const layout = this.#layout;
      const rows = layout !== null && layout.taskId === task.id && layout.panel === "activity" ? layout.rows : [];
      card.scroll = Math.max(0, Math.min(card.scroll + delta, Math.max(0, rows.length - this.height)));
      const top = rows.slice(card.scroll).find(r => r.item !== null)?.item ?? null;
      if (top !== null) card.cursor = top;
      card.anchor = null;
      card.reveal = false;
    }
    this.#session.redraw();
  }

  /** Enter: expand or collapse the Activity card, follow the Related row; on a failure, retry. */
  activate(): void {
    const task = this.#session.selectedTask();
    if (task === null) return;
    const panel = this.#session.panel;
    const card = this.#card(task.id);
    if (panel === "activity") {
      const thread = this.#threads.get(task.id);
      if (thread?.error != null) {
        this.retry(panel);
        return;
      }
      const id = resolve(
        this.#newestFirst(task.id).map(u => u.id),
        card.cursor,
      );
      if (id === null) return;
      card.cursor = id;
      if (card.expanded.has(id)) card.expanded.delete(id);
      else card.expanded.add(id);
      card.reveal = true;
    } else if (panel === "related") {
      const r = this.#related;
      if (r !== null && r.taskId === task.id && r.error !== null) {
        this.retry(panel);
        return;
      }
      const id = resolve(this.#relatedIds(task.id), card.related);
      if (id !== null) this.#session.followTaskRef(id);
    }
    this.#session.redraw();
  }

  /** :source in the Activity panel: the highlighted card's Markdown source instead of its rendering (it expands). */
  toggleSource(): void {
    const task = this.#session.selectedTask();
    if (task === null) throw new CommandError("No task selected: :open <id> picks one");
    const card = this.#card(task.id);
    const list = this.#newestFirst(task.id);
    const id = resolve(
      list.map(u => u.id),
      card.cursor,
    );
    const shown = list.find(u => u.id === id);
    if (shown === undefined) throw new CommandError(`@${task.id} has no updates yet`);
    if (!shown.body?.trim()) throw new CommandError("This update has no body: its summary is the whole update");
    card.cursor = shown.id;
    card.expanded.add(shown.id);
    if (card.source.has(shown.id)) card.source.delete(shown.id);
    else card.source.add(shown.id);
    card.reveal = true;
    this.#session.redraw();
  }

  // ---------- rendering ----------

  /** The divider label of the panel shown: its name and how many entries it has. */
  title(): string {
    const task = this.#session.selectedTask();
    const panel = this.#session.panel;
    const updates = task === null ? null : (this.#threads.get(task.id)?.updates ?? null);
    if (panel === "activity") return updates === null ? "ACTIVITY" : `ACTIVITY · ${updates.length} · newest first`;
    if (panel === "authors") return updates === null ? "AUTHORS" : `AUTHORS · ${rollupAuthors(updates).length}`;
    return panel.toUpperCase();
  }

  render(width: number): string[] {
    const theme = this.#session.theme;
    const height = Math.max(0, this.height);
    if (theme === null || width <= 0) return Array.from({ length: height }, () => "");
    if (this.#bodiesTheme !== theme) {
      this.#bodies.clear();
      this.#bodiesTheme = theme;
    }
    const task = this.#session.selectedTask();
    const panel = this.#session.panel;
    const row = (segs: readonly Seg[], item: number | null = null): PanelRow => ({
      text: paint(theme, [seg("text@bg", " "), ...segs], width, "text@bg"),
      item,
    });
    let rows: PanelRow[] = [];
    let scroll = 0;
    if (task === null) rows = [row([seg("muted@bg", "Select a task to see its panels")])];
    else if (panel === "activity") {
      rows = this.#activityRows(theme, task, width, row);
      scroll = this.#activityScroll(task.id, rows, height);
    } else if (panel === "related") {
      rows = this.#relatedRows(task, row);
      const card = this.#card(task.id);
      const at = rows.findIndex(r => r.item !== null && r.item === resolve(this.#relatedIds(task.id), card.related));
      scroll = Math.max(0, Math.min(card.relatedScroll, Math.max(0, rows.length - height)));
      if (at >= 0 && at < scroll) scroll = at;
      else if (at >= scroll + height) scroll = at - height + 1;
      card.relatedScroll = scroll;
    } else if (panel === "authors") {
      rows = this.#authorRows(task, width, row);
      const card = this.#card(task.id);
      scroll = Math.max(0, Math.min(card.authorsScroll, Math.max(0, rows.length - height)));
      card.authorsScroll = scroll;
    }
    this.#layout = task === null ? null : { taskId: task.id, panel, rows };
    const out = rows.slice(scroll, scroll + height).map(r => r.text);
    while (out.length < height) out.push(paint(theme, [], width, "text@bg"));
    return out;
  }

  /** Where the Activity view starts: the cursor card stays where it was read, and a moved cursor comes into view. */
  #activityScroll(taskId: number, rows: readonly PanelRow[], height: number): number {
    const card = this.#card(taskId);
    const cursor = resolve(
      this.#newestFirst(taskId).map(u => u.id),
      card.cursor,
    );
    const first = cursor === null ? -1 : rows.findIndex(r => r.item === cursor);
    const last = cursor === null ? -1 : rows.findLastIndex(r => r.item === cursor);
    let scroll = card.scroll;
    if (first >= 0) {
      if (card.reveal) {
        if (first < scroll) scroll = first;
        else if (last >= scroll + height) scroll = Math.min(first, last - height + 1);
      } else if (card.anchor !== null) scroll = first - card.anchor;
      else if (last < scroll || first >= scroll + height) scroll = first;
    }
    scroll = Math.max(0, Math.min(scroll, Math.max(0, rows.length - height)));
    card.reveal = false;
    card.scroll = scroll;
    card.anchor = first >= 0 ? first - scroll : null;
    return scroll;
  }

  #activityRows(
    theme: ResolvedTheme,
    task: Task,
    width: number,
    row: (segs: readonly Seg[], item?: number | null) => PanelRow,
  ): PanelRow[] {
    const thread = this.#ensureThread(task.id);
    if (thread.updates === null) {
      if (thread.error !== null) {
        return [
          row([seg("danger@bg", `error: could not load the activity: ${esc(thread.error)}`)]),
          row([seg("muted@bg", ":activity retries (or Enter)")]),
        ];
      }
      return [row([seg("muted@bg", "Loading the activity…")])];
    }
    const rows: PanelRow[] = [];
    if (thread.error !== null) {
      rows.push(row([seg("warn@bg", `Could not refresh the activity: ${esc(thread.error)} · :activity retries`)]));
    }
    const list = this.#newestFirst(task.id);
    if (list.length === 0) {
      rows.push(row([seg("muted@bg", "No updates yet · c posts one")]));
      return rows;
    }
    const card = this.#card(task.id);
    const cursor = resolve(
      list.map(u => u.id),
      card.cursor,
    );
    list.forEach((u, i) => {
      if (i > 0) rows.push(row([]));
      rows.push(...this.#cardRows(theme, task, u, width, u.id === cursor, card));
    });
    return rows;
  }

  #cardRows(
    theme: ResolvedTheme,
    task: Task,
    u: Update,
    width: number,
    selected: boolean,
    card: CardState,
  ): PanelRow[] {
    const expanded = card.expanded.has(u.id);
    const hasBody = (u.body ?? "").trim() !== "";
    const status = SEVERITY_STATUS[u.severity] ?? "open";
    const pad = " ".repeat(INDENT);
    const inner = Math.max(1, width - INDENT);
    const line = (segs: readonly Seg[]): PanelRow => ({ text: paint(theme, segs, width, "text@bg"), item: u.id });
    const rows: PanelRow[] = [
      line([
        selected ? seg("accent@bg", "▌") : seg("text@bg", " "),
        seg("muted@bg", expanded ? "▾ " : "▸ "),
        seg("text@bg", esc(u.author), selected ? { bold: true } : undefined),
        seg("muted@bg", ` · ${fmtTime(u.created)} · `),
        seg(statusPair(status, "bg"), `${STATUS_MARK[status]} ${esc(u.severity)}`),
        ...(hasBody && !expanded ? [seg("dim@bg", " · has a body")] : []),
      ]),
    ];
    const summary = escapeTerminalLines(u.summary).flatMap(l => (l === "" ? [""] : wrapTextWithAnsi(l, inner)));
    let shown = summary;
    if (!expanded && summary.length > COLLAPSED_LINES) {
      shown = summary.slice(0, COLLAPSED_LINES);
      shown[COLLAPSED_LINES - 1] = fitWidth(`${shown[COLLAPSED_LINES - 1] ?? ""}…`, inner);
    }
    for (const text of shown) rows.push(line([seg("text@bg", pad), seg("text@bg", text)]));
    if (!expanded) return rows;
    if (!hasBody) {
      rows.push(line([seg("text@bg", pad), seg("muted@bg", "No body: the summary is the whole update")]));
      return rows;
    }
    const sourceView = card.source.has(u.id);
    rows.push(line([]));
    const margin = style(theme, "text@bg", pad);
    for (const text of this.#body(theme, task.id, u, inner, sourceView)) rows.push({ text: margin + text, item: u.id });
    rows.push(
      line([
        seg("text@bg", pad),
        seg(
          "dim@bg",
          sourceView ? "Markdown source · :source renders it" : "Rendered · :source shows the Markdown source",
        ),
      ]),
    );
    return rows;
  }

  /** An update body through the terminal reader (rendered, or its escaped source), cached per width and view. */
  #body(theme: ResolvedTheme, taskId: number, u: Update, width: number, sourceView: boolean): readonly string[] {
    const key = `${u.id}\u0000${width}\u0000${sourceView}`;
    let rows = this.#bodies.get(key);
    if (rows === undefined) {
      rows = renderDocument(u.body ?? "", { taskId, width, theme, sourceView });
      this.#bodies.set(key, rows);
    }
    return rows;
  }

  #relatedRows(task: Task, row: (segs: readonly Seg[], item?: number | null) => PanelRow): PanelRow[] {
    const r = this.#ensureRelated(task.id);
    if (r.error !== null) {
      return [
        row([seg("danger@bg", `error: could not load related tasks: ${esc(r.error)}`)]),
        row([seg("muted@bg", ":related retries (or Enter)")]),
      ];
    }
    const data = r.data;
    if (data === null) return [row([seg("muted@bg", "Loading related tasks…")])];
    const card = this.#card(task.id);
    const cursor = resolve(this.#relatedIds(task.id), card.related);
    const rows: PanelRow[] = [];
    const sections: readonly [string, readonly Task[], string][] = [
      ["REFERENCED BY", data.referencedBy, "no inbound references"],
      ["REFERENCES", data.references, "no outbound references"],
      ["SHARED TAGS", data.shared, "no shared tags"],
    ];
    sections.forEach(([heading, list, empty], i) => {
      if (i > 0) rows.push(row([]));
      rows.push(row([seg("accent@bg", `${heading} · ${list.length}`, { bold: true })]));
      if (list.length === 0) rows.push(row([seg("muted@bg", `  ${empty}`)]));
      for (const t of list) {
        const on = t.id === cursor;
        rows.push(
          row(
            [
              on ? seg("accent@bg", "▌") : seg("text@bg", " "),
              seg("text@bg", " "),
              seg("dim@bg", `[${t.id}]`),
              seg("text@bg", ` ${esc(t.title)}`, on ? { bold: true } : undefined),
            ],
            t.id,
          ),
        );
      }
    });
    return rows;
  }

  #authorRows(task: Task, width: number, row: (segs: readonly Seg[], item?: number | null) => PanelRow): PanelRow[] {
    const thread = this.#ensureThread(task.id);
    if (thread.updates === null) {
      if (thread.error !== null) {
        return [
          row([seg("danger@bg", `error: could not load the activity: ${esc(thread.error)}`)]),
          row([seg("muted@bg", ":authors retries")]),
        ];
      }
      return [row([seg("muted@bg", "Loading the authors…")])];
    }
    const rollup = rollupAuthors(thread.updates);
    if (rollup.length === 0) return [row([seg("muted@bg", "No authors on this task yet")])];
    const names = rollup.map(a => esc(a.author));
    const nameWidth = Math.max(6, Math.min(Math.max(...names.map(n => displayWidth(n))), Math.max(6, width - 26)));
    const cell = (text: string, cells: number) => {
      const shown = fitWidth(text, cells);
      return shown + " ".repeat(Math.max(0, cells - displayWidth(shown)));
    };
    const rows: PanelRow[] = [
      row([seg("muted@bg", `${cell("AUTHOR", nameWidth)}  ${cell("LAST SEEN", 10)}  POSTS`, { bold: true })]),
    ];
    rollup.forEach((a, i) => {
      rows.push(
        row([
          seg("text@bg", cell(names[i] ?? "", nameWidth)),
          seg("muted@bg", `  ${cell(fmtTime(a.lastSeen), 10)}  `),
          seg("text@bg", String(a.posts)),
        ]),
      );
    });
    return rows;
  }

  // ---------- the composer ----------

  /** The daemon's default author (/api/me), read once. */
  defaultAuthor(): Promise<string> {
    if (this.#me !== null) return Promise.resolve(this.#me);
    if (this.#meLoad === null) {
      let request: Promise<{ author: string }>;
      try {
        request = this.#session.client.me();
      } catch (err) {
        request = Promise.reject(err);
      }
      const load = request.then(answer => {
        const author = typeof answer?.author === "string" ? answer.author.trim() : "";
        if (author === "") throw new Error("the daemon reported no default author");
        this.#me = author;
        return author;
      });
      this.#meLoad = load;
      load.then(
        () => {
          this.#meLoad = null;
        },
        () => {
          this.#meLoad = null;
        },
      );
    }
    return this.#meLoad;
  }

  /** The default author once known (null before). */
  get knownAuthor(): string | null {
    return this.#me;
  }

  #draftFor(taskId: number): PostDraft {
    let draft = this.#drafts.get(taskId);
    if (draft === undefined) {
      draft = {
        taskId,
        state: createEditorState(""),
        author: null,
        revision: 0,
        busy: false,
        attempt: null,
        error: null,
        notice: null,
      };
      this.#drafts.set(taskId, draft);
    }
    return draft;
  }

  /** The task's unposted text, or null when it has none. */
  draftText(taskId: number): string | null {
    const draft = this.#drafts.get(taskId);
    const text = draft === undefined ? "" : editorText(draft.state);
    return text === "" ? null : text;
  }

  /** The document header's marker for a task's composer draft: posting, a failure or unsent text; null: none (or its composer is open). */
  marker(taskId: number): Seg[] | null {
    const draft = this.#drafts.get(taskId);
    if (draft === undefined || this.#composer?.taskId === taskId) return null;
    if (draft.busy) return [seg("warn@bg", "◌ Posting the update…")];
    const length = editorText(draft.state).length;
    if (editorText(draft.state).trim() === "") return null;
    if (draft.error !== null) {
      return [
        seg("danger@bg", "✗ Update not posted: "),
        seg("text@bg", esc(draft.error)),
        seg("muted@bg", " · c reopens it, :w there retries"),
      ];
    }
    return [seg("warn@bg", `✎ Unsent update (${length}/${MAX_SUMMARY})`), seg("muted@bg", " · c reopens it")];
  }

  /** `c`, `;c`, `:post`: the composer for a task, in INSERT, with its kept draft. */
  openComposer(taskId: number): void {
    const host = this.#session.overlayHost;
    if (host === null) throw new CommandError("The update composer needs the terminal workspace");
    const task = this.#session.tasks.find(t => t.id === taskId);
    if (task === undefined) throw new CommandError(`No task @${taskId}`);
    if (this.#composer !== null) {
      if (this.#composer.taskId === taskId) return;
      this.#composer.close();
    }
    const composer = new Composer(this, this.#session, host, this.#draftFor(taskId), task.title);
    this.#composer = composer;
    composer.show();
    if (this.#me === null) {
      this.defaultAuthor().then(
        author => composer.authorKnown(author),
        err =>
          this.#session.notify(
            "warn",
            `Could not read the default author (${errorText(err)}): type one in the composer's Author field (Tab)`,
          ),
      );
    }
  }

  /** @internal The composer closed. */
  composerClosed(composer: Composer): void {
    if (this.#composer === composer) this.#composer = null;
    this.#session.redraw();
  }

  /** The composer's :q!: forget the task's draft. */
  discardDraft(taskId: number): void {
    this.#drafts.delete(taskId);
    this.#session.redraw();
  }

  /** `:post <text>`: post it now; a failure keeps it as the task's draft (c reopens it, :w retries). */
  async postText(taskId: number, text: string): Promise<void> {
    const draft = this.#drafts.get(taskId);
    const existing = draft === undefined ? "" : editorText(draft.state);
    if (draft?.busy) throw new CommandError(`Still posting the update to @${taskId}: wait for its answer`);
    if (existing.trim() !== "" && existing !== text) {
      throw new CommandError(
        `@${taskId} has an unsent update draft: c opens it (:w there posts it); :post <text> posts only when there is none`,
      );
    }
    const target = this.#draftFor(taskId);
    if (existing !== text) {
      target.state = createEditorState(text, { cursor: text.length });
      target.revision++;
    }
    await this.submit(taskId);
  }

  /**
   * The composer's :w (and Ctrl-s): post the task's draft once. The author
   * and text are captured now; errors are reported (never thrown) and keep
   * the draft; an identical retry reuses the last attempt's mutation id. It
   * posts only to the database it was submitted against (a replacement while
   * the default author is read posts nothing).
   */
  async submit(taskId: number): Promise<void> {
    const session = this.#session;
    const database = session.databaseGeneration;
    const draft = this.#drafts.get(taskId);
    if (draft === undefined || editorText(draft.state).trim() === "") {
      session.notify("error", "Nothing to post: write the update first");
      return;
    }
    if (draft.busy) {
      session.notify("info", `Still posting the update to @${taskId}: wait for its answer`);
      return;
    }
    // Captured NOW: typing after this is a newer revision and never part of this post.
    const summary = editorText(draft.state);
    const revision = draft.revision;
    const typedAuthor = draft.author;
    if (summary.length > MAX_SUMMARY) {
      session.notify(
        "error",
        `The update is ${summary.length} characters: the limit is ${MAX_SUMMARY} (${summary.length - MAX_SUMMARY} over)`,
      );
      return;
    }
    draft.busy = true;
    draft.error = null;
    draft.notice = null;
    session.redraw();
    try {
      const author = (
        typedAuthor ??
        (await this.defaultAuthor().catch((err: unknown) => {
          throw new CommandError(
            `could not read the default author (${errorText(err)}): type one in the Author field (Tab)`,
          );
        }))
      ).trim();
      if (author === "") throw new CommandError("the author is empty: type one in the Author field (Tab)");
      const previous = draft.attempt;
      const same = previous !== null && previous.author === author && previous.summary === summary;
      const attempt: Attempt = {
        author,
        summary,
        revision,
        mutationId: same && previous !== null ? previous.mutationId : newMutationId(),
      };
      draft.attempt = attempt;
      // A human's post: an author, no notify, no status.
      const result = await session.mutate(
        client => client.versioned.postUpdate(taskId, { author, summary }, { mutationId: attempt.mutationId }),
        database,
      );
      this.#acknowledged(draft, attempt, result);
    } catch (err) {
      const why = postFailure(err);
      if (this.#drafts.get(taskId) === draft) draft.error = why;
      session.notify("error", `Update to @${taskId} not posted: ${why}`);
    } finally {
      draft.busy = false;
      session.redraw();
    }
  }

  #acknowledged(draft: PostDraft, attempt: Attempt, result: PostUpdateResult): void {
    const taskId = draft.taskId;
    this.#insert(result.update);
    const current = this.#drafts.get(taskId) === draft;
    if (current) {
      draft.attempt = null;
      draft.error = null;
    }
    if (current && draft.revision === attempt.revision) {
      // Exactly the text that was posted: done. The author choice stays for the next post.
      draft.state = createEditorState("");
      draft.revision++;
      if (draft.author === null) this.#drafts.delete(taskId);
      const composer = this.#composer;
      if (composer !== null && composer.taskId === taskId) {
        composer.close();
        if (this.#session.selectedTask()?.id === taskId) this.#session.setPanel("activity");
      }
    } else if (current) draft.notice = "Posted; you typed more since: :w posts that too";
    const replayed = result.replayed ? " (the daemon already had it: it is posted once)" : "";
    this.#session.notify("info", `Posted an update to @${taskId}${replayed}`);
  }
}

// ---------- the composer dialog ----------

type ComposerField = "summary" | "author";

/** The update composer: a dialog (session.pushDialog) over the workspace for one task's draft. */
class Composer implements Component, Focusable, SessionDialog {
  /** Set by the toolkit while the overlay has the keyboard (IME cursor placement). */
  focused = false;
  readonly label = "post update";
  readonly taskId: number;
  readonly #activity: Activity;
  readonly #session: TuiSession;
  readonly #host: OverlayHost;
  readonly #draft: PostDraft;
  readonly #title: string;
  readonly #editor: DocumentEditor;
  #author: CommandLine;
  #field: ComposerField = "summary";
  #mode: KeyMode = "INSERT";
  #overlay: OverlayHandle | null = null;
  #closed = false;

  constructor(activity: Activity, session: TuiSession, host: OverlayHost, draft: PostDraft, title: string) {
    this.#activity = activity;
    this.#session = session;
    this.#host = host;
    this.#draft = draft;
    this.#title = title;
    this.taskId = draft.taskId;
    this.#editor = createDocumentEditor(draft.state, state => {
      draft.state = state;
      draft.revision++;
      draft.notice = null;
      session.redraw();
    });
    this.#author = this.#authorLine(draft.author ?? activity.knownAuthor ?? "");
  }

  #authorLine(initial: string): CommandLine {
    const line = createCommandLine(":", {
      history: [],
      initial,
      onChange: () => {
        this.#draft.author = line.text;
        this.#session.redraw();
      },
    });
    return line;
  }

  /** The default author arrived: shown unless an author was typed meanwhile. */
  authorKnown(author: string): void {
    if (this.#closed || this.#draft.author !== null || this.#author.text !== "") return;
    this.#author = this.#authorLine(author);
    this.#session.redraw();
  }

  show(): void {
    const width = Math.min(
      DIALOG_WIDTH,
      Math.max(DIALOG_MIN_WIDTH, this.#host.columns() - DIALOG_MARGIN.left - DIALOG_MARGIN.right),
    );
    this.#overlay = this.#host.showOverlay(this, {
      anchor: "center",
      width,
      minWidth: Math.min(DIALOG_MIN_WIDTH, width),
      maxHeight: "100%",
      margin: { ...DIALOG_MARGIN },
    });
    this.#session.pushDialog(this);
  }

  // ---------- SessionDialog ----------

  mode(): KeyMode {
    return this.#mode;
  }

  hints(): string {
    const save = insertKeyLabels(this.#session.keys.keys, "save")[0];
    const other = this.#field === "summary" ? "the author" : "the summary";
    return this.#mode === "INSERT"
      ? [
          "INSERT",
          this.#field === "summary" ? "Enter new line" : undefined,
          `Tab ${other}`,
          save === undefined ? undefined : `${save} posts`,
          "Esc for NORMAL",
        ]
          .filter(p => p !== undefined)
          .join(" · ")
      : "NORMAL · i types · Tab switches field · :w posts · :q closes (keeps the draft) · :q! discards";
  }

  handleRaw(data: string): boolean {
    if (this.#closed || this.#session.keys.mode() !== "NORMAL") return false;
    const pending = this.#session.keys.pending();
    if (pending.count !== null || pending.leader) return false;
    const ch = printableKey(data);
    if (ch === "a" || ch === "A") this.#insert("end");
    else if (ch === "I") this.#insert("start");
    else return false;
    return true;
  }

  handleKey(event: KeyEvent): void {
    if (this.#closed) return;
    if (event.type === "mode") {
      // Esc or Ctrl-C out of INSERT (the keys are already in NORMAL): the composer's NORMAL mode.
      if (event.cause === "cancel") this.#mode = "NORMAL";
      return;
    }
    if (this.#session.keys.mode() === "INSERT") this.#insertKey(event);
    else this.#normalKey(event);
  }

  search(): void {
    this.#session.notify("info", "Nothing to search here: / filters lists");
  }

  write(): boolean {
    void this.#activity.submit(this.taskId);
    return true;
  }

  quit(force: boolean): void {
    if (this.#closed) return;
    this.close();
    if (force) {
      this.#activity.discardDraft(this.taskId);
      this.#session.notify("info", `Discarded the update draft for @${this.taskId}`);
    } else if (this.#activity.draftText(this.taskId) !== null) {
      this.#session.notify("info", `Kept the update draft for @${this.taskId}: c reopens it`);
    }
  }

  blocksCommands(): boolean {
    return false;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#overlay?.hide();
    this.#session.removeDialog(this);
    this.#activity.composerClosed(this);
  }

  // ---------- keys ----------

  #insert(at?: "start" | "end"): void {
    if (at !== undefined) {
      if (this.#field === "summary") this.#editor.move(at === "start" ? "doc-start" : "doc-end");
      else this.#author.key(at === "start" ? "home" : "end");
    }
    this.#mode = "INSERT";
    this.#session.keys.setMode("INSERT");
  }

  #switchField(to?: ComposerField): void {
    this.#field = to ?? (this.#field === "summary" ? "author" : "summary");
  }

  #insertKey(event: KeyEvent): void {
    const summary = this.#field === "summary";
    switch (event.type) {
      case "text":
        if (summary) this.#editor.insert(event.text);
        else this.#author.insert(event.text);
        return;
      case "paste":
        if (summary) this.#editor.paste(event.text);
        else this.#author.paste(event.text);
        return;
      case "action":
        if (event.action === "save") this.write();
        return;
      case "key": {
        const key = event.key;
        if (key === "tab" || key === "shift+tab") this.#switchField();
        else if (!summary) {
          if (key === "enter" || key === "up" || key === "down") this.#switchField("summary");
          else this.#author.key(key);
        } else if (key !== null) this.#editor.editKey(key);
        return;
      }
      default:
        return;
    }
  }

  #normalKey(event: KeyEvent): void {
    const summary = this.#field === "summary";
    const editor = this.#editor;
    switch (event.type) {
      case "action": {
        const count = event.count ?? 1;
        switch (event.action) {
          case "insert":
            this.#insert();
            return;
          case "next_pane":
          case "previous_pane":
            this.#switchField();
            return;
          case "down":
          case "up":
            if (summary) editor.move(event.action, { count });
            else this.#switchField("summary");
            return;
          case "left":
          case "right":
            if (summary) editor.move(event.action, { count, wrap: false });
            else for (let i = 0; i < count; i++) this.#author.key(event.action);
            return;
          case "top":
            if (summary) editor.move("doc-start");
            return;
          case "bottom":
            if (summary) editor.move("doc-end");
            return;
          case "half_down":
            if (summary) editor.move("half-page-down", { count });
            return;
          case "half_up":
            if (summary) editor.move("half-page-up", { count });
            return;
          case "undo":
          case "redo": {
            if (!summary) return;
            const done = event.action === "undo" ? editor.undo(count) : editor.redo(count);
            if (!done) this.#session.notify("info", event.action === "undo" ? "Nothing to undo" : "Nothing to redo");
            return;
          }
          case "post":
            this.#session.notify("info", "The composer is open: :w posts, :q closes it (the draft stays)");
            return;
          default:
            return;
        }
      }
      case "key":
        if (event.key === "enter") this.#insert();
        return;
      case "paste":
        this.#session.notify("info", "Paste ignored: NORMAL mode never inserts text (i types)");
        return;
      case "cancel":
      case "quit-hint":
        this.quit(false);
        return;
      default:
        return;
    }
  }

  // ---------- the toolkit component ----------

  handleInput(data: string): void {
    this.#session.input(data);
  }

  handleMouse(_event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return { handled: true };
  }

  invalidate(): void {}

  render(width: number): string[] {
    const theme = this.#session.theme;
    if (theme === null || width < 8) return [];
    const inner = width - 2;
    const budget = Math.max(8, this.#host.rows() - DIALOG_MARGIN.top - DIALOG_MARGIN.bottom);
    const body: string[] = [];
    const push = (segs: readonly Seg[], fill: ContrastPair = "text@raised") =>
      body.push(paint(theme, segs, inner, fill));
    const draft = this.#draft;
    const length = editorText(draft.state).length;
    const over = length - MAX_SUMMARY;
    const countPair: ContrastPair = over > 0 ? "danger@raised" : length > WARN_SUMMARY ? "warn@raised" : "muted@raised";
    const count = over > 0 ? `${length}/${MAX_SUMMARY} · ${over} over the limit` : `${length}/${MAX_SUMMARY}`;
    const onSummary = this.#field === "summary";
    const label = " Update summary";
    const gap = Math.max(1, inner - 1 - displayWidth(label) - displayWidth(count) - 1);
    push([
      onSummary ? seg("accent@raised", "▌") : seg("text@raised", " "),
      seg("muted@raised", label),
      seg("text@raised", " ".repeat(gap)),
      seg(countPair, count, over > 0 ? { bold: true } : undefined),
    ]);
    const editor = this.#editor;
    editor.theme = theme;
    editor.height = Math.max(2, Math.min(8, budget - 7));
    editor.focused = this.focused && this.#mode === "INSERT" && onSummary;
    for (const line of editor.render(Math.max(1, inner - 1))) body.push(style(theme, "text@raised", " ") + line);
    body.push(this.#authorRow(theme, inner));
    if (draft.busy) push([seg("warn@raised", " ◌ Posting…")]);
    else if (draft.error !== null) push([seg("danger@raised", ` ✗ not posted: ${esc(draft.error)}`)]);
    else if (draft.notice !== null) push([seg("info@raised", ` ${esc(draft.notice)}`)]);
    push([seg("dim@raised", ` ${esc(this.hints())}`)]);
    const border = (text: string) => style(theme, "border@raised", text);
    const title = fitWidth(` ${esc(`Post an update · @${this.taskId} ${this.#title}`)} `, Math.max(0, width - 4));
    const top =
      border("╭─") +
      style(theme, "accent@raised", title, { bold: true }) +
      border(`${"─".repeat(Math.max(0, width - 3 - displayWidth(title)))}╮`);
    return [top, ...body.map(line => border("│") + line + border("│")), border(`╰${"─".repeat(inner)}╯`)];
  }

  /** The Author field: its text, and while it is typed in, a visible cursor cell with the IME marker. */
  #authorRow(theme: ResolvedTheme, inner: number): string {
    const current = this.#field === "author";
    const line = this.#author;
    const fill: ContrastPair = current ? "text@selection" : "text@raised";
    const text: ContrastPair = current ? "text@selection" : "text@raised";
    const lead: Seg[] = [
      current ? seg("accent@selection", "▌") : seg("text@raised", " "),
      seg(current ? "muted@selection" : "muted@raised", " Author  "),
    ];
    const leadWidth = lead.reduce((n, s) => n + displayWidth(s.text), 0);
    if (!(current && this.#mode === "INSERT")) {
      const value =
        line.text === ""
          ? seg(current ? "muted@selection" : "muted@raised", "(the default author)")
          : seg(text, esc(line.text));
      return paint(theme, [...lead, value], inner, fill);
    }
    const rest = line.text.slice(line.cursor);
    const next = graphemes.segment(rest)[Symbol.iterator]().next();
    const under = next.done ? " " : esc(next.value.segment);
    const cell = displayWidth(under);
    const after = esc(next.done ? "" : rest.slice(next.value.segment.length));
    const before = tailFit(esc(line.text.slice(0, line.cursor)), Math.max(0, inner - leadWidth - cell));
    const left = leadWidth + displayWidth(before);
    return (
      paint(theme, [...lead, seg("text@selection", before)], left, fill) +
      (this.focused ? CURSOR_MARKER : "") +
      style(theme, "text@selection", under, { inverse: true }) +
      paint(theme, [seg("text@selection", after)], Math.max(0, inner - left - cell), fill)
    );
  }
}

/** The task panels of one session: registered with it (commands, live frames, the :q guard). */
export function createActivity(session: TuiSession): Activity {
  const activity = new Activity(session);
  session.attachActivity(activity);
  return activity;
}
