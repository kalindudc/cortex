import { test, expect, describe } from "bun:test";
import { createCommandLine } from "../../../src/tui/commandline.ts";

// Plan @400 N17 (Task 8): ONE one-line prompt component serves the `:`
// command line and `/` search. Tab/Shift-Tab cycle completions computed
// from the TYPED prefix; Up/Down recall history and restore the unfinished
// line; only Enter (the caller) submits, so a pasted newline never runs;
// Alt word motions work as in keys.ts (whose dispatcher delivers them as
// key ids inside text fields).

const typed = (line: ReturnType<typeof createCommandLine>, ...keys: string[]) => {
  for (const key of keys) line.key(key);
};

describe("editing", () => {
  test("typing, cursor keys and backspace edit the line; backspace on an empty line cancels", () => {
    const line = createCommandLine(":", { history: [] });
    expect(line.kind).toBe(":");
    line.insert("opn");
    typed(line, "left");
    line.insert("e");
    expect(line.text).toBe("open");
    expect(line.cursor).toBe(3);
    typed(line, "home", "delete");
    expect(line.text).toBe("pen");
    expect(line.cursor).toBe(0);
    line.insert("o");
    typed(line, "end", "backspace");
    expect(line.text).toBe("ope");
    typed(line, "ctrl+a", "ctrl+k");
    expect(line.text).toBe("");
    line.insert("abc");
    typed(line, "ctrl+b", "ctrl+u");
    expect(line.text).toBe("c");
    typed(line, "ctrl+e", "backspace");
    expect(line.text).toBe("");
    expect(line.key("backspace")).toBe("cancel");
    expect(line.key("pageUp")).toBe("ignored");
  });

  test("a pasted newline never submits: line breaks become spaces", () => {
    const line = createCommandLine(":", { history: [] });
    line.paste("q\r\n!\nx\ry");
    expect(line.text).toBe("q ! x y");
  });

  test("the initial text is editable and the cursor starts at its end", () => {
    const line = createCommandLine(":", { history: [], initial: "open " });
    expect(line.text).toBe("open ");
    expect(line.cursor).toBe(5);
  });

  test("cursor moves and deletions respect graphemes", () => {
    const line = createCommandLine("/", { history: [] });
    line.insert("ae\u0301👨‍👩‍👧z");
    typed(line, "left", "left");
    expect(line.cursor).toBe("ae\u0301".length);
    typed(line, "backspace");
    expect(line.text).toBe("a👨‍👩‍👧z");
    typed(line, "delete");
    expect(line.text).toBe("az");
  });

  test("Alt word motions and word deletion work inside the line", () => {
    const line = createCommandLine(":", { history: [] });
    line.insert("filter tags bug-fix ui");
    typed(line, "alt+b");
    expect(line.cursor).toBe("filter tags bug-fix ".length);
    typed(line, "alt+b", "alt+b");
    expect(line.cursor).toBe("filter tags ".length);
    typed(line, "ctrl+left");
    expect(line.cursor).toBe("filter ".length);
    typed(line, "alt+shift+b");
    expect(line.cursor).toBe(0);
    typed(line, "alt+f");
    expect(line.cursor).toBe("filter".length);
    typed(line, "alt+right", "ctrl+right", "alt+shift+f");
    expect(line.cursor).toBe("filter tags bug-fix".length);
    typed(line, "end", "alt+backspace");
    expect(line.text).toBe("filter tags bug-fix ");
    typed(line, "ctrl+w");
    expect(line.text).toBe("filter tags ");
    typed(line, "alt+left");
    expect(line.cursor).toBe("filter ".length);
  });

  test("changes are reported", () => {
    let changes = 0;
    const line = createCommandLine(":", { history: [], onChange: () => changes++ });
    line.insert("x");
    typed(line, "left");
    line.paste("y");
    expect(changes).toBe(3);
  });
});

