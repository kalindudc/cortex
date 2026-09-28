import { test, expect, describe } from "bun:test";
import {
  DEFAULT_KEYS,
  KEY_ACTIONS,
  INSERT_KEY_ACTIONS,
  NORMAL_ACTIONS,
  INSERT_ACTIONS,
  VISUAL_ACTIONS,
  VISUAL_KEY_ACTIONS,
  actionKeyLabels,
  createKeyDispatcher,
  insertKeyLabels,
  isFunctionKey,
  isNormalAction,
  isVisualAction,
  parseKeyName,
  parseKeys,
  printableKey,
  visualKeyLabels,
  type InsertAction,
  type KeyConfig,
  type KeyEvent,
  type KeyMode,
  type KeyTable,
  type NormalAction,
  type VisualAction,
} from "../../../src/tui/keys.ts";

// Plan @400 N17/N18: modes, counts, the `;` leader, single-key bindings, and
// tui.toml validation that normalizes every key to its legacy byte(s) AND
// its Kitty identity before rejecting anything ambiguous or reserved.

const ESC = "\x1b";

function names(keys: KeyConfig, table: "normal" | "leader", action: NormalAction): string[] {
  return keys.bindings[table][action].map(b => b.id);
}

function parsed(raw: unknown): KeyConfig {
  const result = parseKeys(raw);
  expect(result.problems).toEqual([]);
  return result.keys;
}

/** Feed a sequence of terminal inputs, returning every event in order. */
function feedAll(keys: KeyConfig, inputs: string[], mode: KeyMode = "NORMAL"): KeyEvent[] {
  const d = createKeyDispatcher(keys);
  d.setMode(mode);
  return inputs.flatMap(input => d.feed(input));
}

const action = (
  name: NormalAction | InsertAction | VisualAction,
  count: number | null = null,
  via: KeyTable = "normal",
): KeyEvent => ({
  type: "action",
  action: name,
  count,
  via,
});

describe("default key table (N18)", () => {
  test("NORMAL defaults", () => {
    const k = DEFAULT_KEYS;
    const expected: Partial<Record<NormalAction, string[]>> = {
      down: ["j", "down"],
      up: ["k", "up"],
      left: ["h", "left"],
      right: ["l", "right"],
      half_down: ["ctrl+d"],
      half_up: ["ctrl+u"],
      top: ["g"],
      bottom: ["shift+g"],
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
      previous_match: ["shift+n"],
      insert: ["i"],
      post: ["c"],
      undo: ["u"],
      redo: ["ctrl+r"],
      visual: ["v"],
      visual_line: ["shift+v"],
      paste_after: ["p"],
      paste_before: ["shift+p"],
      help: ["?"],
      commands: ["ctrl+p"],
      back: ["ctrl+o"],
      forward: [],
      suspend: ["ctrl+z"],
      filters: ["f"],
      clear_filters: ["shift+f"],
    };
    for (const [act, ids] of Object.entries(expected)) expect(names(k, "normal", act as NormalAction)).toEqual(ids);
  });

  test("leader `;` defaults and the single INSERT shortcut", () => {
    const k = DEFAULT_KEYS;
    expect(k.leader.id).toBe(";");
    const expected: Partial<Record<NormalAction, string[]>> = {
      focus_tasks: ["h"],
      focus_document: ["l"],
      toggle_tasks: ["e"],
      read: ["r"],
      edit: ["i"],
      split: ["s"],
      post: ["c"],
      tags: ["t"],
      sort: ["o"],
    };
    for (const [act, ids] of Object.entries(expected)) expect(names(k, "leader", act as NormalAction)).toEqual(ids);
    expect(k.bindings.insert.save.map(b => b.id)).toEqual(["ctrl+s"]);
    expect(INSERT_ACTIONS).toEqual(["save"]);
  });

  test("an empty or absent config yields the defaults with no problems", () => {
    expect(parseKeys(undefined)).toEqual({ keys: DEFAULT_KEYS, problems: [] });
    expect(parseKeys({})).toEqual({ keys: DEFAULT_KEYS, problems: [] });
    expect(parseKeys({ keys: {} })).toEqual({ keys: DEFAULT_KEYS, problems: [] });
  });

  test("the list keys f, F and ;o are ordinary configurable actions that pass validation", () => {
    const k = parsed({
      keys: { normal: { filters: ["f"], clear_filters: ["F"] }, leader: { sort: ["o"] } },
    });
    expect(names(k, "normal", "filters")).toEqual(["f"]);
    expect(names(k, "normal", "clear_filters")).toEqual(["shift+f"]);
    expect(names(k, "leader", "sort")).toEqual(["o"]);
    const moved = parsed({ keys: { normal: { filters: ["z"], clear_filters: ["Z"] }, leader: { sort: ["y"] } } });
    expect(names(moved, "normal", "filters")).toEqual(["z"]);
    expect(names(moved, "leader", "sort")).toEqual(["y"]);
    expect(feedAll(DEFAULT_KEYS, ["f", "F", ";", "o"])).toEqual([
      action("filters"),
      action("clear_filters"),
      action("sort", null, "leader"),
    ]);
    // Reserved keys stay refused for them too (N18).
    expect(parseKeys({ keys: { normal: { filters: ["1"] } } }).problems.length).toBeGreaterThan(0);
  });

  test("every action has a description for help", () => {
    for (const a of NORMAL_ACTIONS) expect(KEY_ACTIONS[a].description.length).toBeGreaterThan(0);
    for (const a of INSERT_ACTIONS) expect(INSERT_KEY_ACTIONS[a].description.length).toBeGreaterThan(0);
    for (const a of VISUAL_ACTIONS) expect(VISUAL_KEY_ACTIONS[a].description.length).toBeGreaterThan(0);
  });
});

