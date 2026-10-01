// Terminal key model: the modes, counts, the leader, single-key bindings and
// tui.toml key validation.
//
// - NORMAL (default) never inserts text: keys are actions, counts (`5j`),
//   the leader (`;` + one key) or pass-through keys for the focused pane
//   (a `0` with no count pending is one: the line start). INSERT treats
//   printable input as text until Esc. COMMAND (`:`) and SEARCH (`/`) are
//   one-line prompts: text, Enter submits, Esc cancels.
// - VISUAL (`v`) and VISUAL LINE (`V`, vi's visual modes; the shell enters
//   them) never insert text either: counts and the NORMAL table's motions
//   extend the selection, `[keys.visual]` holds the operators (read first,
//   so `c` changes there while it posts in NORMAL), Esc/Ctrl-C return to
//   NORMAL and `:`/`/` open their prompts. The leader is not active there.
// - Validation normalizes every configured key to its Kitty identity AND the
//   byte sequence(s) a legacy terminal sends for it, then rejects unknown
//   actions, duplicates (same identity or any shared legacy byte, e.g.
//   ctrl+-/ctrl+_), keys that shadow the leader, reserved keys and their
//   aliases, ctrl+i/ctrl+h (Tab/Backspace) and every function key. A section
//   with any problem keeps ALL of its defaults (no partial application).
// - Function keys are never bound, are ignored at input and never hinted.
// - A merged ESC+printable pair (legacy Alt, or a fast `Esc :` that pi-tui's
//   10 ms ESC timeout delivered as one sequence) is Esc then the key, like
//   terminal Vim, unless that Alt key is configured, or it is an Alt word
//   motion inside a text field.

import { decodeKittyPrintable, isKeyRelease, matchesKey, parseKey } from "@earendil-works/pi-tui";

export type KeyMode = "NORMAL" | "INSERT" | "COMMAND" | "SEARCH" | "VISUAL" | "VISUAL LINE";

/** Actions bindable in `[keys.normal]` and `[keys.leader]` (one namespace). */
export const NORMAL_ACTIONS = [
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
  "next_panel",
  "previous_panel",
  "next_heading",
  "previous_heading",
  "next_match",
  "previous_match",
  "insert",
  "post",
  "undo",
  "redo",
  "visual",
  "visual_line",
  "paste_after",
  "paste_before",
  "help",
  "commands",
  "back",
  "forward",
  "suspend",
  "focus_tasks",
  "focus_document",
  "toggle_tasks",
  "toggle_done",
  "read",
  "edit",
  "split",
  "tags",
  "status",
  "sort",
  "filters",
  "clear_filters",
] as const;
export type NormalAction = (typeof NORMAL_ACTIONS)[number];

/** Actions bindable in `[keys.insert]`: ctrl/alt shortcuts only. */
export const INSERT_ACTIONS = ["save"] as const;
export type InsertAction = (typeof INSERT_ACTIONS)[number];

/** Operators bindable in `[keys.visual]` (VISUAL and VISUAL LINE only). */
export const VISUAL_ACTIONS = ["yank", "delete", "change", "indent", "outdent", "other_end"] as const;
export type VisualAction = (typeof VISUAL_ACTIONS)[number];

export type KeyTable = "normal" | "leader" | "insert" | "visual";

export const isNormalAction = (action: string): action is NormalAction =>
  (NORMAL_ACTIONS as readonly string[]).includes(action);
export const isVisualAction = (action: string): action is VisualAction =>
  (VISUAL_ACTIONS as readonly string[]).includes(action);

/** Help text per action; the key table is a single source for help and hints. */
export const KEY_ACTIONS: Readonly<Record<NormalAction, { readonly description: string }>> = {
  down: { description: "Move down: the task list, the document or the editor cursor" },
  up: { description: "Move up: the task list, the document or the editor cursor" },
  left: { description: "Editor cursor left; otherwise focus the task list" },
  right: { description: "Editor cursor right; otherwise focus the document" },
  half_down: { description: "Half a page down" },
  half_up: { description: "Half a page up" },
  top: { description: "Go to the top" },
  bottom: { description: "Go to the bottom" },
  word_forward: { description: "Editor or selection cursor: the start of the next word" },
  word_backward: { description: "Editor or selection cursor: the start of the previous word" },
  word_end: { description: "Editor or selection cursor: the end of the word" },
  line_end: { description: "Editor or selection cursor: the end of the line (0 is its start)" },
  next_pane: { description: "Focus the next pane" },
  previous_pane: { description: "Focus the previous pane" },
  next_panel: { description: "Next task panel" },
  previous_panel: { description: "Previous task panel" },
  next_heading: { description: "Next heading" },
  previous_heading: { description: "Previous heading" },
  next_match: { description: "Next search result" },
  previous_match: { description: "Previous search result" },
  insert: { description: "INSERT mode; from Read, shows Edit for this task" },
  post: { description: "Post an update" },
  undo: { description: "Undo in the visible editor" },
  redo: { description: "Redo in the visible editor" },
  visual: {
    description:
      "VISUAL: select characters from the cursor (the editor or the rendered document); again or Esc ends it",
  },
  visual_line: { description: "VISUAL LINE: select whole lines (rendered rows while reading); again or Esc ends it" },
  paste_after: { description: "Paste the last yank or delete after the cursor (whole lines: below this line)" },
  paste_before: { description: "Paste the last yank or delete before the cursor (whole lines: above this line)" },
  help: { description: "Help: modes, commands and the configured keys (/ searches it, n/N step)" },
  commands: { description: "Searchable command reference (:commands)" },
  back: { description: "Go back (:back)" },
  forward: { description: "Go forward (:forward)" },
  suspend: { description: "Suspend to the shell (:suspend)" },
  focus_tasks: { description: "Focus the task list" },
  focus_document: { description: "Focus the document" },
  toggle_tasks: { description: "Show or hide the task list for this session (:config tasks sets the default)" },
  toggle_done: { description: "Show or hide the done tasks for this session (:config done sets the default)" },
  read: { description: "Read mode (:read)" },
  edit: { description: "Edit mode (:edit)" },
  split: { description: "Split mode (:split)" },
  tags: { description: "Edit this task's tags" },
  status: {
    description: "Set this task's status in a picker (bare :status): d o r b x set one, Enter the next step",
  },
  sort: { description: "Sort and group the task list (:sort)" },
  filters: {
    description: "Pick filters: status, lane, tags, untagged and include-done (the list follows each toggle)",
  },
  clear_filters: { description: "Clear the search and every filter (:clear; include-done stays)" },
};

