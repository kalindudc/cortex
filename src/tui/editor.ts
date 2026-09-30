// The document editor: a thin terminal Component/Focusable over a CodeMirror
// STATE, never an EditorView and never the toolkit's prompt Editor (which
// turns tabs into spaces and has no redo).
//
// - The state is an EditorState with CodeMirror history and the Markdown
//   language (with CodeMirror's defaults: tab size 4, two-space indent
//   unit). Edits are transactions and StateCommands: typing joins undo
//   groups as CodeMirror's history does, a bracketed paste is ONE
//   undoable edit and is never read as keys, Tab/Shift-Tab are indentMore /
//   indentLess, Enter continues Markdown list markup (insertNewlineContinue
//   Markup, else insertNewlineAndIndent) and Backspace removes list markup
//   first, then characters exactly as CodeMirror's deleteCharBackward does.
// - Text is preserved exactly: tabs stay tabs (shown to the next tab stop),
//   and a document whose lines all end in CRLF keeps CRLF (its line
//   separator is CRLF). editorText() is the exact text.
// - View-dependent motions (visual rows of wrapped lines, pages, clicks) use
//   the terminal geometry of the last render, never a fake EditorView: every
//   grapheme cluster (CodeMirror's findClusterBreak) maps to display cells.
// - Rendering: a line-number gutter (the cursor line's number bold), syntax
//   cues from the Markdown syntax tree, the selection and a block cursor, all
//   through theme pairs on text escaped by src/tui/safety.ts. While focused,
//   CURSOR_MARKER sits at the logical cursor (after the gutter, scroll and
//   cell transforms) so the terminal's IME window follows it.
// - The editor never interprets modes: the shell (the modal layer) decides
//   whether a key is a NORMAL motion, a count, undo/redo or INSERT text, and
//   calls move/insert/paste/editKey/undo/redo.
// - VISUAL selections (the shell's vi visual modes) are CodeMirror
//   EditorSelection ranges shaped like vi's: charwise includes the cluster
//   under the cursor (the line break at a line end), linewise covers whole
//   lines. move() extends them from the vi cursor, which is painted as a
//   visible hole in the selection (selection pair PLUS inverse, so it shows
//   without color). Every operator (y d c > < and p/P) is ONE transaction,
//   isolated in the history (one undo step), after collapsing the selection
//   so that undo restores a cursor, never a stale range. vi's w/b/e run over
//   grapheme clusters (wordNext/wordPrev/wordEnd, shared with the reader).

