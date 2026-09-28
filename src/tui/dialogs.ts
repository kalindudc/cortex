// Dialogs (plan @400 N17/N19/N20): keyboard-complete overlays that own input
// and hand focus back when they close.
//
// - ONE Dialog component serves three kinds. Lists: the configured motions
//   (j/k, arrows, g/G, half pages) move, Enter (or Space) picks (the pick
//   learns which: a picker may toggle on Space and close on Enter), `/`
//   filters with the literal, case-insensitive AND-keyword catalog search,
//   which is never capped (src/ui/lib/catalogSearch.ts; only the visible
//   WINDOW is limited; `fixed` rows are never filtered; a `live` list
//   filters as you type), q/Esc close, and a list may add its own letter
//   keys, section headers (never selectable) and a live summary line.
//   Confirmations: y confirms; n, Esc and q cancel; nothing else answers.
//   Forms open in INSERT (printable keys, `j`, `q` and `:` included, are
//   text; Tab/Shift-Tab and Up/Down change fields; Enter or Ctrl-s submit);
//   Esc leaves to the form's NORMAL mode, where Esc and q mean :q, :w
//   submits and :q! discards. Create and management forms refuse :q while
//   they hold input and make other commands wait (src/tui/session.ts).
// - showDialog draws it as a pi-tui overlay through the session's overlay
//   host (the shell), so the toolkit hands it the keyboard and gives focus
//   back when it hides; a closed dialog returns the keys to the dialog below
//   (in its own mode) or to the workspace in NORMAL. Input always takes the
//   session's ONE route, so `:` and `/` work inside dialogs.
// - A dialog's own letter keys and y/n are read before the NORMAL bindings
//   (n is "no" even though NORMAL binds it to the next result).
// - Every untrusted string (titles, names, errors) crosses src/tui/safety.ts
//   before style(); state is never color-only: the highlighted row has a
//   marker, row states are text marks, errors say "error:". No hint ever
//   names a function key.