export const INSERT_KEY_ACTIONS: Readonly<Record<InsertAction, { readonly description: string }>> = {
  save: { description: "Write the draft (:w)" },
};

export const VISUAL_KEY_ACTIONS: Readonly<Record<VisualAction, { readonly description: string }>> = {
  yank: { description: "Copy the selection: the terminal clipboard (OSC 52) and the paste register (p)" },
  delete: { description: "Delete the selection into the paste register (the editor)" },
  change: { description: "Delete the selection, then INSERT there (the editor)" },
  indent: { description: "Indent the selected lines (the editor)" },
  outdent: { description: "Outdent the selected lines (the editor)" },
  other_end: { description: "Move the cursor to the other end of the selection" },
};

/** Default leader. The default NORMAL table never binds it. */
export const DEFAULT_LEADER = ";";

type RawTable<A extends string> = Readonly<Partial<Record<A, readonly string[]>>>;

// The default key table. `forward` has no default key: legacy terminals send
// ctrl+i as Tab. `0` (no count pending) is the fixed line-start key: digits
// are reserved for counts.
const DEFAULT_TABLES: {
  readonly normal: RawTable<NormalAction>;
  readonly leader: RawTable<NormalAction>;
  readonly insert: RawTable<InsertAction>;
  readonly visual: RawTable<VisualAction>;
} = {
  normal: {
    down: ["j", "down"],
    up: ["k", "up"],
    left: ["h", "left"],
    right: ["l", "right"],
    half_down: ["ctrl+d"],
    half_up: ["ctrl+u"],
    top: ["g"],
    bottom: ["G"],
    word_forward: ["w"],
    word_backward: ["b"],
    word_end: ["e"],
    line_end: ["$"],
    next_pane: ["tab"],
    previous_pane: ["shift+tab"],
    next_panel: ["]"],
    previous_panel: ["["],
    next_heading: ["}"],
    previous_heading: ["{"],
    next_match: ["n"],
    previous_match: ["N"],
    insert: ["i"],
    post: ["c"],
    undo: ["u"],
    redo: ["ctrl+r"],
    visual: ["v"],
    visual_line: ["V"],
    paste_after: ["p"],
    paste_before: ["P"],
    help: ["?"],
    commands: ["ctrl+p"],
    back: ["ctrl+o"],
    suspend: ["ctrl+z"],
    filters: ["f"],
    clear_filters: ["F"],
  },
  leader: {
    focus_tasks: ["h"],
    focus_document: ["l"],
    toggle_tasks: ["e"],
    read: ["r"],
    edit: ["i"],
    split: ["s"],
    post: ["c"],
    tags: ["t"],
    // m for mark (;s is split): the status picker's own letters then pick one (;m x marks it done).
    status: ["m"],
    toggle_done: ["d"],
    sort: ["o"],
  },
  insert: { save: ["ctrl+s"] },
  visual: { yank: ["y"], delete: ["d", "x"], change: ["c"], indent: [">"], outdent: ["<"], other_end: ["o"] },
};

// ---------- key names: Kitty identity + legacy bytes ----------

/** One key, normalized. `id` is the canonical Kitty identity (`ctrl+alt+shift+<base>`). */
export interface ParsedKeyName {
  readonly id: string;
  /** Every byte sequence a legacy (non-Kitty, non-modifyOtherKeys) terminal may send for it. */
  readonly legacy: readonly string[];
  /** Display form for help and hints, e.g. `Ctrl-d`, `G`, `Shift-Tab`. */
  readonly label: string;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  /** Canonical base: one printable ASCII character (letters lowercase) or a named key. */
  readonly base: string;
}

/** A validated binding: its normalized key plus the name as written in tui.toml. */
export interface KeyBinding extends ParsedKeyName {
  readonly name: string;
}

export type ParseKeyNameResult = { ok: true; key: ParsedKeyName } | { ok: false; reason: string };

const ESC = "\x1b";