import {
  CharCategory,
  countColumn,
  EditorSelection,
  ChangeSet,
  EditorState,
  type Extension,
  findClusterBreak,
  type StateCommand,
  Text,
  Transaction,
  type TransactionSpec,
} from "@codemirror/state";
import {
  deleteGroupBackward,
  history,
  indentLess,
  indentMore,
  insertNewlineAndIndent,
  isolateHistory,
  redo,
  undo,
} from "@codemirror/commands";
import { deleteMarkupBackward, insertNewlineContinueMarkup, markdown } from "@codemirror/lang-markdown";
import { ensureSyntaxTree, getIndentUnit, syntaxTree } from "@codemirror/language";
import { highlightTree, tagHighlighter, tags } from "@lezer/highlight";
import {
  CURSOR_MARKER,
  type Component,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { displayWidth, escapeTerminalText } from "./safety.ts";
import type { ScrollPosition } from "./scrollbar.ts";
import { type ContrastPair, type ResolvedTheme, type StyleAttributes, style } from "./theme.ts";

// The editor's state extensions (history() + markdown()); both are reusable values.
const EXTENSIONS: readonly Extension[] = [history(), markdown()];
const CRLF_SEPARATOR = EditorState.lineSeparator.of("\r\n");

/** Every line break is CRLF (and there is at least one): the document keeps CRLF. */
function crlfOnly(text: string): boolean {
  return text.includes("\r\n") && !/\r(?!\n)|(?<!\r)\n/.test(text);
}

/** A fresh editor state for `text`: the editor's extensions, the cursor at `cursor` (clamped). */
export function createEditorState(text: string, options: { cursor?: number } = {}): EditorState {
  const extensions = crlfOnly(text) ? [...EXTENSIONS, CRLF_SEPARATOR] : [...EXTENSIONS];
  const first = EditorState.create({ doc: text, extensions });
  const cursor = Math.max(0, Math.min(options.cursor ?? 0, first.doc.length));
  if (cursor === 0) return first;
  return EditorState.create({ doc: first.doc, extensions, selection: EditorSelection.cursor(cursor) });
}

/** The exact text of an editor state (with its own line separator). */
export function editorText(state: EditorState): string {
  return state.sliceDoc();
}

/** Cells of the line-number gutter for a document of `lines` lines: at least three digits, then a space. */
export function gutterWidth(lines: number): number {
  return Math.max(3, String(lines).length) + 1;
}

export type EditorMotion =
  | "left"
  | "right"
  | "up"
  | "down"
  | "line-start"
  | "line-end"
  | "doc-start"
  | "doc-end"
  | "page-up"
  | "page-down"
  | "half-page-up"
  | "half-page-down"
  | "word-left"
  | "word-right"
  /** vi `w`: the start of the next word (an empty line is one). */
  | "word-next"
  /** vi `b`: the start of this or the previous word. */
  | "word-prev"
  /** vi `e`: the end of this or the next word. */
  | "word-end";

/** A VISUAL selection's shape: characters (vi `v`) or whole lines (vi `V`). */
export type VisualKind = "char" | "line";

/** Yanked or deleted text (the shell's paste register): characters, or whole lines ending in a line break. */
export interface Register {
  readonly text: string;
  readonly linewise: boolean;
}

export interface MoveOptions {
  /** Repeat the motion (a NORMAL count). */
  count?: number;
  /** Extend the selection instead of moving the cursor. */
  extend?: boolean;
  /** left/right cross line ends (INSERT arrows); false keeps them in the line (NORMAL h/l). */
  wrap?: boolean;
}

export interface DocumentEditor extends Component, Focusable {
  /** Rows to fill: the shell sets it before each render. */
  height: number;
  /** The theme to paint with: the shell sets it before each render (nothing renders without one). */
  theme: ResolvedTheme | null;
  getState(): EditorState;
  dispatch(spec: TransactionSpec): void;
  /** Replace the whole state (an adopted incoming version); the instance, scroll and focus stay, onChange is not called. */
  setState(state: EditorState): void;
  /** Apply a CodeMirror StateCommand; false when it did not apply. */
  run(command: StateCommand): boolean;
  move(motion: EditorMotion, options?: MoveOptions): void;
  /** Typed text (joins the current undo group, as CodeMirror's history groups typing). */
  insert(text: string): void;
  /** A bracketed paste: ONE undoable edit, inserted as text (line breaks become the document's). */
  paste(text: string): void;
  /** An editing key by its keys.ts id (arrows, Enter, Tab, Backspace ...); false when it is not one. */
  editKey(key: string): boolean;
  undo(count?: number): boolean;
  redo(count?: number): boolean;
  /** The cursor is on the first visual row of the document. */
  atTop(): boolean;
  /** The cursor: VISUAL's moving end, else the selection head. */
  cursor(): number;
  /** Start (or change the kind of) a VISUAL selection at the cursor; null ends it, leaving the cursor where it is. */
  setVisual(kind: VisualKind | null): void;
  visual(): VisualKind | null;
  /** VISUAL `o`: the cursor moves to the other end of the selection. */
  swapVisualEnds(): void;
  /** The VISUAL selection's text (whole lines end in the document's line break), or null outside VISUAL. */
  selection(): Register | null;
  /** VISUAL `y`: the selection's text; VISUAL ends with the cursor at its start. */
  yank(): Register | null;
  /** VISUAL `d` (and `c`: whole lines leave one empty line): ONE undoable edit; returns what it deleted. */
  deleteSelection(options?: { change?: boolean }): Register | null;
  /** VISUAL `>`/`<`: indentMore/indentLess on the selected lines, `count` times, as ONE undoable edit. */
  indentSelection(direction: 1 | -1, count?: number): boolean;
  /** NORMAL `p`/`P`: put a register after/before the cursor (whole lines below/above its line), ONE undoable edit. */
  put(register: Register, options: { before: boolean; count?: number }): boolean;
  /** The cursor's row among the rows the last render drew (Split's preview lines up with it), or -1. */
  cursorRow(): number;
  /** The last render's first visual row and the document's visual rows at its width (wrapped rows count). */
  scrollPosition(): ScrollPosition;
  /**
   * The document offset shown at cell (x, y) of the last render (relative to
   * the editor, the gutter included); a cell above or below the rows on
   * screen takes the first or last of them, past a row's text its end.
   */
  offsetAt(x: number, y: number): number;
  /** A click: the cursor at `pos`, VISUAL ended. */
  placeCursor(pos: number): void;
  /**
   * A mouse selection: VISUAL of `kind` from `anchor` to `cursor` (both
   * included, as vi's). An end past a line's text stands on its last character.
   */
  selectRange(kind: VisualKind, anchor: number, cursor: number): void;
  /** A double click: VISUAL over the word (or the run of blanks or punctuation) at `pos`. */
  selectWord(pos: number): void;
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
}

// ---------- layout: grapheme clusters to display cells ----------

interface Cell {
  /** Offsets relative to the line start. */
  readonly from: number;
  readonly to: number;
  /** Display column within the row. */
  readonly col: number;
  readonly width: number;
  /** What is drawn: escaped text, a tab as spaces. */
  readonly text: string;
}

interface Row {
  readonly from: number;
  readonly to: number;
  readonly cells: readonly Cell[];
  readonly width: number;
  readonly last: boolean;
}

const MAX_LAYOUT_CACHE = 4000;

/** One logical line cut into rows of at most `width` cells at cluster boundaries; tabs run to the next stop of the line. */
function layoutLine(text: string, width: number, tabSize: number): Row[] {
  const rows: Row[] = [];
  let cells: Cell[] = [];
  let used = 0;
  let rowFrom = 0;
  let column = 0;
  let pos = 0;
  while (pos < text.length) {
    const next = findClusterBreak(text, pos);
    const cluster = text.slice(pos, next);
    let shown: string;
    let cellWidth: number;
    if (cluster === "\t") {
      cellWidth = tabSize - (column % tabSize);
      shown = " ".repeat(cellWidth);
    } else {
      shown = escapeTerminalText(cluster);
      cellWidth = displayWidth(shown);
    }
    if (used + cellWidth > width && cells.length > 0) {
      rows.push({ from: rowFrom, to: pos, cells, width: used, last: false });
      cells = [];
      used = 0;
      rowFrom = pos;
    }
    cells.push({ from: pos, to: next, col: used, width: cellWidth, text: shown });
    used += cellWidth;
    column += cellWidth;
    pos = next;
  }
  rows.push({ from: rowFrom, to: text.length, cells, width: used, last: true });
  return rows;
}

/** The row holding relative offset `rel` (a wrap point belongs to the row it starts). */
function rowIndexOf(rows: readonly Row[], rel: number): number {
  for (let i = rows.length - 1; i > 0; i--) if ((rows[i] as Row).from <= rel) return i;
  return 0;
}

/** Display column of relative offset `rel` in `row` (its end is the row width). */
function columnOf(row: Row, rel: number): number {
  for (const cell of row.cells) if (cell.from >= rel) return cell.col;
  return row.width;
}

/** The relative offset shown at display column `col` of `row`. */
function offsetAt(row: Row, col: number): number {
  for (const cell of row.cells) if (col < cell.col + Math.max(1, cell.width)) return cell.from;
  if (row.last || row.cells.length === 0) return row.to;
  return (row.cells[row.cells.length - 1] as Cell).from;
}

// ---------- vi word motions over grapheme clusters ----------

/** Text as lines of grapheme clusters, for the vi word motions (the editor's lines, the reader's rows). */
export interface ClusterLines {
  readonly count: number;
  /** The clusters of line `line` (0-based). */
  clusters(line: number): readonly string[];
}

/** A place in ClusterLines: `col` is a cluster index, and `col === clusters.length` is the line end. */
export interface ClusterPos {
  readonly line: number;
  readonly col: number;
}

/** vi's character classes: 0 blanks, 1 word characters (letters, digits, marks, `_`), 2 anything else. */
function wordClass(cluster: string | undefined): 0 | 1 | 2 {
  if (cluster === undefined || /^\s+$/u.test(cluster)) return 0;
  return /^[\p{L}\p{N}\p{M}_]/u.test(cluster) ? 1 : 2;
}

/** The run of one vi class (a word, blanks or punctuation) holding cluster `col`: its first and last cluster. */
export function wordAt(clusters: readonly string[], col: number): { readonly first: number; readonly last: number } {
  if (clusters.length === 0) return { first: 0, last: 0 };
  const at = Math.max(0, Math.min(col, clusters.length - 1));
  const kind = wordClass(clusters[at]);
  let first = at;
  while (first > 0 && wordClass(clusters[first - 1]) === kind) first--;
  let last = at;
  while (last + 1 < clusters.length && wordClass(clusters[last + 1]) === kind) last++;
  return { first, last };
}

/** vi `w`: past this word (a run of one class), then past blanks and line ends; an empty line is a word. */
export function wordNext(lines: ClusterLines, from: ClusterPos): ClusterPos {
  let { line, col } = from;
  let cl = lines.clusters(line);
  const start = wordClass(cl[col]);
  if (start !== 0) while (col < cl.length && wordClass(cl[col]) === start) col++;
  for (;;) {
    while (col < cl.length && wordClass(cl[col]) === 0) col++;
    if (col < cl.length || line + 1 >= lines.count) return { line, col };
    line++;
    col = 0;
    cl = lines.clusters(line);
    if (cl.length === 0) return { line, col };
  }
}

/** vi `b`: back past blanks and line ends (an empty line is a word), then to the start of that word. */
export function wordPrev(lines: ClusterLines, from: ClusterPos): ClusterPos {
  let { line, col } = from;
  let cl = lines.clusters(line);
  for (;;) {
    if (col > 0) col--;
    else if (line === 0) return { line, col };
    else {
      line--;
      cl = lines.clusters(line);
      col = cl.length;
      if (cl.length === 0) return { line, col };
      continue;
    }
    if (wordClass(cl[col]) !== 0) break;
  }
  const kind = wordClass(cl[col]);
  while (col > 0 && wordClass(cl[col - 1]) === kind) col--;
  return { line, col };
}

/** vi `e`: one step, past blanks, line ends and empty lines, then to the last cluster of that word. */
export function wordEnd(lines: ClusterLines, from: ClusterPos): ClusterPos {
  let { line, col } = from;
  let cl = lines.clusters(line);
  const step = (): boolean => {
    if (col + 1 < cl.length) {
      col++;
      return true;
    }
    if (line + 1 >= lines.count) return false;
    line++;
    cl = lines.clusters(line);
    col = 0;
    return true;
  };
  if (!step()) return from;
  while (wordClass(cl[col]) === 0) if (!step()) return from;
  const kind = wordClass(cl[col]);
  while (col + 1 < cl.length && wordClass(cl[col + 1]) === kind) col++;
  return { line, col };
}

/** The grapheme clusters of one line (CodeMirror's findClusterBreak, as every motion uses). */
function clustersOf(text: string): string[] {
  const out: string[] = [];
  for (let pos = 0; pos < text.length; ) {
    const next = findClusterBreak(text, pos);
    out.push(text.slice(pos, next));
    pos = next;
  }
  return out;
}

// ---------- syntax cues ----------

const HIGHLIGHTER = tagHighlighter([
  { tag: tags.heading, class: "heading" },
  { tag: tags.strong, class: "strong" },
  { tag: tags.emphasis, class: "emphasis" },
  { tag: tags.list, class: "list" },
  { tag: tags.monospace, class: "code" },
  { tag: [tags.link, tags.url], class: "link" },
  { tag: tags.quote, class: "quote" },
  { tag: tags.processingInstruction, class: "mark" },
]);

interface Look {
  readonly pair: ContrastPair;
  readonly attrs: StyleAttributes;
}

const PLAIN: Look = { pair: "text@bg", attrs: {} };

/**
 * The editor's Markdown highlight cues as theme pairs, with an
 * attribute beside every color so no cue is tint alone: headings and strong
 * text bold, emphasis and quotes italic, links underlined, code and list
 * marks in their roles.
 */
function lookOf(classes: string): Look {
  const names = classes.split(" ");
  const has = (name: string) => names.includes(name);
  const attrs: StyleAttributes = {
    ...(has("heading") || has("strong") ? { bold: true } : {}),
    ...(has("emphasis") || has("quote") ? { italic: true } : {}),
    ...(has("link") ? { underline: true } : {}),
  };
  let pair: ContrastPair = "text@bg";
  if (has("code")) pair = "md.code@bg";
  else if (has("link")) pair = "md.link@bg";
  else if (has("heading")) pair = "md.heading@bg";
  else if (has("quote")) pair = "md.quote@bg";
  else if (has("list") && has("mark")) pair = "md.bullet@bg";
  return { pair, attrs };
}

interface Span {
  readonly from: number;
  readonly to: number;
  readonly look: Look;
}

/** Looks by position for positions visited in increasing order (spans are sorted and disjoint). */
class SpanCursor {
  #index = 0;
  constructor(readonly spans: readonly Span[]) {}
  at(pos: number): Look {
    const spans = this.spans;
    while (this.#index < spans.length && (spans[this.#index] as Span).to <= pos) this.#index++;
    const span = spans[this.#index];
    return span !== undefined && span.from <= pos ? span.look : PLAIN;
  }
}

const sameLook = (a: Look, b: Look): boolean =>
  a.pair === b.pair &&
  a.attrs.bold === b.attrs.bold &&
  a.attrs.italic === b.attrs.italic &&
  a.attrs.underline === b.attrs.underline &&
  a.attrs.inverse === b.attrs.inverse;

// ---------- the editor ----------

interface VisibleRow {
  /** Absolute offset of the line start. */
  readonly lineFrom: number;
  readonly row: Row;
}

const DEFAULT_WIDTH = 1000;
const WHEEL_ROWS = 3;

class Editor implements DocumentEditor {
  height = 10;
  theme: ResolvedTheme | null = null;
  focused = false;
  #state: EditorState;
  readonly #onChange: (state: EditorState) => void;
  /** Text cells per row from the last render (layout before the first render: effectively unwrapped). */
  #width = DEFAULT_WIDTH;
  #gutter = gutterWidth(1);
  /** First visible row: a logical line and a row within it. */
  #top = { line: 1, row: 0 };
  /** The display column vertical motions aim for. */
  #goal: number | null = null;
  #layouts = new Map<string, Row[]>();
  #visible: VisibleRow[] = [];
  #cursorRow = -1;
  /** scrollPosition's memo: each line's first visual row (the total last) for one document at one width. */
  #rowStarts: { doc: Text; width: number; starts: number[] } | null = null;
  /** VISUAL: the fixed end, the moving end (the vi cursor) and the shape; null outside VISUAL. */
  #visual: { kind: VisualKind; anchor: number; cursor: number } | null = null;

  constructor(initial: EditorState, onChange: (state: EditorState) => void) {
    this.#state = initial;
    this.#onChange = onChange;
  }

  getState(): EditorState {
    return this.#state;
  }

  dispatch(spec: TransactionSpec): void {
    this.#apply(this.#state.update(spec));
  }

  setState(state: EditorState): void {
    this.#state = state;
    this.#goal = null;
    this.#visual = null; // its offsets belonged to the replaced text
    if (this.#top.line > state.doc.lines) this.#top = { line: state.doc.lines, row: 0 };
  }

  run(command: StateCommand): boolean {
    return command({ state: this.#state, dispatch: tr => this.#apply(tr) });
  }

  #apply(tr: Transaction, keepGoal = false): void {
    this.#state = tr.state;
    if (!keepGoal) this.#goal = null;
    if (tr.docChanged) {
      this.#visual = null; // an edit ends VISUAL (its operators end it themselves)
      this.#onChange(this.#state);
    }
  }

  // ---------- geometry ----------

  #rows(lineText: string): Row[] {
    const key = `${this.#width}\u0000${lineText}`;
    let rows = this.#layouts.get(key);
    if (rows === undefined) {
      if (this.#layouts.size >= MAX_LAYOUT_CACHE) this.#layouts.clear();
      rows = layoutLine(lineText, this.#width, this.#state.tabSize);
      this.#layouts.set(key, rows);
    }
    return rows;
  }

  /** The (line number, row index, column) of an absolute position. */
  #where(pos: number): { line: number; row: number; col: number } {
    const line = this.#state.doc.lineAt(pos);
    const rows = this.#rows(line.text);
    const row = rowIndexOf(rows, pos - line.from);
    return { line: line.number, row, col: columnOf(rows[row] as Row, pos - line.from) };
  }

  /** The position `delta` visual rows away at display column `goal` (stopping at the document's ends). */
  #rowStep(pos: number, delta: number, goal: number): number {
    const doc = this.#state.doc;
    let line = doc.lineAt(pos);
    let rows = this.#rows(line.text);
    let row = rowIndexOf(rows, pos - line.from);
    let remaining = delta;
    while (remaining > 0) {
      if (row + 1 < rows.length) row++;
      else if (line.number < doc.lines) {
        line = doc.line(line.number + 1);
        rows = this.#rows(line.text);
        row = 0;
      } else break;
      remaining--;
    }
    while (remaining < 0) {
      if (row > 0) row--;
      else if (line.number > 1) {
        line = doc.line(line.number - 1);
        rows = this.#rows(line.text);
        row = rows.length - 1;
      } else break;
      remaining++;
    }
    return line.from + offsetAt(rows[row] as Row, goal);
  }

  /** One cluster step (`dir` ±1), crossing line ends only when `wrap`. */
  #charStep(pos: number, dir: 1 | -1, wrap: boolean): number {
    const doc = this.#state.doc;
    const line = doc.lineAt(pos);
    if (dir > 0) {
      if (pos < line.to) return line.from + findClusterBreak(line.text, pos - line.from, true);
      return wrap && line.number < doc.lines ? pos + 1 : pos;
    }
    if (pos > line.from) return line.from + findClusterBreak(line.text, pos - line.from, false);
    return wrap && line.number > 1 ? pos - 1 : pos;
  }

  /** One word-group step, like CodeMirror's group motion: skip blanks, then one run of one character category. */
  #wordStep(pos: number, dir: 1 | -1): number {
    const state = this.#state;
    const line = state.doc.lineAt(pos);
    if (dir > 0 ? pos === line.to : pos === line.from) return this.#charStep(pos, dir, true);
    const categorize = state.charCategorizer(pos);
    const text = line.text;
    let at = pos - line.from;
    let category: CharCategory | null = null;
    while (dir > 0 ? at < text.length : at > 0) {
      const next = findClusterBreak(text, at, dir > 0);
      const cluster = dir > 0 ? text.slice(at, next) : text.slice(next, at);
      const kind = categorize(cluster);
      if (category === null) {
        if (kind !== CharCategory.Space) category = kind;
      } else if (kind !== category) break;
      at = next;
    }
    return line.from + at;
  }

  atTop(): boolean {
    const where = this.#where(this.cursor());
    return where.line === 1 && where.row === 0;
  }

  cursor(): number {
    return this.#visual?.cursor ?? this.#state.selection.main.head;
  }

  // ---------- clusters (the vi word motions) ----------

  #clusterLines(): ClusterLines {
    const doc = this.#state.doc;
    const cache = new Map<number, string[]>();
    return {
      count: doc.lines,
      clusters: line => {
        let found = cache.get(line);
        if (found === undefined) {
          found = clustersOf(doc.line(line + 1).text);
          cache.set(line, found);
        }
        return found;
      },
    };
  }

  #toCluster(pos: number, lines: ClusterLines): ClusterPos {
    const line = this.#state.doc.lineAt(pos);
    const clusters = lines.clusters(line.number - 1);
    let col = 0;
    for (let at = line.from; col < clusters.length && at < pos; col++) at += (clusters[col] as string).length;
    return { line: line.number - 1, col };
  }

  #fromCluster(place: ClusterPos, lines: ClusterLines): number {
    let pos = this.#state.doc.line(place.line + 1).from;
    const clusters = lines.clusters(place.line);
    for (let i = 0; i < place.col && i < clusters.length; i++) pos += (clusters[i] as string).length;
    return pos;
  }

  // ---------- VISUAL ----------

  visual(): VisualKind | null {
    return this.#visual?.kind ?? null;
  }

  setVisual(kind: VisualKind | null): void {
    const visual = this.#visual;
    if (kind === null) {
      if (visual === null) return;
      this.#visual = null;
      this.#apply(this.#state.update({ selection: EditorSelection.cursor(visual.cursor) }));
      return;
    }
    if (visual !== null) visual.kind = kind;
    else {
      const head = this.#state.selection.main.head;
      this.#visual = { kind, anchor: head, cursor: head };
    }
    this.#selectVisual(true);
  }

  swapVisualEnds(): void {
    const visual = this.#visual;
    if (visual === null) return;
    [visual.anchor, visual.cursor] = [visual.cursor, visual.anchor];
    this.#selectVisual(false);
  }

  /** The end of the cluster at `pos`: the line break at a line end, nothing at the document's end. */
  #clusterEnd(pos: number): number {
    const doc = this.#state.doc;
    const line = doc.lineAt(pos);
    if (pos < line.to) return line.from + findClusterBreak(line.text, pos - line.from, true);
    return line.number < doc.lines ? pos + 1 : pos;
  }

  /** What VISUAL covers: [anchor, cursor] plus the cursor's cluster (charwise), or whole lines. */
  #visualRange(visual: { kind: VisualKind; anchor: number; cursor: number }): { from: number; to: number } {
    const doc = this.#state.doc;
    const first = Math.min(visual.anchor, visual.cursor);
    const last = Math.max(visual.anchor, visual.cursor);
    if (visual.kind === "line") return { from: doc.lineAt(first).from, to: doc.lineAt(last).to };
    return { from: first, to: this.#clusterEnd(last) };
  }

  /** The CodeMirror selection for VISUAL (its head on the cursor's side). */
  #selectVisual(keepGoal: boolean): void {
    const visual = this.#visual;
    if (visual === null) return;
    const { from, to } = this.#visualRange(visual);
    const selection =
      visual.cursor >= visual.anchor ? EditorSelection.range(from, to) : EditorSelection.range(to, from);
    this.#apply(this.#state.update({ selection }), keepGoal);
  }

  selection(): Register | null {
    const visual = this.#visual;
    if (visual === null) return null;
    const { from, to } = this.#visualRange(visual);
    const text = this.#state.sliceDoc(from, to);
    return visual.kind === "line" ? { text: text + this.#state.lineBreak, linewise: true } : { text, linewise: false };
  }

  yank(): Register | null {
    const visual = this.#visual;
    const register = this.selection();
    if (visual === null || register === null) return null;
    const { from } = this.#visualRange(visual);
    this.#visual = null;
    this.#apply(this.#state.update({ selection: EditorSelection.cursor(from) }));
    return register;
  }

  deleteSelection(options: { change?: boolean } = {}): Register | null {
    const visual = this.#visual;
    const register = this.selection();
    if (visual === null || register === null) return null;
    const doc = this.#state.doc;
    const { from, to } = this.#visualRange(visual);
    let changes = { from, to };
    let cursor = from;
    if (visual.kind === "line" && options.change !== true) {
      // Whole lines go with a line break: the one after them, or (the last line) the one before.
      if (doc.lineAt(to).number < doc.lines) changes = { from, to: to + 1 };
      else if (from > 0) {
        changes = { from: from - 1, to };
        cursor = doc.lineAt(from - 1).from;
      }
    }
    this.#operate({ changes, selection: EditorSelection.cursor(cursor), userEvent: "delete.selection" }, from);
    return register;
  }

  indentSelection(direction: 1 | -1, count = 1): boolean {
    const visual = this.#visual;
    if (visual === null) return false;
    const command = direction > 0 ? indentMore : indentLess;
    const start = this.#state;
    let state = start;
    let changes = ChangeSet.empty(start.doc.length);
    for (let i = 0; i < Math.max(1, count); i++) {
      let next: Transaction | null = null;
      command({
        state,
        dispatch: tr => {
          next = tr;
        },
      });
      const tr = next as Transaction | null;
      if (tr === null || tr.changes.empty) break;
      changes = changes.compose(tr.changes);
      state = tr.state;
    }
    const lineStart = start.doc.lineAt(this.#visualRange(visual).from).from;
    if (changes.empty) {
      this.#visual = null;
      this.#apply(start.update({ selection: EditorSelection.cursor(lineStart) }));
      return false;
    }
    // vi leaves the cursor on the first non-blank of the first line.
    const line = state.doc.lineAt(changes.mapPos(lineStart, -1));
    const cursor = line.from + (/\S/.exec(line.text)?.index ?? line.length);
    this.#operate(
      {
        changes,
        selection: EditorSelection.cursor(cursor),
        userEvent: direction > 0 ? "input.indent" : "delete.dedent",
      },
      lineStart,
    );
    return true;
  }

  put(register: Register, options: { before: boolean; count?: number }): boolean {
    if (register.text === "") return false;
    this.#visual = null;
    const doc = this.#state.doc;
    const head = this.#state.selection.main.head;
    const line = doc.lineAt(head);
    const times = Math.max(1, options.count ?? 1);
    if (register.linewise) {
      // Whole lines, in this document's line breaks: above this line (P) or below it (p).
      const lines = register.text.replace(/(?:\r\n|\r|\n)$/, "").split(/\r\n|\r|\n/);
      const all = Array.from({ length: times }, () => lines).flat();
      const at = options.before ? line.from : line.to;
      const insert = Text.of(options.before ? [...all, ""] : ["", ...all]);
      const cursor = options.before ? line.from : line.to + 1;
      this.#operate(
        { changes: { from: at, insert }, selection: EditorSelection.cursor(cursor), userEvent: "input.paste" },
        head,
      );
      return true;
    }
    // Characters: after the cluster under the cursor (p) or before it (P); the cursor ends on the last one.
    const at =
      options.before || head >= line.to ? head : line.from + findClusterBreak(line.text, head - line.from, true);
    const insert = Text.of(register.text.repeat(times).split(/\r\n|\r|\n/));
    const last = insert.line(insert.lines).text;
    const end = at + insert.length;
    const cursor = last === "" ? end : end - (last.length - findClusterBreak(last, last.length, false));
    this.#operate(
      { changes: { from: at, insert }, selection: EditorSelection.cursor(cursor), userEvent: "input.paste" },
      head,
    );
    return true;
  }

  /**
   * One vi operation as ONE undo step: collapse the selection first (outside
   * the history, so undo restores a cursor at `collapseAt`, never a stale
   * VISUAL range), then the edit, isolated from typing on either side.
   */
  #operate(spec: TransactionSpec, collapseAt: number): void {
    this.#visual = null;
    this.#apply(
      this.#state.update({
        selection: EditorSelection.cursor(collapseAt),
        annotations: Transaction.addToHistory.of(false),
      }),
    );
    this.#apply(this.#state.update({ ...spec, annotations: isolateHistory.of("full") }));
  }

  // ---------- motions and edits ----------

  move(motion: EditorMotion, options: MoveOptions = {}): void {
    const count = Math.max(1, options.count ?? 1);
    const extend = options.extend === true;
    const wrap = options.wrap !== false;
    const doc = this.#state.doc;
    const sel = this.#state.selection.main;
    const visual = this.#visual;
    // VISUAL moves its cursor (the selection follows); otherwise the head moves.
    let head = visual?.cursor ?? sel.head;
    let vertical = false;
    const page = Math.max(1, this.height);
    const vertically = (rows: number): void => {
      const goal = this.#goal ?? this.#where(head).col;
      head = this.#rowStep(head, rows, goal);
      this.#goal = goal;
      vertical = true;
    };
    switch (motion) {
      case "left":
      case "right": {
        const dir = motion === "left" ? -1 : 1;
        if (visual === null && !extend && !sel.empty) head = dir < 0 ? sel.from : sel.to;
        else for (let i = 0; i < count; i++) head = this.#charStep(head, dir, wrap);
        break;
      }
      case "up":
        vertically(-count);
        break;
      case "down":
        vertically(count);
        break;
      case "page-up":
        vertically(-page * count);
        break;
      case "page-down":
        vertically(page * count);
        break;
      case "half-page-up":
        vertically(-Math.max(1, Math.floor(page / 2)) * count);
        break;
      case "half-page-down":
        vertically(Math.max(1, Math.floor(page / 2)) * count);
        break;
      case "line-start":
        head = doc.lineAt(head).from;
        break;
      case "line-end":
        head = doc.lineAt(head).to;
        break;
      case "doc-start":
        head = 0;
        break;
      case "doc-end":
        head = doc.length;
        break;
      case "word-left":
      case "word-right": {
        const dir = motion === "word-left" ? -1 : 1;
        for (let i = 0; i < count; i++) head = this.#wordStep(head, dir);
        break;
      }
      case "word-next":
      case "word-prev":
      case "word-end": {
        const lines = this.#clusterLines();
        const step = motion === "word-next" ? wordNext : motion === "word-prev" ? wordPrev : wordEnd;
        let place = this.#toCluster(head, lines);
        for (let i = 0; i < count; i++) place = step(lines, place);
        head = this.#fromCluster(place, lines);
        break;
      }
    }
    const goal = this.#goal;
    if (visual !== null) {
      visual.cursor = head;
      this.#selectVisual(vertical);
    } else {
      const selection = extend ? EditorSelection.range(sel.anchor, head) : EditorSelection.cursor(head);
      this.#apply(this.#state.update({ selection }), vertical);
    }
    if (vertical) this.#goal = goal;
  }

  insert(text: string): void {
    if (text === "") return;
    this.#apply(this.#state.update({ ...this.#state.replaceSelection(text), userEvent: "input.type" }));
  }

  paste(text: string): void {
    if (text === "") return;
    const lines = Text.of(text.split(/\r\n|\r|\n/));
    this.#apply(this.#state.update({ ...this.#state.replaceSelection(lines), userEvent: "input.paste" }));
  }

  editKey(key: string): boolean {
    switch (key) {
      case "enter":
        if (!this.run(insertNewlineContinueMarkup)) this.run(insertNewlineAndIndent);
        return true;
      case "tab":
        this.run(indentMore);
        return true;
      case "shift+tab":
        this.run(indentLess);
        return true;
      case "backspace":
        if (this.#state.selection.main.empty && this.run(deleteMarkupBackward)) return true;
        this.#deleteChar(false);
        return true;
      case "delete":
        this.#deleteChar(true);
        return true;
      case "alt+backspace":
      case "ctrl+w":
        this.run(deleteGroupBackward);
        return true;
      case "ctrl+u":
        this.#deleteToLineStart();
        return true;
    }
    const extend = key.startsWith("shift+");
    const base = extend ? key.slice("shift+".length) : key;
    const motion = MOTION_KEYS[base];
    if (motion === undefined) return false;
    this.move(motion, { extend });
    return true;
  }

  undo(count = 1): boolean {
    let any = false;
    for (let i = 0; i < Math.max(1, count); i++) {
      if (!this.run(undo)) break;
      any = true;
    }
    return any;
  }

  redo(count = 1): boolean {
    let any = false;
    for (let i = 0; i < Math.max(1, count); i++) {
      if (!this.run(redo)) break;
      any = true;
    }
    return any;
  }

  /** CodeMirror's deleteCharBackward/Forward on state alone: the selection, else one cluster (indent units in leading blanks). */
  #deleteChar(forward: boolean): void {
    const state = this.#state;
    const spec = state.changeByRange(range => {
      if (!range.empty)
        return { changes: { from: range.from, to: range.to }, range: EditorSelection.cursor(range.from) };
      const pos = range.head;
      const line = state.doc.lineAt(pos);
      let target: number;
      const before = line.text.slice(0, pos - line.from);
      if (!forward && pos > line.from && pos < line.from + 200 && !/[^ \t]/.test(before)) {
        if (before.endsWith("\t")) target = pos - 1;
        else {
          const unit = getIndentUnit(state);
          const drop = countColumn(before, state.tabSize) % unit || unit;
          target = pos;
          for (let i = 0; i < drop && before[before.length - 1 - i] === " "; i++) target--;
        }
      } else {
        target = findClusterBreak(line.text, pos - line.from, forward, forward) + line.from;
        if (target === pos && line.number !== (forward ? state.doc.lines : 1)) target += forward ? 1 : -1;
        else if (!forward && /[\ufe00-\ufe0f]/.test(line.text.slice(target - line.from, pos - line.from))) {
          target = findClusterBreak(line.text, target - line.from, false, false) + line.from;
        }
      }
      const from = Math.min(pos, target);
      const to = Math.max(pos, target);
      return { changes: { from, to }, range: EditorSelection.cursor(from) };
    });
    if (spec.changes.empty) return;
    this.#apply(state.update(spec, { userEvent: forward ? "delete.forward" : "delete.backward" }));
  }

  #deleteToLineStart(): void {
    const state = this.#state;
    const spec = state.changeByRange(range => {
      const from = range.empty ? state.doc.lineAt(range.head).from : range.from;
      return { changes: { from, to: range.to }, range: EditorSelection.cursor(from) };
    });
    if (spec.changes.empty) return;
    this.#apply(state.update(spec, { userEvent: "delete.backward" }));
  }

  // ---------- rendering ----------

  invalidate(): void {
    this.#layouts.clear();
  }

  cursorRow(): number {
    return this.#cursorRow;
  }

  scrollPosition(): ScrollPosition {
    const doc = this.#state.doc;
    let memo = this.#rowStarts;
    if (memo === null || memo.doc !== doc || memo.width !== this.#width) {
      const starts = [0];
      for (let n = 1; n <= doc.lines; n++) starts[n] = starts[n - 1] + this.#rows(doc.line(n).text).length;
      memo = { doc, width: this.#width, starts };
      this.#rowStarts = memo;
    }
    const line = Math.min(this.#top.line, doc.lines);
    return { top: memo.starts[line - 1] + this.#top.row, total: memo.starts[doc.lines] };
  }

  render(width: number): string[] {
    const theme = this.theme;
    const height = Math.max(0, this.height);
    if (theme === null || width <= 0) return Array.from({ length: height }, () => "");
    const state = this.#state;
    const doc = state.doc;
    this.#gutter = Math.min(gutterWidth(doc.lines), Math.max(0, width - 1));
    const digits = this.#gutter - 1;
    const textWidth = Math.max(1, width - this.#gutter - 1);
    if (textWidth !== this.#width) {
      this.#width = textWidth;
      this.#layouts.clear();
    }
    this.#reveal(height);
    const visible = this.#collect(height);
    this.#visible = visible;
    const main = state.selection.main;
    const cursor = this.cursor();
    const where = this.#where(cursor);
    const cursorFrom = doc.line(where.line).from;
    const rowFrom = this.#rows(doc.line(where.line).text)[where.row]?.from ?? 0;
    this.#cursorRow = visible.findIndex(v => v.lineFrom === cursorFrom && v.row.from === rowFrom);
    const cursorLine = doc.lineAt(cursor).number;
    const visual = this.#visual === null ? null : { kind: this.#visual.kind, ...this.#visualRange(this.#visual) };
    const spans = new SpanCursor(this.#highlight(visible));
    const out: string[] = [];
    for (const { lineFrom, row } of visible) {
      const lineNumber = doc.lineAt(lineFrom).number;
      let line = "";
      // Gutter: the number on a line's first row; the cursor line's number is bold, never tint alone.
      if (digits > 0) {
        const label = row.from === 0 ? String(lineNumber).padStart(digits) : " ".repeat(digits);
        line +=
          lineNumber === cursorLine && row.from === 0
            ? style(theme, "accent@bg", label, { bold: true })
            : style(theme, "dim@bg", label);
        line += style(theme, "text@bg", " ");
      }
      line +=
        visual === null
          ? this.#paintRow(theme, lineFrom, row, spans, main, textWidth + 1)
          : this.#paintVisualRow(theme, lineFrom, row, spans, visual, cursor, textWidth + 1);
      out.push(line);
    }
    while (out.length < height) out.push(style(theme, "text@bg", " ".repeat(width)));
    return out;
  }

  /** The row cells as styled runs: syntax look, selection, the block cursor (and the marker while focused). */
  #paintRow(
    theme: ResolvedTheme,
    lineFrom: number,
    row: Row,
    spans: SpanCursor,
    main: { from: number; to: number; head: number; empty: boolean },
    width: number,
  ): string {
    let out = "";
    let used = 0;
    let run = "";
    let runLook: Look | null = null;
    const flush = (): void => {
      if (runLook !== null && run !== "") out += style(theme, runLook.pair, run, runLook.attrs);
      run = "";
      runLook = null;
    };
    for (const cell of row.cells) {
      if (used + cell.width > width) break;
      const pos = lineFrom + cell.from;
      let look = spans.at(pos);
      const selected = !main.empty && pos >= main.from && pos < main.to;
      if (selected) look = { pair: "text@selection", attrs: look.attrs };
      if (pos === main.head && this.focused) {
        flush();
        out += CURSOR_MARKER + style(theme, look.pair, cell.text || " ", { ...look.attrs, inverse: true });
      } else {
        if (runLook !== null && !sameLook(runLook, look)) flush();
        runLook = look;
        run += cell.text;
      }
      used += cell.width;
    }
    flush();
    const end = lineFrom + row.to;
    if (this.focused && row.last && main.head === end && used < width) {
      out += CURSOR_MARKER + style(theme, "text@bg", " ", { inverse: true });
      used++;
    }
    if (used < width) out += style(theme, "text@bg", " ".repeat(width - used));
    return out;
  }

  /**
   * A row under VISUAL: selected cells in the selection pair PLUS inverse (so
   * the selection shows without color), the cursor as an underlined hole in
   * it, and one selected cell for a selected line break or empty line.
   */
  #paintVisualRow(
    theme: ResolvedTheme,
    lineFrom: number,
    row: Row,
    spans: SpanCursor,
    visual: { kind: VisualKind; from: number; to: number },
    cursor: number,
    width: number,
  ): string {
    let out = "";
    let used = 0;
    let run = "";
    let runLook: Look | null = null;
    const flush = (): void => {
      if (runLook !== null && run !== "") out += style(theme, runLook.pair, run, runLook.attrs);
      run = "";
      runLook = null;
    };
    const hole = (look: Look, text: string): void => {
      flush();
      out += CURSOR_MARKER + style(theme, look.pair, text, { ...look.attrs, inverse: false, underline: true });
    };
    for (const cell of row.cells) {
      if (used + cell.width > width) break;
      const pos = lineFrom + cell.from;
      let look = spans.at(pos);
      if (pos === cursor && this.focused) hole(look, cell.text || " ");
      else {
        if (pos >= visual.from && pos < visual.to)
          look = { pair: "text@selection", attrs: { ...look.attrs, inverse: true } };
        if (runLook !== null && !sameLook(runLook, look)) flush();
        runLook = look;
        run += cell.text;
      }
      used += cell.width;
    }
    flush();
    const end = lineFrom + row.to;
    if (row.last && used < width) {
      // The line break: selected charwise when the range covers it; an empty line of a linewise selection.
      const selected =
        visual.kind === "char"
          ? end >= visual.from && end < visual.to
          : lineFrom === end && end >= visual.from && end <= visual.to;
      if (end === cursor && this.focused) hole(PLAIN, " ");
      else if (selected) out += style(theme, "text@selection", " ", { inverse: true });
      if ((end === cursor && this.focused) || selected) used++;
    }
    if (used < width) out += style(theme, "text@bg", " ".repeat(width - used));
    return out;
  }

  /** Move the first visible row so the cursor row is on screen. */
  #reveal(height: number): void {
    const doc = this.#state.doc;
    if (this.#top.line > doc.lines) this.#top = { line: doc.lines, row: 0 };
    const topRows = this.#rows(doc.line(this.#top.line).text);
    if (this.#top.row >= topRows.length) this.#top = { line: this.#top.line, row: topRows.length - 1 };
    const cursor = this.#where(this.cursor());
    if (cursor.line < this.#top.line || (cursor.line === this.#top.line && cursor.row < this.#top.row)) {
      this.#top = { line: cursor.line, row: cursor.row };
      return;
    }
    // Rows from the top to the cursor, counting at most a screenful.
    let line = this.#top.line;
    let row = this.#top.row;
    for (let n = 0; n < Math.max(1, height); n++) {
      if (line === cursor.line && row === cursor.row) return;
      const rows = this.#rows(doc.line(line).text);
      if (row + 1 < rows.length) row++;
      else if (line < doc.lines) {
        line++;
        row = 0;
      } else return;
    }
    // Below the screen: the cursor row becomes the last visible row.
    line = cursor.line;
    row = cursor.row;
    for (let n = 1; n < Math.max(1, height); n++) {
      if (row > 0) row--;
      else if (line > 1) {
        line--;
        row = this.#rows(doc.line(line).text).length - 1;
      } else break;
    }
    this.#top = { line, row };
  }

  #collect(height: number): VisibleRow[] {
    const doc = this.#state.doc;
    const out: VisibleRow[] = [];
    let lineNumber = this.#top.line;
    let row = this.#top.row;
    while (out.length < height && lineNumber <= doc.lines) {
      const line = doc.line(lineNumber);
      const rows = this.#rows(line.text);
      for (; row < rows.length && out.length < height; row++) out.push({ lineFrom: line.from, row: rows[row] as Row });
      lineNumber++;
      row = 0;
    }
    return out;
  }

  /** Syntax looks over the visible range, from the Markdown syntax tree (parsed as far as a short budget allows). */
  #highlight(visible: readonly VisibleRow[]): Span[] {
    const first = visible[0];
    const last = visible[visible.length - 1];
    if (first === undefined || last === undefined) return [];
    const from = first.lineFrom + first.row.from;
    const to = last.lineFrom + last.row.to;
    const tree = ensureSyntaxTree(this.#state, to, 25) ?? syntaxTree(this.#state);
    const spans: Span[] = [];
    highlightTree(
      tree,
      HIGHLIGHTER,
      (start, end, classes) => spans.push({ from: start, to: end, look: lookOf(classes) }),
      from,
      to,
    );
    return spans;
  }

  /** The visual row after (`dir` 1) or before (-1) `at`; null past the document's ends. */
  #rowBeside(at: { line: number; row: number }, dir: 1 | -1): { line: number; row: number } | null {
    const doc = this.#state.doc;
    if (dir > 0) {
      if (at.row + 1 < this.#rows(doc.line(at.line).text).length) return { line: at.line, row: at.row + 1 };
      return at.line < doc.lines ? { line: at.line + 1, row: 0 } : null;
    }
    if (at.row > 0) return { line: at.line, row: at.row - 1 };
    return at.line > 1 ? { line: at.line - 1, row: this.#rows(doc.line(at.line - 1).text).length - 1 } : null;
  }

  /**
   * The wheel (vi's Ctrl-E/Ctrl-Y): the first visible row moves `delta` rows
   * (wrapped rows count, as in #reveal), stopping at the document's start and
   * where its last row reaches the bottom. The cursor stays while it is still
   * shown; else it moves to the nearest visible row, keeping its column.
   */
  #scroll(delta: number): void {
    const doc = this.#state.doc;
    const height = Math.max(1, this.height);
    const before = (a: { line: number; row: number }, b: { line: number; row: number }): boolean =>
      a.line < b.line || (a.line === b.line && a.row < b.row);
    const topLine = Math.min(this.#top.line, doc.lines);
    let top = {
      line: topLine,
      row: Math.min(this.#top.row, this.#rows(doc.line(topLine).text).length - 1),
    };
    // The lowest top: the document's last row on the bottom row.
    let lowest = { line: doc.lines, row: this.#rows(doc.line(doc.lines).text).length - 1 };
    for (let n = 1; n < height; n++) lowest = this.#rowBeside(lowest, -1) ?? lowest;
    for (let n = 0; n < Math.abs(delta); n++) {
      const next = delta > 0 ? (before(top, lowest) ? this.#rowBeside(top, 1) : null) : this.#rowBeside(top, -1);
      if (next === null) break;
      top = next;
    }
    this.#top = top;
    let bottom = top;
    for (let n = 1; n < height; n++) bottom = this.#rowBeside(bottom, 1) ?? bottom;
    const head = this.cursor();
    const where = this.#where(head);
    const target = before(where, top) ? top : before(bottom, where) ? bottom : null;
    if (target === null) return; // still shown: it stays
    const goal = this.#goal ?? where.col;
    const line = doc.line(target.line);
    const pos = line.from + offsetAt(this.#rows(line.text)[target.row] as Row, goal);
    const visual = this.#visual;
    if (visual !== null) {
      visual.cursor = pos;
      this.#selectVisual(true);
    } else this.#apply(this.#state.update({ selection: EditorSelection.cursor(pos) }), true);
    this.#goal = goal;
  }

  // ---------- mouse ----------

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "wheel") {
      const rows = Math.sign(event.wheelDelta ?? 0) * WHEEL_ROWS;
      if (rows !== 0) this.#scroll(rows);
      return { handled: true };
    }
    if (event.type !== "click" || event.button !== "left") return undefined;
    this.placeCursor(this.offsetAt(event.x, event.y));
    return { handled: true };
  }

  offsetAt(x: number, y: number): number {
    const visible = this.#visible;
    if (visible.length === 0) return this.#state.doc.length;
    if (y >= visible.length) {
      // Below the last row on screen: the end of that row (the document's end when it is the last).
      const last = visible[visible.length - 1] as VisibleRow;
      return last.lineFrom + last.row.to;
    }
    const target = visible[Math.max(0, y)] as VisibleRow;
    return target.lineFrom + offsetAt(target.row, Math.max(0, x - this.#gutter));
  }

  placeCursor(pos: number): void {
    this.#visual = null; // a click places the cursor: VISUAL ends
    this.dispatch({ selection: EditorSelection.cursor(this.#clamp(pos)) });
  }

  selectRange(kind: VisualKind, anchor: number, cursor: number): void {
    this.#visual = { kind, anchor: this.#onText(anchor), cursor: this.#onText(cursor) };
    this.#selectVisual(false);
  }

  selectWord(pos: number): void {
    const lines = this.#clusterLines();
    const place = this.#toCluster(this.#clamp(pos), lines);
    const clusters = lines.clusters(place.line);
    const { first, last } = wordAt(clusters, place.col);
    const anchor = this.#fromCluster({ line: place.line, col: first }, lines);
    const cursor = this.#fromCluster({ line: place.line, col: last }, lines);
    this.#visual = { kind: "char", anchor, cursor };
    this.#selectVisual(false);
  }

  #clamp(pos: number): number {
    return Math.max(0, Math.min(pos, this.#state.doc.length));
  }

  /** `pos`, or the last character of its line when it is past the line's text (an empty line keeps its break). */
  #onText(pos: number): number {
    const at = this.#clamp(pos);
    const line = this.#state.doc.lineAt(at);
    if (at < line.to || line.length === 0) return at;
    return line.from + findClusterBreak(line.text, line.length, false);
  }
}

/** Editing keys that are motions (their shift+ forms extend the selection). */
const MOTION_KEYS: Readonly<Record<string, EditorMotion>> = {
  left: "left",
  right: "right",
  up: "up",
  down: "down",
  home: "line-start",
  end: "line-end",
  "ctrl+a": "line-start",
  "ctrl+e": "line-end",
  "ctrl+home": "doc-start",
  "ctrl+end": "doc-end",
  pageUp: "page-up",
  pageDown: "page-down",
  "alt+left": "word-left",
  "ctrl+left": "word-left",
  "alt+b": "word-left",
  "alt+right": "word-right",
  "ctrl+right": "word-right",
  "alt+f": "word-right",
};

/** A document editor over `initial`; `onChange` receives every state whose document changed. */
export function createDocumentEditor(initial: EditorState, onChange: (state: EditorState) => void): DocumentEditor {
  return new Editor(initial, onChange);
}