describe("parseKeyName: normalization to Kitty identity and legacy bytes", () => {
  const ok = (name: string) => {
    const r = parseKeyName(name);
    if (!r.ok) throw new Error(`${name}: ${r.reason}`);
    return r.key;
  };

  test("letters, shifted letters and symbols", () => {
    expect(ok("j")).toMatchObject({ id: "j", legacy: ["j"] });
    expect(ok("G")).toMatchObject({ id: "shift+g", legacy: ["G"] });
    expect(ok("shift+g")).toMatchObject({ id: "shift+g", legacy: ["G"] });
    expect(ok("?").id).toBe("?");
    expect(ok("space")).toMatchObject({ id: "space", legacy: [" "] });
  });

  test("ctrl mapping follows the legacy table (same-byte aliases share a byte)", () => {
    expect(ok("ctrl+d").legacy).toEqual(["\x04"]);
    expect(ok("CTRL+D").id).toBe("ctrl+d");
    expect(ok("ctrl+-").legacy).toContain("\x1f");
    expect(ok("ctrl+_").legacy).toContain("\x1f");
    expect(ok("ctrl+/").legacy).toContain("\x1f");
    expect(ok("ctrl+space").legacy).toContain("\x00");
    expect(ok("ctrl+@").legacy).toContain("\x00");
    expect(ok("ctrl+[").legacy).toContain(ESC);
    expect(ok("ctrl+;").legacy).toContain(";");
    // Legacy terminals drop shift for ctrl+letter.
    expect(ok("ctrl+shift+p").legacy).toEqual(["\x10"]);
    expect(ok("ctrl+shift+p").id).toBe("ctrl+shift+p");
  });

  test("alt prefixes ESC; named keys carry their CSI/SS3 encodings", () => {
    expect(ok("alt+x").legacy).toEqual(["\x1bx"]);
    expect(ok("alt+left").legacy).toContain("\x1bb");
    expect(ok("down").legacy).toEqual(expect.arrayContaining(["\x1b[B", "\x1bOB"]));
    expect(ok("shift+tab").legacy).toContain("\x1b[Z");
    expect(ok("pagedown").id).toBe("pageDown");
    expect(ok("esc").id).toBe("escape");
    expect(ok("return").id).toBe("enter");
    expect(ok("ctrl++").id).toBe("ctrl++");
  });

  test("names that are not one key are rejected", () => {
    for (const bad of [
      "",
      " ",
      "gg",
      "ctrl+",
      "ctrl+ctrl+x",
      "hyper+x",
      "super+k",
      "shift+/",
      "shift+1",
      "é",
      "ctrl+pgdn",
    ]) {
      expect(parseKeyName(bad).ok, bad).toBe(false);
    }
  });
});

describe("parseKeys: remaps replace an action's whole key list", () => {
  test("a remapped action replaces its defaults; others keep theirs", () => {
    const k = parsed({
      keys: { normal: { down: ["ctrl+n", "j"] }, leader: { tags: ["g"] }, insert: { save: ["alt+w"] } },
    });
    expect(names(k, "normal", "down")).toEqual(["ctrl+n", "j"]);
    expect(names(k, "normal", "up")).toEqual(["k", "up"]);
    expect(names(k, "leader", "tags")).toEqual(["g"]);
    expect(names(k, "leader", "read")).toEqual(["r"]);
    expect(k.bindings.insert.save.map(b => b.id)).toEqual(["alt+w"]);
  });

  test("an empty list unbinds; NORMAL actions may also be bound in the leader table and vice versa", () => {
    const k = parsed({ keys: { normal: { undo: [], read: ["R"] }, leader: { undo: ["u"] } } });
    expect(names(k, "normal", "undo")).toEqual([]);
    expect(names(k, "normal", "read")).toEqual(["shift+r"]);
    expect(names(k, "leader", "undo")).toEqual(["u"]);
  });

  test("a custom leader", () => {
    const k = parsed({ leader: ",", keys: { normal: {} } });
    expect(k.leader.id).toBe(",");
    const k2 = parsed({ leader: "space" });
    expect(k2.leader.id).toBe("space");
  });

  test("the configured name is retained for help and errors", () => {
    const k = parsed({ keys: { normal: { down: ["CTRL+N"] } } });
    expect(k.bindings.normal.down[0]).toMatchObject({ name: "CTRL+N", id: "ctrl+n", label: "Ctrl-n" });
  });
});