const NAMED_KEYS: Readonly<Record<string, string>> = {
  escape: "escape",
  esc: "escape",
  enter: "enter",
  return: "enter",
  tab: "tab",
  space: "space",
  backspace: "backspace",
  delete: "delete",
  insert: "insert",
  home: "home",
  end: "end",
  pageup: "pageUp",
  pagedown: "pageDown",
  up: "up",
  down: "down",
  left: "left",
  right: "right",
};

const NAMED_LABELS: Readonly<Record<string, string>> = {
  escape: "Esc",
  enter: "Enter",
  tab: "Tab",
  space: "Space",
  backspace: "Backspace",
  delete: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  pageUp: "PageUp",
  pageDown: "PageDown",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
};

const FUNCTION_KEY_NAME = /^f(?:[1-9]|[12][0-9]|3[0-5])$/i;

// Kitty's "legacy ctrl mapping of ASCII keys" table (a superset of VT100
// table 3-5), plus xterm's ctrl+- = 0x1f. Other ASCII keys are sent
// untouched by ctrl, so ctrl+; is `;` and ctrl+1 is `1` in a legacy terminal.
const CTRL_BYTES: Readonly<Record<string, readonly number[]>> = {
  "@": [0],
  "2": [0],
  "[": [27],
  "3": [27],
  "\\": [28],
  "4": [28],
  "]": [29],
  "5": [29],
  "^": [30],
  "6": [30],
  "~": [30],
  _: [31],
  "/": [31],
  "7": [31],
  "-": [31, 45],
  "?": [127],
  "8": [127],
};

const ARROW_FINAL: Readonly<Record<string, string>> = { up: "A", down: "B", right: "C", left: "D" };
// pi-tui reads these legacy Meta pairs as alt+arrows (macOS Option-as-Meta word motions).
const ALT_ARROW_ALIASES: Readonly<Record<string, readonly string[]>> = {
  up: ["\x1bp"],
  down: ["\x1bn"],
  right: ["\x1bf", "\x1bF"],
  left: ["\x1bb", "\x1bB"],
};
const TILDE_KEYS: Readonly<Record<string, number>> = { insert: 2, delete: 3, pageUp: 5, pageDown: 6 };

const isLetter = (c: string): boolean => c.length === 1 && c >= "a" && c <= "z";

function legacySequences(base: string, ctrl: boolean, alt: boolean, shift: boolean): string[] {
  const mod = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0);
  const withAlt = (cores: string[]): string[] => (alt ? cores.map(c => ESC + c) : cores);
  if (base.length === 1) {
    if (ctrl) {
      if (isLetter(base)) return withAlt([String.fromCharCode(base.charCodeAt(0) & 0x1f)]);
      const bytes = CTRL_BYTES[base];
      return withAlt(bytes ? bytes.map(b => String.fromCharCode(b)) : [base]);
    }
    return withAlt([shift && isLetter(base) ? base.toUpperCase() : base]);
  }
  switch (base) {
    case "space":
      return withAlt([ctrl ? "\x00" : " "]);
    case "tab":
      return withAlt([shift ? "\x1b[Z" : "\t"]);
    case "enter":
      return alt ? ["\x1b\r"] : ctrl || shift ? ["\r"] : ["\r", "\x1bOM"];
    case "backspace":
      return withAlt(ctrl ? ["\x08"] : shift ? ["\x7f"] : ["\x7f", "\x08"]);
    case "escape":
      return withAlt([ESC]);
    case "up":
    case "down":
    case "right":
    case "left": {
      const f = ARROW_FINAL[base];
      if (mod === 1) return [`\x1b[${f}`, `\x1bO${f}`];
      const out = [`\x1b[1;${mod}${f}`];
      if (mod === 2) out.push(`\x1b[${f.toLowerCase()}`);
      if (mod === 5) out.push(`\x1bO${f.toLowerCase()}`);
      if (mod === 3) out.push(...ALT_ARROW_ALIASES[base]);
      return out;
    }
    case "home":
    case "end": {
      const [f, n] = base === "home" ? ["H", 7] : ["F", 8];
      if (mod === 1) return [`\x1b[${f}`, `\x1bO${f}`, `\x1b[${base === "home" ? 1 : 4}~`, `\x1b[${n}~`];
      const out = [`\x1b[1;${mod}${f}`];
      if (mod === 2) out.push(`\x1b[${n}$`);
      if (mod === 5) out.push(`\x1b[${n}^`);
      return out;
    }
    default: {
      const n = TILDE_KEYS[base];
      if (mod === 1) return base === "pageUp" || base === "pageDown" ? [`\x1b[${n}~`, `\x1b[[${n}~`] : [`\x1b[${n}~`];
      const out = [`\x1b[${n};${mod}~`];
      if (mod === 2) out.push(`\x1b[${n}$`);
      if (mod === 5) out.push(`\x1b[${n}^`);
      return out;
    }
  }
}

function labelOf(base: string, ctrl: boolean, alt: boolean, shift: boolean): string {
  let shown = NAMED_LABELS[base] ?? base;
  let showShift = shift;
  if (isLetter(base) && shift && !ctrl) {
    shown = base.toUpperCase();
    showShift = false;
  }
  const mods: string[] = [];
  if (ctrl) mods.push("Ctrl");
  if (alt) mods.push("Alt");
  if (showShift) mods.push("Shift");
  return [...mods, shown].join("-");
}

