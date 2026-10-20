// lib/constants.ts — the status order, labels and cycle, plus the client-side
// tag-name rule shared by the desktop app and CLI.

import { describe, expect, test } from "bun:test";
import {
  isValidTagName,
  LANE_COLORS,
  nextActionLabel,
  nextStatusFor,
  priorityClass,
  STATUS,
  STATUS_LABEL,
} from "../../../src/lib/constants.ts";

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

describe("desktop UI constants", () => {
  test("nextActionLabel names the action that nextStatusFor takes", () => {
    expect(STATUS.map(nextActionLabel)).toEqual(["Publish", "Move to review", "Mark done", "Unblock", "Reopen"]);
  });

  test("priorityClass styles P0 as urgent and P1 as high, everything else plain", () => {
    expect(priorityClass(0)).toBe("urgent");
    expect(priorityClass(1)).toBe("high");
    expect(priorityClass(2)).toBe("");
    expect(priorityClass(null)).toBe("");
  });

  test("LANE_COLORS starts with no color, then 15 hex swatches", () => {
    expect(LANE_COLORS[0]).toBeNull();
    expect(LANE_COLORS).toHaveLength(16);
    for (const color of LANE_COLORS.slice(1)) expect(color).toMatch(/^#[0-9a-f]{6}$/);
  });
});