describe("parseKeys: rejections keep the whole section's defaults and record a problem", () => {
  function rejects(raw: unknown, keyPath: string | RegExp, reason: RegExp) {
    const { keys, problems } = parseKeys(raw);
    expect(problems.length, JSON.stringify(problems)).toBeGreaterThan(0);
    const hit = problems.find(p => (typeof keyPath === "string" ? p.keyPath === keyPath : keyPath.test(p.keyPath)));
    expect(hit, `no problem at ${keyPath} in ${JSON.stringify(problems)}`).toBeDefined();
    expect(hit?.reason).toMatch(reason);
    return keys;
  }

  test("unknown actions in every table", () => {
    rejects({ keys: { normal: { fly: ["x"] } } }, "keys.normal.fly", /unknown action/);
    rejects({ keys: { leader: { fly: ["x"] } } }, "keys.leader.fly", /unknown action/);
    rejects({ keys: { insert: { down: ["ctrl+n"] } } }, "keys.insert.down", /unknown action/);
    rejects({ keys: { visual: { fly: ["x"] } } }, "keys.visual.fly", /unknown action/);
    rejects({ keys: { replace: {} } }, "keys.replace", /unknown key table/);
  });

  test("wrong shapes", () => {
    rejects({ keys: 3 }, "keys", /table/);
    rejects({ keys: { normal: 3 } }, "keys.normal", /table/);
    rejects({ keys: { normal: { down: "j" } } }, "keys.normal.down", /array of key names/);
    rejects({ keys: { normal: { down: [1] } } }, "keys.normal.down", /array of key names/);
    rejects({ keys: { normal: { down: ["gg"] } } }, "keys.normal.down", /not a single key/);
  });

  test("no partial application: one bad entry reverts every remap in that section", () => {
    const keys = rejects({ keys: { normal: { down: ["ctrl+n"], up: ["q"] } } }, "keys.normal.up", /reserved/);
    expect(names(keys, "normal", "down")).toEqual(["j", "down"]);
    expect(names(keys, "normal", "up")).toEqual(["k", "up"]);
  });

  test("other sections still apply when one is rejected", () => {
    const { keys, problems } = parseKeys({ keys: { normal: { up: ["q"] }, leader: { tags: ["g"] } } });
    expect(problems.map(p => p.keyPath)).toEqual(["keys.normal.up"]);
    expect(names(keys, "leader", "tags")).toEqual(["g"]);
  });

  test("duplicates, including same-byte and same-identity aliases", () => {
    rejects({ keys: { normal: { down: ["x"], up: ["x"] } } }, /^keys\.normal\./, /assigned to both|twice/);
    rejects({ keys: { normal: { down: ["x", "x"] } } }, "keys.normal.down", /twice/);
    rejects({ keys: { normal: { down: ["G"], bottom: ["shift+g"] } } }, /^keys\.normal\./, /same key/);
    rejects({ keys: { normal: { down: ["ctrl+-"], up: ["ctrl+_"] } } }, /^keys\.normal\./, /same key/);
    rejects({ keys: { normal: { down: ["ctrl+space"], up: ["ctrl+@"] } } }, /^keys\.normal\./, /same key/);
    // Legacy terminals drop shift for ctrl+letter: ctrl+shift+p collides with commands' default ctrl+p.
    rejects({ keys: { normal: { back: ["ctrl+shift+p"] } } }, "keys.normal.back", /same key/);
    rejects({ keys: { insert: { save: ["alt+b", "alt+left"] } } }, "keys.insert.save", /same key/);
    // A default binding is a real assignment: rebinding its key elsewhere collides.
    rejects({ keys: { normal: { post: ["j"] } } }, /^keys\.normal\./, /assigned to both/);
  });

  test("keys that shadow the leader", () => {
    rejects({ keys: { normal: { down: [";"] } } }, "keys.normal.down", /leader/);
    rejects({ leader: ",", keys: { normal: { down: [","] } } }, "keys.normal.down", /leader/);
    // A leader that a (default) NORMAL binding already uses keeps its default.
    const keys = rejects({ leader: "g" }, "leader", /leader/);
    expect(keys.leader.id).toBe(";");
    expect(names(keys, "normal", "top")).toEqual(["g"]);
  });

  test("reserved keys and their aliases, in every table", () => {
    const reserved = [
      ":",
      "/",
      "escape",
      "esc",
      "ctrl+[",
      "ctrl+3",
      "ctrl+c",
      "q",
      "enter",
      "return",
      "ctrl+m",
      "ctrl+j",
      "shift+enter",
      "ctrl+enter",
      "0",
      "5",
      "9",
      "ctrl+1",
      "ctrl+:",
    ];
    for (const key of reserved) {
      rejects({ keys: { normal: { down: [key] } } }, "keys.normal.down", /reserved/);
      rejects({ keys: { leader: { tags: [key] } } }, "keys.leader.tags", /reserved/);
    }
    for (const key of ["escape", "ctrl+[", "ctrl+c", "ctrl+m", "ctrl+j", "alt+escape"]) {
      rejects({ keys: { insert: { save: [key] } } }, "keys.insert.save", /reserved/);
    }
  });

  test("ctrl+i and ctrl+h (legacy Tab and Backspace), and other Tab/Backspace aliases", () => {
    for (const key of ["ctrl+i", "ctrl+h", "ctrl+8", "ctrl+?"]) {
      rejects({ keys: { normal: { down: [key] } } }, "keys.normal.down", /Tab|Backspace/);
      rejects({ keys: { insert: { save: [key] } } }, "keys.insert.save", /Tab|Backspace/);
    }
  });

  test("every function key, in any case or with modifiers", () => {
    for (const key of ["F1", "f5", "F12", "f13", "F24", "shift+f5", "ctrl+F1", "alt+f24"]) {
      rejects({ keys: { normal: { down: [key] } } }, "keys.normal.down", /function key/);
      rejects({ keys: { insert: { save: [key] } } }, "keys.insert.save", /function key/);
    }
  });

  test("the leader obeys the reserved rule", () => {
    for (const leader of [
      ":",
      "/",
      "q",
      "5",
      "0",
      "escape",
      "ctrl+[",
      "ctrl+c",
      "enter",
      "ctrl+i",
      "ctrl+h",
      "F1",
      "gg",
      3,
      "",
    ]) {
      const keys = rejects({ leader }, "leader", /reserved|function key|Tab|Backspace|single key|string/);
      expect(keys.leader.id).toBe(";");
    }
  });

  test("INSERT accepts only ctrl/alt shortcuts", () => {
    for (const key of ["s", "S", "tab", "shift+tab", "space", "down", "home"]) {
      rejects({ keys: { insert: { save: [key] } } }, "keys.insert.save", /ctrl or alt/);
    }
    expect(names(parsed({ keys: { insert: { save: ["ctrl+shift+s"] } } }), "normal", "down")).toEqual(["j", "down"]);
    expect(parsed({ keys: { insert: { save: ["alt+s", "ctrl+w"] } } }).bindings.insert.save.map(b => b.id)).toEqual([
      "alt+s",
      "ctrl+w",
    ]);
  });
});

