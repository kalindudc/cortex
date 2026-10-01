// One terminal UI session: the state ONE `cortex tui` owns, with no
// process-wide singletons.
//
// - Shared data (tasks, lanes, tags, notifications) comes only from the
//   daemon: a workspace snapshot plus the live stream. Events after the
//   applied cursor apply (task upserts/removals directly; catalog and
//   notification changes through one coalesced snapshot); events the state
//   already covers are ignored; `ready`, `resync` and anything from another
//   epoch resnapshot. Frames that arrive while a snapshot is in flight are
//   buffered and replayed against its cursor, and a newer snapshot request
//   makes an older answer obsolete.
// - Per session: the list view (search, filter slots, include-done, the
//   explicit selection; src/tui/workspace.ts computes the list from it),
//   the task history of jumps (:back/:forward), focus, the task-list
//   disclosure, document and view scroll, the `:`/`/` prompt
//   (src/tui/commandline.ts) with its histories,
//   the resolved theme, messages and the connection state. Selection
//   survives the filters that hide it; only explicit calls move focus.
// - The `:` commands come from ONE registry (src/tui/commands.ts).
// - Only the last task persists, per database UUID (src/tui/preferences.ts).
//   Everything a command or shortcut changes (filters, the search, sort,
//   grouping, Read/Edit/Split, the panel, done tasks, the task list) lasts
//   for the session: tui.toml's values at startup are its settings, and the
//   :config pane (src/tui/settings.ts) is the one writer of tui.toml
//   (saveSetting), applying a live setting only after the write succeeded.
// - Input takes ONE route whichever component the toolkit focuses: the open
//   `:`/`/` prompt, then the top dialog (src/tui/dialogs.ts; a stack of
//   overlays shown through the shell's overlay host), then the workspace's
//   key handler (the shell). `:` therefore works inside dialogs.
// - Writes (the metadata commands) run one at a time through mutate(); the
//   session never patches its tasks from a write's answer: the live stream
//   applies every change, so a slow answer can never overwrite newer data.
//   Each runs against the database it was SUBMITTED against: every request
//   goes through the client mutate hands it, refused before dispatch once
//   that database was replaced (so no part of it reaches the replacement).
// - Documents: per task, ONE draft (src/tui/drafts.ts: autosave,
//   guarded writes, conflicts) started from an atomic TaskState, and ONE
//   editor (src/tui/editor.ts), both kept across modes, panels and task
//   switches and never replaced by a refresh. Editing waits for the baseline:
//   INSERT input typed before it arrives is queued, then applied in order.
//   Those keys are the user's: they count as unsaved; a failed load keeps
//   them for its retry (:edit, i, selecting the task; :w and :wq load it once
//   more); :w <path> waits for the load (never exporting the saved body in
//   their place); a document that goes away first (deleted, its database
//   replaced) keeps them, replayed onto empty text, as a kept draft.
//   A live change to a drafted task's title or body re-reads its versions.
//   The preferred Read/Edit/Split mode changes ONLY through setDocumentMode
//   (:read/:edit/:split and their leader keys); `i` from Read shows Edit for
//   that task until task navigation or an explicit mode command. The title
//   edits in place; leaving INSERT saves the title (Enter/Esc) but never the
//   body separately from autosave or :w. :q refuses while a draft is unsaved,
//   failing or conflicted; :q! discards the drafts; a task deleted elsewhere
//   keeps its dirty draft for :w <path> (a private file) instead of losing it.
// - The reader (src/tui/reader.ts) registers itself: while it has the
//   focus (Read, or the Split preview half) `/` and n/N search the rendered
//   document instead of the list; a jump (a task, a heading, `{`/`}`) records
//   where the document was read, so :back/:forward return there; a heading
//   jump from Edit shows Read for that task only (the session's mode stays), and
//   the launch --heading belongs to its task until another is
//   selected. @id references clear the filters and jump; #tag references set
//   the tag filter. Copies are explicit OSC 52 writes to the shell's terminal.

import type { Component, OverlayHandle, OverlayOptions } from "@earendil-works/pi-tui";
import { HttpError } from "../api.ts";
import type { Activity, UnsentPost } from "./activity.ts";
import type { Notifications } from "./notifications.ts";
import type {
  BlockedTransition,
  ConnectionState,
  CortexClient,
  DaemonIdentity,
  LiveEvent,
  ReadyPayload,
  TagWithCount,
  WorkspaceSnapshot,
} from "../contracts.ts";
import { parseCursor } from "../events.ts";
import type { Lane, Notification, Task } from "../store.ts";
import { stepSelection } from "../lib/taskView.ts";
import { type CommandLine, type CommandLineKind, createCommandLine } from "./commandline.ts";
import {
  COMMANDS,
  CommandError,
  type CommandSpec,
  completeCommandLine,
  describeCandidate,
  parseCommand,
} from "./commands.ts";
import {
  createTaskDraft,
  DRAFT_FIELDS,
  type DraftField,
  type FieldState,
  resolveDraftPath,
  type Scheduler,
  type TaskDraft,
  writeDraftFile,
} from "./drafts.ts";
import { createDocumentEditor, createEditorState, type DocumentEditor, editorText } from "./editor.ts";
import type { Help } from "./help.ts";
import { createKeyDispatcher, type KeyConfig, type KeyDispatcher, type KeyEvent, type KeyMode } from "./keys.ts";
import { WheelNotches } from "./mouse.ts";
import type { PreferenceSession } from "./preferences.ts";
import type { Reader } from "./reader.ts";
import { osc52Copy } from "./safety.ts";
import {
  DEFAULT_CONFIG,
  type Density,
  type DocumentMode,
  saveSettings,
  type TaskGroup,
  type TaskSort,
  type TuiConfig,
  type WritableSetting,
} from "./config.ts";
import type { ResolvedTheme } from "./theme.ts";
import {
  appendTagFilter,
  clearFilters,
  followTagRef,
  followTaskRef,
  moveWithin,
  NO_FILTER,
  selectWorkspace,
  type TaskFilter,
  type WorkspaceSelection,
  type WorkspaceView,
  withSelection,
} from "./workspace.ts";

export type Focus = "tasks" | "document";
/** The task panels (Document/Activity/Related/Authors), in `[`/`]` order. */
export const TASK_PANELS = ["document", "activity", "related", "authors"] as const;
export type TaskPanel = (typeof TASK_PANELS)[number];
export type SessionView = "workspace" | "help" | "messages";
/** What `/` searches: the task list (and a dialog's rows), the rendered document, or the open help. */
export type SearchTarget = "list" | "document" | "help";
export type MessageLevel = "info" | "warn" | "error";

export interface SessionMessage {
  readonly id: number;
  readonly level: MessageLevel;
  /** Raw text: escape it (src/tui/safety.ts) before it reaches the terminal. */
  readonly text: string;
  readonly at: number;
}

export interface Problem {
  readonly level: MessageLevel;
  readonly text: string;
}

/**
 * Where a task's document is read: the reader's (src/tui/reader.ts) anchor
 * for a jump in the :back/:forward history, opaque to the session. The top
 * row, the heading above it (and how far below), and its top-level block.
 */
export interface DocumentPlace {
  readonly heading: string | null;
  readonly delta: number;
  readonly top: number;
  readonly block: number;
  readonly blockDelta: number;
  readonly blockRows: number;
}

/** One entry of the :back/:forward history: a task, and where its document was read when there was a reader. */
interface Jump {
  readonly taskId: number;
  readonly place: DocumentPlace | null;
}

const samePlace = (a: Jump, b: Jump): boolean =>
  a.taskId === b.taskId && (a.place === null || b.place === null || a.place.top === b.place.top);

/** Where the document cursor is: the title (edits in place) or the body. */
export type DocumentTarget = "title" | "body";
/** The Split half that has the keyboard (narrow terminals show only this half). */
export type SplitHalf = "editor" | "preview";

/** One task's editing state in this session, kept across modes, panels and task switches. */
export interface TaskDocument {
  readonly taskId: number;
  /** Null until the atomic TaskState baseline arrived (editing waits for it). */
  readonly draft: TaskDraft | null;
  readonly editor: DocumentEditor | null;
  /** Why its baseline could not be loaded (an explicit action retries; rendering never does). */
  readonly error: string | null;
}

/** A title or body draft that is not saved, for the :q guard and the status line. */
export interface UnsavedDraft {
  readonly taskId: number;
  readonly field: DraftField;
  readonly state: FieldState;
  /** A kept draft: its task was deleted (or its database replaced) while it held unsaved work. */
  readonly orphaned: boolean;
  /** How :w addresses it: `@<id>` (a later kept draft of the same id: `@<id>.<n>`). */
  readonly address: string;
  /**
   * Why a kept draft is kept ("task deleted", "database replaced"), or why the
   * keys typed before a live document's baseline are not applied yet
   * ("not loaded: <why>"); else null.
   */
  readonly reason: string | null;
}

/** What a kept draft keeps: a discarded draft, or only the keys typed before a baseline arrived. */
type KeptText = Pick<TaskDraft, "text" | "unsaved" | "state">;

/**
 * A dirty title/body draft kept after its task was deleted or its database
 * replaced: discarded (never written again), apart from the live documents
 * (a replaced database's task of the same id is another task), exportable by
 * its address (:w @<id> <path>) and blocking :q until :q!. Keys typed before
 * the baseline arrived are kept the same way, replayed onto empty text
 * (`typed`: there was no baseline to merge them with).
 */
interface KeptDraft {
  readonly taskId: number;
  readonly address: string;
  readonly draft: KeptText;
  readonly reason: string;
  readonly typed: boolean;
}

/** INSERT input typed before a task's baseline arrived (null: leave the title's INSERT, which saves it). */
interface QueuedInput {
  readonly target: DocumentTarget;
  readonly event: KeyEvent | null;
}

interface DocumentEntry extends TaskDocument {
  draft: TaskDraft | null;
  editor: DocumentEditor | null;
  error: string | null;
  /** A deletion this session sent: its removal discards the draft quietly. */
  removing: boolean;
  loading: Promise<TaskDocument | null> | null;
  queue: QueuedInput[];
  /** A versions re-read is in flight (one per document). */
  refreshing: boolean;
  /** A newer live copy arrived meanwhile: check it once the read settled. */
  refreshAgain: boolean;
  /** The address of the kept draft its unsaved input became when it left the live documents, else null. */
  keptAs: string | null;
}

/** Keys typed for `field` while the baseline loads (not only the marker of a title's INSERT ending). */
const typedFor = (queue: readonly QueuedInput[], field: DraftField): boolean =>
  queue.some(q => q.target === field && q.event !== null);
const hasTyped = (queue: readonly QueuedInput[]): boolean => queue.some(q => q.event !== null);

/** Why an operation submitted against a database that was replaced since then did nothing. */
const REPLACED_BEFORE = "The database was replaced before this could run: nothing was changed";
/** Why the rest of an operation that had begun sending to a replaced database was not sent. */
const REPLACED_DURING = "The database was replaced while this ran: the rest of it was not sent";
/** Requests that only read: an operation refused after sending only these changed nothing. */
const STATE_READS: ReadonlySet<PropertyKey> = new Set(["taskState", "laneState", "tagState"]);

const STATE_WORDS: Readonly<Record<FieldState, string>> = {
  saved: "saved",
  pending: "unsaved",
  saving: "saving",
  retrying: "retrying",
  failed: "save failed",
  conflict: "conflict",
};

/** `@1 body (unsaved), @2 title (conflict), @3 body (task deleted)`. */
export function describeUnsaved(list: readonly UnsavedDraft[]): string {
  return list.map(d => `${d.address} ${d.field} (${d.reason ?? STATE_WORDS[d.state]})`).join(", ");
}

/** What :w <path> writes: a body and, when unsaved, the title (reported, not in the file). */
interface ExportSource {
  readonly label: string;
  readonly text: string;
  readonly title: string | null;
  /** Only keys typed before a baseline arrived (not merged with the saved text): the fields typed, else null. */
  readonly typed: readonly DraftField[] | null;
}

const draftSource = (label: string, draft: KeptText, typed: readonly DraftField[] | null = null): ExportSource => ({
  label,
  text: draft.text("body"),
  title: draft.unsaved().includes("title") ? draft.text("title") : null,
  typed,
});

const keptSource = (kept: KeptDraft): ExportSource =>
  draftSource(`kept draft ${kept.address}`, kept.draft, kept.typed ? kept.draft.unsaved() : null);

/** `:w @1 <path> exports @1's kept draft, :w @2 <path> exports @2's kept draft`: one per kept draft. */
function keptHints(addresses: readonly string[]): string {
  return addresses.map(a => `:w ${a} <path> exports ${a}'s kept draft`).join(", ");
}

/** `unsent update for @3, @5 (not posted)` and what resolves it. */
function describeUnsent(list: readonly UnsentPost[]): string {
  const which = list
    .map(p => `@${p.taskId}${p.state === "unsent" ? "" : p.state === "failed" ? " (not posted)" : " (posting)"}`)
    .join(", ");
  return `unsent update for ${which}: c reopens its composer (:w there posts it, :q! there discards it), :q! discards everything`;
}

/** Keys typed before a live document's baseline, which did not load (the reason says why). */
const notLoaded = (d: UnsavedDraft): boolean => !d.orphaned && d.reason !== null;