import {
  CURSOR_MARKER,
  type Component,
  type Focusable,
  type OverlayHandle,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { searchCatalog } from "../ui/lib/catalogSearch.ts";
import { type CommandLine, createCommandLine } from "./commandline.ts";
import { actionKeyLabels, type KeyEvent, type KeyMode, type NormalAction, printableKey } from "./keys.ts";
import { displayWidth, escapeTerminalText, fitWidth } from "./safety.ts";
import type { OverlayHost, SessionDialog, TuiSession } from "./session.ts";
import { type ContrastPair, paint, type ResolvedTheme, type Seg, seg, style } from "./theme.ts";

/** The widest a dialog grows. */
export const DIALOG_WIDTH = 76;
const DIALOG_MIN_WIDTH = 40;
/**
 * Room kept around every dialog: the status line, the prompt and up to five
 * completion rows stay visible below it, so `:` works inside dialogs.
 */
export const DIALOG_MARGIN = { top: 1, bottom: 7, left: 2, right: 2 } as const;

// ---------- specs ----------

/** One list row. Text is raw (untrusted); the dialog escapes it. */
export interface DialogRow {
  /** Stable identity: the highlight follows it while the rows change. */
  readonly key: string;
  readonly label: string;
  readonly detail?: string;
  /** A short text state before the label ("[x]", "(current)"). */
  readonly mark?: string;
  /** What `/` matches (default: the label and detail). */
  readonly search?: string;
  /** Always listed after the matches and never filtered (e.g. "+ New lane…"). */
  readonly pinned?: boolean;
  /** Never filtered by `/` and kept in its place (e.g. the filter picker's statuses). */
  readonly fixed?: boolean;
  /** Its section: a header line is drawn above the first row of each section (motions skip it). */
  readonly section?: string;
  /** A checkbox or radio row: EVERY click on it picks it as Space does (a toggle, the dialog stays open). */
  readonly toggle?: boolean;
}

/** How a list row was picked: Enter, Space (or its own letter, or a click on a toggle row) or a double click. */
export type PickVia = "enter" | "space" | "click";

/** A list's own letter key (read before the NORMAL bindings). */
export interface DialogKey {
  /** One printable character. */
  readonly key: string;
  readonly label: string;
  /** Needs a highlighted row (the row is passed). */
  readonly row?: boolean;
  run(row: DialogRow | null, dialog: Dialog): void | Promise<void>;
}

export interface ListSpec {
  readonly kind: "list";
  /** Raw title for the border. */
  readonly title: string;
  /** Its name on the status line. */
  readonly label: string;
  /** What Enter does, for the hints ("edits", "toggles"). */
  readonly pickLabel: string;
  /** What Space does when it differs from Enter (the hints then name both). */
  readonly spaceLabel?: string;
  /** A live line above the rows (e.g. how many tasks the filters show). Raw text. */
  summary?(): string;
  /** What the searchable rows are, for the count line ("lanes and tags"). */
  readonly noun?: string;
  /** `/` filters the rows as you type (Esc in the prompt restores the previous filter). */
  readonly live?: boolean;
  /** The hints after the motion hint, replacing the generated ones (a picker with many letters). */
  readonly hints?: readonly string[];
  /** The rows, read live on every render (catalogs change while it is open). */
  rows(): readonly DialogRow[];
  /** Rows after the matches that depend on the filter text (e.g. "+ Create #name"); never filtered. */
  extra?(filter: string): readonly DialogRow[];
  /** Enter or Space on a row (`via` says which). Call dialog.finish() to close it as done. */
  pick(row: DialogRow, dialog: Dialog, via: PickVia): void | Promise<void>;
  readonly keys?: readonly DialogKey[];
  /** The highlighted row changed (a live preview). */
  highlight?(row: DialogRow | null): void;
  /** Closed without finishing (Esc, q, :q, another command): undo any preview. */
  dismiss?(): void;
  /** The row highlighted first. */
  readonly initial?: string;
  /** Shown when no row matches. */
  readonly empty?: string;
}

export interface ConfirmSpec {
  readonly kind: "confirm";
  readonly title: string;
  readonly label: string;
  /** Raw lines of the question. */
  readonly message: readonly string[];
  /** What y does ("deletes it"). */
  readonly yes: string;
  /** What n does (default "cancels"). */
  readonly no?: string;
  /** y: the dialog is already closed; errors are shown on the status line. */
  confirm(dialog: Dialog): void | Promise<void>;
  /** n, Esc, q or :q. */
  dismiss?(): void;
}

export interface FormFieldSpec {
  readonly name: string;
  readonly label: string;
  /** The initial text (the baseline for "unsaved input"). */
  readonly value: string;
  /** What the field accepts, shown beside it. */
  readonly hint?: string;
  /** Why it cannot be edited; it is shown and skipped. */
  readonly locked?: string;
}

export interface FormSpec {
  readonly kind: "form";
  readonly title: string;
  readonly label: string;
  readonly fields: readonly FormFieldSpec[];
  /** Create and management forms: :q is refused while the form holds input, and other commands wait. */
  readonly guarded: boolean;
  /** What :w does, for the hints ("creates", "saves"). */
  readonly submitLabel: string;
  /**
   * Resolve true when done (the form closes), false to keep it open. A throw
   * keeps the draft and shows the error in the form and on the status line;
   * form.rebase() moves the baseline to incoming values first (a conflict).
   */
  submit(values: Readonly<Record<string, string>>, form: Dialog): boolean | Promise<boolean>;
}

export type DialogSpec = ListSpec | ConfirmSpec | FormSpec;

/** showDialog's handle: the toolkit's OverlayHandle (hide() closes the dialog) plus the dialog. */
export interface DialogOverlay extends OverlayHandle {
  readonly dialog: Dialog;
}

// ---------- helpers ----------

const esc = escapeTerminalText;
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The character a `key` event's id names ("d", "shift+d" -> "D", "space" -> " "), if it is one. */
function keyChar(id: string | null): string | null {
  if (id === null) return null;
  if (id === "space") return " ";
  if ([...id].length === 1) return id;
  const shifted = /^shift\+([a-z])$/.exec(id);
  return shifted ? (shifted[1] ?? "").toUpperCase() : null;
}

const rowText = (row: DialogRow): string => row.search ?? [row.label, row.detail ?? ""].join(" ");

const on = (fg: "text" | "muted" | "info", selected: boolean): ContrastPair =>
  selected ? (`${fg}@selection` as ContrastPair) : (`${fg}@raised` as ContrastPair);

const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Drop graphemes from the start until `text` fits in `width` cells. */
function tailFit(text: string, width: number): string {
  let out = text;
  while (displayWidth(out) > width && out !== "") {
    const first = segments.segment(out)[Symbol.iterator]().next();
    out = first.done ? "" : out.slice(first.value.segment.length);
  }
  return out;
}

// ---------- the dialog ----------

export class Dialog implements Component, Focusable, SessionDialog {
  /** Set by the toolkit while the overlay has the keyboard (IME cursor placement). */
  focused = false;
  readonly spec: DialogSpec;
  readonly label: string;
  readonly #session: TuiSession;
  readonly #host: OverlayHost;
  #overlay: OverlayHandle | null = null;
  #closed = false;
  #finished = false;
  #busy = false;
  #error: string | null = null;
  #notice: string | null = null;
  // lists
  #filter = "";
  #key: string | null = null;
  #index = 0;
  #scroll = 0;
  #page = 10;
  /** The row key or field index on each rendered line (mouse). */
  #hits: (string | number | null)[] = [];
  // forms
  readonly #lines: CommandLine[] = [];
  readonly #baseline: string[] = [];
  #field = 0;
  #mode: KeyMode = "NORMAL";

  constructor(session: TuiSession, host: OverlayHost, spec: DialogSpec) {
    this.#session = session;
    this.#host = host;
    this.spec = spec;
    this.label = spec.label;
    if (spec.kind === "list") this.#key = spec.initial ?? null;
    if (spec.kind === "form") {
      for (const field of spec.fields) {
        this.#lines.push(
          createCommandLine(":", { history: [], initial: field.value, onChange: () => session.redraw() }),
        );
        this.#baseline.push(field.value);
      }
      this.#field = Math.max(
        0,
        spec.fields.findIndex(f => f.locked === undefined),
      );
      this.#mode = "INSERT";
    }
  }

  /** @internal showDialog hands over the toolkit's handle. */
  attach(overlay: OverlayHandle): void {
    this.#overlay = overlay;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** @internal Where row `key` was drawn on screen (a cell of its label), or null when it is not shown. */
  rowOnScreen(key: string): [number, number] | null {
    const bounds = this.#overlay?.getBounds();
    const y = this.#hits.indexOf(key);
    return bounds === undefined || y < 0 ? null : [bounds.col + 2, bounds.row + y];
  }

  // ---------- SessionDialog ----------

  mode(): KeyMode {
    return this.spec.kind === "form" ? this.#mode : "NORMAL";
  }

  hints(): string {
    const keys = this.#session.keys.keys;
    const first = (action: NormalAction) => actionKeyLabels(keys, action)[0];
    const down = first("down");
    const up = first("up");
    const motion = down && up ? `${down}/${up}` : (down ?? up ?? "Up/Down");
    const spec = this.spec;
    switch (spec.kind) {
      case "list": {
        if (spec.hints !== undefined) return [`${motion} move`, ...spec.hints].join(" · ");
        const letters = (spec.keys ?? []).map(k => `${k.key} ${k.label}`);
        const picks =
          spec.spaceLabel === undefined
            ? [`Enter ${spec.pickLabel}`]
            : [`Space ${spec.spaceLabel}`, `Enter ${spec.pickLabel}`];
        return [`${motion} move`, ...picks, ...letters, "/ filter", "q close"].join(" · ");
      }
      case "confirm":
        return `y ${spec.yes} · n ${spec.no ?? "cancels"}`;
      case "form":
        return this.#mode === "INSERT"
          ? `INSERT · Enter ${spec.submitLabel} · Tab next field · Esc for NORMAL`
          : `NORMAL · i edits · ${motion} fields · :w ${spec.submitLabel} · :q closes · :q! discards`;
    }
  }

  handleRaw(data: string): boolean {
    if (this.#closed || this.#session.keys.mode() !== "NORMAL") return false;
    const pending = this.#session.keys.pending();
    if (pending.count !== null || pending.leader) return false;
    const ch = printableKey(data);
    return ch !== undefined && this.#letter(ch);
  }

  handleKey(event: KeyEvent): void {
    if (this.#closed) return;
    const spec = this.spec;
    if (spec.kind !== "form") this.#error = null;
    if (spec.kind === "list") this.#listKey(event);
    else if (spec.kind === "confirm") this.#confirmKey(event);
    else this.#formKey(event);
  }

  search(text: string): void {
    if (this.spec.kind !== "list") {
      this.#session.notify("info", "Nothing to search here: / filters lists");
      return;
    }
    const before = this.highlighted()?.key ?? null;
    this.#filter = text;
    this.#index = 0;
    this.#scroll = 0;
    // The first match is highlighted (past the rows a search never filters).
    this.#key = text === "" ? null : (this.visibleRows().find(r => !r.fixed)?.key ?? null);
    this.#highlighted(before);
  }

  /** A `live` list filters as the `/` prompt is typed (the session feeds search()). */
  get searchesLive(): boolean {
    return this.spec.kind === "list" && this.spec.live === true;
  }

  /** The current `/` filter text (restored when a live search is cancelled). */
  get searchText(): string {
    return this.#filter;
  }

  write(): boolean {
    if (this.spec.kind !== "form") return false;
    this.#submit();
    return true;
  }

  quit(force: boolean): void {
    if (this.#closed) return;
    const spec = this.spec;
    if (spec.kind === "form" && !force && spec.guarded && this.hasDraft()) {
      this.#session.notify("warn", `The ${spec.label} form has unsaved input: :w saves it, :q! discards it`);
      return;
    }
    this.close();
  }

  blocksCommands(): boolean {
    return this.spec.kind === "form" && this.spec.guarded && this.hasDraft();
  }

  /** Close without questions: a list or confirmation that was not finished is dismissed (previews undone). */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (!this.#finished && this.spec.kind !== "form") this.spec.dismiss?.();
    this.#overlay?.hide();
    this.#session.removeDialog(this);
  }

  /** Close as done (a pick or a submit): nothing is dismissed. */
  finish(): void {
    this.#finished = true;
    this.close();
  }

  // ---------- list state ----------

  /** The filter text (`/`). */
  get filter(): string {
    return this.#filter;
  }

  /** Every row the filter matches (never capped), then pinned and extra rows. */
  visibleRows(): DialogRow[] {
    return this.#listRows().rows;
  }

  #listRows(): { rows: DialogRow[]; matched: number; total: number } {
    if (this.spec.kind !== "list") return { rows: [], matched: 0, total: 0 };
    const all = this.spec.rows();
    const entries = all.filter(r => !r.pinned);
    const searchable = entries.filter(r => !r.fixed);
    const found = new Set(searchCatalog(searchable, this.#filter, rowText).items);
    return {
      rows: [
        ...entries.filter(r => r.fixed || found.has(r)),
        ...all.filter(r => r.pinned),
        ...(this.spec.extra?.(this.#filter) ?? []),
      ],
      matched: found.size,
      total: searchable.length,
    };
  }

  /** The highlighted row (it follows its key while the rows change), or null. */
  highlighted(): DialogRow | null {
    const rows = this.visibleRows();
    const at = this.#resolve(rows);
    return at < 0 ? null : (rows[at] ?? null);
  }

  #resolve(rows: readonly DialogRow[]): number {
    if (rows.length === 0) return -1;
    const byKey = this.#key === null ? -1 : rows.findIndex(r => r.key === this.#key);
    const at = byKey >= 0 ? byKey : Math.max(0, Math.min(this.#index, rows.length - 1));
    this.#index = at;
    this.#key = rows[at]?.key ?? null;
    return at;
  }

  #move(delta: number): void {
    const rows = this.visibleRows();
    if (rows.length === 0) return;
    const before = rows[this.#resolve(rows)]?.key ?? null;
    const at = Math.max(0, Math.min(rows.length - 1, this.#index + delta));
    this.#index = at;
    this.#key = rows[at]?.key ?? null;
    this.#highlighted(before);
  }

  #highlighted(before: string | null): void {
    if (this.spec.kind !== "list") return;
    const now = this.highlighted();
    if ((now?.key ?? null) !== before) this.spec.highlight?.(now);
  }

  #pick(via: PickVia): void {
    const spec = this.spec;
    if (spec.kind !== "list" || this.#busy) return;
    const row = this.highlighted();
    if (row === null) return;
    this.#run(() => spec.pick(row, this, via));
  }

  // ---------- form state ----------

  /** The fields' current text by name. */
  values(): Record<string, string> {
    if (this.spec.kind !== "form") return {};
    return Object.fromEntries(this.spec.fields.map((f, i) => [f.name, this.#lines[i]?.text ?? ""]));
  }

  /** The text each field is compared with for "unsaved input". */
  baseline(): Record<string, string> {
    if (this.spec.kind !== "form") return {};
    return Object.fromEntries(this.spec.fields.map((f, i) => [f.name, this.#baseline[i] ?? ""]));
  }

  hasDraft(): boolean {
    return this.#lines.some((line, i) => line.text !== this.#baseline[i]);
  }

  /** Move the baseline to incoming values (a conflict): the draft stays as typed. */
  rebase(values: Readonly<Record<string, string>>): void {
    if (this.spec.kind !== "form") return;
    this.spec.fields.forEach((f, i) => {
      const value = values[f.name];
      if (value !== undefined) this.#baseline[i] = value;
    });
    this.#session.redraw();
  }

  #editable(index: number): boolean {
    return this.spec.kind === "form" && this.spec.fields[index]?.locked === undefined;
  }

  #moveField(delta: number): void {
    if (this.spec.kind !== "form") return;
    const count = this.spec.fields.length;
    let at = this.#field;
    const step = Math.sign(delta);
    for (let moved = 0; moved < Math.abs(delta); moved++) {
      let next = at + step;
      while (next >= 0 && next < count && !this.#editable(next)) next += step;
      if (next < 0 || next >= count) break;
      at = next;
    }
    this.#field = at;
  }

  #insert(at?: "home" | "end"): void {
    if (!this.#editable(this.#field)) this.#moveField(1);
    if (at !== undefined) this.#lines[this.#field]?.key(at);
    this.#mode = "INSERT";
    this.#session.keys.setMode("INSERT");
  }

  #edit(apply: (line: CommandLine) => void): void {
    const spec = this.spec;
    if (spec.kind !== "form") return;
    const locked = spec.fields[this.#field]?.locked;
    if (locked !== undefined) {
      this.#session.notify("info", locked);
      return;
    }
    const line = this.#lines[this.#field];
    if (line) apply(line);
  }

  #submit(): void {
    const spec = this.spec;
    if (spec.kind !== "form" || this.#busy || this.#closed) return;
    const values = this.values();
    this.#error = null;
    this.#notice = null;
    this.#busy = true;
    let outcome: boolean | Promise<boolean>;
    try {
      outcome = spec.submit(values, this);
    } catch (err) {
      this.#busy = false;
      this.#fail(err);
      return;
    }
    void Promise.resolve(outcome)
      .then(
        done => {
          this.#busy = false;
          if (!done || this.#closed) return;
          const now = this.values();
          if (Object.keys(values).some(name => now[name] !== values[name])) {
            // Typing continued while it saved: keep the newer text.
            this.rebase(values);
            this.#notice = `Saved; you typed more since: :w ${spec.submitLabel} that too`;
            return;
          }
          this.finish();
        },
        err => {
          this.#busy = false;
          this.#fail(err);
        },
      )
      .finally(() => this.#session.redraw());
  }

  // ---------- keys ----------

  #letter(ch: string): boolean {
    const spec = this.spec;
    if (spec.kind === "confirm") {
      if (ch === "y" || ch === "Y") {
        this.#confirm();
        return true;
      }
      if (ch === "n" || ch === "N") {
        this.quit(true);
        return true;
      }
      return false;
    }
    if (spec.kind === "form") {
      if (ch === "a" || ch === "A") this.#insert("end");
      else if (ch === "I") this.#insert("home");
      else return false;
      return true;
    }
    if (ch === " ") {
      this.#pick("space");
      return true;
    }
    const key = spec.keys?.find(k => k.key === ch);
    if (key === undefined) return false;
    const row = this.highlighted();
    if (key.row === true && row === null) return true;
    if (!this.#busy) this.#run(() => key.run(row, this));
    return true;
  }

  #listKey(event: KeyEvent): void {
    const half = Math.max(1, Math.floor(this.#page / 2));
    switch (event.type) {
      case "action": {
        const n = event.count ?? 1;
        if (event.action === "down") this.#move(n);
        else if (event.action === "up") this.#move(-n);
        else if (event.action === "half_down") this.#move(half * n);
        else if (event.action === "half_up") this.#move(-half * n);
        else if (event.action === "top") this.#move(-Number.MAX_SAFE_INTEGER);
        else if (event.action === "bottom") this.#move(Number.MAX_SAFE_INTEGER);
        return;
      }
      case "key": {
        if (event.key === "enter") this.#pick("enter");
        else if (event.key === "home") this.#move(-Number.MAX_SAFE_INTEGER);
        else if (event.key === "end") this.#move(Number.MAX_SAFE_INTEGER);
        else if (event.key === "pageUp") this.#move(-this.#page);
        else if (event.key === "pageDown") this.#move(this.#page);
        else {
          const ch = keyChar(event.key);
          if (ch !== null) this.#letter(ch);
        }
        return;
      }
      case "cancel":
      case "quit-hint":
        this.quit(false);
        return;
      default:
        return;
    }
  }

  #confirmKey(event: KeyEvent): void {
    if (event.type === "cancel" || event.type === "quit-hint") {
      this.quit(true);
      return;
    }
    if (event.type !== "key") return;
    const ch = keyChar(event.key);
    if (ch !== null && this.#letter(ch)) return;
    if (event.key === "enter" && this.spec.kind === "confirm") {
      this.#session.notify("info", `Press y (${this.spec.yes}) or n (${this.spec.no ?? "cancels"})`);
    }
  }

  #formKey(event: KeyEvent): void {
    if (event.type === "mode") {
      // Esc or Ctrl-C out of INSERT (the keys are already in NORMAL): the form's NORMAL mode.
      if (event.cause === "cancel") this.#mode = "NORMAL";
      return;
    }
    if (this.#session.keys.mode() === "INSERT") {
      switch (event.type) {
        case "text":
          this.#edit(line => line.insert(event.text));
          return;
        case "paste":
          this.#edit(line => line.paste(event.text));
          return;
        case "action":
          if (event.action === "save") this.#submit();
          return;
        case "key": {
          const key = event.key;
          if (key === "enter") this.#submit();
          else if (key === "tab" || key === "down") this.#moveField(1);
          else if (key === "shift+tab" || key === "up") this.#moveField(-1);
          else this.#edit(line => void line.key(key));
          return;
        }
        default:
          return;
      }
    }
    switch (event.type) {
      case "action": {
        const n = event.count ?? 1;
        if (event.action === "down" || event.action === "next_pane") this.#moveField(n);
        else if (event.action === "up" || event.action === "previous_pane") this.#moveField(-n);
        else if (event.action === "top") this.#moveField(-Number.MAX_SAFE_INTEGER);
        else if (event.action === "bottom") this.#moveField(Number.MAX_SAFE_INTEGER);
        else if (event.action === "insert") this.#insert();
        return;
      }
      case "key": {
        if (event.key === "enter") this.#insert();
        else if (event.key === "tab") this.#moveField(1);
        else if (event.key === "shift+tab") this.#moveField(-1);
        else {
          const ch = keyChar(event.key);
          if (ch !== null) this.#letter(ch);
        }
        return;
      }
      case "paste":
        this.#session.notify("info", "Paste ignored: NORMAL mode never inserts text (i edits the field)");
        return;
      case "cancel":
      case "quit-hint":
        this.quit(false);
        return;
      default:
        return;
    }
  }

  #confirm(): void {
    const spec = this.spec;
    if (spec.kind !== "confirm") return;
    this.finish();
    this.#run(() => spec.confirm(this));
  }

  /** Run a callback; a promise shows the dialog as busy; errors reach the dialog and the status line. */
  #run(action: () => void | Promise<void>): void {
    let result: void | Promise<void>;
    try {
      result = action();
    } catch (err) {
      this.#fail(err);
      return;
    }
    if (!(result instanceof Promise)) return;
    this.#busy = true;
    this.#session.redraw();
    void result
      .catch(err => this.#fail(err))
      .finally(() => {
        this.#busy = false;
        this.#session.redraw();
      });
  }

  #fail(err: unknown): void {
    const text = errorText(err);
    this.#error = text;
    this.#session.notify("error", text);
  }

  // ---------- the toolkit component ----------

  /** The toolkit's focus path: the same ONE input route as the workspace. */
  handleInput(data: string): void {
    this.#session.input(data);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const spec = this.spec;
    if (event.type === "wheel") {
      if (spec.kind === "list") this.#move(Math.sign(event.wheelDelta ?? 0));
      else if (spec.kind === "form") this.#moveField(Math.sign(event.wheelDelta ?? 0));
      this.#session.redraw();
      return { handled: true };
    }
    if (event.type === "click" && event.button === "left") {
      const hit = this.#hits[event.y];
      if (typeof hit === "string" && spec.kind === "list") {
        // A click highlights the row; a toggle row also toggles (every click), any other row picks on a double click.
        const rows = this.visibleRows();
        const at = rows.findIndex(r => r.key === hit);
        if (at >= 0) {
          this.#move(at - this.#resolve(rows));
          if (rows[at]?.toggle === true) this.#pick("space");
          else if ((event.clickCount ?? 1) >= 2) this.#pick("click");
        }
      } else if (typeof hit === "number" && this.#editable(hit)) {
        this.#field = hit;
      }
      this.#session.redraw();
    }
    return { handled: true };
  }

  invalidate(): void {}

  render(width: number): string[] {
    const theme = this.#session.theme;
    if (theme === null || width < 8) return [];
    const inner = width - 2;
    const budget = Math.max(6, this.#host.rows() - DIALOG_MARGIN.top - DIALOG_MARGIN.bottom);
    const body: { line: string; hit: string | number | null }[] = [];
    const push = (segs: readonly Seg[], fill: ContrastPair = "text@raised", hit: string | number | null = null) =>
      body.push({ line: paint(theme, segs, inner, fill), hit });
    const status: Seg[] = this.#busy
      ? [seg("warn@raised", " Working…")]
      : this.#error !== null
        ? [seg("danger@raised", ` error: ${esc(this.#error)}`)]
        : this.#notice !== null
          ? [seg("info@raised", ` ${esc(this.#notice)}`)]
          : [];
    const footer = [seg("dim@raised", ` ${esc(this.hints())}`)];
    const spec = this.spec;
    if (spec.kind === "list") this.#renderList(spec, inner, budget - 4 - (status.length > 0 ? 1 : 0), push);
    else if (spec.kind === "confirm") {
      for (const text of spec.message) {
        for (const line of wrapTextWithAnsi(esc(text), Math.max(1, inner - 2))) push([seg("text@raised", ` ${line}`)]);
      }
      push([]);
    } else this.#renderForm(theme, spec, inner, push, body);
    if (status.length > 0) push(status);
    push(footer);
    this.#hits = [null, ...body.map(b => b.hit), null];
    const border = (text: string) => style(theme, "border@raised", text);
    const title = fitWidth(` ${esc(spec.title)} `, Math.max(0, width - 4));
    const top =
      border("╭─") +
      style(theme, "accent@raised", title, { bold: true }) +
      border(`${"─".repeat(Math.max(0, width - 3 - displayWidth(title)))}╮`);
    return [top, ...body.map(b => border("│") + b.line + border("│")), border(`╰${"─".repeat(inner)}╯`)];
  }

  #renderList(
    spec: ListSpec,
    inner: number,
    room: number,
    push: (segs: readonly Seg[], fill?: ContrastPair, hit?: string | number | null) => void,
  ): void {
    const { rows, matched, total } = this.#listRows();
    const at = this.#resolve(rows);
    if (spec.summary !== undefined) push([seg("info@raised", ` ${esc(spec.summary())}`)]);
    const noun = spec.noun === undefined ? "" : ` ${esc(spec.noun)}`;
    push([
      seg("muted@raised", ` ${matched} of ${total}${noun}`),
      this.#filter === "" ? seg("dim@raised", " · / filters") : seg("info@raised", ` · /${esc(this.#filter)}`),
    ]);
    const visible = Math.max(1, room - (spec.summary === undefined ? 0 : 1));
    this.#page = visible;
    if (rows.length === 0) {
      push([seg("muted@raised", ` ${esc(spec.empty ?? "Nothing matches")}`)]);
      return;
    }
    // Lines: a section header above the first row of each section, then the rows.
    const lines: ({ readonly header: string } | { readonly row: number })[] = [];
    let section: string | undefined;
    rows.forEach((row, i) => {
      if (row.section !== undefined && row.section !== section) lines.push({ header: row.section });
      section = row.section;
      lines.push({ row: i });
    });
    const target = lines.findIndex(l => "row" in l && l.row === at);
    // The highlighted row stays in view, with its section header when it opens the section.
    const top = target > 0 && "header" in (lines[target - 1] ?? {}) ? target - 1 : target;
    let scroll = Math.min(this.#scroll, Math.max(0, lines.length - visible));
    if (top < scroll) scroll = top;
    else if (target >= scroll + visible) scroll = target - visible + 1;
    this.#scroll = scroll;
    const labelWidth = Math.min(
      Math.max(8, Math.floor(inner / 2)),
      Math.max(...rows.map(r => displayWidth(esc(r.label))), 1),
    );
    for (const entry of lines.slice(scroll, scroll + visible)) {
      if ("header" in entry) {
        push([seg("muted@raised", ` ${esc(entry.header)}`, { bold: true })]);
        continue;
      }
      const row = rows[entry.row];
      if (row === undefined) continue;
      const selected = entry.row === at;
      const label = fitWidth(esc(row.label), labelWidth);
      const pad = " ".repeat(Math.max(0, labelWidth - displayWidth(label)));
      const segs: Seg[] = [
        selected ? seg("accent@selection", "▌") : seg("text@raised", " "),
        ...(row.mark === undefined ? [] : [seg(on("info", selected), `${esc(row.mark)} `)]),
        seg(on("text", selected), `${label}${pad}`, selected ? { bold: true } : undefined),
        ...(row.detail === undefined ? [] : [seg(on("muted", selected), `  ${esc(row.detail)}`)]),
      ];
      push(segs, selected ? "text@selection" : "text@raised", row.key);
    }
  }

  #renderForm(
    theme: ResolvedTheme,
    spec: FormSpec,
    inner: number,
    push: (segs: readonly Seg[], fill?: ContrastPair, hit?: string | number | null) => void,
    body: { line: string; hit: string | number | null }[],
  ): void {
    const labelWidth = Math.max(...spec.fields.map(f => displayWidth(esc(f.label)))) + 2;
    const typing = this.#mode === "INSERT";
    spec.fields.forEach((field, i) => {
      const current = i === this.#field;
      const line = this.#lines[i];
      const text = line?.text ?? "";
      const label = `${esc(field.label)}${" ".repeat(Math.max(0, labelWidth - displayWidth(esc(field.label))))}`;
      const note = field.locked ?? field.hint;
      if (field.locked !== undefined) {
        push(
          [
            seg("text@raised", "  "),
            seg("muted@raised", label),
            seg("dim@raised", esc(text)),
            seg("dim@raised", `  (${esc(field.locked)})`),
          ],
          "text@raised",
          i,
        );
        return;
      }
      const fill: ContrastPair = current ? "text@selection" : "text@raised";
      const lead: Seg[] = [
        current ? seg("accent@selection", "▌") : seg("text@raised", " "),
        seg(on("muted", current), ` ${label}`),
      ];
      const leadWidth = lead.reduce((n, s) => n + displayWidth(s.text), 0);
      const rest = line === undefined ? "" : text.slice(line.cursor);
      const next = segments.segment(rest)[Symbol.iterator]().next();
      const under = next.done ? " " : esc(next.value.segment);
      const cell = displayWidth(under);
      if (!(current && typing) || line === undefined || leadWidth + cell > inner) {
        const segs = [...lead, seg(on("text", current), esc(text))];
        if (note !== undefined) segs.push(seg(on("muted", current), `  (${esc(note)})`));
        push(segs, fill, i);
        return;
      }
      // The field being typed in: a visible cursor cell, and the hardware
      // cursor marker at it while the overlay has the keyboard (IME).
      const after = esc(next.done ? "" : rest.slice(next.value.segment.length));
      const before = tailFit(esc(text.slice(0, line.cursor)), Math.max(0, inner - leadWidth - cell));
      const left = leadWidth + displayWidth(before);
      const tail = note === undefined ? after : `${after}  (${esc(note)})`;
      body.push({
        line:
          paint(theme, [...lead, seg("text@selection", before)], left, fill) +
          (this.focused ? CURSOR_MARKER : "") +
          style(theme, "text@selection", under, { inverse: true }) +
          paint(theme, [seg("text@selection", tail)], Math.max(0, inner - left - cell), fill),
        hit: i,
      });
    });
    push([]);
  }
}

/**
 * Show a dialog on top of everything as a toolkit overlay (it gets the
 * keyboard) and put it on the session's dialog stack. The returned handle's
 * hide() closes it like q; focus returns to what was below. `right` draws it
 * narrower at the right edge, so the task list stays in view (the filter
 * picker, whose toggles narrow the list live).
 */
export function showDialog(
  session: TuiSession,
  spec: DialogSpec,
  placement: "center" | "right" = "center",
): DialogOverlay {
  const host = session.overlayHost;
  if (host === null) throw new Error("Dialogs need the terminal workspace to draw on");
  const dialog = new Dialog(session, host, spec);
  const room = host.columns() - DIALOG_MARGIN.left - DIALOG_MARGIN.right;
  const width = Math.min(
    DIALOG_WIDTH,
    Math.max(DIALOG_MIN_WIDTH, placement === "right" ? Math.min(room, Math.floor(host.columns() * 0.6)) : room),
  );
  const overlay = host.showOverlay(dialog, {
    anchor: placement === "right" ? "right-center" : "center",
    width,
    minWidth: Math.min(DIALOG_MIN_WIDTH, width),
    maxHeight: "100%",
    margin: { ...DIALOG_MARGIN },
  });
  dialog.attach(overlay);
  session.pushDialog(dialog);
  return {
    dialog,
    hide: () => dialog.close(),
    setHidden: hidden => overlay.setHidden(hidden),
    isHidden: () => overlay.isHidden(),
    focus: () => overlay.focus(),
    unfocus: options => overlay.unfocus(options),
    isFocused: () => overlay.isFocused(),
    getBounds: () => overlay.getBounds(),
  };
}