describe("dispatcher: NORMAL counts, leader and reserved keys", () => {
  test("motions with and without counts", () => {
    expect(feedAll(DEFAULT_KEYS, ["j"])).toEqual([action("down")]);
    expect(feedAll(DEFAULT_KEYS, ["5", "j"])).toEqual([action("down", 5)]);
    expect(feedAll(DEFAULT_KEYS, ["1", "2", "k"])).toEqual([action("up", 12)]);
    expect(feedAll(DEFAULT_KEYS, ["5", "j", "j"])).toEqual([action("down", 5), action("down")]);
    expect(feedAll(DEFAULT_KEYS, ["\x1b[B"])).toEqual([action("down")]);
    expect(feedAll(DEFAULT_KEYS, ["G"])).toEqual([action("bottom")]);
    expect(feedAll(DEFAULT_KEYS, ["\x04"])).toEqual([action("half_down")]);
  });

  test("a leading 0 is never a count (it is the line-start key for the focused pane) and counts are clamped", () => {
    const d = createKeyDispatcher(DEFAULT_KEYS);
    expect(d.feed("0")).toEqual([{ type: "key", key: "0", data: "0", count: null }]);
    expect(d.pending()).toEqual({ count: null, leader: false });
    for (const digit of "123456789") d.feed(digit);
    expect(d.feed("j")).toEqual([action("down", 9999)]);
  });

  test("pending state is observable and cleared by Esc or Ctrl-C without an event", () => {
    const d = createKeyDispatcher(DEFAULT_KEYS);
    d.feed("4");
    expect(d.pending()).toEqual({ count: 4, leader: false });
    expect(d.feed(ESC)).toEqual([]);
    expect(d.pending()).toEqual({ count: null, leader: false });
    d.feed(";");
    expect(d.pending()).toEqual({ count: null, leader: true });
    expect(d.feed("\x03")).toEqual([]);
    expect(d.pending()).toEqual({ count: null, leader: false });
    expect(d.mode()).toBe("NORMAL");
  });

  test("Esc and Ctrl-C with nothing pending cancel; Ctrl-C never quits", () => {
    expect(feedAll(DEFAULT_KEYS, [ESC])).toEqual([{ type: "cancel", key: "escape" }]);
    expect(feedAll(DEFAULT_KEYS, ["\x03"])).toEqual([{ type: "cancel", key: "ctrl+c" }]);
  });

  test("leader + one key, with a count; unknown leader keys are reported, not re-dispatched", () => {
    expect(feedAll(DEFAULT_KEYS, [";", "h"])).toEqual([action("focus_tasks", null, "leader")]);
    expect(feedAll(DEFAULT_KEYS, [";", "c"])).toEqual([action("post", null, "leader")]);
    expect(feedAll(DEFAULT_KEYS, ["3", ";", "s"])).toEqual([action("split", 3, "leader")]);
    expect(feedAll(DEFAULT_KEYS, [";", "j"])).toEqual([{ type: "unbound", key: "j", leader: true }]);
    expect(feedAll(DEFAULT_KEYS, [";", ";", "h"])).toEqual([
      { type: "unbound", key: ";", leader: true },
      action("left"),
    ]);
  });

  test("a custom leader and remapped keys drive dispatch", () => {
    const keys = parsed({ leader: ",", keys: { normal: { down: ["ctrl+n"], half_down: ["ctrl+_"] } } });
    expect(feedAll(keys, [",", "h"])).toEqual([action("focus_tasks", null, "leader")]);
    expect(feedAll(keys, ["j"])).toEqual([{ type: "key", key: "j", data: "j", count: null }]);
    expect(feedAll(keys, ["\x0e"])).toEqual([action("down")]);
    // ctrl+_ and ctrl+- send the same legacy byte.
    expect(feedAll(keys, ["\x1f"])).toEqual([action("half_down")]);
    expect(feedAll(keys, [";"])).toEqual([{ type: "key", key: ";", data: ";", count: null }]);
  });

  test(": and / open COMMAND and SEARCH; bare q only reminds", () => {
    const d = createKeyDispatcher(DEFAULT_KEYS);
    expect(d.feed("5")).toEqual([]);
    expect(d.feed(":")).toEqual([{ type: "mode", mode: "COMMAND", previous: "NORMAL", cause: "command" }]);
    expect(d.pending()).toEqual({ count: null, leader: false });
    expect(d.mode()).toBe("COMMAND");
    d.setMode("NORMAL");
    expect(d.feed("/")).toEqual([{ type: "mode", mode: "SEARCH", previous: "NORMAL", cause: "search" }]);
    d.setMode("NORMAL");
    expect(d.feed("q")).toEqual([{ type: "quit-hint" }]);
    expect(d.mode()).toBe("NORMAL");
  });

  test("unbound keys pass through with their count for the focused pane (Home/End/Page, Enter)", () => {
    expect(feedAll(DEFAULT_KEYS, ["3", "\x1b[6~"])).toEqual([
      { type: "key", key: "pageDown", data: "\x1b[6~", count: 3 },
    ]);
    expect(feedAll(DEFAULT_KEYS, ["\r"])).toEqual([{ type: "key", key: "enter", data: "\r", count: null }]);
    expect(feedAll(DEFAULT_KEYS, ["\x1b[H"])).toEqual([{ type: "key", key: "home", data: "\x1b[H", count: null }]);
    expect(feedAll(DEFAULT_KEYS, ["x"])).toEqual([{ type: "key", key: "x", data: "x", count: null }]);
  });

  test("NORMAL never inserts text: a paste is reported as one paste event, never as keys", () => {
    const d = createKeyDispatcher(DEFAULT_KEYS);
    d.feed("2");
    expect(d.feed("\x1b[200~jj:q!\r\x1b[201~")).toEqual([{ type: "paste", text: "jj:q!\r" }]);
    expect(d.pending()).toEqual({ count: null, leader: false });
    expect(d.mode()).toBe("NORMAL");
  });

  test("Kitty keyboard protocol encodings and key releases", () => {
    expect(feedAll(DEFAULT_KEYS, ["\x1b[106u"])).toEqual([action("down")]);
    expect(feedAll(DEFAULT_KEYS, ["\x1b[100;5u"])).toEqual([action("half_down")]);
    expect(feedAll(DEFAULT_KEYS, ["\x1b[112;6u"])).toEqual([
      { type: "key", key: "ctrl+shift+p", data: "\x1b[112;6u", count: null },
    ]);
    expect(feedAll(DEFAULT_KEYS, ["\x1b[106;1:3u"])).toEqual([]);
    expect(feedAll(DEFAULT_KEYS, ["\x1b[27u"])).toEqual([{ type: "cancel", key: "escape" }]);
    // A Kitty-reported shifted ; is the : that opens COMMAND.
    expect(feedAll(DEFAULT_KEYS, ["\x1b[59:58;2u"])).toEqual([
      { type: "mode", mode: "COMMAND", previous: "NORMAL", cause: "command" },
    ]);
    const keys = parsed({ keys: { normal: { commands: ["ctrl+shift+p"], top: ["ctrl+g"] } } });
    expect(feedAll(keys, ["\x1b[112;6u"])).toEqual([action("commands")]);
  });
});

