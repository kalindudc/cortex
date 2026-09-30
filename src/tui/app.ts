// The terminal workspace (plan @400 Task 7: N13, N17-N20, N22-N23).
//
// `runTui` checks everything that can fail with a message BEFORE it takes the
// terminal (tui.toml, the view state, the daemon, the requested task), then
// hands one TuiSession to the Shell: pi-tui's TuiAltScreen + ProcessTerminal
// with the toolkit's conflicting fullscreen viewport keys bound to nothing
// and copy-on-select off.
//
// - The theme resolves BEFORE the first content frame: in auto (no explicit
//   theme, appearance = "system"), DSR 996 and OSC 11 go out together under
//   ONE 150 ms deadline (unanswered means dark), and afterwards the palette
//   notifications (mode 2031) are followed. An explicit theme never changes
//   under the user; late replies are then ignored.
// - The shell renders the task list (src/tui/workspace.ts: ascending id or
//   the :sort/:group order, relevance while searching, status glyphs never
//   tint alone, the active filters as chips), the document pane in the
//   task's Read/Edit/Split mode
//   (Read and the Split preview are src/tui/reader.ts, rendering the current
//   draft; Edit is src/tui/editor.ts; Split is useful from SPLIT_COLUMNS, and a
//   narrower terminal shows the focused half without changing the saved
//   preference), a status line (mode, focus, the draft's save state even in
//   Read, connection, messages, a persistent problem warning) and a hint line
//   built from the configured keys (never a function key; only the hints
//   that fit whole). Of two panes side
//   by side (the list and the document, or Split's editor and preview), the
//   one without the focus is painted through theme.ts inactiveTheme (greyed;
//   SGR dim without color) and the focused one's label is inverse.
// - The density (the session's: a saved `:density`, else tui.toml's) is
//   comfortable by default: a blank row under the document header (and the
//   list header, src/tui/workspace.ts) and above the status line, and a
//   1-cell margin at both ends of the status and hint lines; compact drops
//   them. A terminal program cannot change the terminal's font size.
// - The reader takes `{`/`}` (headings) whenever it is shown and the editor
//   does not have the keyboard; `/` and n/N search it while it has the focus
//   (the session routes them); Enter in it lists its links (:links); a click
//   on a link or reference follows it. Its clipboard writes (:copy) are sent
//   to this terminal only when asked.
// - The shell is the modal layer for the editor: NORMAL motions, counts and
//   u/Ctrl-r go to the focused, VISIBLE editor (a hint elsewhere); INSERT
//   input is the session's (the body editor or the in-place title). Home/End/
//   PageUp/PageDown act on the focused pane. VISUAL (`v`) and VISUAL LINE
//   (`V`) select in the focused, visible editor or the focused reader: the
//   motions extend it, the `[keys.visual]` operators act on it (y yanks to
//   the paste register AND the terminal clipboard through ONE OSC 52 write,
//   reported as unconfirmed or failed; d/c/>/< edit only in the editor),
//   Esc or the same key again ends it, and anything that takes the keyboard
//   away (a prompt, a dialog, another task, a click, a re-wrap) ends it too.
//   `p`/`P` paste the register in the editor. Exactly one CURSOR_MARKER per
//   frame: the prompt, a dialog field, the title or the editor cursor. The `:` line (src/tui/commandline.ts) completes from the
//   ONE command registry (src/tui/commands.ts) and shows the candidates
//   above it; `?`/:help and the searchable :commands view list the same
//   registry. The help is drawn by src/tui/help.ts: wrapped under its
//   description column, and `/` and n/N search it while it is open (never
//   the task list). Every untrusted string crosses src/tui/safety.ts before
//   style() colors it.
// - Dialogs (src/tui/dialogs.ts) are toolkit overlays through this shell's
//   overlay host; every input, whichever component the toolkit focused,
//   takes the session's ONE route (prompt, top dialog, then this shell).
//   The shell owns the theme inputs, so it implements `:theme`'s live
//   preview/restore/apply (an applied choice is saved; auto clears it and
//   every session override).
// - SIGTERM/SIGHUP/SIGINT first try a bounded flush of every draft, then
//   restore the terminal. Every exit path (:q, the signals, a crash, Ctrl-z
//   before SIGTSTP) restores the terminal: the mouse goes off first (the shell
//   owns it: src/tui/mouse.ts), the toolkit's stop({preserveScreen}) pops what
//   it enabled (raw mode, bracketed paste, Kitty flags, modifyOtherKeys, mode
//   2031, the alternate screen), then TERMINAL_RESET repeats the always-safe
//   resets. Quitting closes this TUI's connections, never the shared daemon.
// - The mouse (src/tui/mouse.ts; tui.toml `mouse`, on by default) is never the
//   only path to an action. A click focuses the pane under it (the list, the
//   document, Split's editor or preview half, a panel); a list row selects,
//   and a second click (or a double click) on it opens the document; the
//   document header's view tabs run :read/:edit/:split/:activity/:related/
//   :authors; the list header's chips and sort label open the `f` and `;o`
//   pickers; the status line's unread count opens :notifications; the wheel
//   scrolls the pane under the pointer (a list one row a notch, however many
//   reports the terminal sends for it). In the editor a click places the
//   cursor and a drag, double click (a word) or triple click (a line) makes a
//   VISUAL selection, the same one v/V make (y/d/c act on it); the rendered
//   document selects its rows the same way.