function split(name: string): { mods: string[]; base: string } {
  if (name === "+") return { mods: [], base: "+" };
  if (name.length > 2 && name.endsWith("++")) return { mods: name.slice(0, -2).split("+"), base: "+" };
  const parts = name.split("+");
  const base = parts.pop() ?? "";
  return { mods: parts, base };
}

/**
 * Parse one key name as written in tui.toml: `j`, `G`, `?`, `space`, `down`,
 * `pageDown`, `ctrl+d`, `alt+x`, `shift+tab`, `ctrl+shift+p`. Modifiers are
 * ctrl, alt and shift, case-insensitively. Without ctrl an uppercase letter
 * means shift (`G` = `shift+g`); with ctrl its case is ignored (`CTRL+D` =
 * `ctrl+d`). `shift+<symbol or digit>` is rejected as layout-dependent (bind
 * the character it types). Function keys are recognized only to be refused.
 */
export function parseKeyName(name: string): ParseKeyNameResult {
  const quoted = JSON.stringify(name);
  const notOne: ParseKeyNameResult = {
    ok: false,
    reason: `${quoted} is not a single key name (for example "j", "G", "ctrl+d", "shift+tab", "down")`,
  };
  if (typeof name !== "string" || name.length === 0 || name.length > 32) return notOne;
  const { mods, base: rawBase } = split(name);
  if (FUNCTION_KEY_NAME.test(rawBase)) {
    return { ok: false, reason: `${quoted} is a function key; function keys are never bound (use a command instead)` };
  }
  let ctrl = false;
  let alt = false;
  let shift = false;
  for (const raw of mods) {
    const mod = raw.toLowerCase();
    if (mod === "super" || mod === "cmd" || mod === "meta" || mod === "hyper") {
      return { ok: false, reason: `${quoted}: ${mod} keys do not reach terminal programs reliably; use ctrl or alt` };
    }
    if (mod !== "ctrl" && mod !== "alt" && mod !== "shift") return notOne;
    if ((mod === "ctrl" && ctrl) || (mod === "alt" && alt) || (mod === "shift" && shift)) return notOne;
    if (mod === "ctrl") ctrl = true;
    else if (mod === "alt") alt = true;
    else shift = true;
  }
  let base: string;
  const named = NAMED_KEYS[rawBase.toLowerCase()];
  if (rawBase.length === 0) return notOne;
  if (rawBase.length > 1) {
    if (named === undefined) return notOne;
    base = named;
  } else {
    const code = rawBase.charCodeAt(0);
    if (code < 0x21 || code > 0x7e) return notOne;
    base = rawBase;
    if (base >= "A" && base <= "Z") {
      base = base.toLowerCase();
      if (!ctrl) shift = true;
    } else if (shift && !isLetter(base)) {
      return {
        ok: false,
        reason: `${quoted}: shift with a symbol or digit depends on the keyboard layout; bind the character it types instead`,
      };
    }
  }
  const id = `${ctrl ? "ctrl+" : ""}${alt ? "alt+" : ""}${shift ? "shift+" : ""}${base}`;
  return {
    ok: true,
    key: {
      id,
      legacy: legacySequences(base, ctrl, alt, shift),
      label: labelOf(base, ctrl, alt, shift),
      ctrl,
      alt,
      shift,
      base,
    },
  };
}

function conflicts(a: ParsedKeyName, b: ParsedKeyName): boolean {
  return a.id === b.id || a.legacy.some(s => b.legacy.includes(s));
}

function mustParse(name: string): ParsedKeyName {
  const r = parseKeyName(name);
  if (!r.ok) throw new Error(`cortex key table: ${r.reason}`);
  return r.key;
}

// Reserved in every table and for the leader. Enter also covers "\n", which
// pi-tui reads as Enter outside the Kitty protocol (so ctrl+j is Enter too).
const RESERVED: readonly ParsedKeyName[] = [":", "/", "escape", "ctrl+c", "q", "enter", ..."0123456789"].map(name => {
  const key = mustParse(name);
  return name === "enter" ? { ...key, legacy: [...key.legacy, "\n"] } : key;
});
const RESERVED_SUMMARY = '":" "/" Esc Ctrl-C q Enter and the digits';
const TAB = mustParse("tab");
const BACKSPACE = mustParse("backspace");

/** Why a normalized key may not be bound in `table` (or as the leader), or null. */
function forbidden(key: ParsedKeyName, name: string, table: KeyTable | "leader-key"): string | null {
  const quoted = JSON.stringify(name);
  if (key.base === "escape") return `${quoted} is reserved: Esc always cancels (reserved: ${RESERVED_SUMMARY})`;
  for (const r of RESERVED) {
    if (!conflicts(key, r)) continue;
    return r.id === key.id
      ? `${quoted} is reserved (${RESERVED_SUMMARY} keep their meaning)`
      : `${quoted} is the same key as ${r.label} in legacy terminals, which is reserved (${RESERVED_SUMMARY})`;
  }
  if (key.base !== "tab" && key.legacy.some(s => TAB.legacy.includes(s))) {
    return `${quoted} sends Tab in legacy terminals; bind "tab" instead`;
  }
  if (key.base !== "backspace" && key.legacy.some(s => BACKSPACE.legacy.includes(s))) {
    return `${quoted} sends Backspace in legacy terminals`;
  }
  if (table === "insert" && !key.ctrl && !key.alt) {
    return `INSERT shortcuts must use ctrl or alt so typed text stays text: ${quoted}`;
  }
  return null;
}