/** What resolves each kind of unsaved draft. */
function unsavedHint(list: readonly UnsavedDraft[]): string {
  const hints: string[] = [];
  if (list.some(d => d.state === "conflict" && !d.orphaned)) hints.push(":apply or :keep resolves a conflict");
  if (list.some(d => d.state === "failed" && !d.orphaned && !notLoaded(d))) hints.push(":w retries a failed save");
  if (list.some(notLoaded)) hints.push(":w (or :edit) loads it again and applies the typed keys");
  const kept = [...new Set(list.filter(d => d.orphaned).map(d => d.address))];
  if (kept.length > 0) hints.push(keptHints(kept));
  hints.push(":q! discards");
  return hints.join(", ");
}

/** Home/End sequences pi-tui does not name. */
function legacyKey(data: string): string | null {
  if (data === "\x1b[1~" || data === "\x1b[7~") return "home";
  if (data === "\x1b[4~" || data === "\x1b[8~") return "end";
  return null;
}

/** One INSERT key typed into the in-place title (Enter, which ends the edit, is the caller's). */
function typeTitle(line: CommandLine, event: KeyEvent): void {
  if (event.type === "text") line.insert(event.text);
  else if (event.type === "paste") line.paste(event.text);
  else if (event.type === "key" && event.key !== "enter") line.key(event.key);
}

/** One INSERT key typed into the body editor. */
function typeBody(editor: DocumentEditor, event: KeyEvent): void {
  if (event.type === "text") editor.insert(event.text);
  else if (event.type === "paste") editor.paste(event.text);
  else if (event.type === "key") editor.editKey(event.key ?? legacyKey(event.data) ?? "");
}

/**
 * The keys typed before a baseline arrived, on their own: replayed in order
 * onto an EMPTY title line and body editor (the ones INSERT types into),
 * since there is no baseline to merge them with. Null when nothing was
 * typed. Never sent anywhere.
 */
function typedCopy(queue: readonly QueuedInput[]): KeptText | null {
  const fields = DRAFT_FIELDS.filter(field => typedFor(queue, field));
  if (fields.length === 0) return null;
  const line = createCommandLine(":", { history: [] });
  const editor = createDocumentEditor(createEditorState(""), () => {});
  for (const { target, event } of queue) {
    if (event === null || event.type === "action") continue;
    if (target === "title") typeTitle(line, event);
    else typeBody(editor, event);
  }
  const text: Record<DraftField, string> = { title: line.text, body: editorText(editor.getState()) };
  return {
    text: field => (fields.includes(field) ? text[field] : ""),
    unsaved: () => [...fields],
    state: () => "pending",
  };
}

/** What the session needs from an open dialog (src/tui/dialogs.ts implements it). */
export interface SessionDialog {
  /** Its name on the status line ("lanes", "delete" ...). */
  readonly label: string;
  /** The key mode it wants while it is on top (forms remember INSERT/NORMAL). */
  mode(): KeyMode;
  /** The hint line while it is on top (configured keys, never a function key). */
  hints(): string;
  /** Raw input first: y/n and the dialog's own letter keys; true when it used the input. */
  handleRaw(data: string): boolean;
  /** One classified key event; prompt events never reach it. */
  handleKey(event: KeyEvent): void;
  /** A `/` search submitted while it is on top (or, for a live dialog, each edit of the prompt). */
  search(text: string): void;
  /** `/` filters it as you type; Esc in the prompt restores searchText. */
  readonly searchesLive?: boolean;
  /** Its current `/` filter text. */
  readonly searchText?: string;
  /** `:w`: true when the dialog saves something (a form submits), false when it has nothing to write. */
  write(): boolean;
  /** `:q` (force false: create/management forms refuse while they hold input) or `:q!` (discards). */
  quit(force: boolean): void;
  /** A create/management form holding input: other commands must wait. */
  blocksCommands(): boolean;
  /** Close at once, without questions (and undo any preview). */
  close(): void;
}

/** Where dialogs are drawn: the shell's toolkit overlays. */
export interface OverlayHost {
  showOverlay(component: Component, options?: OverlayOptions): OverlayHandle;
  columns(): number;
  rows(): number;
}

export interface ThemeChoice {
  readonly name: string;
  readonly source: "bundled" | "custom";
}

/** The shell's theme controls for `:config theme` (resolution inputs live in the shell). */
export interface ThemeControl {
  /** Bundled, then custom themes. */
  choices(): readonly ThemeChoice[];
  /** Show `name` (null: auto) without saving; the first preview remembers what to restore. */
  preview(name: string | null): void;
  /** Back to the theme shown before the previews. */
  restore(): void;
  /** Apply for this session (the :config pane saves it first); null clears every session override (auto). */
  apply(name: string | null): ResolvedTheme;
}

/**
 * The shell's terminal handoff (src/tui/app.ts): restore the terminal exactly
 * as for a suspend, run `run` (an external program owns the terminal), then
 * take the terminal back and redraw, whatever `run` did.
 */
export type TerminalHandoff = <T>(run: () => Promise<T>) => Promise<T>;

export interface SessionOptions {
  /** Client bound to the verified daemon instance. */
  client: CortexClient;
  identity: DaemonIdentity;
  keys: KeyConfig;
  preferences: PreferenceSession;
  /** tui.toml's settings at startup (each defaults to DEFAULT_CONFIG's). */
  settings?: Partial<Pick<TuiConfig, "density" | "done" | "tasks" | "number" | "scroll" | "sort" | "group" | "mode">>;
  /** The tui.toml :config writes (runTui: tuiConfigPath()); omitted, no setting can be saved. */
  configFile?: string;
  /** A client for another instance at the same endpoint (after the daemon restarted); verified before use. */
  connect?: (instanceId: string) => CortexClient;
  /** Task to select at startup (`cortex tui <id>`). */
  initialTask?: number | null;
  /** Heading slug to reveal in the initial task (`--heading`). */
  heading?: string | null;
  /** Startup problems (tui.toml, themes, view state) for `:messages`. */
  problems?: readonly Problem[];
  /** The `:` command registry (default COMMANDS). */
  commands?: readonly CommandSpec[];
  /** Timer seam (coalescing, retries, preference saves); returns a cancel function. */
  schedule?: (fn: () => void, ms: number) => () => void;
  now?: () => number;
  /** Something changed that the screen shows. */
  onChange?: () => void;
  /** `:q` (force false) or `:q!` (force true). */
  onQuit?: (force: boolean) => void;
}

type Position = { epoch: string; seq: number };

const covers = (a: Position | null, b: Position): boolean => a !== null && a.epoch === b.epoch && a.seq >= b.seq;

const later = (a: Position | null, b: Position): Position =>
  a !== null && a.epoch === b.epoch && a.seq >= b.seq ? a : b;

/** Changes the next workspace snapshot picks up (catalog cascades); notification state re-reads only itself. */
const SNAPSHOT_KINDS: ReadonlySet<string> = new Set(["lane.changed", "tag.changed"]);

const COALESCE_MS = 50;
const RETRY_MS = 1000;
const MAX_RETRY_MS = 5000;
const SAVE_DELAY_MS = 1000;
const MAX_MESSAGES = 200;

/** Jumps remembered for :back/:forward, per direction. */
const MAX_JUMPS = 100;
/** How long a created task may take to arrive on the live stream before :new stops waiting for it. */
const REVEAL_TIMEOUT_MS = 3000;

const isTask = (value: unknown): value is Task =>
  typeof value === "object" &&
  value !== null &&
  Number.isSafeInteger((value as Task).id) &&
  typeof (value as Task).title === "string";

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};

export class TuiSession {
  /** Per-session key state: mode, count and leader. */
  readonly keys: KeyDispatcher;

  #client: CortexClient;
  #identity: DaemonIdentity;
  readonly #options: SessionOptions;
  readonly #schedule: (fn: () => void, ms: number) => () => void;
  readonly #now: () => number;
  /** The wheel in notches, for every pane (src/tui/mouse.ts). */
  readonly #wheel: WheelNotches;

  // shared data
  #tasks: Task[] = [];
  #lanes: Lane[] = [];
  #tags: TagWithCount[] = [];
  #notifications: Notification[] = [];
  #loaded = false;
  #connection: ConnectionState = "connecting";

  // live synchronization
  #applied: Position | null = null;
  #required: Position | null = null;
  #snapshotGen = 0;
  #inFlight = false;
  #buffered: LiveEvent[] = [];
  #cancelCoalesce: (() => void) | null = null;
  #cancelRetry: (() => void) | null = null;
  #retryMs = RETRY_MS;
  #rebinding = false;
  /** A failed verification of a restarted daemon waits for its retry (the session stays rebinding meanwhile). */
  #rebindRetry: (() => void) | null = null;
  /**
   * A replacement database is bound but its FIRST snapshot has not applied:
   * the workspace is empty and every write is refused (mutate,
   * acknowledgeNotifications), so nothing loaded for the old database acts on it.
   */
  #replacing = false;
  /** Bumped when the database is replaced: a write submitted before that never runs (mutate). */
  #databaseGen = 0;
  /** The required snapshot may have to cover frames this session never saw (a reconnect, resync, gap or epoch). */
  #missed = false;
  // notifications: shared read state
  /** Generation of the newest notifications read (a re-read or a snapshot); older answers are obsolete. */
  #notifRead = 0;
  /** The re-read in flight (its generation), or null. */
  #notifFetching: number | null = null;
  /** The answer in flight may predate a change: drop it and read once more. */
  #notifAgain = false;
  /** This session's acknowledgements in flight; reads wait for them. */
  #notifWrites = 0;
  #notificationFeed: Notifications | null = null;
  /** The newest task.blocked frame that raised attention (a duplicate never alerts twice). */
  #alerted: Position | null = null;

