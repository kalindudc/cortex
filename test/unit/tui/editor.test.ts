import { describe, expect, test } from "bun:test";
import { EditorSelection } from "@codemirror/state";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG } from "../../../src/tui/config.ts";
import {
  createDocumentEditor,
  createEditorState,
  type DocumentEditor,
  editorText,
  gutterWidth,
} from "../../../src/tui/editor.ts";
import { resolveTheme } from "../../../src/tui/theme.ts";

// Plan @400 N14/N19 (Task 9): the document editor is a thin terminal
// Component/Focusable over CodeMirror EditorState + history + the Markdown
// language state. It maps graphemes and display cells to document offsets,
// preserves the text exactly, pastes as ONE undoable edit, and puts the
// CURSOR_MARKER at the logical cursor after the gutter, scroll and cell
// transforms. It never interprets modes: the shell calls its motions/keys.

const plainTheme = resolveTheme({ config: DEFAULT_CONFIG, env: { NO_COLOR: "1" } });
const colorTheme = resolveTheme({ config: DEFAULT_CONFIG, env: { TERM: "xterm-256color", COLORTERM: "truecolor" } });
const SGR = /\x1b\[[0-9;]*m/g;
const strip = (line: string): string => line.replace(SGR, "").replace(CURSOR_MARKER, "");

function make(text: string, cursor = 0, options: { width?: number; height?: number } = {}) {
  const changes: string[] = [];
  const editor = createDocumentEditor(createEditorState(text, { cursor }), state => changes.push(editorText(state)));
  editor.theme = plainTheme;
  editor.height = options.height ?? 10;
  const width = options.width ?? 40;
  return {
    editor,
    changes,
    width,
    text: () => editorText(editor.getState()),
    head: () => editor.getState().selection.main.head,
    render: () => editor.render(width),
  };
}

/** Where the cursor marker is: [row, visible column], or null. */
function markerAt(lines: string[]): [number, number] | null {
  for (const [row, line] of lines.entries()) {
    const at = line.indexOf(CURSOR_MARKER);
    if (at >= 0) return [row, visibleWidth(line.slice(0, at))];
  }
  return null;
}

const repeat = (editor: DocumentEditor, key: string, times: number) => {
  for (let i = 0; i < times; i++) editor.editKey(key);
};

describe("text fidelity", () => {
  test("tabs and every other character are preserved exactly; rendering expands tabs to the next stop", () => {
    const source = "\talpha\tbeta\n\t\tgamma  \nend";
    const e = make(source);
    expect(e.text()).toBe(source);
    const lines = e.render().map(strip);
    const gutter = gutterWidth(3);
    expect(lines[0]?.slice(gutter)).toMatch(/^ {4}alpha {3}beta/);
    expect(lines[1]?.slice(gutter)).toMatch(/^ {8}gamma/);
    // Typing next to tabs keeps them.
    e.editor.move("down");
    e.editor.move("line-end");
    e.editor.insert("!");
    expect(e.text()).toBe("\talpha\tbeta\n\t\tgamma  !\nend");
    expect(e.changes.at(-1)).toBe(e.text());
  });

  test("a CRLF document stays CRLF: new lines use its separator", () => {
    const e = make("one\r\ntwo\r\n", 3);
    expect(e.text()).toBe("one\r\ntwo\r\n");
    e.editor.editKey("enter");
    e.editor.insert("x");
    expect(e.text()).toBe("one\r\nx\r\ntwo\r\n");
    e.editor.paste("p\nq");
    expect(e.text()).toBe("one\r\nxp\r\nq\r\ntwo\r\n");
  });

  test("untrusted control characters render escaped, never raw, and stay in the text", () => {
    const source = "a\x1b[2Jb\x9b31m";
    const e = make(source);
    const out = e.render().join("\n");
    expect(out.replace(SGR, "").replace(CURSOR_MARKER, "")).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    expect(strip(e.render()[0] ?? "")).toContain("a^[[2Jb<U+009B>31m");
    expect(e.text()).toBe(source);
  });
});

describe("indentation (web parity: indentMore / indentLess)", () => {
  test("Tab and Shift-Tab indent and outdent the cursor line, and every line of a selection", () => {
    const e = make("one\ntwo\nthree", 1);
    e.editor.editKey("tab");
    expect(e.text()).toBe("  one\ntwo\nthree");
    e.editor.editKey("shift+tab");
    expect(e.text()).toBe("one\ntwo\nthree");
    e.editor.dispatch({ selection: EditorSelection.range(0, 5) });
    e.editor.editKey("tab");
    expect(e.text()).toBe("  one\n  two\nthree");
    e.editor.editKey("shift+tab");
    expect(e.text()).toBe("one\ntwo\nthree");
  });

  test("indenting a tab-indented line keeps its tab", () => {
    const e = make("\tcode", 0);
    e.editor.editKey("tab");
    expect(e.text()).toBe("  \tcode");
  });

  test("Enter inserts a newline, continuing Markdown list markup (CodeMirror's insertNewlineContinueMarkup)", () => {
    const list = make("- item", 6);
    list.editor.editKey("enter");
    expect(list.text()).toBe("- item\n- ");
    const plain = make("plain", 5);
    plain.editor.editKey("enter");
    plain.editor.insert("next");
    expect(plain.text()).toBe("plain\nnext");
  });
});

describe("selection", () => {
  test("Shift-arrows extend the selection, it is painted with the selection pair, and typing replaces it", () => {
    const e = make("hello world", 0);
    repeat(e.editor, "shift+right", 5);
    const { anchor, head } = e.editor.getState().selection.main;
    expect([anchor, head]).toEqual([0, 5]);
    // colors none: the selection is inverse.
    expect(e.render()[0]).toContain("\x1b[7mhello\x1b[0m");
    e.editor.theme = colorTheme;
    const selected = /\x1b\[([0-9;]*)mhello\x1b\[0m/.exec(e.render()[0] ?? "");
    expect(selected?.[1]).toContain("48;2;36;47;74"); // cortex-dark selection surface
    e.editor.insert("HEY");
    expect(e.text()).toBe("HEY world");
    e.editor.editKey("shift+end");
    expect(e.editor.getState().selection.main.from).toBe(3);
    expect(e.editor.getState().selection.main.to).toBe(9);
    e.editor.editKey("backspace");
    expect(e.text()).toBe("HEY");
    e.editor.editKey("shift+home");
    e.editor.editKey("right");
    expect(e.editor.getState().selection.main.empty).toBe(true);
  });
});

describe("undo and redo (CodeMirror history StateCommands)", () => {
  test("typing a word is one undo step; undo/redo with counts restore text and report changes", () => {
    const e = make("");
    for (const ch of "abc") e.editor.insert(ch);
    expect(e.text()).toBe("abc");
    expect(e.editor.undo()).toBe(true);
    expect(e.text()).toBe("");
    expect(e.editor.redo()).toBe(true);
    expect(e.text()).toBe("abc");
    e.editor.editKey("enter");
    e.editor.paste("pasted");
    expect(e.text()).toBe("abc\npasted");
    expect(e.editor.undo(2)).toBe(true);
    expect(e.text()).toBe("abc");
    expect(e.editor.redo(5)).toBe(true);
    expect(e.text()).toBe("abc\npasted");
    expect(e.editor.redo()).toBe(false);
    expect(e.changes.at(-1)).toBe("abc\npasted");
  });
});

describe("Unicode: graphemes and display cells", () => {
  const source = "a👍🏽e\u0301東x";

  test("motions never split a grapheme cluster; deletions follow CodeMirror's commands", () => {
    const e = make(source, 0);
    const heads: number[] = [];
    for (let i = 0; i < 5; i++) {
      e.editor.move("right");
      heads.push(e.head());
    }
    expect(heads).toEqual([1, 5, 7, 8, 9]);
    e.editor.move("left", { count: 2 });
    expect(e.head()).toBe(7);
    // Backspace takes a combining mark on its own (as CodeMirror does), then the base letter.
    e.editor.editKey("backspace");
    expect(e.text()).toBe("a👍🏽e東x");
    e.editor.editKey("backspace");
    expect(e.text()).toBe("a👍🏽東x");
    // Delete takes the whole next cluster.
    e.editor.editKey("delete");
    expect(e.text()).toBe("a👍🏽x");
    e.editor.move("left");
    expect(e.head()).toBe(1);
  });

  test("wide characters take two cells; the cursor column counts cells, not code units", () => {
    const e = make(source, 7);
    e.editor.focused = true;
    const gutter = gutterWidth(1);
    // a (1) + 👍🏽 (2) + é (1): the cursor sits on 東.
    expect(markerAt(e.render())).toEqual([0, gutter + 4]);
  });
});

describe("bracketed paste", () => {
  test("a paste is ONE undoable edit, inserted verbatim, never run as commands", () => {
    const e = make("start", 5);
    e.editor.paste("\tone\n:q\ntwo");
    expect(e.text()).toBe("start\tone\n:q\ntwo");
    expect(e.editor.undo()).toBe(true);
    expect(e.text()).toBe("start");
    // A paste over a selection replaces it, still as one edit.
    e.editor.dispatch({ selection: EditorSelection.range(0, 5) });
    e.editor.paste("x\ty");
    expect(e.text()).toBe("x\ty");
    e.editor.undo();
    expect(e.text()).toBe("start");
  });
});

describe("the cursor marker (IME) and scrolling", () => {
  test("the marker sits at the logical cursor after the gutter, tabs and wide cells; only while focused", () => {
    const e = make("東京\tx\nsecond", 3);
    expect(markerAt(e.render())).toBeNull();
    e.editor.focused = true;
    // 東京 = 4 cells, the tab runs to the next stop (8), then x.
    expect(markerAt(e.render())).toEqual([0, gutterWidth(2) + 8]);
    e.editor.move("down");
    expect(markerAt(e.render())).toEqual([1, gutterWidth(2) + 6]);
  });

  test("a shadow cursor paints the cell without the marker (Split's other half); VISUAL's hole too", () => {
    const e = make("hello world", 6);
    expect(e.render()[0]).not.toContain("\x1b[7m");
    e.editor.shadowCursor = true;
    const row = e.render()[0] ?? "";
    expect(row).toContain("\x1b[7mw\x1b[0m"); // the block cursor on "w"
    expect(row).not.toContain(CURSOR_MARKER);
    expect(strip(row).slice(gutterWidth(1))).toMatch(/^hello world/);
    e.editor.setVisual("char");
    e.editor.move("right", { count: 2, wrap: false });
    const visual = e.render()[0] ?? "";
    expect(visual).toContain("\x1b[4mr\x1b[0m"); // the hole, still without the marker
    expect(visual).not.toContain(CURSOR_MARKER);
    e.editor.focused = true;
    expect(markerAt(e.render())).toEqual([0, gutterWidth(1) + 8]);
  });

  test("the view scrolls to keep the cursor visible; the marker row and the gutter agree", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
    const e = make(lines, 0, { height: 5 });
    e.editor.focused = true;
    e.editor.move("down", { count: 29 });
    const out = e.render();
    expect(out.length).toBe(5);
    const at = markerAt(out);
    expect(at).not.toBeNull();
    const row = at?.[0] ?? -1;
    expect(strip(out[row] ?? "")).toMatch(/^\s*30 line 30/);
    e.editor.move("doc-start");
    expect(strip(e.render()[0] ?? "")).toMatch(/^\s*1 line 1/);
    e.editor.move("doc-end");
    const end = e.render();
    expect(strip(end[4] ?? "")).toMatch(/^\s*50 line 50/);
  });

  test("the wheel scrolls the view, not the cursor, until the cursor would leave it; it stops at the document's ends (review F15)", () => {
    // The Shell counts the notches and scrolls `scroll` rows a notch (3 by default) through scrollRows.
    const wheel = (e: ReturnType<typeof make>, delta: 1 | -1, notches = 1) => {
      for (let i = 0; i < notches; i++) e.editor.scrollRows(delta * 3);
    };
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
    const e = make(lines, 0, { height: 10 });
    const at = (line: number, col: number) => e.editor.getState().doc.line(line).from + col;
    e.editor.focused = true;
    e.editor.move("down", { count: 4 });
    e.editor.move("right", { count: 3 }); // line 5, column 3, mid-screen
    expect(markerAt(e.render())?.[0]).toBe(4);
    // One notch: the first visible row moves three rows; the cursor stays on its text (three rows higher).
    wheel(e, 1);
    let out = e.render();
    expect(strip(out[0] ?? "")).toMatch(/^\s*4 line 4/);
    expect(e.head()).toBe(at(5, 3));
    expect(markerAt(out)?.[0]).toBe(1);
    // Line 5 would leave the view: the cursor moves to the first visible row, its column kept.
    wheel(e, 1);
    out = e.render();
    expect(strip(out[0] ?? "")).toMatch(/^\s*7 line 7/);
    expect([e.head(), markerAt(out)?.[0]]).toEqual([at(7, 3), 0]);
    // The end: the last line stays on the bottom row.
    wheel(e, 1, 20);
    out = e.render();
    expect(strip(out[0] ?? "")).toMatch(/^\s*41 line 41/);
    expect(strip(out[9] ?? "")).toMatch(/^\s*50 line 50/);
    expect(e.head()).toBe(at(41, 3));
    // Upward: the cursor stays while it is shown, then rides the last visible row; the start stops it.
    wheel(e, -1);
    expect(strip(e.render()[0] ?? "")).toMatch(/^\s*38 line 38/);
    expect(e.head()).toBe(at(41, 3));
    wheel(e, -1, 20);
    out = e.render();
    expect(strip(out[0] ?? "")).toMatch(/^\s*1 line 1/);
    expect([e.head(), markerAt(out)?.[0]]).toEqual([at(10, 3), 9]);
    // Keyboard motions are unchanged: j past the last row scrolls one row.
    e.editor.move("down");
    out = e.render();
    expect(strip(out[0] ?? "")).toMatch(/^\s*2 line 2/);
    expect([e.head(), markerAt(out)?.[0]]).toEqual([at(11, 3), 9]);
    // Wrapped rows count as rows: one notch shows a long line's fourth row, where the cursor moves.
    const w = make("abcdefghijklmnopqrstuvwxyz0123456789\nnext", 0, { width: 12, height: 3 });
    w.editor.focused = true;
    expect(strip(w.render()[0] ?? "")).toMatch(/^\s*1 abcdefg/);
    wheel(w, 1);
    const wrapped = w.render();
    expect(strip(wrapped[0] ?? "")).toMatch(/^\s*vwxyz01/);
    expect([w.head(), markerAt(wrapped)?.[0]]).toEqual([21, 0]);
    // The wheel never reaches the editor itself: only the Shell scrolls it.
    expect(w.editor.handleMouse({ type: "wheel", button: "none", x: 0, y: 0, wheelDelta: 1 } as never)).toBeUndefined();
    expect(strip(w.render()[0] ?? "")).toMatch(/^\s*vwxyz01/);
    // One row a call: scroll = 1 moves the view one row a notch.
    w.editor.scrollRows(-1);
    expect(strip(w.render()[0] ?? "")).toMatch(/^\s*opqrstu/);
  });

  test("scrollPosition counts visual rows at the last render's width (wrapped rows count)", () => {
    const wheel = (e: ReturnType<typeof make>) => e.editor.scrollRows(3);
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
    const e = make(lines, 0, { height: 5 });
    e.render();
    expect(e.editor.scrollPosition()).toEqual({ top: 0, total: 50 });
    e.editor.move("doc-end");
    e.render();
    expect(e.editor.scrollPosition()).toEqual({ top: 45, total: 50 });
    // An edit that adds a line: the memo follows the new document.
    e.editor.dispatch({ changes: { from: 0, insert: "new\n" } });
    e.render();
    expect(e.editor.scrollPosition().total).toBe(51);
    // Width 12: gutter 4, 7 text cells a row, so 36 characters make 6 rows, plus `next`.
    const w = make("abcdefghijklmnopqrstuvwxyz0123456789\nnext", 0, { width: 12, height: 3 });
    w.render();
    expect(w.editor.scrollPosition()).toEqual({ top: 0, total: 7 });
    wheel(w);
    w.render();
    expect(w.editor.scrollPosition()).toEqual({ top: 3, total: 7 });
  });

  test("cursorRow reports the cursor's row in the last render (focused or not), for Split's preview", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
    const e = make(lines, 0, { height: 5, width: 12 });
    expect(e.editor.cursorRow()).toBe(-1); // never rendered
    e.render();
    expect(e.editor.cursorRow()).toBe(0);
    e.editor.move("down", { count: 2 });
    e.render();
    expect(e.editor.cursorRow()).toBe(2);
    e.editor.move("doc-end");
    e.render();
    expect(e.editor.cursorRow()).toBe(4);
    // A wrapped line: the row the cursor is on, not the line's first row.
    const w = make(`${"word ".repeat(6)}end`, 34, { height: 5, width: 12 });
    w.render();
    expect(w.editor.cursorRow()).toBeGreaterThan(0);
  });

  test("the active line number is emphasized (bold), never by color alone", () => {
    const e = make("one\ntwo", 4);
    e.editor.theme = colorTheme;
    e.editor.focused = true;
    const out = e.render();
    const params = (line: string | undefined): string[] => /^\x1b\[([0-9;]*)m/.exec(line ?? "")?.[1]?.split(";") ?? [];
    expect(strip(out[1] ?? "")).toMatch(/^ {2}2 two/);
    expect(params(out[1]).at(-1)).toBe("1");
    expect(params(out[0])).not.toContain("1");
  });
});

describe("motions (the shell maps NORMAL keys to them)", () => {
  test("vertical motion follows wrapped rows and keeps the goal column", () => {
    // Width 20: gutter 4, one spare cell, so 15 cells of text per row.
    const e = make("0123456789abcdefghij\nshort\nlonger line here", 2, { width: 20 });
    e.editor.render(20);
    e.editor.move("down");
    expect(e.head()).toBe(17); // row 2 of line 1, column 2
    e.editor.move("down");
    expect(e.head()).toBe(23); // "short", column 2
    e.editor.move("down");
    expect(e.head()).toBe(29); // the goal column survives the short line
    e.editor.move("up", { count: 3 });
    expect(e.head()).toBe(2);
  });

  test("h/l stay inside the line; arrows in INSERT cross line ends", () => {
    const e = make("ab\ncd", 2);
    e.editor.move("right", { wrap: false });
    expect(e.head()).toBe(2);
    e.editor.move("right");
    expect(e.head()).toBe(3);
    e.editor.move("left", { wrap: false });
    expect(e.head()).toBe(3);
    e.editor.editKey("left");
    expect(e.head()).toBe(2);
  });

  test("Home/End/PageUp/PageDown act inside the editor", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `row ${i}`).join("\n");
    const e = make(lines, 2, { height: 6 });
    e.editor.render(40);
    e.editor.editKey("end");
    expect(e.head()).toBe(5);
    e.editor.editKey("home");
    expect(e.head()).toBe(0);
    e.editor.editKey("pageDown");
    expect(e.editor.getState().doc.lineAt(e.head()).number).toBe(7);
    e.editor.editKey("pageUp");
    expect(e.editor.getState().doc.lineAt(e.head()).number).toBe(1);
    e.editor.move("half-page-down", { count: 2 });
    expect(e.editor.getState().doc.lineAt(e.head()).number).toBe(7);
  });

  test("word keys move and delete by word groups", () => {
    const e = make("alpha beta gamma", 16);
    e.editor.editKey("alt+b");
    expect(e.head()).toBe(11);
    e.editor.editKey("ctrl+left");
    expect(e.head()).toBe(6);
    e.editor.editKey("alt+f");
    expect(e.head()).toBe(10);
    e.editor.editKey("ctrl+w");
    expect(e.text()).toBe("alpha  gamma");
    expect(e.editor.editKey("f12")).toBe(false);
  });
});