import {
  CURSOR_MARKER,
  KeybindingsManager,
  type KeybindingsConfig,
  ProcessTerminal,
  type RgbColor,
  setKeybindings,
  type Component,
  type Focusable,
  type Terminal,
  type TerminalColorScheme,
  TUI_KEYBINDINGS,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  TuiAltScreen,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { createClient } from "../client.ts";
import { ensureDaemon } from "../daemon.ts";
import { dbPath, tuiConfigPath, tuiStatePath } from "../paths.ts";
import { subscribeChanges } from "../subscription.ts";
import { STATUS_LABEL } from "../lib/constants.ts";
import { type Activity, createActivity } from "./activity.ts";
import { createNotifications, type Notifications, UNREAD_MARK } from "./notifications.ts";
import { CommandError, commandHelp, reportPendingMigrations } from "./commands.ts";
import type { CommandLine } from "./commandline.ts";
import { DRAFT_FIELDS, type FieldState } from "./drafts.ts";
import type { DocumentEditor, EditorMotion, Register, VisualKind } from "./editor.ts";
import { createHelp, type Help, type HelpLine } from "./help.ts";
import { createReader, type EditorCursor, type Reader, type ReaderPoint, type SelectionMotion } from "./reader.ts";
import { withScrollbar } from "./scrollbar.ts";
import { type ConfigProblem, loadConfig, type TuiConfig } from "./config.ts";
import {
  actionKeyLabels,
  INSERT_ACTIONS,
  INSERT_KEY_ACTIONS,
  insertKeyLabels,
  KEY_ACTIONS,
  type KeyConfig,
  type KeyEvent,
  type KeyMode,
  isNormalAction,
  isVisualAction,
  NORMAL_ACTIONS,
  type NormalAction,
  VISUAL_ACTIONS,
  VISUAL_KEY_ACTIONS,
  type VisualAction,
  visualKeyLabels,
} from "./keys.ts";
import { filterMouseInput, MOUSE_OFF, MOUSE_ON } from "./mouse.ts";
import { openPreferences, type PreferenceProblem } from "./preferences.ts";
import { displayWidth, escapeTerminalText, fitWidth } from "./safety.ts";
import { type MessageLevel, type Problem, type ThemeChoice, TuiSession } from "./session.ts";
import {
  type ColorEnvironment,
  type ContrastPair,
  inactiveTheme,
  listThemes,
  paint,
  type ResolvedTheme,
  resolveTheme,
  type Seg,
  seg,
  style,
  type ThemeProblem,
} from "./theme.ts";
import { createWorkspace, STATUS_MARK, statusPair, type WorkspaceComponent } from "./workspace.ts";

/** N19: the smallest workspace; below it a recoverable resize screen. */
export const MIN_COLUMNS = 80;
export const MIN_ROWS = 24;
/** The help's key column: an entry is two cells in, this wide, then one blank (its description's column). */
const HELP_KEY_WIDTH = 24;
/** From this width the task list sits beside the document. */
export const SIDE_BY_SIDE_COLUMNS = 100;
/** From this width Split shows the editor and the preview side by side; below it, the focused half. */
export const SPLIT_COLUMNS = 120;
/** How long a termination signal waits for the drafts to save before restoring the terminal. */
const SIGNAL_FLUSH_MS = 1500;
/** N22: one deadline for both appearance queries. */
export const APPEARANCE_BUDGET_MS = 150;
const DEFAULT_PROFILE = "default";
const TITLE_LINES = 4;
/** Completion candidates shown above the `:` line at most. */
const SUGGESTION_ROWS = 5;
const SHUTDOWN_DEADLINE_MS = 2000;
/** How long after resuming a SIGCONT must have arrived for the suspend to have been real. */
const SUSPEND_CHECK_MS = 250;

/**
 * Always-safe resets written after the toolkit's own stop on every exit path:
 * bracketed paste, mouse and focus reporting, palette notifications (2031),
 * modifyOtherKeys back to its initial value, SGR, autowrap and the cursor.
 * Stack-like state (Kitty keyboard flags, the alternate screen) is popped
 * only by the toolkit, which knows what it pushed.
 */
export const TERMINAL_RESET = `\x1b[?2004l${MOUSE_OFF}\x1b[?1004l\x1b[?2031l\x1b[>4m\x1b[0m\x1b[?7h\x1b[?25h`;
/** Only when the toolkit's stop failed part-way: pop our Kitty flags, then leave the alternate screen. */
const TERMINAL_ABORT = "\x1b[<u\x1b[?1049l";

/**
 * N19: the toolkit's fullscreen viewport keys (Home/End/PageUp/PageDown,
 * prompt navigation, alt-screen search) are bound to NOTHING, explicitly:
 * an `undefined` override would restore the default, and the viewport
 * would otherwise take these keys before the focused pane (even over
 * dialogs). Keys are routed by the focused pane instead.
 */
export const DISABLED_VIEWPORT_KEYS: KeybindingsConfig = {
  "tui.altScreen.pageUp": [],
  "tui.altScreen.pageDown": [],
  "tui.altScreen.halfPageUp": [],
  "tui.altScreen.halfPageDown": [],
  "tui.altScreen.lineUp": [],
  "tui.altScreen.lineDown": [],
  "tui.altScreen.previousPrompt": [],
  "tui.altScreen.nextPrompt": [],
  "tui.altScreen.search": [],
  "tui.altScreen.searchNext": [],
  "tui.altScreen.searchPrevious": [],
  "tui.altScreen.searchClose": [],
  "tui.altScreen.top": [],
  "tui.altScreen.bottom": [],
};

// ---------- appearance ----------

type AppearanceQueries = {
  queryTerminalColorScheme(options: { timeoutMs: number }): Promise<TerminalColorScheme | undefined>;
  queryTerminalBackgroundColor(options: { timeoutMs: number }): Promise<RgbColor | undefined>;
};

/**
 * The terminal's light/dark appearance: DSR 996 (the color-scheme report)
 * and OSC 11 (the background color) are sent TOGETHER and share one
 * deadline, because the toolkit times each query separately. A DSR answer
 * wins; otherwise the background's luminance decides; null when neither
 * answered (the caller treats that as dark).
 */
export async function detectAppearance(
  queries: AppearanceQueries,
  budgetMs: number = APPEARANCE_BUDGET_MS,
): Promise<"dark" | "light" | null> {
  const scheme = queries.queryTerminalColorScheme({ timeoutMs: budgetMs });
  const background = queries.queryTerminalBackgroundColor({ timeoutMs: budgetMs });
  const reported = await scheme;
  if (reported !== undefined) return reported;
  const rgb = await background;
  if (rgb === undefined) return null;
  return (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255 > 0.5 ? "light" : "dark";
}

// ---------- text helpers (on text ALREADY escaped by safety.ts) ----------

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const esc = escapeTerminalText;
const fit = fitWidth;

// ---------- painting ----------

const MODE_PAIR: Readonly<Record<KeyMode, ContrastPair>> = {
  NORMAL: "mode.normal@panel",
  INSERT: "mode.insert@panel",
  COMMAND: "mode.command@panel",
  SEARCH: "mode.search@panel",
  // No token of their own (a complete custom theme stays complete): the label names the mode.
  VISUAL: "mode.search@panel",
  "VISUAL LINE": "mode.search@panel",
};

const LEVEL_PAIR: Readonly<Record<MessageLevel, ContrastPair>> = {
  info: "text@panel",
  warn: "warn@panel",
  error: "danger@panel",
};

const LEVEL_PREFIX: Readonly<Record<MessageLevel, string>> = { info: "", warn: "warning: ", error: "error: " };

/** The current task's draft on the status line (even in Read): a mark and words, never tint alone. */
const SAVE_STATE: Readonly<Record<FieldState, Seg>> = {
  saved: seg("dim@panel", "✓ saved"),
  pending: seg("warn@panel", "● unsaved"),
  saving: seg("warn@panel", "◌ saving…"),
  retrying: seg("warn@panel", "↻ retrying…"),
  failed: seg("danger@panel", "✗ save failed · :w retries"),
  conflict: seg("danger@panel", "⚠ conflict · :apply or :keep"),
};
/** Keys typed before the current document's baseline, which did not load (:w loads it again and applies them). */
const NOT_LOADED: Seg = seg("danger@panel", "✗ not loaded · :w retries");

/** NORMAL actions this build acts on; the rest are listed in help as arriving later. */
const AVAILABLE_ACTIONS: ReadonlySet<NormalAction> = new Set<NormalAction>([
  "down",
  "up",
  "left",
  "right",
  "half_down",
  "half_up",
  "top",
  "bottom",
  "word_forward",
  "word_backward",
  "word_end",
  "line_end",
  "next_pane",
  "previous_pane",
  "next_heading",
  "previous_heading",
  "next_match",
  "previous_match",
  "back",
  "forward",
  "focus_tasks",
  "focus_document",
  "toggle_tasks",
  "toggle_done",
  "help",
  "commands",
  "suspend",
  "tags",
  "status",
  "insert",
  "next_panel",
  "previous_panel",
  "post",
  "undo",
  "redo",
  "visual",
  "visual_line",
  "paste_after",
  "paste_before",
  "read",
  "edit",
  "split",
  "sort",
  "filters",
  "clear_filters",
]);

/** The NORMAL motions that move the editor cursor (and extend a VISUAL selection), with the reader's equivalents. */
const MOTIONS: Partial<Record<NormalAction, { editor: EditorMotion; reader: SelectionMotion; inLine?: true }>> = {
  down: { editor: "down", reader: "down" },
  up: { editor: "up", reader: "up" },
  left: { editor: "left", reader: "left", inLine: true },
  right: { editor: "right", reader: "right", inLine: true },
  half_down: { editor: "half-page-down", reader: "half-down" },
  half_up: { editor: "half-page-up", reader: "half-up" },
  top: { editor: "doc-start", reader: "top" },
  bottom: { editor: "doc-end", reader: "bottom" },
  word_forward: { editor: "word-next", reader: "word-next" },
  word_backward: { editor: "word-prev", reader: "word-prev" },
  word_end: { editor: "word-end", reader: "word-end" },
  line_end: { editor: "line-end", reader: "line-end" },
};

/** Unbound keys that are motions in VISUAL: `0` (no count), Home/End and the page keys. */
const PLAIN_MOTIONS: Readonly<Record<string, { editor: EditorMotion; reader: SelectionMotion }>> = {
  "0": { editor: "line-start", reader: "line-start" },
  home: { editor: "line-start", reader: "line-start" },
  end: { editor: "line-end", reader: "line-end" },
  pageUp: { editor: "page-up", reader: "page-up" },
  pageDown: { editor: "page-down", reader: "page-down" },
};

/** How much a yank or delete took, for the status line. */
function amount(register: Register, rows: "lines" | "rendered rows" = "lines"): string {
  if (register.linewise) {
    const n = register.text.split(/\r\n|\r|\n/).length - 1;
    return `${n} ${n === 1 ? rows.replace(/s$/, "") : rows}`;
  }
  const n = [...register.text].length;
  return `${n} character${n === 1 ? "" : "s"}`;
}

function leaderLabel(keys: KeyConfig): string {
  return keys.leader.label;
}

// ---------- problems for :messages ----------

function configProblem(p: ConfigProblem): Problem {
  return { level: "warn", text: `${p.file}: ${p.keyPath === "" ? "(file)" : p.keyPath}: ${p.reason}` };
}

function preferenceProblem(p: PreferenceProblem): Problem {
  return { level: "warn", text: `${p.file}: ${p.reason}` };
}

function themeProblem(p: ThemeProblem): Problem {
  const level: MessageLevel = p.severity === "notice" ? "info" : p.severity === "warning" ? "warn" : "error";
  const where = p.file === null ? "" : `${p.file}: `;
  const key = p.keyPath === "" ? "" : `${p.keyPath}: `;
  return { level, text: `theme ${p.theme}: ${where}${key}${p.reason}` };
}

// ---------- the shell ----------

export interface ShellOptions {
  terminal: Terminal;
  session: TuiSession;
  config: TuiConfig;
  /** `--theme`: this session only. */
  cliTheme?: string | null;
  /** The profile's saved `:theme` choice. */
  savedTheme?: string | null;
  env: ColorEnvironment;
  /** Custom theme directory (default themesDir()). */
  themesDir?: string;
  appearanceBudgetMs?: number;
  /** Signal seam for Ctrl-z (default process.kill). */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Raw-mode seam for the final restore (default: process.stdin when it is a TTY). */
  setRawMode?: (enabled: boolean) => void;
}

/** The document's views as tabs in its header row: the modes (with their keys), then the panels. */
type ViewTab = "read" | "edit" | "split" | "activity" | "related" | "authors";
const VIEW_TABS: readonly { readonly view: ViewTab; readonly label: string; readonly short: string }[] = [
  { view: "read", label: "Read", short: "Rd" },
  { view: "edit", label: "Edit", short: "Ed" },
  { view: "split", label: "Split", short: "Sp" },
  { view: "activity", label: "Activity", short: "Act" },
  { view: "related", label: "Related", short: "Rel" },
  { view: "authors", label: "Authors", short: "Au" },
];
/** How the tabs fit the header row: with the modes' key hints, plain, or abbreviated (80 columns, tags). */
const TAB_STYLES = ["hints", "plain", "short"] as const;
type TabStyle = (typeof TAB_STYLES)[number];

/** Where the last frame put each mouse target; cells are the terminal's, zero-based. */
interface FrameLayout {
  /** The rows above the status line. */
  mainHeight: number;
  /** The list pane's width from the left edge (0 when it is not shown). */
  listWidth: number;
  /** Where the document pane starts (-1 when it is not shown). */
  docX: number;
  tagHits: { x: number; y: number; width: number; tag: string }[];
  tabHits: { x: number; y: number; width: number; view: ViewTab }[];
  statusHits: { x: number; y: number; width: number; command: "notifications" | "messages" }[];
  /** The document title's rows. */
  title: { y: number; height: number } | null;
  editor: { taskId: number; x: number; y: number; width: number; height: number } | null;
  reader: { x: number; y: number; width: number; height: number; preview: boolean } | null;
  panel: { x: number; y: number; width: number; height: number } | null;
}

const emptyLayout = (): FrameLayout => ({
  mainHeight: 0,
  listWidth: 0,
  docX: -1,
  tagHits: [],
  tabHits: [],
  statusHits: [],
  title: null,
  editor: null,
  reader: null,
  panel: null,
});

type Area = { x: number; y: number; width: number; height: number };
const inside = (area: Area | null, x: number, y: number): boolean =>
  area !== null && x >= area.x && x < area.x + area.width && y >= area.y && y < area.y + area.height;
const onHit = (hit: { x: number; y: number; width: number }, x: number, y: number): boolean =>
  hit.y === y && x >= hit.x && x < hit.x + hit.width;
const HANDLED: TuiMouseEventResult = { handled: true };

/** Where Split's editor cursor is (its line and screen row) for the preview to follow; its state is the anchor. */
function cursorOf(editor: DocumentEditor, rows: number): EditorCursor {
  const state = editor.getState();
  const row = editor.cursorRow();
  return {
    line: state.doc.lineAt(editor.cursor()).number,
    row: row < 0 ? Math.floor(rows / 3) : row,
    anchor: state,
  };
}

function stdinRawMode(enabled: boolean): void {
  const stdin = process.stdin;
  if (stdin.isTTY && stdin.isRaw !== enabled) stdin.setRawMode(enabled);
}

class ShellView implements Component, Focusable {
  focused = false;
  constructor(private readonly shell: Shell) {}
  render(width: number): string[] {
    return this.shell.frame(width);
  }
  handleInput(data: string): void {
    this.shell.handleInput(data);
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.shell.handleMouse(event);
  }
  invalidate(): void {}
}

/** The shell around ONE session: rendering, key routing, theme and terminal lifecycle. */
export class Shell {
  readonly tui: TuiAltScreen;
  readonly session: TuiSession;
  readonly #options: ShellOptions;
  /** VISUAL's selection: the task and the surface holding it (the task's editor, or the reader), or null. */
  #visual: { taskId: number; surface: "editor" | "reader" } | null = null;
  /** The paste register (p/P): the last yank or delete, characters or whole lines. */
  #register: Register | null = null;
  readonly #terminal: Terminal;
  readonly #view: ShellView;
  #theme: ResolvedTheme | null = null;
  #detected: "dark" | "light" | null = null;
  #followAppearance = false;
  /** The theme levels this session can change (N22): `:theme` > `--theme` > the saved choice. */
  #sessionTheme: string | null = null;
  #cliTheme: string | null;
  #savedTheme: string | null;
  /** The theme shown before a `:theme` preview, restored by Esc. */
  #previewBase: ResolvedTheme | null = null;
  #listening = false;
  #detecting = false;
  #started = false;
  #running = false;
  #stopped = false;
  #ready = false;
  /** An external program has the terminal (src/tui/bridge.ts withExternalProgram). */
  #handingOff = false;
  #queued: string[] = [];
  /** The task-list pane (src/tui/workspace.ts). */
  readonly #list: WorkspaceComponent;
  /** Read and the Split preview (src/tui/reader.ts). */
  readonly #reader: Reader;
  /** The help view: its lines wrapped to the pane, and `/` over them while it is open (src/tui/help.ts). */
  readonly #help: Help;
  /** The task panels and the update composer (src/tui/activity.ts). */
  readonly #activity: Activity;
  /** The notification feed, :notifications and blocked-transition attention (src/tui/notifications.ts). */
  readonly #notifications: Notifications;
  /** Where the last frame put each mouse target (src/tui/mouse.ts; handleMouse routes by it). */
  #layout: FrameLayout = emptyLayout();
  /** The pointer's gesture since its press in the editor or the reader: drags select from its anchor. */
  #gesture:
    | { readonly surface: "editor"; readonly taskId: number; readonly anchor: number }
    | { readonly surface: "reader"; readonly taskId: number; readonly anchor: ReaderPoint }
    | null = null;

  constructor(options: ShellOptions) {
    this.#options = options;
    this.#terminal = options.terminal;
    this.session = options.session;
    // The toolkit reads through the mouse filter (src/tui/mouse.ts) and never enables the mouse
    // itself (it would ask for any-motion 1003): #takeTerminal enables 1002 + 1006 when it is on.
    this.tui = new TuiAltScreen(filterMouseInput(options.terminal), true, undefined, {
      mouse: false,
      copyOnSelect: false,
    });
    this.#view = new ShellView(this);
    this.#list = createWorkspace(this.session);
    this.#reader = createReader(this.session);
    this.#help = createHelp(this.session, () => this.#helpLines());
    this.#activity = createActivity(this.session);
    // Attention for blocked transitions: the status flash (default) and the opt-in bell, on this terminal.
    this.#notifications = createNotifications(this.session, {
      flash: options.config.flash,
      bell: options.config.bell,
      write: data => this.#terminal.write(data),
    });
    // Explicit copies (:copy) go to this terminal as OSC 52; a failed write is reported, not hidden.
    this.session.setClipboard(data => this.#terminal.write(data));
    this.#cliTheme = options.cliTheme ?? null;
    this.#savedTheme = options.savedTheme ?? null;
    this.session.setSuspendHandler(() => this.suspend());
    this.session.setTerminalHandoff(run => this.handOff(run));
    this.session.setKeyHandler(event => this.#onKey(event));
    this.session.setOverlayHost({
      showOverlay: (component, overlay) => this.tui.showOverlay(component, overlay),
      columns: () => this.#terminal.columns,
      rows: () => this.#terminal.rows,
    });
    this.session.setThemeControl({
      choices: () => this.#themeChoices(),
      preview: name => this.#previewTheme(name),
      restore: () => this.#restoreTheme(),
      apply: name => this.#applyTheme(name),
    });
  }

  /** The resolved theme; null until appearance detection finished (nothing themed renders before). */
  get theme(): ResolvedTheme | null {
    return this.#theme;
  }

  /** Take the terminal, resolve the theme, then show the first content frame. */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, DISABLED_VIEWPORT_KEYS));
    this.tui.addChild(this.#view);
    this.tui.setFocus(this.#view);
    this.#running = true;
    this.#takeTerminal();
    try {
      await this.#resolveTheme();
    } finally {
      this.#ready = !this.#stopped;
    }
    for (const data of this.#queued.splice(0)) this.handleInput(data);
    this.requestRender(true);
  }

  requestRender(force = false): void {
    if (this.#running) this.tui.requestRender(force);
  }

  /** Restore the terminal. Idempotent and never throws. */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#ready = false;
    this.#restore();
  }

  /** Ctrl-z / :suspend: restore the terminal, stop with SIGTSTP, take the terminal back once continued. */
  suspend(): void {
    if (!this.#running || this.#stopped) return;
    this.#restore();
    let continued = false;
    const onContinue = (): void => {
      continued = true;
    };
    process.once("SIGCONT", onContinue);
    const kill = this.#options.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
    kill(process.pid, "SIGTSTP");
    // Execution continues here after SIGCONT, or at once where the kernel discards the
    // stop (a process group without job control, e.g. `exec cortex`): then say so.
    setTimeout(() => {
      process.off("SIGCONT", onContinue);
      if (!continued && !this.#stopped) {
        this.session.notify("info", "Suspend is unavailable (no job control here)");
      }
    }, SUSPEND_CHECK_MS).unref();
    if (this.#stopped) return;
    this.#running = true;
    this.#takeTerminal();
    this.requestRender(true);
  }

  /** An external program has the terminal right now (runTui then leaves Ctrl-C's SIGINT to it). */
  get handingOff(): boolean {
    return this.#handingOff;
  }

  /**
   * Give the terminal to `run` (an external program): the suspend path's
   * restore, then `run`, then take the terminal back and redraw, whether
   * `run` resolved or threw.
   */
  async handOff<T>(run: () => Promise<T>): Promise<T> {
    if (!this.#running || this.#stopped) throw new CommandError("The terminal is not available to hand over");
    if (this.#handingOff) throw new CommandError("Another program already has the terminal");
    this.#handingOff = true;
    this.#restore();
    try {
      return await run();
    } finally {
      this.#handingOff = false;
      if (!this.#stopped) {
        this.#running = true;
        this.#takeTerminal();
        this.requestRender(true);
      }
    }
  }

  /** Take the terminal (the toolkit's start), then turn the mouse on when it is configured. */
  #takeTerminal(): void {
    this.tui.start();
    if (this.#options.config.mouse) this.#write(MOUSE_ON);
  }

  #restore(): void {
    if (this.#running) {
      this.#running = false;
      // The mouse goes off while the alternate screen is still up (TERMINAL_RESET repeats it).
      if (this.#options.config.mouse) this.#write(MOUSE_OFF);
      try {
        this.tui.stop({ preserveScreen: true });
      } catch {
        this.#write(TERMINAL_ABORT);
      }
    }
    this.#write(TERMINAL_RESET);
    try {
      (this.#options.setRawMode ?? stdinRawMode)(false);
    } catch {
      /* the terminal may already be gone (SIGHUP) */
    }
  }

  #write(data: string): void {
    try {
      this.#terminal.write(data);
    } catch {
      /* the terminal may already be gone (SIGHUP) */
    }
  }

  // ---------- theme ----------

  async #resolveTheme(): Promise<void> {
    const base = this.#themeInput();
    const first = resolveTheme({ ...base, detected: null });
    this.#followAppearance =
      !first.explicit &&
      this.#options.config.appearance === "system" &&
      (first.mode === "truecolor" || first.mode === "256");
    if (!this.#followAppearance) {
      this.#setTheme(first);
      return;
    }
    this.#detecting = true;
    try {
      this.#detected = await detectAppearance(this.tui, this.#options.appearanceBudgetMs ?? APPEARANCE_BUDGET_MS);
    } finally {
      this.#detecting = false;
    }
    this.#setTheme(resolveTheme({ ...base, detected: this.#detected }));
    this.#listen();
  }

  #themeInput() {
    return {
      session: this.#sessionTheme,
      cli: this.#cliTheme,
      saved: this.#savedTheme,
      config: this.#options.config,
      env: this.#options.env,
      themesDir: this.#options.themesDir,
    };
  }

  /** Follow the terminal's palette notifications (mode 2031); registered once. */
  #listen(): void {
    if (this.#listening) return;
    this.#listening = true;
    this.tui.onTerminalColorSchemeChange(scheme => this.#onAppearance(scheme));
    this.tui.setTerminalColorSchemeNotifications(true);
  }

  #themeChoices(): ThemeChoice[] {
    const { themes, problems } = listThemes(this.#options.themesDir);
    this.session.addProblems(problems.map(themeProblem));
    return themes;
  }

  /** `:theme` picker: show `name` (null: auto) for this session only; the first preview remembers what Esc restores. */
  #previewTheme(name: string | null): void {
    if (this.#theme === null) return;
    this.#previewBase ??= this.#theme;
    const input =
      name === null
        ? { ...this.#themeInput(), session: null, cli: null, saved: null }
        : { ...this.#themeInput(), session: name };
    this.#setTheme(resolveTheme({ ...input, detected: this.#detected }));
  }

  #restoreTheme(): void {
    const base = this.#previewBase;
    this.#previewBase = null;
    if (base !== null) this.#setTheme(base);
  }

  /**
   * `:theme <name>`: the in-session level (it outranks `--theme`) and SAVED
   * as the profile's explicit choice. `:theme auto` (null) clears the saved
   * choice and, for this session, every override including `--theme`;
   * tui.toml `theme` still applies. Auto follows the terminal again.
   */
  #applyTheme(name: string | null): ResolvedTheme {
    this.#previewBase = null;
    if (name === null) {
      this.#sessionTheme = null;
      this.#cliTheme = null;
      this.#savedTheme = null;
    } else {
      this.#sessionTheme = name;
      this.#savedTheme = name;
    }
    this.session.saveThemeChoice(name);
    const theme = resolveTheme({ ...this.#themeInput(), detected: this.#detected });
    this.#setTheme(theme);
    this.#followAppearance =
      !theme.explicit &&
      this.#options.config.appearance === "system" &&
      (theme.mode === "truecolor" || theme.mode === "256");
    if (this.#followAppearance) {
      this.#listen();
      // Started explicit, so the terminal was never asked: ask now (late replies are ignored once explicit).
      if (this.#detected === null && !this.#detecting) void this.#detectLate();
    }
    return theme;
  }

  async #detectLate(): Promise<void> {
    this.#detecting = true;
    let scheme: "dark" | "light" | null = null;
    try {
      scheme = await detectAppearance(this.tui, this.#options.appearanceBudgetMs ?? APPEARANCE_BUDGET_MS);
    } catch {
      return;
    } finally {
      this.#detecting = false;
    }
    if (scheme !== null) this.#onAppearance(scheme);
  }

  /** A palette notification (or a late DSR reply): followed only while no theme is explicit. */
  #onAppearance(scheme: TerminalColorScheme): void {
    if (!this.#followAppearance || this.#theme === null || this.#theme.explicit) return;
    if (scheme === this.#detected) return;
    this.#detected = scheme;
    this.#setTheme(resolveTheme({ ...this.#themeInput(), detected: scheme }));
  }

  #setTheme(theme: ResolvedTheme): void {
    this.#theme = theme;
    this.session.setTheme(theme);
    // Problems are recorded once each: a re-resolution never repeats a notice.
    this.session.addProblems(theme.problems.map(themeProblem));
    this.tui.invalidate();
    this.requestRender(true);
  }

  // ---------- input ----------

  handleInput(data: string): void {
    if (!this.#ready) {
      if (!this.#stopped) this.#queued.push(data);
      return;
    }
    // A VISUAL whose selection is gone (another task, a click, a re-wrap) is NORMAL again before this key.
    this.#syncVisual();
    // The session routes it: the prompt, then the top dialog, then #onKey.
    this.session.input(data);
  }

  // ---------- the mouse (src/tui/mouse.ts parses; the toolkit dispatches clicks, drags and counts) ----------

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const s = this.session;
    // A dialog is modal: its overlay takes the pointer over it, and a click outside it (or with the
    // prompt open, or before the first frame) does nothing: it never closes a dialog holding a draft.
    if (!this.#ready || s.prompt !== null || s.dialog !== null) return HANDLED;
    // Every report is handled here, so the toolkit never starts its own screen selection.
    if (event.type === "wheel") this.#wheel(event);
    else if (event.type === "release") this.#gesture = null;
    else if (event.button === "left") {
      if (event.type === "press") this.#press(event);
      else if (event.type === "drag") this.#drag(event);
      else if (event.type === "click") this.#click(event);
    }
    return HANDLED;
  }

  /** The workspace area under a cell of the last frame. */
  #areaAt(x: number, y: number): "list" | "editor" | "reader" | "panel" | "document" | "none" {
    const layout = this.#layout;
    if (this.session.view !== "workspace" || y < 0 || y >= layout.mainHeight) return "none";
    if (x < layout.listWidth) return "list";
    if (inside(layout.reader, x, y)) return "reader";
    if (inside(layout.panel, x, y)) return "panel";
    const editor = layout.editor;
    if (editor !== null && editor.taskId === this.session.selectedTask()?.id && inside(editor, x, y)) return "editor";
    return layout.docX >= 0 && x >= layout.docX ? "document" : "none";
  }

  /**
   * The wheel scrolls what is under the pointer, whichever pane has the keyboard.
   * A list moves one row a notch, however many reports the terminal sends for it
   * (session.wheelNotch); scrolled text takes every report.
   */
  #wheel(event: TuiMouseEvent): void {
    const s = this.session;
    const delta = Math.sign(event.wheelDelta ?? 0);
    if (delta === 0) return;
    if (s.view === "commands") {
      const step = s.wheelNotch(delta);
      if (step !== 0) s.moveCommandSelection(step);
      return;
    }
    if (s.view !== "workspace") {
      s.scrollView(delta * 3);
      return;
    }
    switch (this.#areaAt(event.x, event.y)) {
      case "list": {
        const step = s.wheelNotch(delta);
        if (step !== 0) s.moveSelection(step);
        return;
      }
      case "panel":
        this.#activity.scroll(delta * 3);
        return;
      case "editor": {
        const area = this.#layout.editor;
        const task = s.selectedTask();
        const editor = task === null ? null : (s.documentOf(task.id)?.editor ?? null);
        if (area !== null && editor !== null)
          editor.handleMouse({ ...event, x: event.x - area.x, y: event.y - area.y });
        return;
      }
      case "reader":
      case "document":
        s.scrollDocument(delta * 3);
        return;
      default:
        return;
    }
  }

  /** Give the document (its body, Split's `half`) the keyboard, ending a title INSERT. */
  #focusBody(half: "editor" | "preview" | null): void {
    const s = this.session;
    if (s.insertTarget?.target === "title") s.leaveInsert();
    s.setFocus("document");
    s.setDocumentTarget("body");
    if (half !== null && s.documentMode() === "split") s.setSplitHalf(half);
  }

  /** The editor under the pointer and the cell in it, when it is the current task's. */
  #editorAt(event: TuiMouseEvent): { editor: DocumentEditor; taskId: number; x: number; y: number } | null {
    const area = this.#layout.editor;
    const task = this.session.selectedTask();
    const editor = task === null ? null : (this.session.documentOf(task.id)?.editor ?? null);
    if (area === null || task === null || editor === null || area.taskId !== task.id) return null;
    return { editor, taskId: task.id, x: event.x - area.x, y: event.y - area.y };
  }

  /** A press in the editor or the reader focuses it and anchors a possible drag. */
  #press(event: TuiMouseEvent): void {
    const s = this.session;
    this.#gesture = null;
    const area = this.#areaAt(event.x, event.y);
    if (area === "editor") {
      const at = this.#editorAt(event);
      if (at === null) return;
      this.#focusBody("editor");
      this.#gesture = { surface: "editor", taskId: at.taskId, anchor: at.editor.offsetAt(at.x, at.y) };
    } else if (area === "reader") {
      const reading = this.#layout.reader;
      const task = s.selectedTask();
      if (reading === null || task === null) return;
      this.#focusBody(reading.preview ? "preview" : null);
      const point = this.#reader.pointAt(event.x - reading.x, event.y - reading.y);
      if (point !== null) this.#gesture = { surface: "reader", taskId: task.id, anchor: point };
    }
  }

  /** A drag from a press in the editor or the reader: VISUAL (charwise) from the press to the pointer. */
  #drag(event: TuiMouseEvent): void {
    const s = this.session;
    const gesture = this.#gesture;
    if (gesture === null || s.selectedTask()?.id !== gesture.taskId) return;
    if (gesture.surface === "editor") {
      const at = this.#editorAt(event);
      if (at === null || at.editor !== this.#activeEditor()) return;
      at.editor.selectRange("char", gesture.anchor, at.editor.offsetAt(at.x, at.y));
      this.#mouseVisual("editor", "char");
      return;
    }
    const reading = this.#layout.reader;
    if (reading === null || !this.#readerSelectable()) return;
    const point = this.#reader.pointAt(event.x - reading.x, event.y - reading.y);
    if (point !== null && this.#reader.selectRange("char", gesture.anchor, point)) this.#mouseVisual("reader", "char");
  }

  /** A mouse selection is VISUAL, the same one v/V make: INSERT ends first, the keys switch mode. */
  #mouseVisual(surface: "editor" | "reader", kind: VisualKind): void {
    const s = this.session;
    const task = s.selectedTask();
    if (task === null) return;
    if (s.keys.mode() === "INSERT") s.leaveInsert();
    this.#visual = { taskId: task.id, surface };
    s.keys.setMode(kind === "char" ? "VISUAL" : "VISUAL LINE");
    s.redraw();
  }

  /** A click (a press and release on one cell); `clickCount` counts a double or triple click. */
  #click(event: TuiMouseEvent): void {
    const s = this.session;
    const count = event.clickCount ?? 1;
    const status = this.#layout.statusHits.find(hit => onHit(hit, event.x, event.y));
    if (status !== undefined) {
      void s.execute(status.command);
      return;
    }
    switch (this.#areaAt(event.x, event.y)) {
      case "list":
        this.#listClick(event.y);
        return;
      case "editor": {
        const at = this.#editorAt(event);
        if (at === null) return;
        this.#focusBody("editor");
        const pos = at.editor.offsetAt(at.x, at.y);
        if (count >= 3) {
          at.editor.selectRange("line", pos, pos);
          this.#mouseVisual("editor", "line");
        } else if (count === 2) {
          at.editor.selectWord(pos);
          this.#mouseVisual("editor", "char");
        } else {
          // A click places the cursor: VISUAL ends (INSERT keeps typing there).
          this.#endVisual();
          at.editor.placeCursor(pos);
        }
        return;
      }
      case "reader":
        this.#readerClick(event, count);
        return;
      case "panel":
        this.#focusBody(null);
        return;
      case "document":
        this.#documentClick(event);
        return;
      default:
        return;
    }
  }

  /** A task row selects it; the selected row again (the second click of a double click too) opens its document. */
  #listClick(y: number): void {
    const s = this.session;
    const hit = this.#list.hitAt(y);
    if (hit.kind === "task") {
      if (s.selectedTask()?.id === hit.id) s.setFocus("document");
      else {
        s.select(hit.id);
        s.setFocus("tasks");
      }
    } else if (hit.kind === "sort") this.#onAction("sort", 1);
    else if (hit.kind === "filters") this.#onAction("filters", 1);
    else s.setFocus("tasks");
  }

  /** The rendered document: a link follows; else it takes the keyboard, a double click selects a word, a triple its row. */
  #readerClick(event: TuiMouseEvent, count: number): void {
    const reading = this.#layout.reader;
    if (reading === null) return;
    const local = { ...event, x: event.x - reading.x, y: event.y - reading.y };
    if (count === 1) {
      this.#endVisual();
      if (this.#reader.handleMouse(local) !== undefined) return; // a link or reference: followed
    }
    this.#focusBody(reading.preview ? "preview" : null);
    if (count === 1 || !this.#readerSelectable()) return;
    const point = this.#reader.pointAt(local.x, local.y);
    if (point === null) return;
    if (count === 2 ? this.#reader.selectWord(point) : this.#reader.selectRange("line", point, point)) {
      this.#mouseVisual("reader", count === 2 ? "char" : "line");
    }
  }

  /** The document pane around its body: a view tab, a tag label, the title, a Split half, or just the focus. */
  #documentClick(event: TuiMouseEvent): void {
    const s = this.session;
    const layout = this.#layout;
    const tab = layout.tabHits.find(hit => onHit(hit, event.x, event.y));
    if (tab !== undefined) {
      s.setFocus("document");
      // Exactly the commands (and their preference semantics): only Read/Edit/Split are saved.
      if (tab.view === "read" || tab.view === "edit" || tab.view === "split") this.#onAction(tab.view, 1);
      else void s.execute(tab.view);
      return;
    }
    // A tag label in the header widens the tag filter.
    const tag = layout.tagHits.find(hit => onHit(hit, event.x, event.y));
    if (tag !== undefined) s.appendTagFilter(tag.tag);
    s.setFocus("document");
    const title = layout.title;
    if (
      tag === undefined &&
      title !== null &&
      s.panel === "document" &&
      event.y >= title.y &&
      event.y < title.y + title.height
    ) {
      s.setDocumentTarget("title"); // the document cursor on the title: i or Enter edits it
      return;
    }
    // Split's divider row (or any row) above a half: that half.
    const editor = layout.editor;
    const reader = layout.reader;
    if (editor !== null && event.x >= editor.x && event.x < editor.x + editor.width) this.#focusBody("editor");
    else if (reader?.preview === true && event.x >= reader.x && event.x < reader.x + reader.width) {
      this.#focusBody("preview");
    }
  }

  /** The workspace's keys: whatever the prompt, dialogs and INSERT did not take (session.input routes). */
  #onKey(event: KeyEvent): void {
    const s = this.session;
    this.#syncVisual();
    if (this.#visual !== null) {
      this.#onVisualKey(event);
      return;
    }
    switch (event.type) {
      case "mode":
      case "text":
        // Only the prompt, forms and INSERT (the session routes those) take text.
        return;
      case "paste":
        s.notify("info", "Paste ignored: NORMAL mode never inserts text (i starts INSERT)");
        return;
      case "key":
        this.#onPlainKey(event.key, event.data, event.count ?? 1);
        return;
      case "action":
        if (event.action === "save") s.notify("info", "Ctrl-s writes in INSERT; :w writes now");
        else if (isNormalAction(event.action)) this.#onAction(event.action, event.count ?? 1);
        return;
      case "cancel":
        if (s.view !== "workspace") s.closeView();
        else if (s.focus === "document" && s.documentTarget === "title") s.setDocumentTarget("body");
        else if (event.key === "ctrl+c") s.notify("info", "Ctrl-C cancels; type :q to quit");
        return;
      case "quit-hint":
        if (s.view !== "workspace") s.closeView();
        else s.notify("info", "Type :q to quit (:q! discards anything unsaved)");
        return;
      case "unbound":
        s.notify("info", `${leaderLabel(s.keys.keys)}${event.key ?? "that key"} is not bound; :help lists the keys`);
        return;
    }
  }

  /** Does the current mode show the editor at this width (Edit, or Split's editor half)? */
  #editorShown(): boolean {
    const s = this.session;
    const mode = s.documentMode();
    if (mode === "edit") return true;
    return mode === "split" && (this.#terminal.columns >= SPLIT_COLUMNS || s.splitHalf === "editor");
  }

  /** Is the reader on screen at this size: Read, or the Split preview (its whole half on narrow terminals)? */
  #readerShown(): boolean {
    const s = this.session;
    const task = s.selectedTask();
    if (s.view !== "workspace" || task === null || s.panel !== "document") return false;
    const columns = this.#terminal.columns;
    if (columns < MIN_COLUMNS || this.#terminal.rows < MIN_ROWS) return false;
    if (s.taskListVisible && s.focus === "tasks" && columns < SIDE_BY_SIDE_COLUMNS) return false;
    const mode = s.documentMode();
    if (mode === "read") return true;
    if (mode !== "split" || s.documentOf(task.id)?.editor == null) return false;
    return columns >= SPLIT_COLUMNS || (s.focus === "document" && s.splitHalf === "preview");
  }

  /** The reader when `{`/`}` go to it: shown, and the editor does not have the keyboard. */
  #readerTarget(): Reader | null {
    return this.#readerShown() && this.#activeEditor() === null ? this.#reader : null;
  }

  /** The focused, VISIBLE editor that NORMAL motions and u/Ctrl-r act on, or null. */
  #activeEditor(): DocumentEditor | null {
    const s = this.session;
    if (s.view !== "workspace" || s.focus !== "document" || s.documentTarget !== "body") return null;
    if (s.panel !== "document") return null;
    if (!this.#editorShown() || (s.documentMode() === "split" && s.splitHalf === "preview")) return null;
    const task = s.selectedTask();
    return task === null ? null : (s.documentOf(task.id)?.editor ?? null);
  }

  #onPlainKey(key: string | null, data: string, count: number): void {
    const s = this.session;
    const page = Math.max(1, this.#terminal.rows - 4);
    const editor = this.#activeEditor();
    const inPanel = this.#inPanel();
    const name =
      key ??
      (data === "\x1b[1~" || data === "\x1b[7~" ? "home" : data === "\x1b[4~" || data === "\x1b[8~" ? "end" : null);
    switch (name) {
      case "enter":
        if (s.view === "commands") s.pickCommand();
        else if (s.view === "workspace" && s.focus === "tasks") s.setFocus("document");
        else if (s.view === "workspace" && s.documentTarget === "title" && s.selectedTask() !== null) s.editTitle();
        else if (inPanel) this.#activity.activate();
        else if (s.readerFocused() && this.#readerShown()) void s.execute("links");
        return;
      case "home":
        if (editor) editor.move("line-start");
        else this.#edge("first");
        return;
      case "0":
        // vi's line start (a 0 with no count pending); digits are never bindable.
        if (editor) editor.move("line-start");
        return;
      case "end":
        if (editor) editor.move("line-end");
        else this.#edge("last");
        return;
      case "pageUp":
        if (editor) editor.move("page-up", { count });
        else if (inPanel) this.#activity.scroll(-page * count);
        else this.#move(-page * count);
        return;
      case "pageDown":
        if (editor) editor.move("page-down", { count });
        else if (inPanel) this.#activity.scroll(page * count);
        else this.#move(page * count);
        return;
      default:
        return;
    }
  }

  /** A task panel (Activity, Related, Authors) has the keyboard: motions and Enter are its. */
  #inPanel(): boolean {
    const s = this.session;
    return s.view === "workspace" && s.focus === "document" && s.panel !== "document" && s.documentTarget === "body";
  }

  /** The body is scrolled to its top (Read, or the Split preview): k then moves the document cursor to the title. */
  #atBodyTop(): boolean {
    const task = this.session.selectedTask();
    return task !== null && this.session.docScroll(task.id) === 0;
  }

  #onAction(action: NormalAction, count: number): void {
    const s = this.session;
    const half = Math.max(1, Math.floor((this.#terminal.rows - 4) / 2));
    const editor = this.#activeEditor();
    const inDocument = s.view === "workspace" && s.focus === "document";
    const onTitle = inDocument && s.documentTarget === "title";
    const inPanel = this.#inPanel();
    switch (action) {
      case "down":
        if (onTitle) s.setDocumentTarget("body");
        else if (editor) editor.move("down", { count });
        else this.#move(count);
        break;
      case "up":
        if (onTitle) break;
        if (editor) {
          if (editor.atTop()) s.setDocumentTarget("title");
          else editor.move("up", { count });
        } else if (inPanel) this.#activity.move(-count);
        else if (inDocument && this.#atBodyTop()) s.setDocumentTarget("title");
        else this.#move(-count);
        break;
      case "half_down":
        if (editor) editor.move("half-page-down", { count });
        else if (inPanel) this.#activity.scroll(half * count);
        else this.#move(half * count);
        break;
      case "half_up":
        if (editor) editor.move("half-page-up", { count });
        else if (inPanel) this.#activity.scroll(-half * count);
        else this.#move(-half * count);
        break;
      case "top":
        if (editor) editor.move("doc-start");
        else this.#edge("first");
        break;
      case "bottom":
        if (editor) editor.move("doc-end");
        else this.#edge("last");
        break;
      case "left":
        if (editor) editor.move("left", { count, wrap: false });
        else {
          s.closeView();
          s.setFocus("tasks");
        }
        break;
      case "right":
        if (editor) editor.move("right", { count, wrap: false });
        else {
          s.closeView();
          s.setFocus("document");
        }
        break;
      case "focus_tasks":
        s.closeView();
        s.setFocus("tasks");
        break;
      case "focus_document":
        s.closeView();
        s.setFocus("document");
        break;
      case "next_pane":
        s.closeView();
        s.cycleFocus(1);
        break;
      case "previous_pane":
        s.closeView();
        s.cycleFocus(-1);
        break;
      case "toggle_tasks":
        s.closeView();
        s.toggleTaskList();
        break;
      case "toggle_done": {
        // ;d is :set done!, saying which way it went (the list header also shows +done while they are shown).
        s.closeView();
        s.setIncludeDone(!s.includeDone);
        const key = actionKeyLabels(s.keys.keys, "toggle_done")[0];
        const again = key === undefined ? "" : ` (${key} ${s.includeDone ? "hides" : "shows"} them)`;
        const filtered =
          !s.includeDone && s.filter.status === "done" ? "; the done status filter still lists them" : "";
        s.notify("info", `${s.includeDone ? "Showing" : "Hiding"} done tasks${again}${filtered}`);
        break;
      }
      case "next_heading":
      case "previous_heading": {
        s.closeView();
        const reader = this.#readerTarget();
        if (reader === null) {
          s.notify("info", "{ and } step through the headings of the rendered document: Read, or the Split preview");
        } else reader.stepHeading(action === "next_heading" ? count : -count);
        break;
      }
      case "next_match":
      case "previous_match":
        // In the help they step through its matches (it stays open); elsewhere, the workspace's.
        if (s.view !== "help") s.closeView();
        s.stepResult(action === "next_match" ? count : -count);
        break;
      case "back":
        s.closeView();
        s.back();
        break;
      case "forward":
        s.closeView();
        s.forward();
        break;
      case "help":
        if (s.view === "help") s.closeView();
        else s.openView("help");
        break;
      case "commands":
        if (s.view === "commands") s.closeView();
        else s.openCommands();
        break;
      case "suspend":
        this.suspend();
        break;
      case "tags":
        // ;t is :tag: the current task's tag picker.
        s.closeView();
        void s.execute("tag");
        break;
      case "status":
        // ;m is a bare :status: the current task's status picker.
        s.closeView();
        void s.execute("status");
        break;
      case "insert":
        s.closeView();
        s.startInsert();
        break;
      case "next_panel":
      case "previous_panel":
        s.closeView();
        if (s.selectedTask() === null) {
          s.notify("info", "No task selected: :open <id> picks one");
          break;
        }
        s.cyclePanel(action === "next_panel" ? 1 : -1);
        this.#activity.retry(s.panel); // its read starts now (a failed one is retried: an explicit key)
        // Beside the list, the list keeps the keyboard (the panel follows its selection); narrower, the panel needs the focus to show.
        if (this.#terminal.columns < SIDE_BY_SIDE_COLUMNS || !s.taskListVisible) s.setFocus("document");
        break;
      case "post":
        s.closeView();
        void s.execute("post");
        break;
      case "undo":
      case "redo": {
        if (editor === null) {
          s.notify("info", "Undo and redo act only in a visible editor (:edit, or i in the body)");
          break;
        }
        const done = action === "undo" ? editor.undo(count) : editor.redo(count);
        if (!done) s.notify("info", action === "undo" ? "Nothing to undo" : "Nothing to redo");
        break;
      }
      case "word_forward":
      case "word_backward":
      case "word_end":
      case "line_end": {
        const motion = MOTIONS[action];
        if (editor !== null && motion !== undefined) editor.move(motion.editor, { count });
        else s.notify("info", "Word and line motions move the editor cursor, or a VISUAL selection (v, V)");
        break;
      }
      case "visual":
      case "visual_line":
        this.#startVisual(action === "visual" ? "char" : "line");
        break;
      case "paste_after":
      case "paste_before": {
        if (editor === null) {
          s.notify("info", "Paste acts in a visible editor (:edit, or i in the body)");
          break;
        }
        if (this.#register === null) {
          s.notify("info", "Nothing to paste yet: a yank or delete in VISUAL (v, V) fills the paste register");
          break;
        }
        editor.put(this.#register, { before: action === "paste_before", count });
        break;
      }
      case "read":
      case "edit":
      case "split":
        s.closeView();
        void s.execute(action);
        break;
      case "sort":
        // ;o is a bare :sort: the sort and group picker.
        s.closeView();
        void s.execute("sort");
        break;
      case "filters":
        // f (and a click on the list header's filter chips) is a bare :filter: the filter picker.
        s.closeView();
        void s.execute("filter");
        break;
      case "clear_filters":
        s.closeView();
        void s.execute("clear");
        break;
      default: {
        // Every action has its case; a new one must get its own (this assignment then fails to type-check).
        const unhandled: never = action;
        s.notify("info", `${String(unhandled)}: not available in this build yet`);
        break;
      }
    }
  }

  // ---------- VISUAL (vi's v and V) ----------

  /** The VISUAL kind the keys are in, or null. */
  #visualKind(): VisualKind | null {
    const mode = this.session.keys.mode();
    return mode === "VISUAL" ? "char" : mode === "VISUAL LINE" ? "line" : null;
  }

  /** The rendered document has the keyboard and is on screen (Read, or the Split preview), on the body. */
  #readerSelectable(): boolean {
    const s = this.session;
    return s.readerFocused() && this.#readerShown() && s.documentTarget === "body";
  }

  /** `v`/`V` in NORMAL: select in the focused, visible editor, or in the focused reader. */
  #startVisual(kind: VisualKind): void {
    const s = this.session;
    const task = s.selectedTask();
    const editor = this.#activeEditor();
    if (task === null) {
      s.notify("info", s.loaded ? "No task selected: :open <id> picks one" : "The workspace is still loading");
      return;
    }
    if (editor !== null) {
      editor.setVisual(kind);
      this.#visual = { taskId: task.id, surface: "editor" };
    } else if (this.#readerSelectable() && this.#reader.select(kind)) {
      this.#visual = { taskId: task.id, surface: "reader" };
    } else {
      s.notify("info", "VISUAL selects in the document: focus the editor or the rendered text first (Tab)");
      return;
    }
    s.keys.setMode(kind === "char" ? "VISUAL" : "VISUAL LINE");
    s.redraw();
  }

  /** End VISUAL: the selection goes (the cursor stays), and the keys are NORMAL again (unless a prompt took them). */
  #endVisual(): void {
    const s = this.session;
    const visual = this.#visual;
    this.#visual = null;
    if (visual?.surface === "editor") s.documentOf(visual.taskId)?.editor?.setVisual(null);
    else if (visual?.surface === "reader") this.#reader.endSelection();
    if (this.#visualKind() !== null) s.keys.setMode("NORMAL");
  }

  /**
   * Keep VISUAL and its selection in step: it lives only while the keys are
   * in VISUAL, the task is the same and its surface (the editor, or the
   * reader) still has the keyboard with a selection. Otherwise it ends.
   */
  #syncVisual(): void {
    const s = this.session;
    const visual = this.#visual;
    const kind = this.#visualKind();
    if (visual === null && kind === null) return;
    if (visual !== null && kind !== null && s.selectedTask()?.id === visual.taskId) {
      if (visual.surface === "editor") {
        const editor = this.#activeEditor();
        if (editor !== null && editor === s.documentOf(visual.taskId)?.editor && editor.visual() !== null) return;
      } else if (this.#readerSelectable() && this.#reader.selecting() !== null) return;
    }
    this.#endVisual();
  }

  /** VISUAL's keys: motions extend the selection, the operators act on it, Esc (or v/V again) ends it. */
  #onVisualKey(event: KeyEvent): void {
    const s = this.session;
    switch (event.type) {
      case "mode":
        // Esc or Ctrl-C (the session's prompts take `:` and `/` first).
        this.#endVisual();
        return;
      case "action":
        if (event.via === "visual" && isVisualAction(event.action))
          this.#onVisualAction(event.action, event.count ?? 1);
        else if (isNormalAction(event.action)) this.#onVisualMotion(event.action, event.count ?? 1);
        return;
      case "key": {
        const motion = PLAIN_MOTIONS[event.key ?? ""];
        if (motion !== undefined) this.#visualMove(motion, event.count ?? 1);
        else this.#visualHint();
        return;
      }
      case "paste":
        s.notify("info", "Paste ignored: VISUAL never inserts text (Esc, then p pastes)");
        return;
      case "quit-hint":
        s.notify("info", "Type :q to quit (:q! discards anything unsaved)");
        return;
      default:
        return;
    }
  }

  #onVisualMotion(action: NormalAction, count: number): void {
    if (action === "suspend") {
      this.suspend(); // Ctrl-z always works; VISUAL is still there on return
      return;
    }
    if (action === "visual" || action === "visual_line") {
      // The same key again ends VISUAL; the other one switches the kind in place.
      const kind: VisualKind = action === "visual" ? "char" : "line";
      if (this.#visualKind() === kind) {
        this.#endVisual();
        return;
      }
      if (this.#visual?.surface === "editor") this.#activeEditor()?.setVisual(kind);
      else this.#reader.select(kind);
      this.session.keys.setMode(kind === "char" ? "VISUAL" : "VISUAL LINE");
      return;
    }
    const motion = MOTIONS[action];
    if (motion === undefined) this.#visualHint();
    else this.#visualMove(motion, count);
  }

  #visualMove(motion: { editor: EditorMotion; reader: SelectionMotion; inLine?: true }, count: number): void {
    if (this.#visual?.surface === "reader") this.#reader.moveSelection(motion.reader, count);
    else this.#activeEditor()?.move(motion.editor, { count, wrap: motion.inLine !== true });
  }

  #onVisualAction(action: VisualAction, count: number): void {
    const s = this.session;
    const visual = this.#visual;
    if (visual === null) return;
    if (action === "other_end") {
      if (visual.surface === "editor") this.#activeEditor()?.swapVisualEnds();
      else this.#reader.swapSelectionEnds();
      return;
    }
    if (visual.surface === "reader") {
      if (action !== "yank") {
        s.notify("info", "Reading never edits: yank copies the selection; i edits the document");
        return;
      }
      const picked = this.#reader.selectedText();
      this.#endVisual();
      if (picked !== null) {
        const register: Register = { text: picked.text, linewise: picked.linewise };
        this.#yanked(register, amount(register, "rendered rows"));
      }
      return;
    }
    const editor = this.#activeEditor();
    if (editor === null) {
      this.#endVisual();
      return;
    }
    switch (action) {
      case "yank": {
        const register = editor.yank();
        this.#endVisual();
        if (register !== null) this.#yanked(register, amount(register));
        return;
      }
      case "delete":
      case "change": {
        const register = editor.deleteSelection({ change: action === "change" });
        this.#endVisual();
        if (register !== null) this.#register = register;
        if (action === "change") s.startInsert();
        else if (register !== null) s.notify("info", `Deleted ${amount(register)} (u undoes it; p pastes it)`);
        return;
      }
      case "indent":
      case "outdent": {
        const done = editor.indentSelection(action === "indent" ? 1 : -1, count);
        this.#endVisual();
        if (!done) s.notify("info", action === "indent" ? "Nothing to indent" : "Nothing to outdent");
        return;
      }
    }
  }

  /** A yank: the paste register, and the terminal clipboard through ONE OSC 52 write, never reported as confirmed. */
  #yanked(register: Register, what: string): void {
    const s = this.session;
    this.#register = register;
    try {
      s.copyText(register.text, what);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      s.notify("error", `${reason}; it is in the paste register (p pastes it)`);
    }
  }

  /** A key VISUAL does not use: say what it does. */
  #visualHint(): void {
    const s = this.session;
    const keys = s.keys.keys;
    const key = (action: VisualAction): string | undefined => visualKeyLabels(keys, action)[0];
    const hint = (k: string | undefined, text: string) => (k === undefined ? undefined : `${k} ${text}`);
    const parts =
      this.#visual?.surface === "reader"
        ? [hint(key("yank"), "copies"), hint(key("other_end"), "goes to the other end")]
        : [
            hint(key("yank"), "yanks"),
            hint(key("delete"), "deletes"),
            hint(key("change"), "changes"),
            hint(key("indent"), "indents"),
            hint(key("outdent"), "outdents"),
          ];
    const list = parts.filter((p): p is string => p !== undefined).join(", ");
    s.notify("info", `VISUAL: ${list === "" ? "" : `${list}; `}motions extend the selection; Esc ends it`);
  }

  #move(delta: number): void {
    const s = this.session;
    if (s.view === "commands") s.moveCommandSelection(delta);
    else if (s.view !== "workspace") s.scrollView(delta);
    else if (s.focus === "tasks" && s.taskListVisible) s.moveSelection(delta);
    else if (s.panel !== "document") this.#activity.move(delta);
    else s.scrollDocument(delta);
  }

  #edge(edge: "first" | "last"): void {
    const s = this.session;
    const far = edge === "first" ? -Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
    if (s.view === "commands") s.moveCommandSelection(far);
    else if (s.view !== "workspace") s.scrollView(far);
    else if (s.focus === "tasks" && s.taskListVisible) s.selectEdge(edge);
    else if (s.panel !== "document") this.#activity.edge(edge);
    else s.scrollDocument(far);
  }

  // ---------- rendering ----------

  /** The whole screen for the current terminal size: exactly `height` rows of at most `width` cells. */
  frame(width: number = this.#terminal.columns, height: number = this.#terminal.rows): string[] {
    const theme = this.#theme;
    if (theme === null) return Array.from({ length: Math.max(0, height) }, () => "");
    this.#layout = emptyLayout();
    if (width < MIN_COLUMNS || height < MIN_ROWS) return this.#resizeScreen(theme, width, height);
    const s = this.session;
    this.#syncVisual();
    const suggestions = this.#suggestionRows(theme, width);
    // S3: comfortable leaves one blank row (the bg surface) between the view and the status line.
    const spacer = s.density === "comfortable" ? [paint(theme, [], width, "text@bg")] : [];
    const mainHeight = height - 2 - spacer.length - suggestions.length;
    const main =
      s.view === "workspace"
        ? this.#workspace(theme, width, mainHeight)
        : s.view === "commands"
          ? this.#commandsPane(theme, width, mainHeight)
          : this.#viewPane(theme, width, mainHeight);
    // A re-wrap while rendering ends a reader selection: the status line then says NORMAL in this frame.
    this.#syncVisual();
    const bottom = s.prompt !== null ? this.#promptLine(theme, width) : this.#hintLine(theme, width);
    this.#layout.mainHeight = main.length;
    const status = this.#statusLine(theme, width, main.length + spacer.length);
    return [...main, ...spacer, status, ...suggestions, bottom];
  }

  #workspace(theme: ResolvedTheme, width: number, height: number): string[] {
    const s = this.session;
    if (s.taskListVisible && width >= SIDE_BY_SIDE_COLUMNS) {
      const listWidth = Math.max(28, Math.min(56, Math.floor(width * 0.33)));
      this.#list.height = height;
      // N23: the pane without the focus is greyed (never by color alone: dim without color, and
      // the focused pane's label is inverse); every component in it paints through that theme.
      const listTheme = s.focus === "tasks" ? theme : inactiveTheme(theme);
      const docTheme = s.focus === "tasks" ? inactiveTheme(theme) : theme;
      const list = s.withPaneTheme(listTheme, () => this.#list.render(listWidth));
      const doc = s.withPaneTheme(docTheme, () =>
        this.#documentPane(docTheme, width - listWidth - 1, height, listWidth + 1),
      );
      const divider = style(theme, "border@bg", "│");
      this.#layout.listWidth = listWidth;
      return list.map((line, i) => line + divider + (doc[i] ?? ""));
    }
    if (s.taskListVisible && s.focus === "tasks") {
      this.#layout.listWidth = width;
      this.#list.height = height;
      return this.#list.render(width);
    }
    return this.#documentPane(theme, width, height, 0);
  }

  #documentPane(theme: ResolvedTheme, width: number, height: number, x: number): string[] {
    const s = this.session;
    this.#layout.docX = x;
    const fill: ContrastPair = "text@bg";
    const inner = Math.max(1, width - 2);
    const row = (segs: readonly Seg[]) => paint(theme, [seg("text@bg", " "), ...segs], width, fill);
    const out: string[] = [];
    const task = s.selectedTask();
    if (!s.loaded) out.push(row([seg("muted@bg", "Loading the workspace…")]));
    else if (task === null) {
      out.push(row([seg("muted@bg", s.tasks.length === 0 ? "No tasks yet" : "No task selected")]));
    } else {
      const mode = s.documentMode();
      if (mode !== "read" && s.documentOf(task.id) === null) void s.openDocument(task.id);
      const doc = s.documentOf(task.id);
      const draft = doc?.draft ?? null;
      const focused = s.view === "workspace" && s.focus === "document";
      // One cursor marker per frame: the prompt and dialog fields own it while they are open.
      const markable = s.prompt === null && s.dialog === null;
      const meta: Seg[] = [
        seg("dim@bg", `@${task.id}`),
        seg("muted@bg", ` · ${esc(task.lane)} · `),
        seg(statusPair(task.status, "bg"), `${STATUS_MARK[task.status]} ${STATUS_LABEL[task.status]}`),
      ];
      if (task.priority !== null) meta.push(seg("muted@bg", ` · P${task.priority}`));
      // The header row: one leading cell (the margin), the metadata and the tag labels, then the view
      // tabs at the right edge: with key hints, plain, or abbreviated, whichever keeps every tag.
      let column = 1 + meta.reduce((n, m) => n + displayWidth(m.text), 0);
      const labels = task.tags.map(tag => ({ tag, text: ` #${esc(tag)}` }));
      const tagCells = labels.reduce((n, l) => n + displayWidth(l.text), 0);
      const tabs =
        TAB_STYLES.map(look => this.#viewTabs(look)).find(t => column + tagCells + 1 + t.width <= width) ??
        this.#viewTabs("short");
      const room = Math.max(0, width - tabs.width - 1);
      for (const { tag, text } of labels) {
        const cells = displayWidth(text);
        // Each fully shown tag label is a click target (the rest are cut at the tabs).
        if (column + cells <= room)
          this.#layout.tagHits.push({ x: x + column + 1, y: out.length, width: cells - 1, tag });
        meta.push(seg("info@bg", text));
        column += cells;
      }
      const left = width - tabs.width;
      for (const hit of tabs.hits) {
        this.#layout.tabHits.push({ x: x + left + hit.offset, y: out.length, width: hit.width, view: hit.view });
      }
      out.push(
        paint(theme, [seg("text@bg", " "), ...meta], Math.max(0, left), fill) +
          paint(theme, tabs.segs, tabs.width, fill),
      );
      const titleEdit = s.titleEdit;
      const titleCap = Math.max(TITLE_LINES, Math.floor(height / 2));
      const titleTop = out.length;
      if (titleEdit !== null && titleEdit.taskId === task.id) {
        out.push(...this.#titleEditRows(theme, titleEdit.line, width, titleCap, markable));
      } else {
        // The document cursor on the title shows it in full, marked, never tint alone.
        const targeted = focused && s.documentTarget === "title";
        const title = wrapTextWithAnsi(esc(draft?.text("title") ?? task.title), inner);
        const limit = targeted ? titleCap : TITLE_LINES;
        const shownTitle = title.slice(0, limit);
        if (title.length > limit) {
          const last = shownTitle[limit - 1] ?? "";
          shownTitle[limit - 1] = displayWidth(last) < inner ? `${last}…` : fit(`${last}…`, inner);
        }
        for (const line of shownTitle) {
          out.push(
            paint(
              theme,
              [
                seg(targeted ? "accent@bg" : "text@bg", targeted ? "▌" : " "),
                seg("md.heading@bg", line, { bold: true }),
              ],
              width,
              fill,
            ),
          );
        }
      }
      this.#layout.title = { y: titleTop, height: out.length - titleTop };
      if (!s.isVisible(task.id)) out.push(row([seg("warn@bg", "Outside the current list filters")]));
      if (draft !== null) {
        for (const field of DRAFT_FIELDS) {
          const incoming = draft.incoming(field);
          if (incoming === null) continue;
          const preview = (incoming || "(empty)").replace(/\s+/g, " ").trim();
          out.push(
            row([
              seg("danger@bg", `↻ ${field === "title" ? "Title" : "Body"} changed elsewhere (conflict): `, {
                bold: true,
              }),
              seg("text@bg", esc(preview.length > 120 ? `${preview.slice(0, 117)}…` : preview)),
              seg("muted@bg", ` · :apply ${field} takes it · :keep ${field} keeps yours`),
            ]),
          );
        }
        for (const field of DRAFT_FIELDS) {
          if (draft.state(field) !== "failed") continue;
          out.push(row([seg("danger@bg", `✗ ${field} not saved: ${esc(draft.error(field) ?? "")} · :w retries`)]));
        }
      }
      // The task's update composer draft (kept when the composer closed): marked in every panel.
      const composer = this.#activity.marker(task.id);
      if (composer !== null) out.push(row(composer));
      // S2: comfortable leaves one blank row between the header block and the divider below it (every
      // branch below starts with one): a one-line title's body then starts on the list's first task row.
      if (s.density === "comfortable") out.push(row([]));
      // S5: comfortable also leaves one blank row under the divider, so the content never touches it.
      const gap = s.density === "comfortable" ? 1 : 0;
      const underDivider = (): void => {
        if (gap > 0) out.push(row([]));
      };
      const editorFocused = focused && s.documentTarget === "body";
      const wideSplit = mode === "split" && this.#terminal.columns >= SPLIT_COLUMNS;
      if (s.panel !== "document") {
        const keys = s.keys.keys;
        const steps = [actionKeyLabels(keys, "previous_panel")[0], actionKeyLabels(keys, "next_panel")[0]].filter(
          (k): k is string => k !== undefined,
        );
        const labels: (readonly [string, boolean])[] = [[` ${this.#activity.title()} `, focused]];
        if (steps.length > 0) labels.push([` ${steps.join(" ")} panels `, false]);
        out.push(this.#divider(theme, width, labels, fill));
        underDivider();
        const rows = Math.max(0, height - out.length);
        this.#activity.height = rows;
        this.#layout.panel = { x, y: out.length, width, height: rows };
        out.push(...this.#activity.render(width));
      } else if (mode === "read") {
        out.push(this.#divider(theme, width, [[" READ ", focused], ...this.#readerLabels()], fill));
        underDivider();
        out.push(...this.#readerRows(width, Math.max(0, height - out.length), x, out.length, false, null));
      } else if (draft === null || doc?.editor == null) {
        out.push(this.#divider(theme, width, [[mode === "edit" ? " EDIT " : " SPLIT ", focused]], fill));
        underDivider();
        out.push(
          doc?.error
            ? row([seg("danger@bg", `error: could not load it for editing: ${esc(doc.error)} · :edit retries`)])
            : row([seg("muted@bg", "Loading the document for editing…")]),
        );
      } else if (mode === "edit") {
        out.push(this.#divider(theme, width, [[" EDIT ", editorFocused]], fill));
        underDivider();
        const rows = Math.max(0, height - out.length);
        const lines = this.#editorRows(
          theme,
          doc.editor,
          task.id,
          width - 1,
          rows,
          editorFocused && markable,
          x + 1,
          out.length,
        );
        for (const line of lines) out.push(style(theme, "text@bg", " ") + line);
      } else if (wideSplit) {
        const left = Math.floor((width - 1) / 2);
        const right = width - 1 - left;
        const onEditor = editorFocused && s.splitHalf === "editor";
        const onPreview = editorFocused && s.splitHalf === "preview";
        // With the document focused, the other half is greyed (an unfocused document greys both).
        const editorTheme = focused && s.splitHalf !== "editor" ? inactiveTheme(theme) : theme;
        const previewTheme = focused && s.splitHalf !== "preview" ? inactiveTheme(theme) : theme;
        // The halves render before their divider: the preview follows the editor's cursor (the editor
        // renders first, so its cursor row is this frame's), and the labels then name what it shows.
        const top = out.length + 1 + gap;
        const rows = Math.max(0, height - top);
        const editorLines = this.#editorRows(
          editorTheme,
          doc.editor,
          task.id,
          left - 1,
          rows,
          onEditor && markable,
          x + 1,
          top,
        );
        const cursor = cursorOf(doc.editor, rows);
        const previewLines = s.withPaneTheme(previewTheme, () =>
          this.#readerRows(right, rows, x + left + 1, top, true, cursor),
        );
        out.push(
          this.#divider(editorTheme, left, [[" EDIT ", onEditor]], fill) +
            style(theme, "border@bg", "┬") +
            this.#divider(previewTheme, right, [[" PREVIEW ", onPreview], ...this.#readerLabels()], fill),
        );
        // The halves' rule runs through the spacer row.
        if (gap > 0) {
          out.push(
            paint(editorTheme, [], left, fill) +
              style(theme, "border@bg", "\u2502") +
              paint(previewTheme, [], right, fill),
          );
        }
        for (let i = 0; i < rows; i++) {
          out.push(
            style(editorTheme, "text@bg", " ") +
              (editorLines[i] ?? "") +
              style(theme, "border@bg", "│") +
              (previewLines[i] ?? paint(previewTheme, [], right, fill)),
          );
        }
      } else {
        // Narrow Split: only the focused half; the saved preference stays Split.
        const half = s.splitHalf;
        const label =
          half === "editor" ? " SPLIT · editor · Tab shows the preview " : " SPLIT · preview · Tab moves on ";
        // The half renders before its divider (the preview's labels then name what it shows).
        const top = out.length + 1 + gap;
        const rows = Math.max(0, height - top);
        const body =
          half === "editor"
            ? this.#editorRows(theme, doc.editor, task.id, width - 1, rows, editorFocused && markable, x + 1, top).map(
                line => style(theme, "text@bg", " ") + line,
              )
            : this.#readerRows(width, rows, x, top, true, cursorOf(doc.editor, rows));
        out.push(
          this.#divider(
            theme,
            width,
            [[label, editorFocused], ...(half === "preview" ? this.#readerLabels() : [])],
            fill,
          ),
        );
        underDivider();
        out.push(...body);
      }
    }
    while (out.length < height) out.push(row([]));
    return out.slice(0, height);
  }

  /**
   * The view tabs in `look`: the view shown (the panel, else the document
   * mode) bold and inverse, never color alone; `hits` are their cells from
   * the first tab.
   */
  #viewTabs(look: TabStyle): {
    segs: Seg[];
    width: number;
    hits: { offset: number; width: number; view: ViewTab }[];
  } {
    const s = this.session;
    const active: ViewTab = s.panel !== "document" ? s.panel : s.documentMode();
    const keys = s.keys.keys;
    const segs: Seg[] = [];
    const hits: { offset: number; width: number; view: ViewTab }[] = [];
    let width = 0;
    for (const tab of VIEW_TABS) {
      if (tab.view === "activity") {
        segs.push(seg("border@bg", " │ "));
        width += 3;
      }
      const mode = tab.view === "read" || tab.view === "edit" || tab.view === "split" ? tab.view : null;
      const key = look === "hints" && mode !== null ? actionKeyLabels(keys, mode)[0] : undefined;
      const name = look === "short" ? tab.short : tab.label;
      const text = ` ${name}${key === undefined ? "" : ` ${key}`} `;
      if (tab.view === active) segs.push(seg("accent@bg", text, { bold: true, inverse: true }));
      else {
        segs.push(seg("muted@bg", ` ${name}`));
        if (key !== undefined) segs.push(seg("dim@bg", ` ${key}`));
        segs.push(seg("muted@bg", " "));
      }
      const cells = displayWidth(text);
      hits.push({ offset: width, width: cells, view: tab.view });
      width += cells;
    }
    return { segs, width, hits };
  }

  /** A pane divider: `──` then labels (the focused one accented, bold and inverse: never color alone), then a rule. */
  #divider(
    theme: ResolvedTheme,
    width: number,
    labels: readonly (readonly [string, boolean])[],
    fill: ContrastPair,
  ): string {
    const segs: Seg[] = [seg("border@bg", "──")];
    let used = 2;
    for (const [label, on] of labels) {
      segs.push(seg(on ? "accent@bg" : "dim@bg", label, { bold: on, inverse: on }));
      used += displayWidth(label);
    }
    segs.push(seg("border@bg", "─".repeat(Math.max(0, width - used))));
    return paint(theme, segs, width, fill);
  }

  /** The editor's rows at `width` x `height`; `focused` puts its cursor (and the marker) on screen; the last column is its scrollbar. */
  #editorRows(
    theme: ResolvedTheme,
    editor: DocumentEditor,
    taskId: number,
    width: number,
    height: number,
    focused: boolean,
    x: number,
    y: number,
  ): string[] {
    editor.theme = theme;
    editor.height = height;
    editor.focused = focused;
    this.#layout.editor = { taskId, x, y, width, height };
    // The last column is the body's scrollbar (src/tui/scrollbar.ts); the mouse area keeps it (the wheel scrolls).
    const lines = editor.render(Math.max(1, width - 1));
    return withScrollbar(theme, lines, editor.scrollPosition());
  }

  /** The reader's rows (Read, or the Split preview following `cursor`) at `width` x `height`, placed at x/y for the mouse; the last column is its scrollbar. */
  #readerRows(
    width: number,
    height: number,
    x: number,
    y: number,
    preview: boolean,
    cursor: EditorCursor | null,
  ): string[] {
    this.#reader.height = height;
    this.#reader.editorCursor = cursor;
    this.#layout.reader = { x, y, width, height, preview };
    const lines = this.#reader.render(Math.max(1, width - 1));
    const theme = this.session.theme; // the pane's (withPaneTheme), as the reader paints with
    return theme === null ? lines : withScrollbar(theme, lines, this.#reader.scrollPosition());
  }

  /** Divider labels after READ/PREVIEW: the raw-source view, the section in view, the document search. */
  #readerLabels(): (readonly [string, boolean])[] {
    const labels: (readonly [string, boolean])[] = [];
    if (this.#reader.sourceView) labels.push([" source (:source renders) ", false]);
    const section = this.#reader.section();
    if (section?.heading) {
      labels.push([` § ${fit(esc(section.heading.text), 40)} ${section.index + 1}/${section.count} `, false]);
    }
    const search = this.#reader.searchStatus();
    if (search !== null) {
      const where =
        search.count === 0 ? "no match" : search.index === 0 ? `${search.count}` : `${search.index}/${search.count}`;
      labels.push([` /${fit(esc(search.query), 24)} ${where} `, false]);
    }
    return labels;
  }

  /** The title being edited in place: every row (no clamp), the cursor cell inverse, the marker at it. */
  #titleEditRows(theme: ResolvedTheme, line: CommandLine, width: number, cap: number, markable: boolean): string[] {
    const inner = Math.max(1, width - 2);
    type TitleCell = { text: string; width: number; cursor: boolean };
    const cells: TitleCell[] = [];
    for (const { index, segment } of segmenter.segment(line.text)) {
      const shown = esc(segment);
      cells.push({ text: shown, width: displayWidth(shown), cursor: index === line.cursor });
    }
    if (line.cursor >= line.text.length) cells.push({ text: " ", width: 1, cursor: true });
    const rows: TitleCell[][] = [[]];
    let used = 0;
    for (const cell of cells) {
      if (used + cell.width > inner && used > 0) {
        rows.push([]);
        used = 0;
      }
      (rows[rows.length - 1] as TitleCell[]).push(cell);
      used += cell.width;
    }
    const cursorRow = Math.max(
      0,
      rows.findIndex(r => r.some(c => c.cursor)),
    );
    const first = Math.max(0, Math.min(cursorRow - cap + 1, rows.length - cap));
    return rows.slice(first, first + cap).map(cellsOfRow => {
      let text = style(theme, "accent@bg", "▌");
      let rowUsed = 1;
      let run = "";
      for (const cell of cellsOfRow) {
        if (!cell.cursor) {
          run += cell.text;
          continue;
        }
        text += style(theme, "md.heading@bg", run, { bold: true });
        run = "";
        text +=
          (markable ? CURSOR_MARKER : "") + style(theme, "md.heading@bg", cell.text, { bold: true, inverse: true });
      }
      text += style(theme, "md.heading@bg", run, { bold: true });
      rowUsed += cellsOfRow.reduce((n, c) => n + c.width, 0);
      return text + (rowUsed < width ? style(theme, "text@bg", " ".repeat(width - rowUsed)) : "");
    });
  }

  #viewPane(theme: ResolvedTheme, width: number, height: number): string[] {
    const s = this.session;
    if (s.view === "help") return this.#help.render(theme, width, height);
    const content = this.#messageLines(width - 2);
    const max = Math.max(0, content.length - height);
    const scroll = Math.min(s.viewScroll, max);
    s.setViewScroll(scroll);
    const out = content
      .slice(scroll, scroll + height)
      .map(segs => paint(theme, [seg("text@bg", " "), ...segs], width, "text@bg"));
    while (out.length < height) out.push(paint(theme, [], width, "text@bg"));
    return out;
  }

  /** The :commands reference: the registry, filtered by its search; the highlighted row stays in view. */
  #commandsPane(theme: ResolvedTheme, width: number, height: number): string[] {
    const s = this.session;
    const list = s.commandList();
    const selected = s.commandsSelected;
    const total = s.commands.length;
    const query = s.commandsQuery;
    const head: Seg[][] = [
      [
        seg("accent@bg", "COMMANDS", { bold: true }),
        seg("muted@bg", ` · ${list.length} of ${total}`),
        ...(query === "" ? [] : [seg("info@bg", ` · /${esc(query)}`)]),
        seg("dim@bg", " · / searches · Enter picks · q or Esc closes"),
      ],
      [],
    ];
    const out = head.map(segs => paint(theme, [seg("text@bg", " "), ...segs], width, "text@bg"));
    const room = Math.max(0, height - out.length);
    if (list.length === 0)
      out.push(paint(theme, [seg("muted@bg", ` No command matches /${esc(query)}`)], width, "text@bg"));
    // Usage plus the other ways to type it, as in :help (`:q  :quit`).
    const help = new Map(commandHelp(list).map(h => [h.name, [h.usage, ...h.names].join("  ")]));
    const usageOf = (name: string): string => esc(help.get(name) ?? "");
    const usageWidth = Math.min(30, Math.max(12, ...list.map(c => displayWidth(usageOf(c.name)))));
    let scroll = Math.min(s.viewScroll, Math.max(0, list.length - room));
    if (selected < scroll) scroll = selected;
    else if (selected >= scroll + room) scroll = selected - room + 1;
    s.setViewScroll(scroll);
    list.slice(scroll, scroll + room).forEach((spec, i) => {
      const usage = fit(usageOf(spec.name), usageWidth);
      const pad = " ".repeat(Math.max(0, usageWidth - displayWidth(usage)));
      if (scroll + i === selected) {
        out.push(
          paint(
            theme,
            [
              seg("accent@selection", "▌"),
              seg("text@selection", `${usage}${pad}  `, { bold: true }),
              seg("muted@selection", esc(spec.description)),
            ],
            width,
            "text@selection",
          ),
        );
      } else {
        out.push(
          paint(theme, [seg("text@bg", ` ${usage}${pad}  `), seg("muted@bg", esc(spec.description))], width, "text@bg"),
        );
      }
    });
    while (out.length < height) out.push(paint(theme, [], width, "text@bg"));
    return out.slice(0, height);
  }

  /** The help's lines (src/tui/help.ts wraps and searches them): an entry's description column is its hang. */
  #helpLines(): HelpLine[] {
    const keys = this.session.keys.keys;
    const out: HelpLine[] = [];
    const blank = () => out.push({ segs: [] });
    const heading = (text: string) => out.push({ segs: [seg("accent@bg", text, { bold: true })] });
    const entry = (left: string, right: string, later = false) =>
      out.push({
        segs: [
          seg("text@bg", `  ${esc(left).padEnd(HELP_KEY_WIDTH)} `),
          seg("muted@bg", esc(right)),
          ...(later ? [seg("dim@bg", "  (later)")] : []),
        ],
        hang: HELP_KEY_WIDTH + 3,
      });
    heading("CORTEX TERMINAL WORKSPACE · help (/ searches it · q or Esc closes)");
    blank();
    heading("MODES");
    entry("NORMAL", "Keys move and act; they never insert text");
    entry("INSERT", "Every key is text until Esc: the body editor, or the title in place (Enter or Esc saves it)");
    entry(
      `${actionKeyLabels(keys, "visual")[0] ?? ""}  VISUAL`,
      "Select characters from the cursor in the editor or the rendered document: motions (with counts) extend it, the VISUAL keys act on it, Esc or the same key ends it",
    );
    entry(
      `${actionKeyLabels(keys, "visual_line")[0] ?? ""}  VISUAL LINE`,
      "Select whole lines (while reading: rendered rows, copied as their visible text)",
    );
    entry(":  COMMAND", "A one-line command: Tab completes, Up/Down recall, Enter runs it, Esc cancels");
    entry(
      "/  SEARCH",
      "Filter the task list, search the rendered document while it has the focus, or search this help while it is open (n/N step): Enter applies, Esc cancels, an empty search clears it",
    );
    blank();
    // The mouse is optional: every row here also has a key or a command.
    heading(
      this.#options.config.mouse
        ? "MOUSE (mouse = false in tui.toml turns it off)"
        : "MOUSE · off (mouse = true in tui.toml)",
    );
    entry("click", "Focus the pane under it: the list, the document, a Split half, a panel");
    entry("click a task row", "Select it; a click on the selected row (or a double click) opens its document");
    entry(
      "view tabs",
      "The document header's Read Edit Split │ Activity Related Authors: :read :edit :split :activity :related :authors",
    );
    entry(
      "list header",
      "The filter chips open the filter picker (bare :filter); the sort label, the sort and group picker (bare :sort)",
    );
    entry("status line", "The unread count opens :notifications; the problems, :messages");
    entry("drag", "Select from the press to the pointer: VISUAL in the editor or the rendered document (then y, d, c)");
    entry("double / triple click", "Select the word / the line (VISUAL LINE) under the pointer");
    entry("click in the editor", "Place the cursor there (VISUAL ends; INSERT keeps typing there)");
    entry("wheel", "Scroll the pane under the pointer, whichever has the keyboard; a list moves one row a notch");
    entry(
      "in a dialog",
      "A click highlights a row, a double click picks it; checkbox and radio rows toggle on each click; outside does nothing",
    );
    entry("Shift-drag", "The terminal's native selection while the mouse is on (Option-drag in some macOS terminals)");
    blank();
    heading("COMMANDS");
    for (const c of commandHelp(this.session.commands)) entry([c.usage, ...c.names].join("  "), c.description);
    entry(":<id>", "Jump to a task by id, for example :42");
    blank();
    heading("KEYS · NORMAL");
    for (const action of NORMAL_ACTIONS) {
      const labels = keys.bindings.normal[action].map(k => k.label);
      if (labels.length > 0) entry(labels.join(" "), KEY_ACTIONS[action].description, !AVAILABLE_ACTIONS.has(action));
    }
    entry("5j (a count first)", "Counts repeat a motion");
    entry("0 (no count)", "Line start: the editor cursor, or a VISUAL selection");
    entry("Enter", "From the task list: focus the document");
    entry("Enter (reading)", "The document's links and references (:links); Enter follows one");
    entry("Enter (a task panel)", "Activity: expand or collapse the update; Related: open the task");
    entry("q", "Reminds you that :q quits");
    entry("Esc  Ctrl-C", "Cancel pending input, close this view; never quits");
    blank();
    heading(`KEYS · LEADER ${leaderLabel(keys)}`);
    for (const action of NORMAL_ACTIONS) {
      const labels = actionKeyLabels(keys, action).slice(keys.bindings.normal[action].length);
      if (labels.length > 0) entry(labels.join(" "), KEY_ACTIONS[action].description, !AVAILABLE_ACTIONS.has(action));
    }
    blank();
    heading("KEYS · VISUAL");
    for (const action of VISUAL_ACTIONS) {
      const labels = visualKeyLabels(keys, action);
      if (labels.length > 0) entry(labels.join(" "), VISUAL_KEY_ACTIONS[action].description);
    }
    entry("motions", "The NORMAL motions and counts extend the selection (0 is the line start)");
    entry("Esc  Ctrl-C", "Back to NORMAL (the selection ends; the cursor stays)");
    blank();
    heading("KEYS · INSERT");
    for (const action of INSERT_ACTIONS) {
      const labels = insertKeyLabels(keys, action);
      if (labels.length > 0) entry(labels.join(" "), INSERT_KEY_ACTIONS[action].description);
    }
    entry("Tab  Shift-Tab", "Indent / outdent the line or the selected lines");
    entry("Enter", "A new line (continuing a Markdown list); in the title, save it");
    entry("Shift-arrows", "Select; typing or a paste replaces the selection");
    entry("Esc", "Back to NORMAL (the body saves by autosave or :w; the title saves now)");
    blank();
    const later = NORMAL_ACTIONS.some(action => !AVAILABLE_ACTIONS.has(action));
    out.push({ segs: [seg("dim@bg", `${later ? "(later): not in this build yet. " : ""}Keys are set in tui.toml.`)] });
    return out;
  }

  #messageLines(width: number): Seg[][] {
    const messages = this.session.messages;
    const out: Seg[][] = [[seg("accent@bg", `MESSAGES · ${messages.length} (q or Esc closes)`, { bold: true })], []];
    if (messages.length === 0) out.push([seg("muted@bg", "No messages.")]);
    for (const m of messages) {
      const label = `[${m.level}] `;
      const pair: ContrastPair = m.level === "error" ? "danger@bg" : m.level === "warn" ? "warn@bg" : "muted@bg";
      const lines = wrapTextWithAnsi(esc(m.text), Math.max(1, width - label.length));
      for (const [i, line] of lines.entries()) {
        out.push([seg(pair, i === 0 ? label : " ".repeat(label.length)), seg("text@bg", line)]);
      }
    }
    return out;
  }

  #statusLine(theme: ResolvedTheme, width: number, y: number): string {
    const s = this.session;
    const mode = s.keys.mode();
    const pending = s.keys.pending();
    const suffix = pending.leader ? ` ${leaderLabel(s.keys.keys)}` : pending.count !== null ? ` ${pending.count}` : "";
    const sep = seg("dim@panel", " │ ");
    const connection: Seg =
      s.connection === "live"
        ? s.resyncing
          ? seg("warn@panel", "◌ resyncing")
          : seg("info@panel", "● live")
        : s.connection === "stale"
          ? seg("danger@panel", "○ stale · reconnecting")
          : seg("warn@panel", "◌ connecting");
    const task = s.selectedTask();
    const draft = task === null ? null : (s.documentOf(task.id)?.draft ?? null);
    const unsaved = s.unsavedDrafts();
    // Kept drafts (deleted tasks, a replaced database) always count: they are never the current document.
    const elsewhere = unsaved.filter(d => d.orphaned || d.taskId !== task?.id).length;
    // Without a draft, the current document's unsaved input is the keys typed before its baseline (review C4).
    const typed = draft === null ? unsaved.filter(d => !d.orphaned && d.taskId === task?.id) : [];
    const saveState: Seg = s.writing
      ? seg("warn@panel", "◌ saving…")
      : draft !== null
        ? SAVE_STATE[draft.saveState]
        : typed.some(d => d.state === "failed")
          ? NOT_LOADED
          : SAVE_STATE[typed.length > 0 ? "pending" : "saved"];
    const unsent = this.#activity.unsent().length;
    // S4: comfortable keeps one blank cell at each end: before the mode badge and after the last badge.
    const margin = s.density === "comfortable" ? 1 : 0;
    const left: Seg[] = [
      ...(margin > 0 ? [seg("text@panel", " ".repeat(margin))] : []),
      seg(MODE_PAIR[mode], ` ${mode}${suffix} `, { bold: true }),
      sep,
      seg("muted@panel", s.dialog?.label ?? (s.view === "workspace" ? s.focus : s.view)),
      sep,
      saveState,
      ...(elsewhere > 0 ? [seg("warn@panel", ` +${elsewhere} unsaved`)] : []),
      ...(unsent > 0 ? [seg("warn@panel", ` ✎ ${unsent} unsent`)] : []),
      sep,
      connection,
    ];
    if (s.prompt !== null) {
      left.push(
        sep,
        seg(
          "muted@panel",
          s.prompt.kind === ":"
            ? "Tab completes · Up/Down history · Enter runs · Esc cancels"
            : s.searchTarget === "document"
              ? "Enter searches the document · Esc cancels · empty clears"
              : s.searchTarget === "help"
                ? "Enter searches the help · Esc cancels · empty clears"
                : "Enter applies · Esc cancels · empty clears",
        ),
      );
    } else if (s.status !== null) {
      left.push(sep, seg(LEVEL_PAIR[s.status.level], `${LEVEL_PREFIX[s.status.level]}${esc(s.status.text)}`));
    }
    const unread = this.#notifications.unread();
    const right: Seg[] = [];
    const targets: ("notifications" | "messages")[] = [];
    // The unread badge: a glyph, the count and a word (never color alone). A click opens the list.
    if (unread > 0) {
      right.push(seg("info@panel", ` ${UNREAD_MARK} ${unread} unread `, { bold: true }));
      targets.push("notifications");
    }
    if (s.warnings > 0) {
      right.push(
        seg("warn@panel", ` ! ${s.warnings} problem${s.warnings === 1 ? "" : "s"} · :messages `, { bold: true }),
      );
      targets.push("messages");
    }
    const rightWidth = Math.min(
      Math.max(0, width - margin),
      right.reduce((n, x) => n + displayWidth(x.text), 0),
    );
    let at = width - margin - rightWidth;
    right.forEach((part, i) => {
      const cells = displayWidth(part.text);
      const command = targets[i];
      if (command !== undefined && at >= 0) this.#layout.statusHits.push({ x: at, y, width: cells, command });
      at += cells;
    });
    return (
      paint(theme, left, width - margin - rightWidth, "text@panel") +
      (rightWidth > 0 ? paint(theme, right, rightWidth, "text@panel") : "") +
      (margin > 0 ? style(theme, "text@panel", " ".repeat(margin)) : "")
    );
  }

  #hintLine(theme: ResolvedTheme, width: number): string {
    const s = this.session;
    const dialog = s.dialog;
    if (dialog !== null) {
      // The dialog's own hints (joined by " · "), then the way to its commands: dropped whole too.
      const own = dialog.hints().split(" · ");
      return this.#hints(theme, width, [...own.map(part => [" · ", part] as const), ["  ·  ", ": commands"]]);
    }
    const keys = s.keys.keys;
    const key = (action: NormalAction): string | undefined => actionKeyLabels(keys, action)[0];
    const pair = (a: string | undefined, b: string | undefined) => (a && b ? `${a}/${b}` : (a ?? b));
    const hint = (k: string | undefined, text: string) => (k === undefined ? undefined : `${k} ${text}`);
    const save = insertKeyLabels(keys, "save")[0];
    const insert = s.insertTarget;
    const editor = this.#activeEditor() !== null;
    const onTitle = s.view === "workspace" && s.focus === "document" && s.documentTarget === "title";
    const visual = this.#visual === null ? null : this.#visualKind();
    const op = (action: VisualAction): string | undefined => visualKeyLabels(keys, action)[0];
    const parts =
      visual !== null
        ? this.#visual?.surface === "reader"
          ? [
              visual === "line" ? "VISUAL LINE · rendered rows" : "VISUAL · rendered text",
              hint(op("yank"), "copies"),
              hint(op("other_end"), "other end"),
              "motions extend",
              "Esc ends",
            ]
          : [
              visual === "line" ? "VISUAL LINE · whole lines" : "VISUAL · characters",
              hint(op("yank"), "yanks"),
              hint(op("delete"), "deletes"),
              hint(op("change"), "changes"),
              hint(pair(op("indent"), op("outdent")), "indent"),
              hint(op("other_end"), "other end"),
              "Esc ends",
            ]
        : insert !== null && s.keys.mode() === "INSERT"
          ? insert.target === "title"
            ? ["INSERT · the title", "Enter or Esc saves it", hint(save, "writes"), "pasted lines join with spaces"]
            : [
                "INSERT · every key is text",
                "Esc for NORMAL (autosave keeps saving)",
                "Tab/Shift-Tab indent",
                hint(save, "writes (:w)"),
              ]
          : s.view === "workspace" && editor
            ? [
                ": commands",
                hint(key("insert"), "insert"),
                hint(pair(key("undo"), key("redo")), "undo/redo"),
                hint(pair(key("down"), key("up")), "move"),
                ":w write",
                ":q quit",
                hint(key("next_pane"), "focus"),
              ]
            : onTitle
              ? [
                  ": commands",
                  hint(key("insert"), "or Enter edits the title"),
                  hint(key("down"), "back to the body"),
                  ":q quit",
                ]
              : this.#inPanel()
                ? [
                    ": commands",
                    hint(pair(key("down"), key("up")), "move"),
                    s.panel === "activity" ? "Enter expands" : s.panel === "related" ? "Enter opens" : undefined,
                    hint(key("post"), "posts an update"),
                    hint(pair(key("previous_panel"), key("next_panel")), "panels"),
                    ":q quit",
                    hint(key("next_pane"), "focus"),
                  ]
                : s.view === "workspace" && s.readerFocused() && this.#readerShown()
                  ? [
                      ": commands",
                      "/ searches the document",
                      this.#reader.query === ""
                        ? undefined
                        : hint(pair(key("next_match"), key("previous_match")), "matches"),
                      this.#reader.headings().length === 0
                        ? undefined
                        : hint(pair(key("previous_heading"), key("next_heading")), "headings"),
                      this.#reader.links().length === 0 ? undefined : "Enter links",
                      ":q quit",
                      hint(pair(key("down"), key("up")), "scroll"),
                      hint(key("insert"), "edits"),
                      hint(key("next_pane"), "focus"),
                    ]
                  : s.view === "workspace"
                    ? [
                        ": commands",
                        "/ search",
                        hint(key("filters"), "filters"),
                        hint(key("sort"), "sort"),
                        s.query === "" ? undefined : hint(pair(key("next_match"), key("previous_match")), "results"),
                        hint(key("help"), "help"),
                        ":q quit",
                        hint(pair(key("down"), key("up")), "move"),
                        hint(key("insert"), "edits"),
                        hint(key("next_pane"), "focus"),
                        hint(key("toggle_tasks"), "task list"),
                      ]
                    : s.view === "commands"
                      ? [
                          hint(pair(key("down"), key("up")), "move"),
                          "Enter picks",
                          "/ searches",
                          "q/Esc close",
                          ": commands",
                        ]
                      : [
                          hint(pair(key("down"), key("up")), "scroll"),
                          hint(pair(key("top"), key("bottom")), "top/bottom"),
                          s.view === "help" ? "/ searches" : undefined,
                          s.view === "help" && this.#help.query !== ""
                            ? hint(pair(key("next_match"), key("previous_match")), "matches")
                            : undefined,
                          "q/Esc close",
                          ": commands",
                        ];
    const shown = parts.filter((p): p is string => p !== undefined);
    return this.#hints(
      theme,
      width,
      shown.map(part => ["  ·  ", part] as const),
    );
  }

  /**
   * The hint line: the leading hints that fit WHOLE (R7: the rest are
   * dropped from the end, never cut mid-word), each after its separator,
   * one cell in (two, with a blank last cell, when comfortable: S4).
   */
  #hints(theme: ResolvedTheme, width: number, parts: readonly (readonly [separator: string, hint: string])[]): string {
    const comfortable = this.session.density === "comfortable";
    const lead = comfortable ? "  " : " ";
    const room = Math.max(0, width - lead.length - (comfortable ? 1 : 0));
    let text = "";
    for (const [separator, hint] of parts) {
      const next = text === "" ? esc(hint) : `${text}${separator}${esc(hint)}`;
      if (displayWidth(next) > room) break;
      text = next;
    }
    return paint(theme, [seg("dim@panel", `${lead}${text}`)], width, "text@panel");
  }

  /** The completion candidates of the open prompt: a window around the one shown, with what each names. */
  #suggestionRows(theme: ResolvedTheme, width: number): string[] {
    const p = this.session.prompt;
    const completion = p?.completion ?? null;
    if (p === null || completion === null) return [];
    const { candidates, index } = completion;
    const shown = Math.min(SUGGESTION_ROWS, candidates.length);
    const start = Math.max(0, Math.min(index - Math.floor(shown / 2), candidates.length - shown));
    const labelWidth = Math.min(
      36,
      Math.max(...candidates.slice(start, start + shown).map(c => displayWidth(esc(`${p.kind}${c}`)))),
    );
    return candidates.slice(start, start + shown).map((candidate, i) => {
      const chosen = start + i === index;
      const label = fit(esc(`${p.kind}${candidate}`), labelWidth);
      const pad = " ".repeat(Math.max(0, labelWidth - displayWidth(label)));
      const about = p.kind === ":" ? (this.session.describeCandidate(candidate) ?? "") : "";
      const position = chosen && candidates.length > shown ? `  ${index + 1}/${candidates.length}` : "";
      return chosen
        ? paint(
            theme,
            [
              seg("accent@selection", "▌"),
              seg("text@selection", `${label}${pad}  `, { bold: true }),
              seg("muted@selection", `${esc(about)}${position}`),
            ],
            width,
            "text@selection",
          )
        : paint(
            theme,
            [seg("text@raised", ` ${label}${pad}  `), seg("muted@raised", esc(about))],
            width,
            "text@raised",
          );
    });
  }

  #promptLine(theme: ResolvedTheme, width: number): string {
    const p = this.session.prompt;
    if (p === null) return paint(theme, [], width, "text@panel");
    const rest = p.text.slice(p.cursor);
    const first = segmenter.segment(rest)[Symbol.iterator]().next();
    const under = first.done ? " " : first.value.segment;
    const cursor = first.done ? " " : esc(under);
    const after = esc(first.done ? "" : rest.slice(under.length));
    let before = esc(p.text.slice(0, p.cursor));
    const room = Math.max(1, width - 1 - displayWidth(cursor));
    // Keep the cursor visible: drop graphemes from the start of a long line.
    while (displayWidth(before) > room - 1 && before !== "") {
      const lead = segmenter.segment(before)[Symbol.iterator]().next();
      before = lead.done ? "" : before.slice(lead.value.segment.length);
    }
    const used = 1 + displayWidth(before) + displayWidth(cursor);
    const tail = fit(after, Math.max(0, width - used));
    const padding = width - used - displayWidth(tail);
    return (
      style(theme, "accent@panel", p.kind, { bold: true }) +
      style(theme, "text@panel", before) +
      CURSOR_MARKER +
      style(theme, "text@panel", cursor, { inverse: true }) +
      style(theme, "text@panel", tail) +
      (padding > 0 ? style(theme, "text@panel", " ".repeat(padding)) : "")
    );
  }

  #resizeScreen(theme: ResolvedTheme, width: number, height: number): string[] {
    const text = [
      `cortex: this terminal is ${width}x${height}; the workspace needs at least ${MIN_COLUMNS}x${MIN_ROWS}.`,
      "Enlarge the window, or type :q to quit.",
    ];
    const lines: string[] = [];
    for (const t of text) {
      for (const part of wrapTextWithAnsi(esc(t), Math.max(1, width - 1))) {
        lines.push(paint(theme, [seg("text@bg", " "), seg("text@bg", part)], width, "text@bg"));
      }
    }
    const bottom = this.session.prompt !== null ? this.#promptLine(theme, width) : null;
    const room = bottom === null ? height : height - 1;
    const out = lines.slice(0, Math.max(0, room));
    while (out.length < room) out.push(paint(theme, [], width, "text@bg"));
    if (bottom !== null && height > 0) out.push(bottom);
    return out.slice(0, Math.max(0, height));
  }
}