// ---------- tui.toml [keys.*] validation ----------

export interface KeyConfig {
  readonly leader: KeyBinding;
  readonly bindings: {
    readonly normal: Readonly<Record<NormalAction, readonly KeyBinding[]>>;
    readonly leader: Readonly<Record<NormalAction, readonly KeyBinding[]>>;
    readonly insert: Readonly<Record<InsertAction, readonly KeyBinding[]>>;
    readonly visual: Readonly<Record<VisualAction, readonly KeyBinding[]>>;
  };
}

/** A rejected key setting; `keyPath` is the dotted tui.toml path (`leader`, `keys.normal.down`). */
export interface KeyProblem {
  readonly keyPath: string;
  readonly reason: string;
}

const isTable = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function binding(name: string, key: ParsedKeyName): KeyBinding {
  return { name, ...key };
}

function defaultTable<A extends string>(actions: readonly A[], raw: RawTable<A>): Record<A, KeyBinding[]> {
  const out = {} as Record<A, KeyBinding[]>;
  for (const a of actions) out[a] = (raw[a] ?? []).map(name => binding(name, mustParse(name)));
  return out;
}

/**
 * Validate one `[keys.<table>]` over its defaults. Returns the merged table,
 * or null (with problems recorded) when ANY entry is invalid, so a section
 * never applies partially.
 */
function resolveTable<A extends string>(
  table: KeyTable,
  actions: readonly A[],
  overrides: unknown,
  leader: KeyBinding | null,
  problems: KeyProblem[],
): Record<A, KeyBinding[]> | null {
  const merged = defaultTable(actions, DEFAULT_TABLES[table] as RawTable<A>);
  if (overrides === undefined) return merged;
  const path = `keys.${table}`;
  if (!isTable(overrides)) {
    problems.push({ keyPath: path, reason: `must be a table of action = [keys], for example down = ["j", "down"]` });
    return null;
  }
  const found: KeyProblem[] = [];
  const overridden = new Set<string>();
  for (const [action, value] of Object.entries(overrides)) {
    const keyPath = `${path}.${action}`;
    if (!(actions as readonly string[]).includes(action)) {
      found.push({ keyPath, reason: `unknown action "${action}"` });
      continue;
    }
    if (!Array.isArray(value) || !value.every(v => typeof v === "string")) {
      found.push({ keyPath, reason: `must be an array of key names, for example ["j", "down"]` });
      continue;
    }
    const list: KeyBinding[] = [];
    for (const name of value as string[]) {
      const r = parseKeyName(name);
      const why = r.ok ? forbidden(r.key, name, table) : r.reason;
      if (why !== null) found.push({ keyPath, reason: why });
      else if (r.ok) list.push(binding(name, r.key));
    }
    merged[action as A] = list;
    overridden.add(action);
  }
  // Duplicates across the whole merged table, defaults included, and (NORMAL)
  // overridden keys that shadow the leader. Reported at an overridden action.
  const seen: { action: A; key: KeyBinding }[] = [];
  for (const action of actions) {
    for (const key of merged[action]) {
      for (const prior of seen) {
        if (!conflicts(prior.key, key)) continue;
        const at = overridden.has(action) ? action : prior.action;
        const reason =
          prior.action === action
            ? `${JSON.stringify(key.name)} is listed twice (as the same key as ${JSON.stringify(prior.key.name)})`
            : prior.key.name === key.name
              ? `${JSON.stringify(key.name)} is assigned to both ${prior.action} and ${action}`
              : `${JSON.stringify(key.name)} for ${action} is the same key as ${JSON.stringify(prior.key.name)} for ${prior.action}`;
        found.push({ keyPath: `${path}.${at}`, reason });
      }
      seen.push({ action, key });
      if (leader !== null && overridden.has(action) && conflicts(leader, key)) {
        found.push({
          keyPath: `${path}.${action}`,
          reason: `${JSON.stringify(key.name)} shadows the leader ${JSON.stringify(leader.name)}`,
        });
      }
    }
  }
  if (found.length > 0) {
    problems.push(...found);
    return null;
  }
  return merged;
}

function resolveLeader(value: unknown): KeyBinding | string {
  if (typeof value !== "string") return 'leader must be a string key name, for example ";"';
  const r = parseKeyName(value);
  if (!r.ok) return r.reason;
  return forbidden(r.key, value, "leader-key") ?? binding(value, r.key);
}

const DEFAULT_LEADER_BINDING = binding(DEFAULT_LEADER, mustParse(DEFAULT_LEADER));

/**
 * Normalize and validate the key settings of a parsed tui.toml root table
 * (reads only `leader` and `keys`). Each section (`leader`, `[keys.normal]`,
 * `[keys.leader]`, `[keys.insert]`, `[keys.visual]`) either applies whole or
 * keeps its defaults with its problems recorded; other sections are
 * unaffected. `[keys.visual]` may reuse NORMAL keys: VISUAL reads it first.
 */