describe("dispatcher: INSERT, COMMAND and SEARCH", () => {
  test("INSERT treats every printable key as text, including j, : and q", () => {
    expect(feedAll(DEFAULT_KEYS, ["j", ":", "q", "5", "é"], "INSERT")).toEqual([
      { type: "text", text: "j" },
      { type: "text", text: ":" },
      { type: "text", text: "q" },
      { type: "text", text: "5" },
      { type: "text", text: "é" },
    ]);
  });

  test("INSERT: Esc and Ctrl-C return to NORMAL; ctrl+s saves; editing keys pass through", () => {
    expect(feedAll(DEFAULT_KEYS, [ESC], "INSERT")).toEqual([
      { type: "mode", mode: "NORMAL", previous: "INSERT", cause: "cancel" },
    ]);
    expect(feedAll(DEFAULT_KEYS, ["\x03"], "INSERT")).toEqual([
      { type: "mode", mode: "NORMAL", previous: "INSERT", cause: "cancel" },
    ]);
    expect(feedAll(DEFAULT_KEYS, ["\x13"], "INSERT")).toEqual([action("save", null, "insert")]);
    expect(feedAll(DEFAULT_KEYS, ["\t", "\x1b[Z", "\r", "\x7f", "\x04"], "INSERT")).toEqual([
      { type: "key", key: "tab", data: "\t", count: null },
      { type: "key", key: "shift+tab", data: "\x1b[Z", count: null },
      { type: "key", key: "enter", data: "\r", count: null },
      { type: "key", key: "backspace", data: "\x7f", count: null },
      { type: "key", key: "ctrl+d", data: "\x04", count: null },
    ]);
    expect(feedAll(DEFAULT_KEYS, ["\x1b[200~a\tb\x1b[201~"], "INSERT")).toEqual([{ type: "paste", text: "a\tb" }]);
  });

  test("COMMAND/SEARCH: text, Enter submits, Esc/Ctrl-C cancel, completion/history keys pass through", () => {
    const d = createKeyDispatcher(DEFAULT_KEYS);
    d.feed(":");
    expect(d.feed("w")).toEqual([{ type: "text", text: "w" }]);
    expect(d.feed("q")).toEqual([{ type: "text", text: "q" }]);
    expect(d.feed("\t")).toEqual([{ type: "key", key: "tab", data: "\t", count: null }]);
    expect(d.feed("\x1b[A")).toEqual([{ type: "key", key: "up", data: "\x1b[A", count: null }]);
    expect(d.feed("\r")).toEqual([{ type: "mode", mode: "NORMAL", previous: "COMMAND", cause: "submit" }]);
    d.feed("/");
    expect(d.feed("\x03")).toEqual([{ type: "mode", mode: "NORMAL", previous: "SEARCH", cause: "cancel" }]);
    d.feed(":");
    expect(d.feed(ESC)).toEqual([{ type: "mode", mode: "NORMAL", previous: "COMMAND", cause: "cancel" }]);
  });
});