// ---------- runTui ----------

export interface RunTuiOptions {
  /** `cortex tui <id>`: the task to open. */
  taskId?: number;
  /** `--heading <slug>`: a heading of that task to reveal. */
  heading?: string;
  /** `--profile <name>`: whose view state to use (default "default"). */
  profile?: string;
  /** `--theme <name>`: this session's theme. */
  theme?: string;
}

/** A problem found before the terminal was taken over: printed as-is, exit non-zero. */
export class TuiStartError extends Error {}

const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const;

/**
 * Run the terminal workspace on this process's terminal until `:q` (0) or a
 * termination signal (128 + its number); resolves with the exit code once the
 * terminal is restored. Connects to (or starts, headless, over IPC only) the
 * daemon of this database; quitting leaves that daemon running.
 */
export async function runTui(options: RunTuiOptions = {}): Promise<number> {
  const { config, problems: configProblems } = loadConfig(tuiConfigPath());
  const preferences = openPreferences(tuiStatePath(options.profile ?? DEFAULT_PROFILE));
  const identity = await ensureDaemon({ databasePath: dbPath() });
  const client = createClient(identity.endpoint, { instanceId: identity.instanceId });
  const snapshot = await client.workspace();
  if (options.taskId !== undefined && !snapshot.tasks.some(t => t.id === options.taskId)) {
    throw new TuiStartError(`no task @${options.taskId} in ${identity.databasePath}`);
  }

  let shell: Shell | null = null;
  let finish: (code: number) => void = () => {};
  const finished = new Promise<number>(resolve => {
    finish = resolve;
  });
  const abort = new AbortController();
  const terminal = new ProcessTerminal();
  let closing = false;
  const shutdown = async (code: number, flushDrafts = false): Promise<void> => {
    if (closing) return;
    closing = true;
    if (flushDrafts) {
      // SIGTERM/SIGHUP/SIGINT: a bounded attempt to save every draft BEFORE the terminal is restored.
      await Promise.race([session.flushDrafts().catch(() => {}), Bun.sleep(SIGNAL_FLUSH_MS)]);
    }
    const deadline = setTimeout(() => finish(code), SHUTDOWN_DEADLINE_MS);
    abort.abort(); // this TUI's live connection, never the daemon
    session.savePreferences();
    session.dispose();
    try {
      await Promise.race([terminal.drainInput(150, 20), Bun.sleep(500)]);
    } catch {
      /* the terminal may already be gone (SIGHUP) */
    }
    clearTimeout(deadline);
    finish(code);
  };

  const session: TuiSession = new TuiSession({
    client,
    identity,
    keys: config.keys,
    preferences,
    // tui.toml's density; the profile's saved :density choice wins (the theme's precedence).
    density: config.density,
    connect: instanceId => createClient(identity.endpoint, { instanceId }),
    initialTask: options.taskId ?? null,
    heading: options.heading ?? null,
    problems: [...configProblems.map(configProblem), ...preferences.problems().map(preferenceProblem)],
    onChange: () => shell?.requestRender(),
    onQuit: () => void shutdown(0),
  });
  session.applySnapshot(snapshot);
  shell = new Shell({
    terminal,
    session,
    config,
    cliTheme: options.theme ?? null,
    savedTheme: preferences.view().theme,
    env: { NO_COLOR: process.env.NO_COLOR, COLORTERM: process.env.COLORTERM, TERM: process.env.TERM },
  });
  const active = shell;

  // While an external program has the terminal, Ctrl-C's SIGINT (sent to the
  // whole foreground process group) is that program's, as with system(3).
  const signalHandlers = (Object.keys(SIGNAL_EXIT_CODES) as (keyof typeof SIGNAL_EXIT_CODES)[]).map(
    signal =>
      [
        signal,
        () => {
          if (signal === "SIGINT" && active.handingOff) return;
          void shutdown(SIGNAL_EXIT_CODES[signal], true);
        },
      ] as const,
  );
  const onExit = (): void => active.stop();
  const onFatal = (err: unknown): void => {
    active.stop();
    console.error("cortex tui crashed:", err);
    process.exit(1);
  };
  const ignoreStreamError = (): void => {};
  for (const [signal, handler] of signalHandlers) process.on(signal, handler);
  process.on("exit", onExit);
  process.on("uncaughtException", onFatal);
  process.on("unhandledRejection", onFatal);
  process.stdout.on("error", ignoreStreamError);
  try {
    await active.start();
    // Pending migrations become a persistent warning in :messages.
    void reportPendingMigrations(session);
    subscribeChanges(
      identity.endpoint,
      event => session.receive(event),
      state => session.setConnection(state),
      abort.signal,
    ).catch(err => session.notify("error", `Live updates stopped: ${(err as Error).message}`));
    return await finished;
  } finally {
    abort.abort();
    session.dispose();
    active.stop();
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    process.off("exit", onExit);
    process.off("uncaughtException", onFatal);
    process.off("unhandledRejection", onFatal);
  }
}