export function parseKeys(raw: unknown): { keys: KeyConfig; problems: KeyProblem[] } {
  const problems: KeyProblem[] = [];
  const root = raw === undefined || raw === null ? {} : raw;
  if (!isTable(root)) {
    problems.push({ keyPath: "", reason: "the configuration must be a table" });
    return { keys: DEFAULT_KEYS, problems };
  }
  let leader = DEFAULT_LEADER_BINDING;
  if (root.leader !== undefined) {
    const r = resolveLeader(root.leader);
    if (typeof r === "string") problems.push({ keyPath: "leader", reason: r });
    else leader = r;
  }
  const overrides: Partial<Record<KeyTable, unknown>> = {};
  if (root.keys !== undefined) {
    if (!isTable(root.keys)) {
      problems.push({
        keyPath: "keys",
        reason: "must be a table holding [keys.normal], [keys.leader], [keys.insert] and [keys.visual]",
      });
    } else {
      for (const [name, value] of Object.entries(root.keys)) {
        if (name === "normal" || name === "leader" || name === "insert" || name === "visual") overrides[name] = value;
        else
          problems.push({
            keyPath: `keys.${name}`,
            reason: `unknown key table "${name}" (use normal, leader, insert or visual)`,
          });
      }
    }
  }
  let normal =
    resolveTable("normal", NORMAL_ACTIONS, overrides.normal, leader, problems) ??
    defaultTable(NORMAL_ACTIONS, DEFAULT_TABLES.normal);
  // A leader that the resulting NORMAL table already binds (a default the
  // user kept, or defaults restored after a rejected section) is the leader's
  // fault: it keeps its default, and NORMAL is rechecked against that.
  const shadowed = NORMAL_ACTIONS.find(a => normal[a].some(k => conflicts(k, leader)));
  if (shadowed !== undefined) {
    problems.push({
      keyPath: "leader",
      reason: `leader ${JSON.stringify(leader.name)} is already bound in NORMAL to ${shadowed}; rebind ${shadowed} first`,
    });
    leader = DEFAULT_LEADER_BINDING;
    if (NORMAL_ACTIONS.some(a => normal[a].some(k => conflicts(k, leader)))) {
      normal =
        resolveTable("normal", NORMAL_ACTIONS, overrides.normal, leader, problems) ??
        defaultTable(NORMAL_ACTIONS, DEFAULT_TABLES.normal);
    }
  }
  const leaderTable =
    resolveTable("leader", NORMAL_ACTIONS, overrides.leader, null, problems) ??
    defaultTable(NORMAL_ACTIONS, DEFAULT_TABLES.leader);
  const insert =
    resolveTable("insert", INSERT_ACTIONS, overrides.insert, null, problems) ??
    defaultTable(INSERT_ACTIONS, DEFAULT_TABLES.insert);
  // The leader is not active in VISUAL, so an operator key never shadows it.
  const visual =
    resolveTable("visual", VISUAL_ACTIONS, overrides.visual, null, problems) ??
    defaultTable(VISUAL_ACTIONS, DEFAULT_TABLES.visual);
  return { keys: { leader, bindings: { normal, leader: leaderTable, insert, visual } }, problems };
}

/** The default key bindings. */
export const DEFAULT_KEYS: KeyConfig = {
  leader: DEFAULT_LEADER_BINDING,
  bindings: {
    normal: defaultTable(NORMAL_ACTIONS, DEFAULT_TABLES.normal),
    leader: defaultTable(NORMAL_ACTIONS, DEFAULT_TABLES.leader),
    insert: defaultTable(INSERT_ACTIONS, DEFAULT_TABLES.insert),
    visual: defaultTable(VISUAL_ACTIONS, DEFAULT_TABLES.visual),
  },
};

// ---------- labels for help and hints ----------

function leaderPrefix(keys: KeyConfig): string {
  const l = keys.leader;
  const bare = l.base.length === 1 && !l.ctrl && !l.alt && !l.shift;
  return bare ? l.label : `${l.label} `;
}

/** Display labels of an action's configured keys: NORMAL keys, then leader keys (`;h`). */
export function actionKeyLabels(keys: KeyConfig, action: NormalAction): string[] {
  const prefix = leaderPrefix(keys);
  return [
    ...keys.bindings.normal[action].map(k => k.label),
    ...keys.bindings.leader[action].map(k => `${prefix}${k.label}`),
  ];
}

/** Display labels of an INSERT shortcut's configured keys. */
export function insertKeyLabels(keys: KeyConfig, action: InsertAction): string[] {
  return keys.bindings.insert[action].map(k => k.label);
}

/** Display labels of a VISUAL operator's configured keys. */
export function visualKeyLabels(keys: KeyConfig, action: VisualAction): string[] {
  return keys.bindings.visual[action].map(k => k.label);
}

// ---------- input classification ----------

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