describe("rendering through the theme", () => {
  test("syntax cues come from the Markdown language state: headings bold, code in md.code", () => {
    const e = make("# Title\nsome `code` here\n- item");
    e.editor.theme = colorTheme;
    const out = e.render();
    expect(out[0]).toMatch(/\x1b\[[0-9;]*;1m# Title/);
    expect(out[1]).toContain("38;2;245;164;126"); // cortex-dark md.code
    expect(out[2]).toMatch(/\x1b\[[0-9;]*38;2;245;164;126[0-9;]*m-/); // the list mark in md.bullet
    for (const line of out) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
  });

  test("every row is exactly the pane width and height, even past the end of the document", () => {
    const e = make("x", 0, { height: 4 });
    const out = e.render();
    expect(out.length).toBe(4);
    for (const line of out) expect(visibleWidth(line.replace(CURSOR_MARKER, ""))).toBe(40);
  });
});

describe("identity", () => {
  test("setState swaps the state in place: same instance, no onChange echo, cursor clamped", () => {
    const e = make("original text", 13);
    const before = e.editor;
    e.editor.setState(createEditorState("new", { cursor: 13 }));
    expect(e.editor).toBe(before);
    expect(e.text()).toBe("new");
    expect(e.head()).toBe(3);
    expect(e.changes).toEqual([]);
  });

  test("run applies a CodeMirror StateCommand and dispatch applies a transaction spec", () => {
    const e = make("abc", 3);
    e.editor.dispatch({ changes: { from: 0, insert: "> " } });
    expect(e.text()).toBe("> abc");
    expect(e.changes).toEqual(["> abc"]);
  });
});

describe("vi word motions (w, b, e)", () => {
  // f0 o1 o2 _3 b4 a5 r6 .7 b8 a9 z10 _11 _12 q13 u14 x15 | line 2 (empty) at 17 | e18 n19 d20
  const source = "foo bar.baz  qux\n\nend";

  test("w stops at each word start (a run of word or of other characters), crossing lines; an empty line is a word", () => {
    const e = make(source, 0);
    const stops: number[] = [];
    for (let i = 0; i < 6; i++) {
      e.editor.move("word-next");
      stops.push(e.head());
    }
    expect(stops).toEqual([4, 7, 8, 13, 17, 18]);
    e.editor.move("word-next");
    expect(e.head()).toBe(21); // the end of the document
    e.editor.move("doc-start");
    e.editor.move("word-next", { count: 3 });
    expect(e.head()).toBe(8);
  });

  test("b goes back to word starts; e goes to word ends (skipping empty lines)", () => {
    const e = make(source, 18);
    const back: number[] = [];
    for (let i = 0; i < 7; i++) {
      e.editor.move("word-prev");
      back.push(e.head());
    }
    expect(back).toEqual([17, 13, 8, 7, 4, 0, 0]);
    const ends: number[] = [];
    for (let i = 0; i < 6; i++) {
      e.editor.move("word-end");
      ends.push(e.head());
    }
    expect(ends).toEqual([2, 6, 7, 10, 15, 20]);
  });

  test("word motions never split a grapheme cluster; a tab is a blank", () => {
    const e = make("a👍🏽e\u0301\tx", 0);
    e.editor.move("word-next");
    expect(e.head()).toBe(1); // 👍🏽 is not a letter: its own word
    e.editor.move("word-next");
    expect(e.head()).toBe(5); // é (e + combining acute)
    e.editor.move("word-next");
    expect(e.head()).toBe(8); // past the tab
    e.editor.move("word-prev");
    expect(e.head()).toBe(5);
  });
});

describe("VISUAL selections (the shell's vi visual mode: the editor applies them, never decides modes)", () => {
  const SEL = "\x1b[7m";
  const focusedMake = (text: string, cursor = 0) => {
    const e = make(text, cursor);
    e.editor.focused = true;
    return e;
  };
  const range = (e: ReturnType<typeof make>) => {
    const main = e.editor.getState().selection.main;
    return [main.from, main.to];
  };

  test("charwise VISUAL includes the character under the cursor; motions extend it; o swaps the ends", () => {
    const e = focusedMake("abcdef", 3);
    e.editor.setVisual("char");
    expect(e.editor.visual()).toBe("char");
    expect(range(e)).toEqual([3, 4]);
    expect(e.editor.selection()).toEqual({ text: "d", linewise: false });
    e.editor.move("left", { count: 2, wrap: false });
    expect(e.editor.cursor()).toBe(1);
    expect(range(e)).toEqual([1, 4]); // the anchor's character stays selected
    e.editor.swapVisualEnds();
    expect(e.editor.cursor()).toBe(3);
    e.editor.move("right", { wrap: false });
    expect(e.editor.selection()).toEqual({ text: "bcde", linewise: false });
    e.editor.setVisual(null);
    expect(e.editor.visual()).toBeNull();
    expect(e.editor.getState().selection.main.empty).toBe(true);
    expect(e.head()).toBe(4); // Esc leaves the cursor where it was
    expect(e.changes).toEqual([]);
  });

  test("the selection is painted with the selection pair PLUS inverse; the cursor cell is a visible hole", () => {
    const e = focusedMake("hello world", 0);
    e.editor.setVisual("char");
    e.editor.move("right", { count: 4, wrap: false });
    const row = e.render()[0] ?? "";
    expect(row).toContain(`${SEL}hell\x1b[0m`);
    expect(row).toContain(`${CURSOR_MARKER}\x1b[4mo\x1b[0m`); // the cursor: underlined, not inverse
    expect(strip(row).slice(gutterWidth(1))).toMatch(/^hello world/);
    e.editor.theme = colorTheme;
    const selected = /\x1b\[([0-9;]*)mhell\x1b\[0m/.exec(e.render()[0] ?? "");
    expect(selected?.[1]).toContain("48;2;36;47;74"); // the cortex-dark selection surface ...
    expect(selected?.[1]?.split(";")).toContain("7"); // ... plus inverse, so it shows without color too
  });

  test("charwise over graphemes and tabs: whole clusters, the tab kept; $ includes the line break", () => {
    const e = focusedMake("a👍🏽e\u0301\tx\nnext", 0);
    e.editor.setVisual("char");
    e.editor.move("right", { count: 3, wrap: false });
    expect(e.editor.cursor()).toBe(7); // on the tab
    expect(e.editor.selection()).toEqual({ text: "a👍🏽e\u0301\t", linewise: false });
    // The tab's cells are all painted as selected.
    expect(e.render()[0]).toContain(`${SEL}a👍🏽e\u0301\x1b[0m`);
    e.editor.move("line-end");
    expect(e.editor.selection()).toEqual({ text: "a👍🏽e\u0301\tx\n", linewise: false });
  });

  test("VISUAL LINE selects whole lines (an empty one shows a selected cell); v and V switch the kind in place", () => {
    const e = focusedMake("one\ntwo\n\nfour", 5);
    e.editor.setVisual("line");
    expect(e.editor.selection()).toEqual({ text: "two\n", linewise: true });
    e.editor.move("down", { count: 2 });
    expect(e.editor.selection()).toEqual({ text: "two\n\nfour\n", linewise: true });
    e.editor.swapVisualEnds(); // the cursor back on "two": the empty line 3 is selected, not the cursor's
    expect(e.render()[2]).toContain(`${SEL} \x1b[0m`);
    e.editor.setVisual("char");
    expect(e.editor.visual()).toBe("char");
    expect(e.editor.selection()).toEqual({ text: "wo\n\nfo", linewise: false });
  });

  test("y returns the text and ends VISUAL at the selection's start; nothing changes", () => {
    const e = focusedMake("one\ntwo\nthree", 5);
    e.editor.setVisual("line");
    e.editor.move("down");
    expect(e.editor.yank()).toEqual({ text: "two\nthree\n", linewise: true });
    expect(e.editor.visual()).toBeNull();
    expect(e.head()).toBe(4);
    expect(e.changes).toEqual([]);
    expect(e.editor.yank()).toBeNull(); // outside VISUAL there is nothing to yank
  });

  test("d deletes the selection as ONE undoable step (u restores it, the cursor at its start); Ctrl-r redoes", () => {
    const e = focusedMake("hello big world", 6);
    for (const ch of "!") e.editor.insert(ch); // a typing group right before
    e.editor.move("left", { wrap: false });
    e.editor.setVisual("char");
    e.editor.move("word-end");
    expect(e.editor.deleteSelection()).toEqual({ text: "!big", linewise: false });
    expect(e.text()).toBe("hello  world");
    expect(e.editor.visual()).toBeNull();
    expect(e.head()).toBe(6);
    expect(e.changes.at(-1)).toBe("hello  world");
    expect(e.editor.undo()).toBe(true);
    expect(e.text()).toBe("hello !big world");
    expect(e.editor.getState().selection.main.empty).toBe(true);
    expect(e.head()).toBe(6);
    expect(e.editor.undo()).toBe(true); // the typing was its own step
    expect(e.text()).toBe("hello big world");
    e.editor.redo(2);
    expect(e.text()).toBe("hello  world");
  });

  test("linewise d takes the lines and their break (the last line takes the break before it)", () => {
    const e = focusedMake("one\ntwo\nthree\nfour", 5);
    e.editor.setVisual("line");
    e.editor.move("down");
    expect(e.editor.deleteSelection()).toEqual({ text: "two\nthree\n", linewise: true });
    expect(e.text()).toBe("one\nfour");
    expect(e.head()).toBe(4);
    e.editor.setVisual("line");
    expect(e.editor.deleteSelection()).toEqual({ text: "four\n", linewise: true });
    expect(e.text()).toBe("one");
    e.editor.setVisual("line");
    e.editor.deleteSelection();
    expect(e.text()).toBe("");
    e.editor.undo(3);
    expect(e.text()).toBe("one\ntwo\nthree\nfour");
  });

  test("c deletes like d but keeps an empty line for whole lines (the shell then starts INSERT)", () => {
    const chars = focusedMake("alpha beta", 6);
    chars.editor.setVisual("char");
    chars.editor.move("line-end");
    chars.editor.move("left", { wrap: false });
    expect(chars.editor.deleteSelection({ change: true })).toEqual({ text: "beta", linewise: false });
    expect(chars.text()).toBe("alpha ");
    expect(chars.head()).toBe(6);
    const lines = focusedMake("one\ntwo\nthree", 5);
    lines.editor.setVisual("line");
    expect(lines.editor.deleteSelection({ change: true })).toEqual({ text: "two\n", linewise: true });
    expect(lines.text()).toBe("one\n\nthree");
    expect(lines.head()).toBe(4);
  });

  test("> and < indent/outdent the selected lines (with a count) as ONE undoable step; tabs survive indenting", () => {
    const e = focusedMake("a\n\tb\nc", 0);
    e.editor.setVisual("line");
    e.editor.move("down");
    expect(e.editor.indentSelection(1, 2)).toBe(true);
    expect(e.text()).toBe("    a\n    \tb\nc");
    expect(e.editor.visual()).toBeNull();
    expect(e.head()).toBe(4); // the first non-blank of the first line
    e.editor.undo();
    expect(e.text()).toBe("a\n\tb\nc");
    const o = focusedMake("x\ny\nz", 0);
    o.editor.setVisual("char");
    o.editor.move("down"); // charwise into line 2: both lines are indented
    expect(o.editor.indentSelection(1)).toBe(true);
    expect(o.text()).toBe("  x\n  y\nz");
    o.editor.setVisual("line");
    o.editor.move("down");
    expect(o.editor.indentSelection(-1)).toBe(true);
    expect(o.text()).toBe("x\ny\nz");
    o.editor.setVisual("line");
    expect(o.editor.indentSelection(-1)).toBe(false); // nothing to outdent: VISUAL still ends
    expect(o.editor.visual()).toBeNull();
    expect(o.changes).toEqual(["  x\n  y\nz", "x\ny\nz"]);
  });

  test("p/P put a charwise register after/before the cursor, count times, as ONE undoable step", () => {
    const e = focusedMake("abc", 1);
    expect(e.editor.put({ text: "XY", linewise: false }, { before: false })).toBe(true);
    expect(e.text()).toBe("abXYc");
    expect(e.head()).toBe(3); // on the last pasted character
    e.editor.put({ text: "-", linewise: false }, { before: true, count: 3 });
    expect(e.text()).toBe("abX---Yc");
    e.editor.undo();
    expect(e.text()).toBe("abXYc");
    e.editor.undo();
    expect(e.text()).toBe("abc");
  });

  test("p/P put whole lines below/above the cursor line (in the document's own line breaks)", () => {
    const e = focusedMake("one\ntwo", 1);
    e.editor.put({ text: "L1\nL2\n", linewise: true }, { before: false });
    expect(e.text()).toBe("one\nL1\nL2\ntwo");
    expect(e.head()).toBe(4);
    e.editor.put({ text: "top\n", linewise: true }, { before: true, count: 2 });
    expect(e.text()).toBe("one\ntop\ntop\nL1\nL2\ntwo");
    e.editor.move("doc-end");
    e.editor.put({ text: "end\n", linewise: true }, { before: false });
    expect(e.text()).toBe("one\ntop\ntop\nL1\nL2\ntwo\nend");
    const crlf = focusedMake("one\r\ntwo\r\n", 0);
    crlf.editor.put({ text: "L\r\n", linewise: true }, { before: false });
    expect(crlf.text()).toBe("one\r\nL\r\ntwo\r\n");
    expect(crlf.editor.undo()).toBe(true);
    expect(crlf.text()).toBe("one\r\ntwo\r\n");
  });

  test("a replaced state, a click or an edit ends VISUAL", () => {
    const e = focusedMake("one two", 0);
    e.editor.setVisual("char");
    e.editor.setState(createEditorState("other"));
    expect(e.editor.visual()).toBeNull();
    e.editor.setVisual("line");
    e.editor.insert("x");
    expect(e.editor.visual()).toBeNull();
    e.editor.setVisual("char");
    e.editor.render(e.width);
    e.editor.handleMouse({ type: "click", button: "left", x: 6, y: 0 } as never);
    expect(e.editor.visual()).toBeNull();
  });
});

describe("the mouse's cells (the shell routes presses, drags and clicks here)", () => {
  test("offsetAt maps a cell through the gutter and the grapheme cells (wide clusters take two); outside the rows clamps", () => {
    const e = make("日本 word\nnext line", 0);
    const lines = e.render().map(strip);
    const gutter = (lines[0] ?? "").indexOf("日");
    expect(gutter).toBeGreaterThan(0);
    expect(e.editor.offsetAt(gutter, 0)).toBe(0);
    expect(e.editor.offsetAt(gutter + 1, 0)).toBe(0); // the second cell of 日
    expect(e.editor.offsetAt(gutter + 2, 0)).toBe(1);
    expect(e.editor.offsetAt(gutter + 5, 0)).toBe("日本 w".length - 1);
    expect(e.editor.offsetAt(0, 0)).toBe(0); // the gutter: the line start
    expect(e.editor.offsetAt(gutter + 30, 0)).toBe("日本 word".length); // past the text: the line end
    expect(e.editor.offsetAt(gutter, -3)).toBe(0); // above: the first row on screen
    expect(e.editor.offsetAt(gutter, 9)).toBe(e.text().length); // below the text: its end
  });

  test("selectRange is VISUAL between two offsets, both included; an end past a line's text stands on its last character", () => {
    const e = make("alpha beta\ngamma", 0);
    e.render();
    e.editor.selectRange("char", 6, 9);
    expect(e.editor.visual()).toBe("char");
    expect(e.editor.selection()).toEqual({ text: "beta", linewise: false });
    e.editor.selectRange("char", 9, 6); // backwards: the same text, the cursor at its start
    expect(e.editor.selection()).toEqual({ text: "beta", linewise: false });
    expect(e.editor.cursor()).toBe(6);
    e.editor.selectRange("char", 6, "alpha beta".length); // dragged past the end of the line
    expect(e.editor.selection()?.text).toBe("beta");
    e.editor.selectRange("line", 12, 12);
    expect(e.editor.selection()).toEqual({ text: "gamma\n", linewise: true });
  });

  test("selectWord takes the run of one vi class under the offset (word, blanks or punctuation), by grapheme", () => {
    const e = make("go 👍🏽👍🏽 now... ok", 0);
    e.render();
    e.editor.selectWord(1);
    expect(e.editor.selection()?.text).toBe("go");
    e.editor.selectWord("go 👍🏽👍🏽 now".length + 1);
    expect(e.editor.selection()?.text).toBe("...");
    e.editor.selectWord("go ".length);
    expect(e.editor.selection()?.text).toBe("👍🏽👍🏽");
    e.editor.selectWord(2);
    expect(e.editor.selection()?.text).toBe(" ");
  });

  test("placeCursor ends VISUAL and puts the cursor there (clamped to the document)", () => {
    const e = make("one two", 0);
    e.render();
    e.editor.selectRange("char", 0, 2);
    e.editor.placeCursor(4);
    expect(e.editor.visual()).toBeNull();
    expect(e.editor.cursor()).toBe(4);
    e.editor.placeCursor(99);
    expect(e.editor.cursor()).toBe(7);
  });
});
