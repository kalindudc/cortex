// lib/constants.ts — the status order, labels and cycle, plus the client-side
// tag-name rule shared by the TUI and CLI.

import { describe, expect, test } from "bun:test";
import { isValidTagName, nextStatusFor, STATUS, STATUS_LABEL } from "../../../src/lib/constants.ts";

describe("status constants", () => {
  test("STATUS lists every status in workflow order", () => {
    expect(STATUS).toEqual(["draft", "open", "review", "blocked", "done"]);
  });

  test("STATUS_LABEL labels exactly the STATUS values", () => {
    expect(Object.keys(STATUS_LABEL).sort()).toEqual([...STATUS].sort());
  });

  test("nextStatusFor moves each status one step on", () => {
    expect(STATUS.map(s => [s, nextStatusFor(s)])).toEqual([
      ["draft", "open"],
      ["open", "review"],
      ["review", "done"],
      ["blocked", "open"],
      ["done", "open"],
    ]);
  });
});

describe("isValidTagName", () => {
  test("accepts the store's tag grammar", () => {
    expect(isValidTagName("a-b_1@x")).toBe(true);
  });

  test("rejects empty, uppercase, too long and non-string names", () => {
    expect(isValidTagName("")).toBe(false);
    expect(isValidTagName("UP")).toBe(false);
    expect(isValidTagName("a".repeat(33))).toBe(false);
    expect(isValidTagName(42)).toBe(false);
    expect(isValidTagName(null)).toBe(false);
  });
});
