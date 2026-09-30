// The help view (`?`, :help): the shell's lines (src/tui/app.ts #helpLines,
// built from the COMMANDS registry, the key table, the fixed keys and the
// tui.toml settings (config.ts SETTING_HELP), so
// help keeps its single sources) wrapped to the pane and searchable.
//
// - wrapHelp: rows of the pane's width in display cells, broken at spaces
//   (a longer word is cut at the row's end). A continuation row starts at
//   its line's hang (the description column, capped at half the width), so
//   a description stays in its column and is never cut short with "…".
// - `/` while the help is open searches it (session.submitPrompt), never the
//   task list: literal and case-insensitive over each whole line, so a match
//   may cross a wrap. Every match is drawn in the search pair, underlined;
//   the current one is bold with `▸` in the margin, scrolled into view when
//   it becomes current (j/k then scroll away freely). n/N step with
//   wrap-around (session.stepResult) and the status line says which match
//   of how many.
//   An empty search clears it; closing the help forgets it
//   (session.openView/closeView).

import { displayWidth, escapeTerminalText } from "./safety.ts";
import type { TuiSession } from "./session.ts";
import { paint, type ResolvedTheme, type Seg, seg } from "./theme.ts";

/** One logical help line: escaped segments, and the cells its continuation rows start at. */
export interface HelpLine {
  readonly segs: readonly Seg[];
  readonly hang?: number;
}

/** One screen row of a line: [start, end) of the line's text, drawn `indent` cells in. */
export interface HelpRow {
  readonly line: number;
  readonly start: number;
  readonly end: number;
  readonly indent: number;
}

/** A search match: [start, end) of a line's text. */
export interface HelpMatch {
  readonly line: number;
  readonly start: number;
  readonly end: number;
}

/** What the help uses of its session: the view's scroll, the status line and redraws. */
export type HelpHost = Pick<TuiSession, "viewScroll" | "setViewScroll" | "notify" | "redraw">;

/** The margin cell before every row: `▸` on the current match's row. */
const MARGIN = 1;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A line's whole text: what wraps and what is searched. */
function helpText(line: HelpLine): string {
  return line.segs.map(s => s.text).join("");
}

/** One line's rows in `width` cells: continuation rows start `hang` cells in; the spaces at a break are dropped. */
function wrapLine(text: string, width: number, hang: number): Omit<HelpRow, "line">[] {
  const cells = Array.from(graphemes.segment(text), g => ({
    at: g.index,
    width: displayWidth(g.segment),
    space: g.segment === " ",
  }));
  const rows: Omit<HelpRow, "line">[] = [];
  let i = 0;
  if (cells.length === 0) return [{ start: 0, end: 0, indent: 0 }];
  while (i < cells.length) {
    const indent = rows.length === 0 ? 0 : hang;
    const room = Math.max(1, width - indent);
    let used = 0;
    let j = i;
    // The last space after a word on this row: the row may end before it.
    let brk = -1;
    let word = false;
    // At least one cell a row, so a cell wider than the row still moves on.
    for (let cell = cells[j]; cell !== undefined && (j === i || used + cell.width <= room); cell = cells[j]) {
      if (!cell.space) word = true;
      else if (word) brk = j;
      used += cell.width;
      j++;
    }
    const stop = cells[j];
    if (stop === undefined) {
      rows.push({ start: cells[i]?.at ?? 0, end: text.length, indent });
      break;
    }
    const end = stop.space ? j : brk > i ? brk : j;
    rows.push({ start: cells[i]?.at ?? 0, end: cells[end]?.at ?? text.length, indent });
    i = end;
    while (cells[i]?.space === true) i++;
  }
  return rows;
}

/** Every line as rows of `width` cells (the hang is capped at half the width, so a continuation row has room). */
export function wrapHelp(lines: readonly HelpLine[], width: number): HelpRow[] {
  const cells = Math.max(1, width);
  return lines.flatMap((line, index) => {
    const hang = Math.min(Math.max(0, line.hang ?? 0), Math.floor(cells / 2));
    return wrapLine(helpText(line), cells, hang).map(row => ({ line: index, ...row }));
  });
}

/** Every occurrence of `query` (literal, case-insensitive) in each whole line, in order; none for "". */
export function findHelpMatches(lines: readonly HelpLine[], query: string): HelpMatch[] {
  if (query === "") return [];
  const pattern = new RegExp(escapeRegExp(query), "giu");
  return lines.flatMap((line, index) =>
    Array.from(helpText(line).matchAll(pattern), m => ({
      line: index,
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
    })),
  );
}

const sameMatch = (a: HelpMatch, b: HelpMatch): boolean => a.line === b.line && a.start === b.start;

/** A row's segments: the line's styling, with the matches in the search pair (underlined; the current one bold). */
function rowSegs(line: HelpLine, row: HelpRow, matches: readonly HelpMatch[], current: HelpMatch | null): Seg[] {
  const out: Seg[] = [];
  let offset = 0;
  for (const part of line.segs) {
    const from = Math.max(row.start, offset);
    const to = Math.min(row.end, offset + part.text.length);
    const piece = (a: number, b: number): string => part.text.slice(a - offset, b - offset);
    if (from < to) {
      let at = from;
      for (const m of matches) {
        const a = Math.max(m.start, at);
        const b = Math.min(m.end, to);
        if (a >= b) continue;
        if (a > at) out.push(seg(part.pair, piece(at, a), part.attrs));
        const bold = current !== null && sameMatch(m, current);
        out.push(seg("text@search", piece(a, b), { underline: true, bold }));
        at = b;
      }
      if (at < to) out.push(seg(part.pair, piece(at, to), part.attrs));
    }
    offset += part.text.length;
  }
  return out;
}