describe("dispatcher: merged ESC+printable pairs split Vim-style", () => {
  test("a fast Esc :w from INSERT is Esc, then :, then w", () => {
    expect(feedAll(DEFAULT_KEYS, ["\x1b:", "w", "\r"], "INSERT")).toEqual([
      { type: "mode", mode: "NORMAL", previous: "INSERT", cause: "cancel" },
      { type: "mode", mode: "COMMAND", previous: "NORMAL", cause: "command" },
      { type: "text", text: "w" },
      { type: "mode", mode: "NORMAL", previous: "COMMAND", cause: "submit" },
    ]);
  });

  test("NORMAL: the Esc half clears a pending count, then the key dispatches", () => {
    expect(feedAll(DEFAULT_KEYS, ["5", "\x1bj"])).toEqual([action("down")]);
    expect(feedAll(DEFAULT_KEYS, ["\x1bj"])).toEqual([{ type: "cancel", key: "escape" }, action("down")]);
    expect(feedAll(DEFAULT_KEYS, [";", "\x1bh"])).toEqual([action("left")]);
    expect(feedAll(DEFAULT_KEYS, ["\x1b\x1b"])).toEqual([
      { type: "cancel", key: "escape" },
      { type: "cancel", key: "escape" },
    ]);
  });

  test("COMMAND: Esc then : reopens the command line", () => {
    const d = createKeyDispatcher(DEFAULT_KEYS);
    d.feed(":");
    expect(d.feed("\x1b:")).toEqual([
      { type: "mode", mode: "NORMAL", previous: "COMMAND", cause: "cancel" },
      { type: "mode", mode: "COMMAND", previous: "NORMAL", cause: "command" },
    ]);
  });

  test("configured Alt bindings win over splitting", () => {
    const keys = parsed({ keys: { normal: { commands: ["alt+x"] }, insert: { save: ["alt+w"] } } });
    expect(feedAll(keys, ["\x1bx"])).toEqual([action("commands")]);
    expect(feedAll(keys, ["\x1bw"], "INSERT")).toEqual([action("save", null, "insert")]);
    // Not configured in NORMAL: split (w is then the word motion).
    expect(feedAll(keys, ["\x1bw"])).toEqual([{ type: "cancel", key: "escape" }, action("word_forward")]);
  });

  test("Alt word motions stay inside text fields; elsewhere they split", () => {
    expect(feedAll(DEFAULT_KEYS, ["\x1bb", "\x1bf"], "INSERT")).toEqual([
      { type: "key", key: "alt+b", data: "\x1bb", count: null },
      { type: "key", key: "alt+f", data: "\x1bf", count: null },
    ]);
    const d = createKeyDispatcher(DEFAULT_KEYS);
    d.feed(":");
    expect(d.feed("\x1bb")).toEqual([{ type: "key", key: "alt+b", data: "\x1bb", count: null }]);
    expect(feedAll(DEFAULT_KEYS, ["\x1bb"])).toEqual([{ type: "cancel", key: "escape" }, action("word_backward")]);
    // alt+d would edit text, so a fast Esc d is still Esc then d.
    expect(feedAll(DEFAULT_KEYS, ["\x1bd"], "INSERT")).toEqual([
      { type: "mode", mode: "NORMAL", previous: "INSERT", cause: "cancel" },
      { type: "key", key: "d", data: "d", count: null },
    ]);
  });
});