const FUNCTION_KEY_INPUT = [
  /^\x1bO\d*[P-S]$/, // SS3 F1-F4 (optionally with an old-style modifier digit)
  /^\x1b\[1?(?:;\d+)?(?::\d+)?[P-S]$/, // CSI [1;mod[:event]] P-S: xterm/Kitty F1-F4
  /^\x1b\[(?:1[1-5]|1[7-9]|2[0-6]|2[89]|3[1-4])(?:;\d+)?(?::\d+)?[~$^@]$/, // VT220/rxvt/Kitty F1-F20
  /^\x1b\[\[[A-E]$/, // Linux console F1-F5
];
const KITTY_CSI_U = /^\x1b\[(\d+)(?::\d*)?(?::\d+)?(?:;\d+)?(?::\d+)?u$/;
const KITTY_F13 = 57376;
const KITTY_F35 = 57398;

/** True for any function key (F1-F35) in any legacy, rxvt, Linux-console or Kitty encoding. */
export function isFunctionKey(data: string): boolean {
  if (FUNCTION_KEY_INPUT.some(re => re.test(data))) return true;
  const m = KITTY_CSI_U.exec(data);
  if (m === null) return false;
  const code = Number(m[1]);
  return code >= KITTY_F13 && code <= KITTY_F35;
}

const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/;
const isPrivateUse = (text: string): boolean => {
  const cp = text.codePointAt(0) ?? 0;
  return cp >= 0xe000 && cp <= 0xf8ff;
};

/** Printable text carried by an input: raw text, or a Kitty CSI-u printable (never a functional key). */
function printableText(data: string): string | undefined {
  if (data.length > 0 && !CONTROL_CHARS.test(data)) return data;
  const kitty = decodeKittyPrintable(data);
  return kitty !== undefined && !isPrivateUse(kitty) ? kitty : undefined;
}

/**
 * The ONE printable character an input carries (raw, or a Kitty CSI-u
 * printable), else undefined: never a control, functional key, merged Esc
 * pair or longer input. Dialogs read their own letter keys (y/n, list
 * actions) with it before the NORMAL bindings.
 */
export function printableKey(data: string): string | undefined {
  const text = printableText(data);
  return text !== undefined && [...text].length === 1 ? text : undefined;
}

/** The second half of a merged ESC+printable (or ESC+ESC) pair, or null. */
function escPair(data: string): string | null {
  if (data.length < 2 || data[0] !== ESC) return null;
  const rest = [...data.slice(1)];
  if (rest.length !== 1) return null;
  const c = rest[0];
  if (c === ESC) return c;
  return CONTROL_CHARS.test(c) ? null : c;
}

function charId(c: string): string {
  if (c === " ") return "space";
  if (c >= "A" && c <= "Z") return `shift+${c.toLowerCase()}`;
  return c;
}

/** Canonical identity of an input sequence, or null when it names no key. */
function inputId(data: string): string | null {
  const pair = escPair(data);
  if (pair !== null) return pair === ESC ? "alt+escape" : `alt+${charId(pair)}`;
  const text = printableText(data);
  if (text !== undefined) return [...text].length === 1 ? charId(text) : null;
  const id = parseKey(data);
  if (id === undefined) return null;
  const r = parseKeyName(id);
  return r.ok ? r.key.id : id;
}

function matches(key: KeyBinding, data: string, id: string | null): boolean {
  return key.legacy.includes(data) || (id !== null && id === key.id);
}

function findAction<A extends string>(
  actions: readonly A[],
  table: Readonly<Record<A, readonly KeyBinding[]>>,
  data: string,
  id: string | null,
): A | null {
  for (const action of actions) if (table[action].some(k => matches(k, data, id))) return action;
  return null;
}

// Legacy Meta pairs that text fields read as word motions (alt+b/alt+f, and
// pi-tui's alt+left/alt+right aliases). Only motions: a fast Esc then d must
// not delete a word, so alt+d is split like any other pair.
const WORD_MOTIONS = new Set(["\x1bb", "\x1bf", "\x1bB", "\x1bF"]);

// ---------- dispatcher ----------

export type KeyEvent =
  /** A bound action; `count` is the typed count (NORMAL/leader/VISUAL), null when none. */
  | { type: "action"; action: NormalAction | InsertAction | VisualAction; count: number | null; via: KeyTable }
  /** A mode change the dispatcher made: `:`/`/` (command/search), Esc/Ctrl-C (cancel), Enter in a prompt (submit). */
  | { type: "mode"; mode: KeyMode; previous: KeyMode; cause: "command" | "search" | "cancel" | "submit" }
  /** Printable input in INSERT, COMMAND or SEARCH. */
  | { type: "text"; text: string }
  /** One bracketed paste, in any mode; NORMAL must not treat it as keys. */
  | { type: "paste"; text: string }
  /** An unbound key for the focused pane or text field (Enter, Home/End/Page, Backspace, a count-less `0`...). */
  | { type: "key"; key: string | null; data: string; count: number | null }
  /** Esc or Ctrl-C in NORMAL with nothing pending (close transient UI; never quits). */
  | { type: "cancel"; key: "escape" | "ctrl+c" }
  /** A bare `q` in NORMAL: remind the user that `:q` quits. */
  | { type: "quit-hint" }
  /** A key after the leader that the leader table does not bind. */
  | { type: "unbound"; key: string | null; leader: true };

export interface KeyDispatcher {
  readonly keys: KeyConfig;
  mode(): KeyMode;
  /** App-driven transitions (e.g. `i` → INSERT, `v` → VISUAL, title Enter → NORMAL); clears any pending count/leader. */
  setMode(mode: KeyMode): void;
  /** Pending NORMAL input for the status line. */
  pending(): { count: number | null; leader: boolean };
  /** Classify ONE terminal input sequence (as delivered by pi-tui), in order. */
  feed(data: string): KeyEvent[];
}

const MAX_COUNT = 9999;

/** A per-session key dispatcher over validated keys (see `parseKeys`). Starts in NORMAL. */
export function createKeyDispatcher(keys: KeyConfig): KeyDispatcher {
  let mode: KeyMode = "NORMAL";
  let count: number | null = null;
  let leader = false;

  const clear = (): void => {
    count = null;
    leader = false;
  };
  const transition = (next: KeyMode, cause: "command" | "search" | "cancel" | "submit"): KeyEvent => {
    const previous = mode;
    mode = next;
    clear();
    return { type: "mode", mode: next, previous, cause };
  };
  const isCancel = (data: string): boolean => matchesKey(data, "escape") || matchesKey(data, "ctrl+c");

  function leaderKey(data: string): KeyEvent[] {
    if (isCancel(data)) {
      clear();
      return [];
    }
    const id = inputId(data);
    const action = findAction(NORMAL_ACTIONS, keys.bindings.leader, data, id);
    const at = count;
    clear();
    if (action !== null) return [{ type: "action", action, count: at, via: "leader" }];
    const pair = escPair(data);
    // A merged Esc+key after the leader: the Esc half cancels it quietly.
    if (pair !== null) return normal(pair);
    return [{ type: "unbound", key: id, leader: true }];
  }

  function normal(data: string): KeyEvent[] {
    if (leader) return leaderKey(data);
    if (isCancel(data)) {
      const pending = count !== null;
      clear();
      return pending ? [] : [{ type: "cancel", key: matchesKey(data, "ctrl+c") ? "ctrl+c" : "escape" }];
    }
    const id = inputId(data);
    const digit = countDigit(id, data);
    if (digit !== null) return digit;
    if (matches(keys.leader, data, id)) {
      leader = true;
      return [];
    }
    if (id === ":") return [transition("COMMAND", "command")];
    if (id === "/") return [transition("SEARCH", "search")];
    const at = count;
    if (id === "q") {
      clear();
      return [{ type: "quit-hint" }];
    }
    const action = findAction(NORMAL_ACTIONS, keys.bindings.normal, data, id);
    if (action !== null) {
      clear();
      return [{ type: "action", action, count: at, via: "normal" }];
    }
    const pair = escPair(data);
    if (pair !== null) return [...normal(ESC), ...normal(pair)];
    clear();
    return [{ type: "key", key: id, data, count: at }];
  }

  /** A digit in NORMAL or VISUAL: part of the count (null: not a digit). A `0` with no count is the line-start key. */
  function countDigit(id: string | null, data: string): KeyEvent[] | null {
    if (id === null || id.length !== 1 || id < "0" || id > "9") return null;
    if (id === "0" && count === null) return [{ type: "key", key: "0", data, count: null }];
    count = Math.min(MAX_COUNT, (count ?? 0) * 10 + Number(id));
    return [];
  }

  function visual(data: string): KeyEvent[] {
    // Esc/Ctrl-C end the selection, dropping a pending count with it (as in Vim).
    if (isCancel(data)) return [transition("NORMAL", "cancel")];
    const id = inputId(data);
    const digit = countDigit(id, data);
    if (digit !== null) return digit;
    if (id === ":") return [transition("COMMAND", "command")];
    if (id === "/") return [transition("SEARCH", "search")];
    if (id === "q") {
      clear();
      return [{ type: "quit-hint" }];
    }
    const at = count;
    const operator = findAction(VISUAL_ACTIONS, keys.bindings.visual, data, id);
    if (operator !== null) {
      clear();
      return [{ type: "action", action: operator, count: at, via: "visual" }];
    }
    const action = findAction(NORMAL_ACTIONS, keys.bindings.normal, data, id);
    if (action !== null) {
      clear();
      return [{ type: "action", action, count: at, via: "normal" }];
    }
    const pair = escPair(data);
    // A merged Esc+key: Esc ends VISUAL, then the key runs in NORMAL.
    if (pair !== null) return [...visual(ESC), ...normal(pair)];
    clear();
    return [{ type: "key", key: id, data, count: at }];
  }

  function textField(data: string): KeyEvent[] {
    const id = inputId(data);
    if (mode === "INSERT") {
      const action = findAction(INSERT_ACTIONS, keys.bindings.insert, data, id);
      if (action !== null) return [{ type: "action", action, count: null, via: "insert" }];
    }
    if (isCancel(data)) return [transition("NORMAL", "cancel")];
    if (mode !== "INSERT" && matchesKey(data, "enter")) return [transition("NORMAL", "submit")];
    const text = printableText(data);
    if (text !== undefined) return [{ type: "text", text }];
    const pair = WORD_MOTIONS.has(data) ? null : escPair(data);
    // Outside a word motion, a merged Esc+key leaves the text field, then the key runs in NORMAL.
    if (pair !== null) return [transition("NORMAL", "cancel"), ...normal(pair)];
    return [{ type: "key", key: id, data, count: null }];
  }

  return {
    keys,
    mode: () => mode,
    setMode(next) {
      mode = next;
      clear();
    },
    pending: () => ({ count, leader }),
    feed(data) {
      if (data.startsWith(PASTE_START) && data.endsWith(PASTE_END) && data.length >= PASTE_START.length * 2) {
        clear();
        return [{ type: "paste", text: data.slice(PASTE_START.length, data.length - PASTE_END.length) }];
      }
      // Key releases (Kitty flag 2) and function keys change nothing, in any mode.
      if ((data.startsWith(ESC) && isKeyRelease(data)) || isFunctionKey(data)) return [];
      if (mode === "NORMAL") return normal(data);
      return mode === "VISUAL" || mode === "VISUAL LINE" ? visual(data) : textField(data);
    },
  };
}