  // per-session view state
  #selectedId: number | null = null;
  #selectionSeeded = false;
  #past: Jump[] = [];
  #future: Jump[] = [];
  #focus: Focus = "tasks";
  #taskList: boolean;
  #includeDone: boolean;
  #lineNumbers: boolean;
  #sort: TaskSort;
  #group: TaskGroup;
  /** The effective spacing: tui.toml's `density` (or :config's change), else comfortable. */
  #density: Density;
  /** The rows or list items one wheel notch moves: tui.toml's `scroll`. */
  #scrollRows: number;
  #query = "";
  #filter: TaskFilter = NO_FILTER;
  #theme: ResolvedTheme | null = null;
  /** The theme of the pane being painted (withPaneTheme), or null. */
  #paneTheme: ResolvedTheme | null = null;
  #suspend: (() => void) | null = null;
  #handoff: TerminalHandoff | null = null;
  #view: SessionView = "workspace";
  #viewScroll = 0;
  #docScroll = new Map<number, number>();
  #heading: { taskId: number; slug: string } | null = null;
  #prompt: CommandLine | null = null;
  /** A live dialog search in the open `/` prompt, and the filter to restore if it is cancelled. */
  #liveSearch: { readonly dialog: SessionDialog; readonly before: string } | null = null;
  /** What the open `/` searches: the task list, the rendered document (the reader had the focus) or the open help. */
  #searchTarget: SearchTarget = "list";
  readonly #histories: Record<CommandLineKind, string[]> = { ":": [], "/": [] };
  #messages: SessionMessage[] = [];
  #status: SessionMessage | null = null;
  #seenProblems = new Set<string>();
  #warnings = 0;
  #messageId = 0;
  #cancelSave: (() => void) | null = null;
  #disposed = false;
  #dialogs: SessionDialog[] = [];
  #overlayHost: OverlayHost | null = null;
  #keyHandler: ((event: KeyEvent) => void) | null = null;
  #themeControl: ThemeControl | null = null;
  /** The document reader (src/tui/reader.ts), registered by createReader. */
  #reader: Reader | null = null;
  /** The help view's wrapping and search (src/tui/help.ts), registered by createHelp. */
  #help: Help | null = null;
  /** The task panels and the update composer (src/tui/activity.ts), registered by createActivity. */
  #activity: Activity | null = null;
  #panel: TaskPanel = "document";
  /** Writes a clipboard sequence to the terminal (the shell's); null without one. */
  #clipboard: ((data: string) => void) | null = null;
  #writes: Promise<void> = Promise.resolve();
  #writing = 0;
  #reveal: { id: number; finish(shown: boolean): void } | null = null;
  #tagMemo: { catalog: TagWithCount[]; tasks: Task[]; value: TagWithCount[] } | null = null;
  // documents
  #documents = new Map<number, DocumentEntry>();
  #preferredMode: DocumentMode;
  /** A mode shown for one task only: Edit after `i` from Read, Read after a heading jump from Edit. */
  #temporary: { readonly taskId: number; readonly mode: DocumentMode } | null = null;
  #splitHalf: SplitHalf = "editor";
  #docTarget: DocumentTarget = "body";
  #insert: { readonly target: DocumentTarget; readonly taskId: number } | null = null;
  #titleLine: CommandLine | null = null;
  /** Dirty drafts kept after their task was deleted or their database replaced, in the order kept. */
  #kept: KeptDraft[] = [];
  readonly #draftScheduler: Scheduler;
  /** Forwards to the CURRENT client, so drafts keep writing after a verified daemon restart. */
  readonly #liveClient: CortexClient;
  #listMemo: {
    tasks: Task[];
    lanes: Lane[];
    query: string;
    filter: TaskFilter;
    includeDone: boolean;
    sort: TaskSort;
    group: TaskGroup;
    selectedId: number | null;
    value: WorkspaceSelection;
  } | null = null;

  /** The `:` command registry. */
  readonly commands: readonly CommandSpec[];

  constructor(options: SessionOptions) {
    this.#options = options;
    this.#client = options.client;
    this.#identity = options.identity;
    this.#schedule = options.schedule ?? defaultSchedule;
    this.#now = options.now ?? Date.now;
    this.#wheel = new WheelNotches(this.#now);
    this.keys = createKeyDispatcher(options.keys);
    this.commands = options.commands ?? COMMANDS;
    const settings = { ...DEFAULT_CONFIG, ...options.settings };
    this.#taskList = settings.tasks;
    this.#includeDone = settings.done;
    this.#lineNumbers = settings.number;
    this.#sort = settings.sort;
    this.#group = settings.group;
    this.#density = settings.density;
    this.#scrollRows = settings.scroll;
    this.#preferredMode = settings.mode;
    this.#draftScheduler = {
      schedule: (fn, ms) => this.#schedule(fn, ms),
      clear: cancel => {
        if (typeof cancel === "function") (cancel as () => void)();
      },
    };
    this.#liveClient = new Proxy({} as CortexClient, { get: (_target, key) => Reflect.get(this.#client, key) });
    if (!this.#taskList) this.#focus = "document";
    this.#restoreDatabaseView();
    this.addProblems(options.problems ?? []);
  }

  // ---------- shared data ----------

  get client(): CortexClient {
    return this.#client;
  }

  get identity(): DaemonIdentity {
    return this.#identity;
  }

  get tasks(): readonly Task[] {
    return this.#tasks;
  }

  get lanes(): readonly Lane[] {
    return this.#lanes;
  }

  /**
   * The tag catalog with member counts taken from the full task pool: task
   * writes move the counts but publish only task frames (no snapshot per
   * frame is needed to keep them exact).
   */
  get tags(): readonly TagWithCount[] {
    const memo = this.#tagMemo;
    if (memo !== null && memo.catalog === this.#tags && memo.tasks === this.#tasks) return memo.value;
    const counts = new Map<string, number>();
    for (const t of this.#tasks) for (const name of t.tags) counts.set(name, (counts.get(name) ?? 0) + 1);
    const value = this.#tags.map(tag => {
      const count = counts.get(tag.name) ?? 0;
      return count === tag.task_count ? tag : { ...tag, task_count: count };
    });
    this.#tagMemo = { catalog: this.#tags, tasks: this.#tasks, value };
    return value;
  }

  get notifications(): readonly Notification[] {
    return this.#notifications;
  }

  /** The notification feed and attention (src/tui/notifications.ts createNotifications registers it). */
  get notificationFeed(): Notifications | null {
    return this.#notificationFeed;
  }

  attachNotifications(feed: Notifications | null): void {
    this.#notificationFeed = feed;
  }

  /**
   * Re-read the notifications (after `notification.changed`): ONE read in
   * flight; a newer need makes its answer obsolete and issues one more read;
   * while this session's own acknowledgements are in flight, reads wait for
   * them, so an answer that predates an acknowledgement never undoes it.
   */
  refetchNotifications(): void {
    if (this.#disposed) return;
    if (this.#notifFetching !== null || this.#notifWrites > 0) {
      this.#notifAgain = true;
      return;
    }
    const gen = ++this.#notifRead;
    this.#notifFetching = gen;
    this.#notifAgain = false;
    let pending: Promise<Notification[]>;
    try {
      pending = this.#client.notifications();
    } catch (err) {
      pending = Promise.reject(err);
    }
    void pending
      .then(
        rows => {
          if (gen !== this.#notifRead || this.#notifAgain || this.#notifWrites > 0 || this.#disposed) return;
          this.#notifications = [...rows];
          this.#changed();
        },
        err => {
          if (gen !== this.#notifRead || this.#disposed) return;
          this.notify("error", `Could not refresh the notifications: ${errorText(err)}`);
        },
      )
      .finally(() => {
        if (this.#notifFetching !== gen) return;
        this.#notifFetching = null;
        if (this.#notifAgain && this.#notifWrites === 0) this.refetchNotifications();
      });
  }

  /**
   * An acknowledgement (read, unread, all read, dismiss, clear): shown at once
   * through `patch`, then sent. Reads wait until it settled; a failure (or an
   * answer it made obsolete) re-reads the daemon's state afterwards.
   */
  async acknowledgeNotifications(
    patch: (rows: readonly Notification[]) => Notification[],
    send: (client: CortexClient) => Promise<void>,
  ): Promise<void> {
    this.#assertWritable();
    this.#notifications = patch(this.#notifications);
    if (this.#notifFetching !== null) this.#notifAgain = true;
    this.#notifWrites++;
    this.#changed();
    try {
      await send(this.#client);
    } catch (err) {
      this.#notifAgain = true;
      throw err;
    } finally {
      this.#notifWrites--;
      if (this.#notifWrites === 0 && this.#notifAgain && this.#notifFetching === null) this.refetchNotifications();
    }
  }

  /** A workspace snapshot has been applied. */
  get loaded(): boolean {
    return this.#loaded;
  }

  get connection(): ConnectionState {
    return this.#connection;
  }

  /**
   * The data shown is behind the daemon's even though the stream may be up: a
   * needed snapshot failed and waits for its retry, or a restarted daemon is
   * being verified before this session reads from it.
   */
  get resyncing(): boolean {
    return this.#cancelRetry !== null || this.#rebinding;
  }

  setConnection(state: ConnectionState): void {
    if (this.#connection === state) return;
    this.#connection = state;
    this.#changed();
  }

  /** Apply one consistent workspace read and remember the cursor it is valid at. */
  /**
   * `missed`: frames may have been missed since the last one applied (the
   * default; a reconnect, resync, gap or epoch), so every thread read here is
   * read again. A snapshot taken only for a catalog change re-reads less.
   */
  applySnapshot(snapshot: WorkspaceSnapshot, missed = true): void {
    const at = parseCursor(snapshot.cursor);
    if (at === null) {
      this.notify("error", `The workspace snapshot has an invalid cursor ${JSON.stringify(snapshot.cursor)}`);
      return;
    }
    this.#tasks = [...snapshot.tasks];
    this.#lanes = [...snapshot.lanes];
    this.#tags = [...snapshot.tags];
    // An acknowledgement in flight may postdate this read: keep it shown and re-read after it settles.
    if (this.#notifWrites > 0) this.#notifAgain = true;
    else this.#notifications = [...snapshot.notifications];
    this.#applied = at;
    if (this.#required !== null && covers(at, this.#required)) this.#required = null;
    this.#loaded = true;
    this.#seedSelection();
    this.#checkReveal();
    for (const entry of [...this.#documents.values()]) {
      const task = this.#tasks.find(t => t.id === entry.taskId);
      if (task === undefined) this.#documentRemoved(entry.taskId);
      else this.#noticeTask(task);
    }
    this.#activity?.refreshed(missed);
    if (this.#replacing) {
      this.#replacing = false;
      this.notify("info", "The replacement database has loaded: commands can change it again");
    }
    this.#changed();
  }

  /** One live-stream frame, in order (src/subscription.ts already drops duplicates and turns gaps into resync). */
  receive(event: LiveEvent): void {
    const at = parseCursor(event.cursor);
    if (at === null) return;
    if (event.kind === "ready") {
      this.#onReady(event, at);
      return;
    }
    if (event.kind === "resync") {
      this.#missed = true;
      // Honest about falling behind: the daemon dropped this session's backlog (a slow reader).
      if ((event.payload as { reason?: unknown } | null)?.reason === "overflow") {
        this.notify("info", "This session fell behind the live updates; the workspace was read again");
      }
      this.#requireSnapshot(at, true, true);
      return;
    }
    // Attention follows the daemon's explicit transition frame as it arrives
    // (never a snapshot, a reconnect or a task copy); a duplicate alerts once.
    if (event.kind === "task.blocked" && !covers(this.#alerted, at)) {
      this.#alerted = later(this.#alerted, at);
      this.#notificationFeed?.blocked(event.payload as BlockedTransition);
    }
    if (this.#inFlight || this.#rebinding) {
      this.#buffered.push(event);
      return;
    }
    this.#apply(event, at);
  }

  /** Take a workspace snapshot now (a newer request makes older answers obsolete). */
  async snapshotNow(): Promise<void> {
    this.#cancelCoalesce?.();
    this.#cancelCoalesce = null;
    this.#cancelRetry?.();
    this.#cancelRetry = null;
    const gen = ++this.#snapshotGen;
    this.#inFlight = true;
    this.#notifRead++; // whatever a notifications re-read in flight returns, this snapshot has too
    let snapshot: WorkspaceSnapshot;
    try {
      snapshot = await this.#client.workspace();
    } catch (err) {
      if (gen !== this.#snapshotGen || this.#disposed) return;
      this.#inFlight = false;
      this.notify("error", `Could not refresh the workspace: ${(err as Error).message}`);
      this.#replay();
      this.#scheduleRetry();
      return;
    }
    if (gen !== this.#snapshotGen || this.#disposed) return;
    this.#inFlight = false;
    this.#retryMs = RETRY_MS;
    const missed = this.#missed;
    this.#missed = false;
    this.applySnapshot(snapshot, missed);
    this.#replay();
    if (this.#required !== null) this.#requireSnapshot(this.#required, false, false);
  }

  #onReady(event: LiveEvent, at: Position): void {
    const ready = event.payload as Partial<ReadyPayload> | null;
    const instanceId = typeof ready?.instanceId === "string" ? ready.instanceId : null;
    // A reconnect: frames of the old connection no longer matter, and an
    // in-flight snapshot may come from a daemon that is gone.
    this.#buffered = [];
    if (this.#rebindRetry !== null && instanceId === this.#identity.instanceId) {
      // The instance this session is bound to answered again: the pending verification is moot.
      this.#rebindRetry();
      this.#rebindRetry = null;
      this.#rebinding = false;
    }
    // Frames between the connections were never seen unless the applied snapshot covers this ready.
    if (!covers(this.#applied, at)) this.#missed = true;
    if (instanceId !== null && instanceId !== this.#identity.instanceId) {
      this.#missed = true;
      this.#required = at;
      void this.#rebind(instanceId, typeof ready?.databaseId === "string" ? ready.databaseId : null);
      return;
    }
    if (this.#inFlight) {
      this.#required = at;
      void this.snapshotNow();
      return;
    }
    this.#requireSnapshot(at, true, false);
  }

  async #rebind(instanceId: string, databaseId: string | null): Promise<void> {
    this.#snapshotGen++; // whatever the old instance answers is obsolete
    this.#inFlight = false;
    this.#rebindRetry?.();
    this.#rebindRetry = null;
    const connect = this.#options.connect;
    if (!connect) {
      this.notify("error", "The cortex daemon restarted; quit (:q) and start cortex again to reconnect");
      return;
    }
    this.#rebinding = true;
    let failed = false;
    try {
      const client = connect(instanceId);
      const health = await client.health();
      const identity = health.identity;
      if (
        !identity ||
        identity.instanceId !== instanceId ||
        identity.databasePath !== this.#identity.databasePath ||
        (databaseId !== null && identity.databaseId !== databaseId)
      ) {
        throw new Error("the daemon answering on this database's socket did not verify");
      }
      const replaced = identity.databaseId !== this.#identity.databaseId;
      // Cleared BEFORE the replacement's client is exposed: nothing of the old one may act on it.
      if (replaced) this.#clearReplacedWorkspace();
      this.#client = client;
      this.#identity = identity;
      if (replaced) {
        this.#restoreDatabaseView();
        this.notify(
          "warn",
          "The database was replaced (it has a new identity): loading it; nothing can be changed until it has loaded. The selection was reset; unsaved drafts of the old one are kept here, never written to it",
        );
      } else {
        this.notify("info", "Reconnected to the restarted cortex daemon");
      }
    } catch (err) {
      failed = true;
      this.notify("error", `Could not reconnect to the restarted daemon: ${(err as Error).message}; retrying`);
      return;
    } finally {
      // Still rebinding while the retry waits: frames are buffered and snapshots wait for it.
      if (failed && !this.#disposed) this.#retryRebind(instanceId, databaseId);
      else this.#rebinding = false;
    }
    await this.snapshotNow();
  }

  /**
   * The database was replaced: drop everything loaded, drafted, selected or
   * open for the old one, and refuse writes until the replacement's first
   * snapshot applied. Dirty drafts are kept (never written into the new one).
   */
  #clearReplacedWorkspace(): void {
    this.#replacing = true;
    this.#databaseGen++;
    for (const entry of [...this.#documents.values()]) {
      this.#orphan(entry, "its database was replaced", "database replaced");
    }
    this.leaveInsert();
    this.#activity?.reset("belongs to the replaced database");
    this.closeDialogs(); // their targets are the old database's
    this.#reveal?.finish(false);
    this.#tasks = [];
    this.#lanes = [];
    this.#tags = [];
    this.#notifications = [];
    this.#notifRead++; // a notifications read in flight answers for the old database
    this.#loaded = false;
    this.#applied = null;
    this.#selectedId = null;
    this.#selectionSeeded = false;
    this.#past = [];
    this.#future = [];
    this.#docScroll.clear();
    this.#heading = null;
    this.#temporary = null;
    this.#changed();
  }

  /** Refuse a write while a replacement database has not loaded yet. */
  #assertWritable(): void {
    if (this.#replacing) {
      throw new CommandError(
        "The database was replaced and is still loading: nothing was changed (try again once it has loaded)",
      );
    }
  }

  /** Verify the restarted daemon again after the retry delay (a newer ready cancels it). */
  #retryRebind(instanceId: string, databaseId: string | null): void {
    const delay = this.#retryMs;
    this.#retryMs = Math.min(this.#retryMs * 2, MAX_RETRY_MS);
    this.#rebindRetry = this.#schedule(() => {
      this.#rebindRetry = null;
      void this.#rebind(instanceId, databaseId);
    }, delay);
  }

  #apply(event: LiveEvent, at: Position): void {
    if (covers(this.#applied, at)) {
      // The state already reflects it, apart from a post: a snapshot has no updates.
      if (event.kind === "update.posted" && this.#activity !== null) {
        this.#activity.covered(event);
        this.#changed();
      }
      return;
    }
    if (this.#applied === null || this.#applied.epoch !== at.epoch) {
      this.#missed = true;
      this.#requireSnapshot(at, true, false); // not comparable with what is shown
      return;
    }
    switch (event.kind) {
      case "task.added":
      case "task.updated": {
        if (!isTask(event.payload)) {
          this.#missed = true;
          this.#requireSnapshot(at, true, false);
          return;
        }
        const next = event.payload;
        const index = this.#tasks.findIndex(t => t.id === next.id);
        this.#tasks = index < 0 ? [...this.#tasks, next] : this.#tasks.map(t => (t.id === next.id ? next : t));
        // A task write auto-creates a lane or tag on first use and publishes
        // only the task: refresh the catalogs (one coalesced snapshot).
        const unknownLane = !this.#lanes.some(l => l.name === next.lane);
        if (unknownLane || next.tags.some(name => !this.#tags.some(t => t.name === name))) {
          this.#requireSnapshot(at, false, false);
        }
        this.#checkReveal();
        this.#noticeTask(next);
        break;
      }
      case "task.removed": {
        const id = (event.payload as { id?: unknown } | null)?.id;
        if (typeof id !== "number") {
          this.#missed = true;
          this.#requireSnapshot(at, true, false);
          return;
        }
        this.#tasks = this.#tasks.filter(t => t.id !== id);
        this.#docScroll.delete(id);
        this.#documentRemoved(id);
        break;
      }
      case "notification.added": {
        const row = event.payload as Notification | null;
        if (row && typeof row.id === "number" && !this.#notifications.some(n => n.id === row.id)) {
          this.#notifications = [row, ...this.#notifications];
          // A re-read in flight may predate the row: its answer would drop it.
          if (this.#notifFetching !== null) this.#notifAgain = true;
        }
        break;
      }
      case "notification.changed":
        this.refetchNotifications();
        break;
      default:
        if (SNAPSHOT_KINDS.has(event.kind)) this.#requireSnapshot(at, false, false);
        break;
    }
    // The task panels follow the same ordered frames (update.posted, task changes).
    this.#activity?.live(event);
    this.#applied = at;
    this.#changed();
  }

  /** Make sure a snapshot at or past `at` is (or will be) applied: now when urgent, else after the coalescing window. */
  #requireSnapshot(at: Position, urgent: boolean, force: boolean): void {
    if (!force && this.#required === null && covers(this.#applied, at)) return;
    this.#required = later(this.#required, at);
    if (this.#rebinding) return; // the rebind snapshots when it is done
    if (urgent || this.#inFlight) {
      void this.snapshotNow();
      return;
    }
    if (this.#cancelCoalesce === null) {
      this.#cancelCoalesce = this.#schedule(() => {
        this.#cancelCoalesce = null;
        void this.snapshotNow();
      }, COALESCE_MS);
    }
  }

  #replay(): void {
    const frames = this.#buffered;
    this.#buffered = [];
    for (const frame of frames) {
      const at = parseCursor(frame.cursor);
      if (at !== null) this.#apply(frame, at);
    }
  }

  #scheduleRetry(): void {
    if (this.#cancelRetry !== null || this.#disposed) return;
    const delay = this.#retryMs;
    this.#retryMs = Math.min(this.#retryMs * 2, MAX_RETRY_MS);
    this.#cancelRetry = this.#schedule(() => {
      this.#cancelRetry = null;
      void this.snapshotNow();
    }, delay);
  }

  // ---------- the list view, selection and task history ----------

  get selectedId(): number | null {
    return this.#selectedId;
  }

  get query(): string {
    return this.#query;
  }

  get filter(): TaskFilter {
    return this.#filter;
  }

  get includeDone(): boolean {
    return this.#includeDone;
  }

  get taskListVisible(): boolean {
    return this.#taskList;
  }

  /** Read and the Split preview show each block's source line (tui.toml's `number`). */
  get lineNumbers(): boolean {
    return this.#lineNumbers;
  }

  /** For this session (:config number saves it first). */
  setLineNumbers(value: boolean): void {
    if (this.#lineNumbers === value) return;
    this.#lineNumbers = value;
    this.#changed();
  }

  /** The task list's order without a search (`:sort`, for this session; tui.toml's `sort` starts it). */
  get sort(): TaskSort {
    return this.#sort;
  }

  /** The task list's grouping without a search (`:sort group`, for this session; tui.toml's `group` starts it). */
  get group(): TaskGroup {
    return this.#group;
  }

  /** The spacing (tui.toml's `density`): comfortable (the default) or compact. */
  get density(): Density {
    return this.#density;
  }

  /** For this session (:config density saves it first). */
  setDensity(density: Density): void {
    this.#density = density;
    this.#changed();
  }

  /** This session's list view (input of src/tui/workspace.ts selectWorkspace). */
  get listView(): WorkspaceView {
    return {
      query: this.#query,
      filter: this.#filter,
      includeDone: this.#includeDone,
      selectedId: this.#selectedId,
      sort: this.#sort,
      group: this.#group,
    };
  }

  /**
   * The list model: displayed rows, the active task and where it is.
   * Memoized per input; a selection change alone reuses the searched rows.
   */
  workspace(): WorkspaceSelection {
    const memo = this.#listMemo;
    const same =
      memo !== null &&
      memo.tasks === this.#tasks &&
      memo.lanes === this.#lanes &&
      memo.query === this.#query &&
      memo.filter === this.#filter &&
      memo.includeDone === this.#includeDone &&
      memo.sort === this.#sort &&
      memo.group === this.#group;
    if (same && memo.selectedId === this.#selectedId) return memo.value;
    const value = same
      ? withSelection(memo.value, this.#tasks, this.#selectedId)
      : selectWorkspace(this.#tasks, this.listView, this.#lanes);
    this.#listMemo = {
      tasks: this.#tasks,
      lanes: this.#lanes,
      query: this.#query,
      filter: this.#filter,
      includeDone: this.#includeDone,
      sort: this.#sort,
      group: this.#group,
      selectedId: this.#selectedId,
      value,
    };
    return value;
  }

  /** The displayed rows in display order. */
  visibleTasks(): readonly Task[] {
    return this.workspace().rows;
  }

  isVisible(id: number): boolean {
    return this.workspace().rows.some(t => t.id === id);
  }

  /** The explicit selection (even when filtered out of the list), else the fallback. */
  selectedTask(): Task | null {
    return this.workspace().active;
  }

  select(id: number): void {
    if (!this.#tasks.some(t => t.id === id)) return;
    // Explicit navigation wins over a created task that has not arrived yet.
    if (this.#reveal !== null && this.#reveal.id !== id) this.#reveal.finish(false);
    if (this.#selectedId === id) return;
    if ((this.selectedTask()?.id ?? null) !== id) {
      // Task navigation: INSERT ends, a temporary view ends, the document cursor returns to the body.
      if (this.#insert !== null && this.#insert.taskId !== id) this.leaveInsert();
      if (this.#temporary?.taskId !== id) this.#temporary = null;
      this.#docTarget = "body";
    }
    // A launch --heading belongs to its task only.
    if (this.#heading !== null && this.#heading.taskId !== id) this.#heading = null;
    this.#selectedId = id;
    this.#selectionSeeded = true;
    this.#setLastTask(id);
    if (this.#preferredMode !== "read") void this.openDocument(id);
    this.#changed();
  }

  /** A motion by `delta` rows: clamped to the list; from outside it, entering at the edge of travel. */
  moveSelection(delta: number): void {
    const list = this.workspace();
    const id = moveWithin(list.rows, list.active?.id ?? null, delta);
    if (id !== null) this.select(id);
  }

  selectEdge(edge: "first" | "last"): void {
    const rows = this.workspace().rows;
    const task = edge === "first" ? rows[0] : rows[rows.length - 1];
    if (task) this.select(task.id);
  }

  /**
   * n / N: while the help is open, its next or previous match; while the
   * rendered document has the focus, its next or previous match; otherwise
   * the next or previous task-list search result (wrapping; from outside the
   * results, the first or last).
   */
  stepResult(delta: number): void {
    if (this.#help !== null && this.#view === "help") {
      this.#help.step(delta);
      return;
    }
    if (this.#reader !== null && this.readerFocused()) {
      this.#reader.step(delta);
      return;
    }
    const query = this.#query.trim();
    if (query === "") {
      this.notify("info", "No search: / searches the task list, then n and N step through the results");
      return;
    }
    const list = this.workspace();
    const id = stepSelection(list.rows, list.active?.id ?? null, delta);
    if (id === null) {
      this.notify("info", `No task matches /${query}`);
      return;
    }
    const at = list.activeIndex;
    if (at >= 0 && list.rows.length > 1 && (at + delta >= list.rows.length || at + delta < 0)) {
      this.notify("info", delta > 0 ? "Search wrapped to the first result" : "Search wrapped to the last result");
    }
    this.select(id);
  }

  /**
   * A jump (`:open`, `:<id>`, following a reference): remember the task shown
   * now for :back, forget the forward history, select the target. The list
   * filters are untouched.
   */
  jump(id: number): void {
    if (!this.#tasks.some(t => t.id === id)) throw new CommandError(`No task @${id}`);
    const here = this.#here();
    if (here !== null && here.taskId !== id) {
      this.#remember(this.#past, here);
      this.#future = [];
    }
    this.select(id);
  }

  /** A jump inside the current document (a heading, `{`/`}`): remember where it was read, for :back. */
  recordJump(): void {
    const here = this.#here();
    if (here === null) return;
    this.#remember(this.#past, here);
    this.#future = [];
  }

  /** An @id reference: clear every filter and the search, then jump to the task. */
  followTaskRef(id: number): void {
    const next = followTaskRef(this.listView, this.#tasks, id);
    if (next === null) throw new CommandError(`No task @${id}`);
    this.setQuery(next.query);
    this.setFilter(next.filter);
    this.jump(id);
  }

  /** A #tag reference: the tag filter becomes exactly that tag. */
  followTagRef(name: string): void {
    this.setFilter(followTagRef(this.listView, name).filter);
  }

  /** The current task and, with a reader, where its document is read. */
  #here(): Jump | null {
    const id = this.selectedTask()?.id ?? null;
    if (id === null) return null;
    return { taskId: id, place: this.#reader?.place(id) ?? null };
  }

  /**
   * Jump to a task this session just created: now when the live stream
   * already delivered it, else as soon as it does (bounded). Resolves whether
   * it was shown; explicit navigation in the meantime cancels it, so a late
   * arrival never steals the selection.
   */
  revealTask(id: number, timeoutMs = REVEAL_TIMEOUT_MS): Promise<boolean> {
    this.#reveal?.finish(false);
    if (this.#tasks.some(t => t.id === id)) {
      this.jump(id);
      return Promise.resolve(true);
    }
    return new Promise<boolean>(resolve => {
      let cancelTimer: () => void = () => {};
      const reveal = {
        id,
        finish: (shown: boolean): void => {
          if (this.#reveal === reveal) this.#reveal = null;
          cancelTimer();
          resolve(shown);
        },
      };
      this.#reveal = reveal;
      cancelTimer = this.#schedule(() => reveal.finish(false), timeoutMs);
    });
  }

  #checkReveal(): void {
    const reveal = this.#reveal;
    if (reveal === null || !this.#tasks.some(t => t.id === reveal.id)) return;
    this.#reveal = null;
    this.jump(reveal.id);
    reveal.finish(true);
  }

  /** :back — the task shown before the last jump. */
  back(): void {
    this.#travel(this.#past, this.#future, "No earlier task in the history");
  }

  /** :forward — undo a :back. */
  forward(): void {
    this.#travel(this.#future, this.#past, "No later task in the history");
  }

  #travel(from: Jump[], to: Jump[], none: string): void {
    const here = this.#here();
    let target: Jump | undefined;
    while ((target = from.pop()) !== undefined) {
      const id = target.taskId;
      if (this.#tasks.some(t => t.id === id) && (here === null || !samePlace(target, here))) break;
    }
    if (target === undefined) {
      this.notify("info", none);
      return;
    }
    if (here !== null) this.#remember(to, here);
    this.select(target.taskId);
    if (target.place !== null) this.#reader?.restore(target.taskId, target.place);
    this.#changed();
  }

  #remember(stack: Jump[], jump: Jump): void {
    const last = stack[stack.length - 1];
    if (last === undefined || !samePlace(last, jump)) stack.push(jump);
    if (stack.length > MAX_JUMPS) stack.splice(0, stack.length - MAX_JUMPS);
  }

  setQuery(query: string): void {
    const next = query.trim();
    if (next === this.#query) return;
    this.#query = next;
    this.#changed();
  }

  /** Replace the filter slots (for this session only). */
  setFilter(filter: TaskFilter): void {
    const next: TaskFilter = { status: filter.status, lane: filter.lane, tags: [...filter.tags] };
    const cur = this.#filter;
    if (
      next.status === cur.status &&
      next.lane === cur.lane &&
      next.tags.length === cur.tags.length &&
      next.tags.every((t, i) => t === cur.tags[i])
    ) {
      return;
    }
    this.#filter = next;
    this.#changed();
  }

  /** :clear — the search and every filter slot; include-done and the selection stay. */
  clearFilters(): void {
    const cleared = clearFilters(this.listView);
    this.setQuery(cleared.query);
    this.setFilter(cleared.filter);
  }

  /** A header tag label: widen the tag filter with it. */
  appendTagFilter(name: string): void {
    this.setFilter(appendTagFilter(this.listView, name).filter);
  }

  /** Show done tasks, for this session only (tui.toml's `done` sets how it starts). */
  setIncludeDone(value: boolean): void {
    if (this.#includeDone === value) return;
    this.#includeDone = value;
    this.#changed();
  }

  /** `:sort` — the list's order without a search, for this session (:config sort sets the default). */
  setSort(sort: TaskSort): void {
    if (this.#sort === sort) return;
    this.#sort = sort;
    this.#changed();
  }

  /** `:sort group` — the list's grouping without a search, for this session (:config group sets the default). */
  setGroup(group: TaskGroup): void {
    if (this.#group === group) return;
    this.#group = group;
    this.#changed();
  }

  #seedSelection(): void {
    if (this.#selectionSeeded) {
      // A deleted selection falls back (to the first visible task) silently.
      return;
    }
    this.#selectionSeeded = true;
    const wanted = [this.#options.initialTask ?? null, this.#databasePreferences()?.lastTask ?? null];
    for (const id of wanted) {
      if (id !== null && this.#tasks.some(t => t.id === id)) {
        this.#selectedId = id;
        break;
      }
    }
    const heading = this.#options.heading ?? null;
    const target = this.#options.initialTask ?? null;
    if (heading !== null && target !== null && this.#selectedId === target) {
      // `cortex tui <id> --heading <slug>` asks to read there: the rendered document gets the focus
      // (a temporary Read from Edit, the preview half in Split; the session's mode stays).
      this.#heading = { taskId: target, slug: heading };
      this.#focus = "document";
      if (this.#preferredMode === "edit") this.#temporary = { taskId: target, mode: "read" };
      else if (this.#preferredMode === "split") this.#splitHalf = "preview";
    }
  }

  /** A database's list starts unfiltered: filters never outlive a session, nor a replaced database. */
  #restoreDatabaseView(): void {
    this.#query = "";
    this.#filter = NO_FILTER;
  }

  // ---------- focus, views and scroll ----------

  get focus(): Focus {
    return this.#focus;
  }

  /** Explicit focus change; focusing the hidden task list shows it (the list's keys end INSERT). */
  setFocus(focus: Focus): void {
    if (focus === "tasks" && !this.#taskList) this.#setTaskList(true);
    if (this.#focus === focus) return;
    this.#focus = focus;
    this.#settleInsert();
    this.#changed();
  }

  /** Tab / Shift-Tab: the next or previous visible pane (in Split, the editor and preview halves are two). */
  cycleFocus(direction: 1 | -1): void {
    const split = this.documentMode() === "split";
    if (!this.#taskList) {
      if (split && this.#focus === "document") this.#splitHalf = this.#splitHalf === "editor" ? "preview" : "editor";
      this.setFocus("document");
      this.#settleInsert();
      this.#changed();
      return;
    }
    const order: readonly string[] = split ? ["tasks", "editor", "preview"] : ["tasks", "document"];
    const current = this.#focus === "tasks" ? "tasks" : split ? this.#splitHalf : "document";
    const next = order[(order.indexOf(current) + direction + order.length) % order.length];
    if (next === "tasks") this.setFocus("tasks");
    else {
      if (next === "editor" || next === "preview") this.#splitHalf = next;
      this.setFocus("document");
    }
    this.#settleInsert();
    this.#changed();
  }

  toggleTaskList(): void {
    this.setTaskListVisible(!this.#taskList);
  }

  /** Show or hide the task list, for this session only (tui.toml's `tasks` sets how it starts); hiding it moves focus to the document. */
  setTaskListVisible(visible: boolean): void {
    this.#setTaskList(visible);
    if (!visible) this.#focus = "document";
    this.#changed();
  }

  #setTaskList(visible: boolean): void {
    this.#taskList = visible;
  }

  get view(): SessionView {
    return this.#view;
  }

  get viewScroll(): number {
    return this.#viewScroll;
  }

  openView(view: SessionView): void {
    // The help's search lasts while it is open: opening it (again) or another view starts without one.
    if (view === "help" || this.#view === "help") this.#help?.clear();
    this.#view = view;
    this.#viewScroll = 0;
    this.#settleInsert(); // the view covers the workspace: its INSERT ends
    this.#changed();
  }

  /**
   * One wheel report's step: its direction when it starts a notch, 0 for the
   * notch's other reports (a terminal may send several for one notch:
   * src/tui/mouse.ts WheelNotches). Every pane moves `step * scrollRows`
   * (a form, one field a step).
   */
  wheelNotch(delta: number): number {
    return this.#wheel.step(delta);
  }

  /** The rows or list items one wheel notch moves, in every pane (tui.toml's `scroll`). */
  get scrollRows(): number {
    return this.#scrollRows;
  }

  /** For this session (:config scroll saves it first). */
  setScrollRows(rows: number): void {
    this.#scrollRows = rows;
    this.#changed();
  }

  closeView(): void {
    if (this.#view === "workspace") return;
    if (this.#view === "help") this.#help?.clear();
    this.#view = "workspace";
    this.#viewScroll = 0;
    this.#changed();
  }

  /** Scroll the open view; `max` (from the renderer) clamps it. */
  scrollView(delta: number, max = Number.MAX_SAFE_INTEGER): void {
    this.#viewScroll = Math.max(0, Math.min(max, this.#viewScroll + delta));
    this.#changed();
  }

  setViewScroll(value: number): void {
    this.#viewScroll = Math.max(0, value);
  }

  docScroll(taskId: number): number {
    return this.#docScroll.get(taskId) ?? 0;
  }

  /** Scroll the selected task's document; the renderer clamps it to the content. */
  scrollDocument(delta: number): void {
    const task = this.selectedTask();
    if (!task) return;
    this.setDocScroll(task.id, this.docScroll(task.id) + delta);
    this.#changed();
  }

  setDocScroll(taskId: number, value: number): void {
    this.#docScroll.set(taskId, Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, value)));
  }

  /** The `--heading` to reveal once the renderer knows the document's lines; consumed by takeHeading. */
  pendingHeading(): { taskId: number; slug: string } | null {
    return this.#heading;
  }

  takeHeading(): void {
    this.#heading = null;
  }

  // ---------- theme and suspend (set by the shell) ----------

  /**
   * The resolved theme; null until the shell resolved it (nothing themed
   * renders before). While the shell paints one pane through withPaneTheme,
   * that pane's theme.
   */
  get theme(): ResolvedTheme | null {
    return this.#paneTheme ?? this.#theme;
  }

  /**
   * Paint one pane through `theme` (the shell greys the unfocused pane with
   * src/tui/theme.ts inactiveTheme): the list, the reader and the task
   * panels read session.theme, so the override reaches each of them for
   * exactly this synchronous render.
   */
  withPaneTheme<T>(theme: ResolvedTheme, render: () => T): T {
    const saved = this.#paneTheme;
    this.#paneTheme = theme;
    try {
      return render();
    } finally {
      this.#paneTheme = saved;
    }
  }

  setTheme(theme: ResolvedTheme): void {
    this.#theme = theme;
    this.#changed();
  }

  /** The shell's theme controls (`:config theme`); null without a shell. */
  get themeControl(): ThemeControl | null {
    return this.#themeControl;
  }

  setThemeControl(control: ThemeControl | null): void {
    this.#themeControl = control;
  }

  // ---------- the document reader and the clipboard ----------

  /** The document reader (src/tui/reader.ts createReader registers it); null without one. */
  get reader(): Reader | null {
    return this.#reader;
  }

  attachReader(reader: Reader | null): void {
    this.#reader = reader;
  }

  /** The help view (src/tui/help.ts createHelp registers it). */
  attachHelp(help: Help | null): void {
    this.#help = help;
  }

  get activity(): Activity | null {
    return this.#activity;
  }

  attachActivity(activity: Activity | null): void {
    this.#activity = activity;
  }

  /** The task panel shown in the document pane (the document itself, Activity, Related or Authors). */
  get panel(): TaskPanel {
    return this.#panel;
  }

  /**
   * Show a task panel; the Read/Edit/Split preference is untouched. Leaving the
   * document ends its INSERT, and the panel owns the document cursor (its
   * motions and Enter are the panel's, never the title's).
   */
  setPanel(panel: TaskPanel): void {
    if (this.#panel === panel) return;
    if (panel !== "document") {
      if (this.#insert !== null) this.leaveInsert();
      this.#docTarget = "body";
    }
    this.#panel = panel;
    this.#changed();
  }

  /** `]` / `[`: the next or previous task panel (wrapping). */
  cyclePanel(direction: 1 | -1): void {
    const at = TASK_PANELS.indexOf(this.#panel);
    this.setPanel(TASK_PANELS[(at + direction + TASK_PANELS.length) % TASK_PANELS.length] ?? "document");
  }

  /** The rendered document (Read, or the Split preview half) has the keyboard: `/` and n/N search it. */
  readerFocused(): boolean {
    if (this.#reader === null || this.#view !== "workspace" || this.#focus !== "document") return false;
    if (this.#panel !== "document") return false;
    const mode = this.documentMode();
    return mode === "read" || (mode === "split" && this.#splitHalf === "preview");
  }

  /**
   * Show the current task's rendered document with the keyboard on it (a
   * heading jump): from Edit, Read for this task only (the session's mode
   * stays); in Split, the preview half.
   */
  revealReader(): void {
    const task = this.selectedTask();
    if (task === null) return;
    const mode = this.documentMode();
    if (mode === "edit") {
      if (this.#insert?.taskId === task.id) this.leaveInsert();
      this.#temporary = { taskId: task.id, mode: "read" };
    } else if (mode === "split") this.#splitHalf = "preview";
    this.#panel = "document";
    this.closeView();
    this.setFocus("document");
    this.#settleInsert();
    this.#changed();
  }

  /** Put the keyboard on one Split half (a click on it): the preview's keys end the editor's INSERT. */
  setSplitHalf(half: SplitHalf): void {
    if (this.#splitHalf === half) return;
    this.#splitHalf = half;
    this.#settleInsert();
    this.#changed();
  }

  /** Where clipboard writes go: the shell's terminal (OSC 52); null without one. */
  setClipboard(write: ((data: string) => void) | null): void {
    this.#clipboard = write;
  }

  /**
   * An explicit copy (:copy, a web link from :links): one OSC 52 write, never
   * a rendering effect. Reported as unconfirmed, because terminals never
   * acknowledge it. Throws CommandError when it cannot be sent.
   */
  copyText(text: string, what: string): void {
    const write = this.#clipboard;
    if (write === null) throw new CommandError(`Could not copy ${what}: no terminal to send the clipboard write to`);
    const result = osc52Copy(text, write);
    if (result.status === "failed") throw new CommandError(`Could not copy ${what}: ${result.reason}`);
    this.notify(
      "info",
      `Copied ${what} (${result.bytes} bytes) with OSC 52; unconfirmed: the terminal never acknowledges it and may ignore it (tmux needs set-clipboard on)`,
    );
  }

  /** The shell's suspend (Ctrl-z and :suspend). */
  setSuspendHandler(suspend: (() => void) | null): void {
    this.#suspend = suspend;
  }

  requestSuspend(): void {
    if (this.#suspend === null) this.notify("info", "Suspend is not available here");
    else this.#suspend();
  }

  /** The shell's terminal handoff for external programs (src/tui/bridge.ts withExternalProgram). */
  setTerminalHandoff(handoff: TerminalHandoff | null): void {
    this.#handoff = handoff;
  }

  /** Give the terminal to `run` and take it back afterwards; a CommandError without a shell. */
  handOffTerminal<T>(run: () => Promise<T>): Promise<T> {
    const handoff = this.#handoff;
    if (handoff === null) {
      return Promise.reject(new CommandError("No terminal to hand over: external programs need the full-screen TUI"));
    }
    return handoff(run);
  }

  // ---------- prompt line (`:` and `/`) ----------

  get prompt(): CommandLine | null {
    return this.#prompt;
  }

  /** What the open `/` searches: the open help, the rendered document when the reader had the focus, else the task list. */
  get searchTarget(): SearchTarget {
    return this.#searchTarget;
  }

  /** Open the `:` command line or `/` search (keys.ts's mode follows). */
  openPrompt(kind: CommandLineKind, initial = ""): void {
    if (kind === "/") {
      this.#searchTarget =
        this.dialog !== null
          ? "list"
          : this.#view === "help" && this.#help !== null
            ? "help"
            : this.readerFocused()
              ? "document"
              : "list";
    }
    // Only the task list's search completes (#tags); the document's and the help's are plain text.
    const listSearch = kind === "/" && this.#searchTarget === "list";
    const dialog = this.dialog;
    // A live dialog (the filter picker) filters as the prompt is typed, starting from its current search.
    const live =
      kind === "/" && dialog !== null && dialog.searchesLive === true
        ? { dialog, before: dialog.searchText ?? "" }
        : null;
    this.#liveSearch = live;
    this.#prompt = createCommandLine(kind, {
      history: this.#histories[kind],
      complete:
        kind === ":"
          ? line => completeCommandLine(line, this.commands, this)
          : listSearch
            ? line => this.#completeSearch(line)
            : () => [],
      initial: live !== null && initial === "" ? live.before : initial,
      onChange: () => {
        if (live !== null && this.#liveSearch === live && this.#prompt !== null)
          live.dialog.search(this.#prompt.text.trim());
        this.#changed();
      },
    });
    this.#syncMode();
    this.#changed();
  }

  /** Cancel the prompt (Esc, Backspace on an empty line); a cancelled live search restores the dialog's filter. */
  closePrompt(): void {
    if (this.#prompt === null) return;
    this.#prompt = null;
    const live = this.#liveSearch;
    this.#liveSearch = null;
    if (live !== null) live.dialog.search(live.before);
    this.#syncMode();
    this.#changed();
  }

  promptInsert(text: string): void {
    this.#prompt?.insert(text);
  }

  /** A bracketed paste: inserted as text, with line breaks as spaces, so it can never submit. */
  promptPaste(text: string): void {
    this.#prompt?.paste(text);
  }

  /** Editing, completion and history keys; `cancel` when backspace on an empty line closed the prompt. */
  promptKey(key: string | null): "cancel" | "handled" | "ignored" {
    const p = this.#prompt;
    if (p === null) return "ignored";
    const result = p.key(key);
    if (result === "cancel") this.closePrompt();
    return result;
  }

  /** A short explanation of a `:` completion candidate (the task it names, else the command). */
  describeCandidate(candidate: string): string | undefined {
    return describeCandidate(candidate, this.commands, this);
  }

  /**
   * Enter: run the command line (remembered in its history), or apply the
   * search: to the open dialog, the help when it is open, the rendered
   * document when it had the focus, else to the task list (an empty search
   * clears it).
   */
  async submitPrompt(): Promise<void> {
    const p = this.#prompt;
    if (p === null) return;
    const text = p.submit();
    this.#prompt = null;
    this.#liveSearch = null;
    this.#syncMode();
    this.#changed();
    if (p.kind === "/") {
      const dialog = this.dialog;
      if (dialog !== null) dialog.search(text.trim());
      else if (this.#searchTarget === "help" && this.#view === "help" && this.#help !== null) {
        this.#help.search(text);
      } else if (this.#searchTarget === "document" && this.#reader !== null) this.#reader.search(text);
      else this.setQuery(text);
      return;
    }
    await this.execute(text);
  }

  /** `/` completes a trailing `#tag` from the tag catalog. */
  #completeSearch(line: string): string[] {
    const m = /(?:^|\s)#(\S*)$/.exec(line);
    if (!m) return [];
    const stem = m[1] ?? "";
    const before = line.slice(0, line.length - stem.length);
    return this.#tags
      .map(t => t.name)
      .filter(n => n.startsWith(stem))
      .map(n => `${before}${n}`);
  }

  /** keys.ts's mode follows the prompt (a programmatic open, a Backspace that closed it). */
  #syncMode(): void {
    const want = this.#prompt === null ? "NORMAL" : this.#prompt.kind === ":" ? "COMMAND" : "SEARCH";
    const mode = this.keys.mode();
    if (mode === want) return;
    if (this.#prompt === null && mode !== "COMMAND" && mode !== "SEARCH") return;
    this.keys.setMode(want);
  }

  // ---------- input routing and dialogs ----------

  /** The workspace's key handler (the shell): events that neither the prompt nor a dialog takes. */
  setKeyHandler(handler: ((event: KeyEvent) => void) | null): void {
    this.#keyHandler = handler;
  }

  /**
   * One terminal input, routed the same way whichever component the toolkit
   * focused: the open prompt, then the top dialog (its raw letter keys
   * first), then the workspace's key handler.
   */
  input(data: string): void {
    this.clearStatus();
    const dialog = this.dialog;
    if (dialog !== null && this.#prompt === null && dialog.handleRaw(data)) {
      this.#changed();
      return;
    }
    for (const event of this.keys.feed(data)) this.#route(event);
  }

  #route(event: KeyEvent): void {
    if (this.handlePromptEvent(event)) return;
    const dialog = this.dialog;
    if (dialog === null) {
      if (this.#insertEvent(event)) return;
      this.#keyHandler?.(event);
      return;
    }
    if (event.type === "action" && event.action === "suspend") this.requestSuspend();
    else dialog.handleKey(event);
    this.#changed();
  }

  /**
   * The `:`/`/` prompt's share of the key events: opening it, submitting,
   * cancelling, and every text/editing key while it is open. False for
   * everything else (Esc out of a form's INSERT is the form's).
   */
  handlePromptEvent(event: KeyEvent): boolean {
    if (event.type === "mode") {
      if (event.cause === "command") this.openPrompt(":");
      else if (event.cause === "search") this.openPrompt("/");
      else if (event.cause === "submit") void this.submitPrompt();
      else if (this.#prompt !== null || event.previous === "COMMAND" || event.previous === "SEARCH") this.closePrompt();
      else return false;
      return true;
    }
    if (this.#prompt === null) return false;
    if (event.type === "text") this.promptInsert(event.text);
    else if (event.type === "paste") this.promptPaste(event.text);
    else if (event.type === "key") this.promptKey(event.key);
    else return false;
    return true;
  }

  /** Where dialogs are drawn (the shell); null without a terminal. */
  get overlayHost(): OverlayHost | null {
    return this.#overlayHost;
  }

  setOverlayHost(host: OverlayHost | null): void {
    this.#overlayHost = host;
  }

  /** The top (focused) dialog, or null. */
  get dialog(): SessionDialog | null {
    return this.#dialogs[this.#dialogs.length - 1] ?? null;
  }

  get dialogs(): readonly SessionDialog[] {
    return this.#dialogs;
  }

  /** A dialog opened on top (src/tui/dialogs.ts showDialog): the keys switch to its mode (INSERT ends first). */
  pushDialog(dialog: SessionDialog): void {
    this.leaveInsert();
    this.#dialogs.push(dialog);
    if (this.#prompt === null) this.keys.setMode(dialog.mode());
    this.#changed();
  }

  /** A dialog closed: the one below (in its own mode) or the workspace (NORMAL) has the keyboard again. */
  removeDialog(dialog: SessionDialog): void {
    const at = this.#dialogs.indexOf(dialog);
    if (at < 0) return;
    this.#dialogs.splice(at, 1);
    if (this.#prompt === null) this.keys.setMode(this.dialog?.mode() ?? "NORMAL");
    this.#changed();
  }

  /** Close every dialog, top first, without questions. */
  closeDialogs(): void {
    for (const dialog of [...this.#dialogs].reverse()) dialog.close();
  }

  /** Something a dialog shows changed. */
  redraw(): void {
    this.#changed();
  }

  // ---------- writes ----------

  /** A write is in flight (the status line says so). */
  get writing(): boolean {
    return this.#writing > 0;
  }

  /**
   * The database commands act on, as a generation: capture it when a command
   * is SUBMITTED and pass it to mutate (and requireDatabase) when the command
   * awaits anything before its write, so a replacement meanwhile refuses it.
   */
  get databaseGeneration(): number {
    return this.#databaseGen;
  }

  /** A CommandError (nothing ran) when the database was replaced since `database` was captured. */
  requireDatabase(database: number): void {
    if (database !== this.#databaseGen) throw new CommandError(REPLACED_BEFORE);
  }

  /**
   * Run one write after the previous one finished (in order, one at a time),
   * so a command acts on the state the earlier ones left. A failure never
   * blocks the next write. Never retries. `write` sends EVERY request through
   * the client it is handed, bound to `database` (the generation the command
   * was submitted against; default: now). Refused (a CommandError, nothing
   * sent) while a replacement database is loading and when the database was
   * replaced before its turn; once it is replaced while `write` runs, each
   * later request is refused before dispatch (its target was the old
   * database's; what was sent went there).
   */
  async mutate<T>(write: (client: CortexClient) => Promise<T>, database = this.#databaseGen): Promise<T> {
    this.requireDatabase(database);
    this.#assertWritable();
    const previous = this.#writes;
    let done = (): void => {};
    this.#writes = new Promise<void>(resolve => {
      done = resolve;
    });
    await previous;
    this.#writing++;
    this.#changed();
    try {
      this.requireDatabase(database);
      this.#assertWritable();
      return await write(this.#boundClient(database));
    } finally {
      this.#writing--;
      done();
      this.#changed();
    }
  }

  /**
   * The client of ONE operation: each request goes to the current client (a
   * restarted daemon of the same database included) while the database is
   * the one the operation was submitted against, and is refused BEFORE
   * dispatch (a rejected CommandError) once it was replaced or its
   * replacement is loading.
   */
  #boundClient(database: number): CortexClient {
    let sent = false;
    const bind =
      (source: () => object, reads: ReadonlySet<PropertyKey>) =>
      (key: PropertyKey): unknown => {
        const target = source();
        const value: unknown = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        return (...args: unknown[]): unknown => {
          if (database !== this.#databaseGen || this.#replacing) {
            return Promise.reject(new CommandError(sent ? REPLACED_DURING : REPLACED_BEFORE));
          }
          if (!reads.has(key)) sent = true;
          return Reflect.apply(value, target, args);
        };
      };
    const versioned = bind(() => this.#client.versioned, new Set());
    const top = bind(() => this.#client, STATE_READS);
    const writes = new Proxy({} as CortexClient["versioned"], { get: (_target, key) => versioned(key) });
    return new Proxy({} as CortexClient, { get: (_target, key) => (key === "versioned" ? writes : top(key)) });
  }

  // ---------- commands ----------

  /**
   * Run one command line through the registry; errors become messages. An
   * empty line does nothing. With dialogs open, only dialog commands (:w,
   * :q ...) act on them; any other command waits while a create/management
   * form holds input, and otherwise closes the dialogs first.
   */
  async execute(line: string): Promise<void> {
    if (line.trim().replace(/^:/, "").trim() === "") return;
    try {
      const parsed = parseCommand(line, this.commands);
      if (this.#dialogs.length > 0 && parsed.spec.dialog !== true) {
        const busy = this.#dialogs.find(d => d.blocksCommands());
        if (busy !== undefined) {
          throw new CommandError(
            `:${parsed.spec.name} waits: the ${busy.label} form has unsaved input (:w saves it, :q! discards it)`,
          );
        }
        this.closeDialogs();
      }
      await parsed.spec.run(this, parsed.argument);
    } catch (err) {
      this.notify("error", err instanceof Error ? err.message : String(err));
    }
    this.#changed();
  }

  /**
   * :q (force false) refuses while any title/body draft is unsaved, failing
   * or conflicted, or any composer draft is unsent, and names them; :q!
   * (force true) discards the local drafts.
   */
  quit(force: boolean): void {
    if (force) {
      this.discardDrafts();
      this.#options.onQuit?.(true);
      return;
    }
    const unsaved = this.unsavedDrafts();
    const unsent = this.#activity?.unsent() ?? [];
    if (unsaved.length > 0 || unsent.length > 0) {
      const parts: string[] = [];
      if (unsaved.length > 0) {
        parts.push(`unsaved ${describeUnsaved(unsaved)}. :w saves, :wq saves and quits, ${unsavedHint(unsaved)}`);
      }
      if (unsent.length > 0) parts.push(describeUnsent(unsent));
      this.notify("error", `Not quitting: ${parts.join("; ")}`);
      return;
    }
    this.#options.onQuit?.(false);
  }

  /** :wq / :x: save every draft, then quit only when every save was acknowledged (composer drafts are never posted). */
  async writeAndQuit(): Promise<void> {
    await this.flushDrafts();
    const unsaved = this.unsavedDrafts();
    const unsent = this.#activity?.unsent() ?? [];
    if (unsaved.length > 0 || unsent.length > 0) {
      const parts: string[] = [];
      if (unsaved.length > 0) parts.push(`${describeUnsaved(unsaved)} not saved; ${unsavedHint(unsaved)}`);
      if (unsent.length > 0) parts.push(describeUnsent(unsent));
      this.notify("error", `Not quitting: ${parts.join("; ")}`);
      return;
    }
    this.#options.onQuit?.(false);
  }

  // ---------- documents: modes, drafts and editors ----------

  /** The session's Read/Edit/Split mode (tui.toml's `mode` starts it). */
  get preferredMode(): DocumentMode {
    return this.#preferredMode;
  }

  /**
   * The mode shown for the current task: a temporary one (Edit after `i` from
   * Read, Read after a heading jump from Edit) or the session's mode.
   */
  documentMode(): DocumentMode {
    const id = this.selectedTask()?.id ?? null;
    const temporary = this.#temporary;
    return id !== null && temporary !== null && temporary.taskId === id ? temporary.mode : this.#preferredMode;
  }

  /** :read / :edit / :split and their leader keys (and :config mode): the ONLY way the session's mode changes. */
  setDocumentMode(mode: DocumentMode): void {
    this.#temporary = null;
    this.#panel = "document";
    this.#preferredMode = mode;
    if (mode === "split") this.#splitHalf = "editor";
    this.#settleInsert(); // Read hides the editor: its INSERT ends
    const task = this.selectedTask();
    if (mode !== "read" && task !== null) void this.openDocument(task.id);
    this.#changed();
  }

  get splitHalf(): SplitHalf {
    return this.#splitHalf;
  }

  get documentTarget(): DocumentTarget {
    return this.#docTarget;
  }

  /** Move the document cursor between the title and the body (k at the top of the body, j from the title). */
  setDocumentTarget(target: DocumentTarget): void {
    if (this.#docTarget === target) return;
    this.#docTarget = target;
    this.#settleInsert(); // off the field in INSERT: it ends
    this.#changed();
  }

  /** The in-place title editor while the title is in INSERT. */
  get titleEdit(): { readonly taskId: number; readonly line: CommandLine } | null {
    const insert = this.#insert;
    return insert?.target === "title" && this.#titleLine !== null
      ? { taskId: insert.taskId, line: this.#titleLine }
      : null;
  }

  /** What INSERT edits right now, or null. */
  get insertTarget(): { readonly target: DocumentTarget; readonly taskId: number } | null {
    return this.#insert;
  }

  /** This session's document of a task (possibly still loading its baseline), or null. */
  documentOf(taskId: number): TaskDocument | null {
    return this.#documents.get(taskId) ?? null;
  }

  /** The task's document, loading its atomic TaskState baseline first when needed; null when it cannot. */
  openDocument(taskId: number): Promise<TaskDocument | null> {
    const existing = this.#documents.get(taskId);
    if (existing !== undefined && existing.error === null) {
      return existing.loading ?? Promise.resolve(existing.draft === null ? null : existing);
    }
    const entry: DocumentEntry = existing ?? {
      taskId,
      draft: null,
      editor: null,
      error: null,
      removing: false,
      loading: null,
      queue: [],
      refreshing: false,
      refreshAgain: false,
      keptAs: null,
    };
    entry.error = null;
    this.#documents.set(taskId, entry);
    entry.loading = this.#load(entry);
    this.#changed();
    return entry.loading;
  }

  async #load(entry: DocumentEntry): Promise<TaskDocument | null> {
    let draft: TaskDraft;
    try {
      const state = await this.#client.taskState(entry.taskId);
      if (this.#disposed || this.#documents.get(entry.taskId) !== entry) {
        entry.loading = null; // orphaned, removed or discarded meanwhile: its late baseline is ignored
        return null;
      }
      draft = createTaskDraft(state, this.#liveClient, this.#draftScheduler, {
        onChange: () => this.#changed(),
        onReplace: field => this.#replaced(entry, field),
      });
    } catch (err) {
      entry.loading = null;
      // Orphaned, removed or discarded meanwhile: whatever it held was dealt with there.
      if (this.#disposed || this.#documents.get(entry.taskId) !== entry) return null;
      const reason = err instanceof HttpError && err.status === 404 ? "it no longer exists" : errorText(err);
      // Kept with its reason, so a render never retries in a loop; :edit, i or selecting it again retries.
      entry.error = reason;
      if (this.#insert?.taskId === entry.taskId) this.leaveInsert();
      // Keys typed meanwhile are the user's: kept, in order, for the retry (never dropped).
      const typed = entry.queue.filter(q => q.event !== null).length;
      const kept =
        typed === 0
          ? ""
          : `; the ${typed === 1 ? "key" : `${typed} keys`} typed meanwhile ${typed === 1 ? "is" : "are"} kept, not applied yet: :edit or i retries loading it, :q! discards ${typed === 1 ? "it" : "them"}`;
      this.notify("error", `Could not open @${entry.taskId} for editing: ${reason}${kept}`);
      return null;
    }
    entry.draft = draft;
    entry.editor = createDocumentEditor(createEditorState(draft.text("body")), state =>
      entry.draft?.set("body", editorText(state)),
    );
    entry.loading = null;
    if (this.#insert?.target === "title" && this.#insert.taskId === entry.taskId) {
      this.#titleLine = this.#newTitleLine(entry);
    }
    // Input typed before the baseline arrived, in order.
    let spare: CommandLine | null = null;
    for (const { target, event } of entry.queue.splice(0)) {
      if (target === "body" || event === null) {
        this.#applyInsert(entry, target, event, null);
        continue;
      }
      const live = this.#insert?.target === "title" && this.#insert.taskId === entry.taskId ? this.#titleLine : null;
      spare = live ?? spare ?? this.#newTitleLine(entry);
      this.#applyInsert(entry, target, event, spare);
    }
    this.#changed();
    return entry;
  }

  #newTitleLine(entry: DocumentEntry): CommandLine {
    const line: CommandLine = createCommandLine(":", {
      history: [],
      initial: entry.draft?.text("title") ?? "",
      onChange: () => {
        entry.draft?.set("title", line.text);
        this.#changed();
      },
    });
    return line;
  }

  /** An adopted version (a clean live update or :apply) replaced a field's local text. */
  #replaced(entry: DocumentEntry, field: DraftField): void {
    const draft = entry.draft;
    if (draft === null) return;
    if (field === "body" && entry.editor !== null) {
      const head = entry.editor.getState().selection.main.head;
      entry.editor.setState(createEditorState(draft.text("body"), { cursor: head }));
    }
    if (field === "title" && this.#insert?.target === "title" && this.#insert.taskId === entry.taskId) {
      this.#titleLine = this.#newTitleLine(entry);
    }
    this.#changed();
  }

  /** A live copy of a drafted task: re-read its versions when its title or body left the draft's base. */
  #noticeTask(task: Task): void {
    const entry = this.#documents.get(task.id);
    const draft = entry?.draft ?? null;
    if (entry === undefined || draft === null) return;
    const same = task.title === draft.base("title") && (task.body ?? "") === draft.base("body");
    if (same && draft.incoming("title") === null && draft.incoming("body") === null) return;
    // ONE re-read per document in flight: a burst of copies asks for one more, checked against the newest.
    if (entry.refreshing) {
      entry.refreshAgain = true;
      return;
    }
    entry.refreshing = true;
    entry.refreshAgain = false;
    draft
      .refresh()
      .catch(err => {
        // Deleted meanwhile: its removal event decides what happens to the draft.
        if (err instanceof HttpError && err.status === 404) return;
        this.notify("warn", `Could not read the latest version of @${task.id}: ${errorText(err)}`);
      })
      .finally(() => {
        entry.refreshing = false;
        if (!entry.refreshAgain || this.#disposed || this.#documents.get(entry.taskId) !== entry) return;
        entry.refreshAgain = false;
        const latest = this.#tasks.find(t => t.id === entry.taskId);
        if (latest !== undefined) this.#noticeTask(latest);
      });
  }

  /**
   * The task is gone: a clean draft goes with it; a dirty one (or keys typed
   * before its baseline arrived) is kept (never written) for :w <path>.
   */
  #documentRemoved(taskId: number): void {
    const entry = this.#documents.get(taskId);
    if (entry === undefined) return;
    if (this.#insert?.taskId === taskId) this.leaveInsert();
    const draft = entry.draft;
    const dirty = draft === null ? hasTyped(entry.queue) : draft.unsaved().length > 0;
    if (entry.removing || !dirty) {
      draft?.discard();
      if (this.#documents.get(taskId) === entry) this.#documents.delete(taskId);
      return;
    }
    this.#orphan(entry, "it was deleted elsewhere", "task deleted");
  }

  /**
   * The document leaves the live ones: a clean draft is dropped, a dirty one
   * becomes a kept draft. Keys typed before its baseline arrived become a
   * kept draft of their own, replayed onto empty text (there is no baseline
   * to merge them with); its late baseline is ignored.
   */
  #orphan(entry: DocumentEntry, why: string, reason: string): void {
    const draft = entry.draft;
    if (this.#documents.get(entry.taskId) === entry) this.#documents.delete(entry.taskId);
    const typed = draft === null ? typedCopy(entry.queue) : null;
    entry.queue = [];
    const kept: KeptText | null = draft !== null && draft.unsaved().length > 0 ? draft : typed;
    if (kept === null) {
      draft?.discard();
      return;
    }
    const fields = kept.unsaved();
    draft?.discard(); // before leaving INSERT, which would save the title
    // Task ids are never reused within a database: a second kept draft of an id comes from a replaced one.
    const same = this.#kept.filter(k => k.taskId === entry.taskId).length;
    const address = same === 0 ? `@${entry.taskId}` : `@${entry.taskId}.${same + 1}`;
    this.#kept.push({ taskId: entry.taskId, address, draft: kept, reason, typed: typed !== null });
    entry.keptAs = address;
    if (this.#insert?.taskId === entry.taskId) this.leaveInsert();
    const what =
      typed === null
        ? `${why}; its unsaved ${fields.join(" and ")} ${fields.length === 1 ? "is" : "are"} kept here`
        : `${why} before it loaded for editing; its typed ${fields.join(" and ")} input (not merged with the saved ${fields.length === 1 ? fields[0] : "text"}) is kept here`;
    this.notify("warn", `@${entry.taskId}: ${what}: :w ${address} <path> exports it, :q! discards it`);
  }

  /** Title/body drafts that are not saved, by task then field (typed input still waiting for a baseline counts). */
  unsavedDrafts(): UnsavedDraft[] {
    const out: UnsavedDraft[] = [];
    for (const entry of [...this.#documents.values()].sort((a, b) => a.taskId - b.taskId)) {
      const draft = entry.draft;
      if (draft === null) {
        // Keys typed before its baseline arrived: unsaved until applied and saved (a failed load keeps them).
        for (const field of DRAFT_FIELDS) {
          if (!typedFor(entry.queue, field)) continue;
          out.push({
            taskId: entry.taskId,
            field,
            state: entry.error === null ? "pending" : "failed",
            orphaned: false,
            address: `@${entry.taskId}`,
            reason: entry.error === null ? null : `not loaded: ${entry.error}`,
          });
        }
        continue;
      }
      for (const field of draft.unsaved()) {
        const state = draft.state(field);
        out.push({ taskId: entry.taskId, field, state, orphaned: false, address: `@${entry.taskId}`, reason: null });
      }
    }
    for (const kept of this.#kept) {
      for (const field of kept.draft.unsaved()) {
        out.push({
          taskId: kept.taskId,
          field,
          state: kept.draft.state(field),
          orphaned: true,
          address: kept.address,
          reason: kept.reason,
        });
      }
    }
    return out;
  }

  /**
   * Send every unsaved draft now (after any baseline still loading); resolves
   * when the writes settled. A baseline that failed to load while holding
   * typed keys is loaded once more, so they are applied and saved.
   */
  async flushDrafts(): Promise<void> {
    for (const entry of [...this.#documents.values()]) {
      if (entry.draft === null && entry.error !== null && hasTyped(entry.queue)) void this.openDocument(entry.taskId);
    }
    const loading = [...this.#documents.values()].flatMap(e => (e.loading === null ? [] : [e.loading]));
    await Promise.all(loading);
    const drafts = [...this.#documents.values()].flatMap(e => (e.draft === null ? [] : [e.draft]));
    await Promise.all(drafts.map(d => d.flush()));
  }

  /** :w: flush every draft (retrying failures) and report what was saved or what is still not. */
  async writeDrafts(): Promise<void> {
    const before = this.unsavedDrafts().filter(d => !d.orphaned);
    await this.flushDrafts();
    const after = this.unsavedDrafts();
    if (after.length > 0) {
      this.notify("error", `Not saved: ${describeUnsaved(after)}; ${unsavedHint(after)}`);
      return;
    }
    this.notify(
      "info",
      before.length === 0
        ? "Nothing to write: every draft is saved"
        : `Saved ${before.map(d => `@${d.taskId} ${d.field}`).join(", ")}`,
    );
  }

  /** :q!: drop every local draft, composer drafts included (nothing more is sent). */
  discardDrafts(): void {
    this.leaveInsert();
    this.#activity?.discard();
    for (const entry of this.#documents.values()) entry.draft?.discard();
    this.#documents.clear();
    this.#kept = [];
    this.#changed();
  }

  /** A deletion this session is about to send (or that failed: expected false): its removal drops the draft quietly. */
  expectRemoval(taskId: number, expected = true): void {
    const entry = this.#documents.get(taskId);
    if (entry !== undefined) entry.removing = expected;
  }

  /**
   * :w [@id] <path> (overwrite false) / :w! [@id] <path>: export a body
   * draft to a private 0600 file. Returns the report; throws CommandError.
   * - `@<id>` (`@<id>.<n>`: a later kept draft of that id): that kept draft,
   *   else task @id's draft or body.
   * - No address: the current task's draft while it has unsaved changes; else
   *   the only kept draft (with several, each is named: nothing is guessed);
   *   else the current task's body. A clean current document never hides a
   *   kept draft. Exporting never discards a kept draft (:q! does).
   * - Keys typed before a document's baseline arrived are its unsaved
   *   changes: the export waits for the baseline (the keys are applied to it)
   *   and refuses when it failed to load, never writing the saved body in
   *   their place.
   */
  async exportDraft(argument: string, overwrite: boolean): Promise<string> {
    const ref = /^@(\d+)(?:\.\d+)?(?=\s|$)/.exec(argument);
    const file = (ref === null ? argument : argument.slice(ref[0].length)).trim();
    if (file === "") throw new CommandError(overwrite ? "Usage: :w! [@id] <path>" : "Usage: :w [@id] <path>");
    const source = await (ref === null ? this.#exportSource() : this.#exportSourceOf(ref[0], Number(ref[1])));
    const target = resolveDraftPath(file);
    try {
      writeDraftFile(target, source.text, overwrite);
    } catch (err) {
      throw new CommandError(`Could not export ${source.label}: ${errorText(err)}`);
    }
    const typed = source.typed;
    const holds =
      typed === null
        ? "body"
        : typed.includes("body")
          ? "typed body input (not merged with the saved body)"
          : "typed input (none of it for the body: the file is empty)";
    const title =
      source.title === null
        ? ""
        : `; its ${typed === null ? "unsaved title" : "typed title input"} is not in the file: ${JSON.stringify(source.title)}`;
    return `Exported ${source.label}'s ${holds} to ${target} (private, mode 0600)${title}`;
  }

  /** What a plain :w <path> exports (see exportDraft). */
  async #exportSource(): Promise<ExportSource> {
    const task = this.selectedTask();
    const current = task === null ? undefined : this.#documents.get(task.id);
    if (current !== undefined && current.draft === null && hasTyped(current.queue)) {
      return this.#typedSource(current, `@${current.taskId}`);
    }
    if (current?.draft && current.draft.unsaved().length > 0) return draftSource(`@${current.taskId}`, current.draft);
    const [only, ...more] = this.#kept;
    if (only !== undefined && more.length === 0) return keptSource(only);
    if (only !== undefined) {
      const body = task === null ? "" : `, :w @${task.id} <path> exports @${task.id}'s body`;
      throw new CommandError(`Which draft? ${keptHints(this.#kept.map(k => k.address))}${body}`);
    }
    if (current?.draft) return draftSource(`@${current.taskId}`, current.draft);
    if (task !== null) return { label: `@${task.id}`, text: task.body ?? "", title: null, typed: null };
    throw new CommandError("Nothing to export: no task is selected");
  }

  /** What :w @<id> <path> exports: that kept draft, else the live task's draft or body. */
  async #exportSourceOf(address: string, id: number): Promise<ExportSource> {
    const kept = this.#kept.find(k => k.address === address);
    if (kept !== undefined) return keptSource(kept);
    const live = address === `@${id}`;
    const entry = live ? this.#documents.get(id) : undefined;
    if (entry !== undefined && entry.draft === null && hasTyped(entry.queue)) return this.#typedSource(entry, address);
    if (entry?.draft) return draftSource(address, entry.draft);
    const task = live ? this.#tasks.find(t => t.id === id) : undefined;
    if (task !== undefined) return { label: address, text: task.body ?? "", title: null, typed: null };
    throw new CommandError(`No task or kept draft ${address}`);
  }

  /**
   * A live document holding keys typed before its baseline arrived: exported
   * once its load settled and applied them (it is awaited), never the saved
   * body in their place. A failed load refuses (the keys stay kept for its
   * retry); a document that left the live ones meanwhile exports the kept
   * draft its keys became.
   */
  async #typedSource(entry: DocumentEntry, label: string): Promise<ExportSource> {
    while (entry.loading !== null) await entry.loading;
    if (this.#documents.get(entry.taskId) === entry) {
      if (entry.draft !== null) return draftSource(label, entry.draft);
      const why = entry.error === null ? "" : ` (${entry.error})`;
      throw new CommandError(
        `Could not export ${label}: its document did not load${why}; the keys typed before it are kept, not applied: :edit retries loading it, :q! discards them`,
      );
    }
    const kept = this.#kept.find(k => k.address === entry.keptAs);
    if (kept !== undefined) return keptSource(kept);
    throw new CommandError(`Nothing was exported: ${label}'s typed keys were discarded while its document loaded`);
  }

  /** :apply / :keep [title|body]: resolve a conflict of the current task's draft from the keyboard. */
  async resolveConflict(action: "apply" | "keep", argument: string): Promise<void> {
    const task = this.selectedTask();
    if (task === null) throw new CommandError("No task selected: :open <id> picks one");
    const draft = this.#documents.get(task.id)?.draft ?? null;
    const conflicted = draft === null ? [] : DRAFT_FIELDS.filter(f => draft.incoming(f) !== null);
    let field: DraftField;
    if (argument === "") {
      const only = conflicted[0];
      if (only === undefined) throw new CommandError(`No conflict to resolve on @${task.id}`);
      if (conflicted.length > 1) {
        throw new CommandError(`Both the title and the body conflict: :${action} title or :${action} body`);
      }
      field = only;
    } else if (argument === "title" || argument === "body") {
      field = argument;
      if (!conflicted.includes(field)) throw new CommandError(`No ${field} conflict on @${task.id}`);
    } else throw new CommandError(`Usage: :${action} [title|body]`);
    if (draft === null) return;
    if (action === "apply") {
      draft.apply(field);
      this.notify("info", `@${task.id}: took the incoming ${field}`);
      return;
    }
    await draft.keep(field);
    const state = draft.state(field);
    if (state === "saved") this.notify("info", `@${task.id}: kept your ${field}, saved over the incoming one`);
    else if (state === "conflict") {
      this.notify("error", `@${task.id}'s ${field} changed again while saving yours: :apply or :keep decides again`);
    } else if (state === "failed") {
      this.notify("error", `Could not save your ${field} of @${task.id}: ${draft.error(field) ?? "unknown error"}`);
    }
  }

  // ---------- INSERT (the title in place, or the body editor) ----------

  /** `i`: INSERT at the document cursor: the title in place, or the body (from Read: Edit for this task only). */
  startInsert(): void {
    const task = this.selectedTask();
    if (task === null) {
      this.notify("info", this.#loaded ? "No task selected: :open <id> picks one" : "The workspace is still loading");
      return;
    }
    if (this.#focus !== "document") {
      this.setFocus("document");
      this.#docTarget = "body";
    }
    if (this.#docTarget === "title") {
      this.editTitle();
      return;
    }
    // The body is typed in the document panel: a task panel gives way to it.
    this.#panel = "document";
    if (this.documentMode() === "read") this.#temporary = { taskId: task.id, mode: "edit" };
    this.#splitHalf = "editor";
    this.#beginInsert("body", task.id);
  }

  /** `i` on the title or `:title`: edit the title in place (Enter and Esc save; the mode preference stays). */
  editTitle(): void {
    const task = this.selectedTask();
    if (task === null) throw new CommandError("No task selected: :open <id> picks one");
    this.closeView(); // edited where it is shown (a :title from :messages or :help)
    if (this.#focus !== "document") this.setFocus("document");
    this.#beginInsert("title", task.id);
  }

  #beginInsert(target: DocumentTarget, taskId: number): void {
    if (this.#insert !== null) this.leaveInsert();
    // INSERT edits at the document cursor (set after the previous INSERT ended, which returns it to the body).
    this.#docTarget = target;
    const known = this.#documents.get(taskId);
    if (known === undefined || known.error !== null) void this.openDocument(taskId);
    const entry = this.#documents.get(taskId);
    this.#insert = { target, taskId };
    this.#titleLine = target === "title" && entry?.draft ? this.#newTitleLine(entry) : null;
    this.keys.setMode("INSERT");
    this.#changed();
  }

  /**
   * Leave INSERT: the title saves (Enter/Esc commit it) and the document cursor
   * returns to the body, so no title state outlives the edit; the body never
   * saves separately from autosave or :w.
   */
  leaveInsert(): void {
    const insert = this.#insert;
    if (insert === null) return;
    this.#insert = null;
    this.#titleLine = null;
    if (insert.target === "title") {
      this.#docTarget = "body";
      const entry = this.#documents.get(insert.taskId);
      if (entry?.draft) void entry.draft.flush();
      else entry?.queue.push({ target: "title", event: null });
    }
    if (this.keys.mode() === "INSERT") this.keys.setMode("NORMAL");
    this.#changed();
  }

  /**
   * The INSERT target is on screen with the keyboard on it: the current task's
   * title (in place in the header, whichever panel is below it), or its body in
   * the document panel's editor (Edit, or Split's editor half).
   */
  #insertShown(): boolean {
    const insert = this.#insert;
    if (insert === null || this.#view !== "workspace" || this.#focus !== "document") return false;
    if (this.#docTarget !== insert.target || this.selectedTask()?.id !== insert.taskId) return false;
    if (insert.target === "title") return true;
    const mode = this.documentMode();
    return this.#panel === "document" && (mode === "edit" || (mode === "split" && this.#splitHalf === "editor"));
  }

  /**
   * A transition took the INSERT target off the screen or the keyboard (Read, a
   * view, the list, the preview half, the document cursor leaving it): INSERT
   * ends at once, so no later key edits what is not shown. A click in the target
   * keeps typing there: it stays shown.
   */
  #settleInsert(): void {
    if (this.#insert !== null && !this.#insertShown()) this.leaveInsert();
  }

  /** INSERT input for the title or the body; queued while the task's baseline is loading. */
  #insertEvent(event: KeyEvent): boolean {
    const insert = this.#insert;
    if (insert === null) return false;
    const leaving = event.type === "mode" && event.previous === "INSERT";
    if (this.keys.mode() !== "INSERT" && !leaving) {
      this.leaveInsert(); // something else took the keys (a dialog): INSERT is over
      return false;
    }
    if (event.type === "mode") {
      if (!leaving) return false;
      this.leaveInsert();
      return true;
    }
    if (this.selectedTask()?.id !== insert.taskId) {
      this.leaveInsert();
      this.notify("info", `Left INSERT: @${insert.taskId} is no longer the current task`);
      return true;
    }
    if (!this.#insertShown()) {
      // Every transition that hides the target ends INSERT (#settleInsert); a key never types into it unseen.
      this.leaveInsert();
      this.notify("info", `Left INSERT: @${insert.taskId}'s ${insert.target} is not on screen (the key was not typed)`);
      return true;
    }
    const entry = this.#documents.get(insert.taskId);
    if (entry === undefined) {
      this.leaveInsert();
      return true;
    }
    if (entry.draft === null) {
      entry.queue.push({ target: insert.target, event });
      this.#changed();
      return true;
    }
    this.#applyInsert(entry, insert.target, event, this.#titleLine);
    return true;
  }

  #applyInsert(entry: DocumentEntry, target: DocumentTarget, event: KeyEvent | null, line: CommandLine | null): void {
    if (event === null) {
      void entry.draft?.flush(); // the title's INSERT ended while it was loading: save it now
      return;
    }
    if (event.type === "action") {
      if (event.action === "save") void this.execute("w");
      return;
    }
    if (target === "title") {
      if (line === null) return;
      if (event.type === "key" && event.key === "enter") {
        if (line === this.#titleLine) this.leaveInsert();
        else void entry.draft?.flush();
        return;
      }
      typeTitle(line, event);
      return;
    }
    const editor = entry.editor;
    if (editor === null) return;
    typeBody(editor, event);
    this.#changed();
  }

  // ---------- messages ----------

  get messages(): readonly SessionMessage[] {
    return this.#messages;
  }

  /** The newest message, shown on the status line until the next key. */
  get status(): SessionMessage | null {
    return this.#status;
  }

  /** Configuration/theme/view-state problems (warnings and errors) found this session. */
  get warnings(): number {
    return this.#warnings;
  }

  notify(level: MessageLevel, text: string): void {
    const message: SessionMessage = { id: ++this.#messageId, level, text, at: this.#now() };
    this.#messages.push(message);
    if (this.#messages.length > MAX_MESSAGES) this.#messages.splice(0, this.#messages.length - MAX_MESSAGES);
    this.#status = message;
    this.#changed();
  }

  /** Record problems once each (the same text again is ignored); warnings and errors count as a persistent warning. */
  addProblems(problems: readonly Problem[]): void {
    for (const problem of problems) {
      const key = `${problem.level}\u0000${problem.text}`;
      if (this.#seenProblems.has(key)) continue;
      this.#seenProblems.add(key);
      if (problem.level !== "info") this.#warnings++;
      this.notify(problem.level, problem.text);
    }
  }

  clearStatus(): void {
    if (this.#status === null) return;
    this.#status = null;
    this.#changed();
  }

  // ---------- preferences ----------

  #databasePreferences() {
    try {
      return this.#options.preferences.database(this.#identity.databaseId);
    } catch {
      return null; // not a UUID-keyed database: nothing per-database is kept
    }
  }

  #setLastTask(id: number): void {
    try {
      this.#options.preferences.setDatabase(this.#identity.databaseId, "lastTask", id);
    } catch {
      return; // not a UUID-keyed database: nothing per-database is kept
    }
    this.#saveLater();
  }

  #saveLater(): void {
    if (this.#cancelSave !== null || this.#disposed) return;
    this.#cancelSave = this.#schedule(() => {
      this.#cancelSave = null;
      this.savePreferences();
    }, SAVE_DELAY_MS);
  }

  /** Save now: this session's last task into the profile's state file. False when it failed (reported). */
  savePreferences(): boolean {
    this.#cancelSave?.();
    this.#cancelSave = null;
    try {
      this.#options.preferences.save();
      return true;
    } catch (err) {
      this.notify("warn", `Could not save the view state: ${(err as Error).message}`);
      return false;
    }
  }

  /** The tui.toml :config writes; undefined: no setting can be saved in this session. */
  get configFile(): string | undefined {
    return this.#options.configFile;
  }

  /**
   * :config — write one tui.toml setting now (null removes its line: the default applies). Throws a
   * CommandError, changing nothing, without a tui.toml or when the write is refused; a live setting is
   * applied to this session only after this returned.
   */
  saveSetting(key: WritableSetting, value: string | number | boolean | null): void {
    const file = this.#options.configFile;
    if (file === undefined) throw new CommandError("Settings are not saved in this session: it has no tui.toml");
    try {
      saveSettings(file, { [key]: value });
    } catch (err) {
      throw new CommandError(`Could not save ${file}: ${errorText(err)}`);
    }
  }

  /** The session's timer seam (coalescing windows; tests control it): returns a cancel function. */
  schedule(fn: () => void, ms: number): () => void {
    return this.#schedule(fn, ms);
  }

  /** Stop timers; late answers are ignored. */
  dispose(): void {
    this.#disposed = true;
    for (const entry of this.#documents.values()) entry.draft?.discard();
    this.#reveal?.finish(false);
    this.#snapshotGen++;
    this.#cancelCoalesce?.();
    this.#cancelRetry?.();
    this.#cancelSave?.();
    this.#rebindRetry?.();
    this.#cancelCoalesce = this.#cancelRetry = this.#cancelSave = this.#rebindRetry = null;
  }

  #changed(): void {
    this.#options.onChange?.();
  }
}