describe("completion", () => {
  const complete = (text: string): readonly string[] =>
    ["filter", "focus", "forward", "help"].filter(c => c.startsWith(text));

  test("Tab cycles forward and Shift-Tab backward through candidates of the TYPED prefix", () => {
    const line = createCommandLine(":", { history: [], complete });
    line.insert("f");
    expect(line.completion).toBeNull();
    typed(line, "tab");
    expect(line.text).toBe("filter");
    expect(line.completion).toEqual({ candidates: ["filter", "focus", "forward"], index: 0 });
    typed(line, "tab");
    expect(line.text).toBe("focus");
    typed(line, "tab", "tab");
    expect(line.text).toBe("filter");
    typed(line, "shift+tab");
    expect(line.text).toBe("forward");
    expect(line.cursor).toBe("forward".length);
  });

  test("Shift-Tab starts from the last candidate; editing makes the new text the prefix", () => {
    const line = createCommandLine(":", { history: [], complete });
    line.insert("f");
    typed(line, "shift+tab");
    expect(line.text).toBe("forward");
    typed(line, "backspace", "backspace", "backspace", "backspace", "backspace", "backspace");
    expect(line.text).toBe("f");
    expect(line.completion).toBeNull();
    line.insert("o");
    typed(line, "tab");
    expect(line.text).toBe("focus");
    typed(line, "tab");
    expect(line.text).toBe("forward");
  });

  test("a single candidate completes and stays; no candidate changes nothing", () => {
    const line = createCommandLine(":", { history: [], complete });
    line.insert("he");
    typed(line, "tab", "tab");
    expect(line.text).toBe("help");
    const none = createCommandLine(":", { history: [], complete });
    none.insert("zz");
    expect(none.key("tab")).toBe("handled");
    expect(none.text).toBe("zz");
    expect(none.completion).toBeNull();
  });

  test("without a completer Tab is inert", () => {
    const line = createCommandLine("/", { history: [] });
    line.insert("abc");
    expect(line.key("tab")).toBe("handled");
    expect(line.text).toBe("abc");
  });
});

describe("history", () => {
  test("Up/Down walk the history and restore the unfinished line; submit records non-repeating entries", () => {
    const history: string[] = [];
    for (const text of ["help", "messages", "messages", "  "]) {
      const line = createCommandLine(":", { history });
      line.insert(text);
      expect(line.submit()).toBe(text);
    }
    expect(history).toEqual(["help", "messages"]);
    const line = createCommandLine(":", { history });
    typed(line, "up");
    expect(line.text).toBe("messages");
    typed(line, "up", "up");
    expect(line.text).toBe("help");
    typed(line, "down");
    expect(line.text).toBe("messages");
    typed(line, "down");
    expect(line.text).toBe("");
  });

  test("a typed prefix filters Up/Down (the unfinished line comes back); Ctrl-P/Ctrl-N ignore it", () => {
    const history = ["help", "set done!", "messages"];
    const line = createCommandLine(":", { history });
    line.insert("se");
    typed(line, "up");
    expect(line.text).toBe("set done!");
    typed(line, "up");
    expect(line.text).toBe("set done!");
    typed(line, "down");
    expect(line.text).toBe("se");
    typed(line, "ctrl+p");
    expect(line.text).toBe("messages");
    typed(line, "ctrl+p", "ctrl+p");
    expect(line.text).toBe("help");
    typed(line, "ctrl+n", "ctrl+n", "ctrl+n");
    expect(line.text).toBe("se");
  });

  test("editing a recalled entry starts a fresh walk from the newest entry", () => {
    const history = ["help", "messages"];
    const line = createCommandLine(":", { history });
    typed(line, "up", "up");
    expect(line.text).toBe("help");
    line.insert("!");
    typed(line, "up");
    expect(line.text).toBe("help!");
    typed(line, "backspace", "up");
    expect(line.text).toBe("help");
  });

  test("history is capped, dropping the oldest entries", () => {
    const history: string[] = [];
    for (let i = 0; i < 5; i++) {
      const line = createCommandLine("/", { history, maxHistory: 3 });
      line.insert(`q${i}`);
      line.submit();
    }
    expect(history).toEqual(["q2", "q3", "q4"]);
  });
});