describe("function keys are inert and never hinted", () => {
  const encodings = [
    "\x1bOP",
    "\x1bOQ",
    "\x1bOR",
    "\x1bOS",
    "\x1bO2P",
    "\x1b[P",
    "\x1b[1;2P",
    "\x1b[1;5S",
    "\x1b[1;2:1Q",
    "\x1b[11~",
    "\x1b[13~",
    "\x1b[15~",
    "\x1b[17~",
    "\x1b[21~",
    "\x1b[23~",
    "\x1b[24~",
    "\x1b[24;5~",
    "\x1b[25~",
    "\x1b[34~",
    "\x1b[11^",
    "\x1b[23$",
    "\x1b[12@",
    "\x1b[[A",
    "\x1b[[E",
    "\x1b[57376u",
    "\x1b[57387;2u",
    "\x1b[57398u",
    "\x1b[15;1:2~",
  ];

  test("isFunctionKey recognizes F1-F24 in legacy, rxvt, Linux console and Kitty encodings", () => {
    for (const data of encodings) expect(isFunctionKey(data), JSON.stringify(data)).toBe(true);
  });

  test("navigation keys are not function keys", () => {
    for (const data of ["\x1b[1~", "\x1b[2~", "\x1b[3~", "\x1b[4~", "\x1b[5~", "\x1b[6~", "\x1b[7~", "\x1b[8~"]) {
      expect(isFunctionKey(data), JSON.stringify(data)).toBe(false);
    }
    for (const data of ["\x1b[A", "\x1bOA", "\x1b[H", "\x1b[1;5H", "\x1b[Z", "j", ESC, "\x1b[106u", "\x1b[12;40R"]) {
      expect(isFunctionKey(data), JSON.stringify(data)).toBe(false);
    }
  });

  test("function keys change nothing in any mode, even with a count or leader pending", () => {
    for (const mode of ["NORMAL", "INSERT", "COMMAND", "SEARCH"] as const) {
      const d = createKeyDispatcher(DEFAULT_KEYS);
      d.setMode(mode);
      if (mode === "NORMAL") d.feed("7");
      for (const data of encodings) expect(d.feed(data), `${mode} ${JSON.stringify(data)}`).toEqual([]);
      expect(d.mode()).toBe(mode);
      if (mode === "NORMAL") expect(d.pending()).toEqual({ count: 7, leader: false });
    }
    const d = createKeyDispatcher(DEFAULT_KEYS);
    d.feed(";");
    expect(d.feed("\x1b[15~")).toEqual([]);
    expect(d.pending()).toEqual({ count: null, leader: true });
    expect(d.feed("h")).toEqual([action("focus_tasks", null, "leader")]);
  });

  test("labels render the configured keys and never a function key", () => {
    expect(actionKeyLabels(DEFAULT_KEYS, "down")).toEqual(["j", "Down"]);
    expect(actionKeyLabels(DEFAULT_KEYS, "half_down")).toEqual(["Ctrl-d"]);
    expect(actionKeyLabels(DEFAULT_KEYS, "bottom")).toEqual(["G"]);
    expect(actionKeyLabels(DEFAULT_KEYS, "previous_pane")).toEqual(["Shift-Tab"]);
    expect(actionKeyLabels(DEFAULT_KEYS, "post")).toEqual(["c", ";c"]);
    expect(actionKeyLabels(DEFAULT_KEYS, "focus_tasks")).toEqual([";h"]);
    expect(actionKeyLabels(DEFAULT_KEYS, "forward")).toEqual([]);
    expect(insertKeyLabels(DEFAULT_KEYS, "save")).toEqual(["Ctrl-s"]);

    const remapped = parsed({ leader: "space", keys: { normal: { down: ["ctrl+n"] }, leader: { tags: ["T"] } } });
    expect(actionKeyLabels(remapped, "down")).toEqual(["Ctrl-n"]);
    expect(actionKeyLabels(remapped, "tags")).toEqual(["Space T"]);

    for (const keys of [DEFAULT_KEYS, remapped]) {
      for (const a of NORMAL_ACTIONS) for (const label of actionKeyLabels(keys, a)) expect(label).not.toMatch(/\bF\d/i);
      for (const a of INSERT_ACTIONS) for (const label of insertKeyLabels(keys, a)) expect(label).not.toMatch(/\bF\d/i);
    }
  });
});

describe("printableKey (the raw hook dialogs use for y/n and their letter keys)", () => {
  test("one printable character, raw or Kitty CSI-u; never a control, functional key, pair or longer input", () => {
    expect(printableKey("y")).toBe("y");
    expect(printableKey("N")).toBe("N");
    expect(printableKey("\x1b[121u")).toBe("y");
    expect(printableKey("é")).toBe("é");
    for (const data of ["\r", ESC, `${ESC}y`, "\x1b[A", "ab", "", "\x1b[57376u", "\x7f"]) {
      expect(printableKey(data)).toBeUndefined();
    }
  });
});

