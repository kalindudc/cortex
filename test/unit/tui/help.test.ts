import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG } from "../../../src/tui/config.ts";
import { findHelpMatches, Help, type HelpHost, type HelpLine, wrapHelp } from "../../../src/tui/help.ts";
import { resolveTheme, seg } from "../../../src/tui/theme.ts";

// The help view (`?`, :help): its lines wrap to the pane (a continuation row
// starts at the line's hang, so a description stays in its column and is
// never cut) and `/` searches them while the help is open: case-insensitive
// and literal over each whole line (a match may cross a wrap), every match
// in the search pair, the current one bold and marked `▸` in the margin,
// n/N stepping with wrap-around.

const theme = resolveTheme({ config: DEFAULT_CONFIG, env: { NO_COLOR: "1" } });
const plain = (rows: string[]): string[] => rows.map(r => r.replace(/\x1b\[[0-9;]*m/g, ""));
const line = (text: string, hang?: number): HelpLine => ({ segs: [seg("text@bg", text)], hang });

/** The session's share the help uses: the view scroll, the status line and redraws. */
function fakeHost() {
  let scroll = 0;
  const notes: string[] = [];
  const host: HelpHost = {
    get viewScroll() {
      return scroll;
    },
    setViewScroll: (value: number) => {
      scroll = Math.max(0, value);
    },
    notify: (_level, text) => {
      notes.push(text);
    },
    redraw: () => {},
  } as HelpHost;
  return { host, notes, scroll: () => scroll };
}

describe("wrapHelp: rows of the pane's width, offsets into each whole line", () => {
  test("a line that fits is one row, an empty line one empty row; a long one breaks at spaces and hangs its continuation rows", () => {
    const entry: HelpLine = {
      segs: [seg("text@bg", "  :cmd    "), seg("muted@bg", "alpha beta gamma delta epsilon")],
      hang: 10,
    };
    expect(wrapHelp([line("short"), { segs: [] }, entry], 24)).toEqual([
      { line: 0, start: 0, end: 5, indent: 0 },
      { line: 1, start: 0, end: 0, indent: 0 },
      // "  :cmd    alpha beta" | "gamma delta" | "epsilon": the spaces at a break are not shown.
      { line: 2, start: 0, end: 20, indent: 0 },
      { line: 2, start: 21, end: 32, indent: 10 },
      { line: 2, start: 33, end: 40, indent: 10 },
    ]);
  });

  test("a word longer than a row is cut at the row's end; the hang always leaves a continuation row room", () => {
    // Width 6, hang 4: the hang is capped at half the width, so continuation rows keep 3 cells.
    expect(wrapHelp([line("abcdefghijklmnop", 4)], 6)).toEqual([
      { line: 0, start: 0, end: 6, indent: 0 },
      { line: 0, start: 6, end: 9, indent: 3 },
      { line: 0, start: 9, end: 12, indent: 3 },
      { line: 0, start: 12, end: 15, indent: 3 },
      { line: 0, start: 15, end: 16, indent: 3 },
    ]);
    // Leading spaces (an entry's indent) never make a row of their own.
    expect(wrapHelp([line("  abcdefgh")], 5)).toEqual([
      { line: 0, start: 0, end: 5, indent: 0 },
      { line: 0, start: 5, end: 10, indent: 0 },
    ]);
  });

  test("cells, not code units: wide characters take two", () => {
    expect(wrapHelp([line("日本語です")], 5)).toEqual([
      { line: 0, start: 0, end: 2, indent: 0 },
      { line: 0, start: 2, end: 4, indent: 0 },
      { line: 0, start: 4, end: 5, indent: 0 },
    ]);
  });
});

describe("findHelpMatches: literal, case-insensitive, over each whole line", () => {
  const lines: HelpLine[] = [
    { segs: [seg("text@bg", "  :q  :quit  "), seg("muted@bg", "Quit (the QUIT command)")] },
    { segs: [seg("accent@bg", "a.b a+b")] },
  ];

  test("every occurrence in any case, across the line's segments", () => {
    expect(findHelpMatches(lines, "quit")).toEqual([
      { line: 0, start: 7, end: 11 },
      { line: 0, start: 13, end: 17 },
      { line: 0, start: 23, end: 27 },
    ]);
    expect(findHelpMatches(lines, "quit  Quit")).toEqual([{ line: 0, start: 7, end: 17 }]);
  });

  test("the query is text, never a pattern; an empty one matches nothing", () => {
    expect(findHelpMatches(lines, "a.b")).toEqual([{ line: 1, start: 0, end: 3 }]);
    expect(findHelpMatches(lines, "a+b")).toEqual([{ line: 1, start: 4, end: 7 }]);
    expect(findHelpMatches(lines, "(the")).toEqual([{ line: 0, start: 18, end: 22 }]);
    expect(findHelpMatches(lines, "")).toEqual([]);
  });
});

describe("Help: search, step and render", () => {
  // Thirty one-row lines; the needle is on lines 3, 13 and 23.
  const LINES: HelpLine[] = Array.from({ length: 30 }, (_, i) =>
    line(i % 10 === 3 ? `row ${i} has the needle` : `row ${i}`),
  );
  const marked = (rows: string[]): string[] => plain(rows).filter(r => r.startsWith("\u25b8"));

  test("/ finds the first match from the top of the view, reveals and marks it; n/N step, wrap, and say so", () => {
    const { host, notes, scroll } = fakeHost();
    const help = new Help(host, () => LINES);
    help.render(theme, 40, 10);
    help.search("NEEDLE");
    expect(notes.at(-1)).toBe("/NEEDLE: match 1 of 3");
    expect(help.searchStatus()).toEqual({ query: "NEEDLE", index: 1, count: 3 });
    let rows = help.render(theme, 40, 10);
    expect(rows.length).toBe(10);
    for (const row of rows) expect(visibleWidth(row)).toBe(40);
    expect(marked(rows).map(r => r.trimEnd())).toEqual(["\u25b8row 3 has the needle"]);
    expect(scroll()).toBe(0); // already in view
    help.step(1);
    expect(notes.at(-1)).toBe("/NEEDLE: match 2 of 3");
    rows = help.render(theme, 40, 10);
    expect(scroll()).toBe(11); // a few rows of context above it
    expect(marked(rows)[0]).toContain("row 13 has the needle");
    help.step(1);
    help.render(theme, 40, 10);
    expect(scroll()).toBe(20); // as far as the help scrolls: row 23 is shown
    help.step(1);
    expect(notes.at(-1)).toBe("/NEEDLE: match 1 of 3 (wrapped to the first)");
    rows = help.render(theme, 40, 10);
    expect(scroll()).toBe(1);
    expect(marked(rows)[0]).toContain("row 3 has the needle");
    help.step(-1);
    expect(notes.at(-1)).toBe("/NEEDLE: match 3 of 3 (wrapped to the last)");
    help.step(-2);
    expect(notes.at(-1)).toBe("/NEEDLE: match 1 of 3");
  });

  test("the search starts at the top of the view (from the top when nothing is below it); scrolling away afterwards is left alone", () => {
    const { host, notes, scroll } = fakeHost();
    const help = new Help(host, () => LINES);
    host.setViewScroll(12);
    help.render(theme, 40, 10);
    help.search("needle");
    expect(notes.at(-1)).toBe("/needle: match 2 of 3");
    help.render(theme, 40, 10);
    expect(scroll()).toBe(12); // line 13 is already shown
    // j/k scroll the help freely afterwards: the match is revealed once, not pinned.
    host.setViewScroll(18);
    help.render(theme, 40, 10);
    expect(scroll()).toBe(18);
    help.search("row 3 has");
    expect(notes.at(-1)).toBe("/row 3 has: match 1 of 1 (from the top)");
    help.render(theme, 40, 10);
    expect(scroll()).toBe(1);
    help.clear();
    expect(help.query).toBe("");
    expect(help.searchStatus()).toBeNull();
    expect(marked(help.render(theme, 40, 10))).toEqual([]);
  });

  test("every match is underlined in the search pair and the current one bold, also across a wrap", () => {
    const { host } = fakeHost();
    const help = new Help(host, () => [line("alpha beta gamma"), line("beta again")]);
    help.render(theme, 12, 5); // 11 cells after the margin: "alpha beta" | "gamma"
    help.search("beta gamma");
    const rows = help.render(theme, 12, 5);
    expect(plain(rows).slice(0, 3)).toEqual(["\u25b8alpha beta ", " gamma      ", " beta again "]);
    expect(rows[0]).toContain("\x1b[1;4;7mbeta\x1b[0m");
    expect(rows[1]).toContain("\x1b[1;4;7mgamma\x1b[0m");
    help.search("beta");
    const again = help.render(theme, 12, 5);
    expect(again[0]).toContain("\x1b[1;4;7mbeta\x1b[0m"); // the current match
    expect(again[2]).toContain("\x1b[4;7mbeta\x1b[0m"); // another match
  });

  test("no match, an empty search and n without a search explain themselves; the query is escaped text", () => {
    const { host, notes } = fakeHost();
    const help = new Help(host, () => LINES);
    help.render(theme, 40, 10);
    help.step(1);
    expect(notes.at(-1)).toBe("No search in the help: / searches it, then n and N step through the matches");
    help.search("zz\x1b[2J");
    expect(notes.at(-1)).toBe("No match for /zz^[[2J in the help");
    expect(help.query).toBe("zz^[[2J");
    help.step(1);
    expect(notes.at(-1)).toBe("No match for /zz^[[2J in the help");
    help.search("  ");
    expect(notes.at(-1)).toBe("Help search cleared");
    expect(help.searchStatus()).toBeNull();
    expect(marked(help.render(theme, 40, 10))).toEqual([]);
  });
});