export class Help {
  #query = "";
  #current: HelpMatch | null = null;
  /** The last frame's rows and height: where the top of the view is, and where a match is shown. */
  #rows: readonly HelpRow[] = [];
  #shown = 0;

  constructor(
    private readonly host: HelpHost,
    private readonly lines: () => readonly HelpLine[],
  ) {}

  /** The search ("" when there is none). */
  get query(): string {
    return this.#query;
  }

  /** The match shown (1-based; 0 when none is) and how many there are; null without a search. */
  searchStatus(): { readonly query: string; readonly index: number; readonly count: number } | null {
    if (this.#query === "") return null;
    const list = findHelpMatches(this.lines(), this.#query);
    const current = this.#current;
    const index = current === null ? 0 : list.findIndex(m => sameMatch(m, current)) + 1;
    return { query: this.#query, index, count: list.length };
  }

  /** `/` in the help: the first match from the top of the view (else from the top); an empty search clears it. */
  search(text: string): void {
    const host = this.host;
    this.#query = escapeTerminalText(text.replace(/[\r\n]+/g, " ").trim());
    this.#current = null;
    if (this.#query === "") {
      host.notify("info", "Help search cleared");
      host.redraw();
      return;
    }
    const list = findHelpMatches(this.lines(), this.#query);
    if (list.length === 0) {
      host.notify("info", `No match for /${this.#query} in the help`);
      host.redraw();
      return;
    }
    const index = list.findIndex(m => this.#fromTop(m));
    this.#goto(list, index < 0 ? 0 : index, index < 0 ? " (from the top)" : "");
  }

  /** n / N: the next or previous match, `|delta|` of them, wrapping at the ends. */
  step(delta: number): void {
    const host = this.host;
    if (this.#query === "") {
      host.notify("info", "No search in the help: / searches it, then n and N step through the matches");
      return;
    }
    if (delta === 0) return;
    const list = findHelpMatches(this.lines(), this.#query);
    const n = list.length;
    if (n === 0) {
      host.notify("info", `No match for /${this.#query} in the help`);
      return;
    }
    const current = this.#current;
    let at = current === null ? -1 : list.findIndex(m => sameMatch(m, current));
    if (at < 0) {
      // No match shown: the first step lands on the nearest one in that direction from the top of the view.
      const after = list.findIndex(m => this.#fromTop(m));
      at = delta > 0 ? (after < 0 ? n : after) - 1 : after < 0 ? n : after;
    }
    const raw = at + delta;
    const note = raw >= n ? " (wrapped to the first)" : raw < 0 ? " (wrapped to the last)" : "";
    this.#goto(list, ((raw % n) + n) % n, note);
  }

  /** Forget the search (the help closed). */
  clear(): void {
    this.#query = "";
    this.#current = null;
  }

  /** `height` rows of `width` cells from the session's view scroll (clamped to the help). */
  render(theme: ResolvedTheme, width: number, height: number): string[] {
    const lines = this.lines();
    const rows = wrapHelp(lines, width - MARGIN);
    this.#rows = rows;
    this.#shown = height;
    const matches = findHelpMatches(lines, this.#query);
    const found = this.#current;
    const current = found !== null && matches.some(m => sameMatch(m, found)) ? found : null;
    const marked = current === null ? -1 : rowOf(rows, current);
    const scroll = Math.min(this.host.viewScroll, Math.max(0, rows.length - height));
    this.host.setViewScroll(scroll);
    const out = rows.slice(scroll, scroll + height).map((row, i) => {
      const segs: Seg[] = [scroll + i === marked ? seg("accent@bg", "\u25b8") : seg("text@bg", " ")];
      if (row.indent > 0) segs.push(seg("text@bg", " ".repeat(row.indent)));
      const line = lines[row.line];
      const own = matches.filter(m => m.line === row.line);
      if (line !== undefined) segs.push(...rowSegs(line, row, own, current));
      return paint(theme, segs, width, "text@bg");
    });
    while (out.length < height) out.push(paint(theme, [], width, "text@bg"));
    return out;
  }

  /** At or below the top of the view (the last frame's first row); everything is before the first frame. */
  #fromTop(m: HelpMatch): boolean {
    const top = this.#rows[Math.min(this.host.viewScroll, this.#rows.length - 1)];
    return top === undefined || m.line > top.line || (m.line === top.line && m.end > top.start);
  }

  /** Make `index` the current match, scrolled into view (a few rows of context above it) when it is not shown. */
  #goto(list: readonly HelpMatch[], index: number, note: string): void {
    const match = list[index];
    if (match === undefined) return;
    this.#current = match;
    const row = rowOf(this.#rows, match);
    const top = this.host.viewScroll;
    const shown = this.#shown;
    if (row >= 0 && (row < top || row >= top + shown)) {
      const max = Math.max(0, this.#rows.length - shown);
      this.host.setViewScroll(Math.max(0, Math.min(max, row - Math.min(2, Math.floor(shown / 3)))));
    }
    this.host.notify("info", `/${this.#query}: match ${index + 1} of ${list.length}${note}`);
    this.host.redraw();
  }
}

/** The row a match starts on (its first character is never a dropped space: a query is trimmed), or -1. */
function rowOf(rows: readonly HelpRow[], m: HelpMatch): number {
  return rows.findIndex(r => r.line === m.line && m.start >= r.start && m.start < r.end);
}

/** The help of this session (the shell's lines), registered so `/` and n/N reach it while the help is open. */
export function createHelp(session: TuiSession, lines: () => readonly HelpLine[]): Help {
  const help = new Help(session, lines);
  session.attachHelp(help);
  return help;
}