describe("VISUAL and VISUAL LINE (vi visual mode): keys, validation and dispatch", () => {
  const visualIds = (keys: KeyConfig, a: VisualAction) => keys.bindings.visual[a].map(b => b.id);

  test("the [keys.visual] operators and their defaults; v/V/p/P and the w/b/e/$ motions are NORMAL actions", () => {
    expect([...VISUAL_ACTIONS]).toEqual(["yank", "delete", "change", "indent", "outdent", "other_end"]);
    expect(visualIds(DEFAULT_KEYS, "yank")).toEqual(["y"]);
    expect(visualIds(DEFAULT_KEYS, "delete")).toEqual(["d", "x"]);
    expect(visualIds(DEFAULT_KEYS, "change")).toEqual(["c"]);
    expect(visualIds(DEFAULT_KEYS, "indent")).toEqual([">"]);
    expect(visualIds(DEFAULT_KEYS, "outdent")).toEqual(["<"]);
    expect(visualIds(DEFAULT_KEYS, "other_end")).toEqual(["o"]);
    expect(visualKeyLabels(DEFAULT_KEYS, "delete")).toEqual(["d", "x"]);
    expect(isVisualAction("yank")).toBe(true);
    expect(isVisualAction("down")).toBe(false);
    expect(isNormalAction("visual")).toBe(true);
    expect(isNormalAction("save")).toBe(false);
    // None of the new NORMAL defaults collides with an existing one (the defaults parse clean).
    expect(parseKeys({}).problems).toEqual([]);
  });

  test("[keys.visual] validates like the other tables and never applies partially", () => {
    const k = parsed({ keys: { visual: { yank: ["Y"], other_end: ["O"] } } });
    expect(visualIds(k, "yank")).toEqual(["shift+y"]);
    expect(visualIds(k, "other_end")).toEqual(["shift+o"]);
    // Operators may reuse a NORMAL key: VISUAL reads its own table first (c posts in NORMAL, changes in VISUAL).
    expect(visualIds(parsed({ keys: { visual: { change: ["c", "s"] } } }), "change")).toEqual(["c", "s"]);
    const { keys, problems } = parseKeys({ keys: { visual: { yank: ["Y"], delete: ["q"] } } });
    expect(problems.map(p => p.keyPath)).toEqual(["keys.visual.delete"]);
    expect(problems[0]?.reason).toMatch(/reserved/);
    expect(visualIds(keys, "yank")).toEqual(["y"]);
    for (const key of [":", "/", "escape", "ctrl+c", "enter", "0", "7"]) {
      expect(parseKeys({ keys: { visual: { yank: [key] } } }).problems[0]?.reason).toMatch(/reserved/);
    }
    expect(parseKeys({ keys: { visual: { yank: ["F5"] } } }).problems[0]?.reason).toMatch(/function key/);
    expect(parseKeys({ keys: { visual: { yank: ["z"], delete: ["z"] } } }).problems[0]?.reason).toMatch(
      /assigned to both/,
    );
    expect(parseKeys({ keys: { visual: { yank: "y" } } }).problems[0]?.reason).toMatch(/array of key names/);
  });

  test("NORMAL: v, V, p, P, w, b, e and $ are actions; a 0 with no count is the line-start key, after a count a digit", () => {
    expect(feedAll(DEFAULT_KEYS, ["v", "V", "p", "P", "w", "b", "e", "$"])).toEqual([
      action("visual"),
      action("visual_line"),
      action("paste_after"),
      action("paste_before"),
      action("word_forward"),
      action("word_backward"),
      action("word_end"),
      action("line_end"),
    ]);
    expect(feedAll(DEFAULT_KEYS, ["0"])).toEqual([{ type: "key", key: "0", data: "0", count: null }]);
    expect(feedAll(DEFAULT_KEYS, ["1", "0", "j"])).toEqual([action("down", 10)]);
    expect(feedAll(DEFAULT_KEYS, ["3", "p"])).toEqual([action("paste_after", 3)]);
  });

  for (const mode of ["VISUAL", "VISUAL LINE"] as const) {
    test(`${mode}: motions (with counts) come from the NORMAL table, operators from [keys.visual]`, () => {
      expect(feedAll(DEFAULT_KEYS, ["j", "3", "k", "w", "$", "G", "\x04"], mode)).toEqual([
        action("down"),
        action("up", 3),
        action("word_forward"),
        action("line_end"),
        action("bottom"),
        action("half_down"),
      ]);
      expect(feedAll(DEFAULT_KEYS, ["y", "d", "x", "c", ">", "2", "<", "o"], mode)).toEqual([
        action("yank", null, "visual"),
        action("delete", null, "visual"),
        action("delete", null, "visual"),
        action("change", null, "visual"),
        action("indent", null, "visual"),
        action("outdent", 2, "visual"),
        action("other_end", null, "visual"),
      ]);
      // v and V are the NORMAL actions again: the shell toggles or switches the kind.
      expect(feedAll(DEFAULT_KEYS, ["v", "V"], mode)).toEqual([action("visual"), action("visual_line")]);
      expect(feedAll(DEFAULT_KEYS, ["0", "\x1b[H"], mode)).toEqual([
        { type: "key", key: "0", data: "0", count: null },
        { type: "key", key: "home", data: "\x1b[H", count: null },
      ]);
    });

    test(`${mode}: Esc and Ctrl-C return to NORMAL (a pending count too); : and / open their prompts; q reminds`, () => {
      const d = createKeyDispatcher(DEFAULT_KEYS);
      d.setMode(mode);
      expect(d.mode()).toBe(mode);
      expect(d.feed("y")).toEqual([action("yank", null, "visual")]);
      expect(d.mode()).toBe(mode); // operators never change the mode: the shell does
      d.feed("4");
      expect(d.pending()).toEqual({ count: 4, leader: false });
      expect(d.feed(ESC)).toEqual([{ type: "mode", mode: "NORMAL", previous: mode, cause: "cancel" }]);
      expect(d.pending()).toEqual({ count: null, leader: false });
      d.setMode(mode);
      expect(d.feed("\x03")).toEqual([{ type: "mode", mode: "NORMAL", previous: mode, cause: "cancel" }]);
      d.setMode(mode);
      expect(d.feed(":")).toEqual([{ type: "mode", mode: "COMMAND", previous: mode, cause: "command" }]);
      d.setMode(mode);
      expect(d.feed("/")).toEqual([{ type: "mode", mode: "SEARCH", previous: mode, cause: "search" }]);
      d.setMode(mode);
      expect(d.feed("q")).toEqual([{ type: "quit-hint" }]);
      // Never text: a paste is one paste event; the leader is not active in VISUAL.
      expect(d.feed("\x1b[200~dd\x1b[201~")).toEqual([{ type: "paste", text: "dd" }]);
      expect(d.feed(";")).toEqual([{ type: "key", key: ";", data: ";", count: null }]);
      // A fast Esc then j (one merged read) is Esc, then j in NORMAL.
      d.setMode(mode);
      expect(d.feed(`${ESC}j`)).toEqual([
        { type: "mode", mode: "NORMAL", previous: mode, cause: "cancel" },
        action("down"),
      ]);
      expect(d.mode()).toBe("NORMAL");
    });
  }

  test("a remapped [keys.visual] drives VISUAL dispatch; its keys stay NORMAL keys in NORMAL", () => {
    const keys = parsed({ keys: { visual: { yank: ["Y"], delete: ["D"] } } });
    expect(feedAll(keys, ["Y", "D", "y"], "VISUAL")).toEqual([
      action("yank", null, "visual"),
      action("delete", null, "visual"),
      { type: "key", key: "y", data: "y", count: null },
    ]);
    expect(feedAll(DEFAULT_KEYS, ["c", "y", "d"])).toEqual([
      action("post"),
      { type: "key", key: "y", data: "y", count: null },
      { type: "key", key: "d", data: "d", count: null },
    ]);
  });
});
