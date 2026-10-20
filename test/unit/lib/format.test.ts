// lib/format.ts — relative "… ago" timestamps and compact row ages.

import { describe, expect, test } from "bun:test";
import { fmtAge, fmtTime, initial, plural } from "../../../src/lib/format.ts";

describe("fmtTime", () => {
  test("seconds, minutes, hours and days ago", () => {
    const now = Date.now();
    expect(fmtTime(now - 5_000)).toBe("5s ago");
    expect(fmtTime(now - 5 * 60_000)).toBe("5m ago");
    expect(fmtTime(now - 5 * 3_600_000)).toBe("5h ago");
    expect(fmtTime(now - 5 * 86_400_000)).toBe("5d ago");
  });
});

describe("fmtAge", () => {
  test("now under a minute, then minutes, hours, days, and weeks from 14 days", () => {
    const now = Date.now();
    expect(fmtAge(now - 30_000)).toBe("now");
    expect(fmtAge(now + 5_000)).toBe("now");
    expect(fmtAge(now - 5 * 60_000)).toBe("5m");
    expect(fmtAge(now - 3 * 3_600_000)).toBe("3h");
    expect(fmtAge(now - 2 * 86_400_000)).toBe("2d");
    expect(fmtAge(now - 13 * 86_400_000)).toBe("13d");
    expect(fmtAge(now - 14 * 86_400_000)).toBe("2w");
    expect(fmtAge(now - 20 * 86_400_000)).toBe("2w");
    expect(fmtAge(now - 28 * 86_400_000)).toBe("4w");
  });
});

describe("initial", () => {
  test("the first non-space character, upper-cased, or ? when empty", () => {
    expect(initial("  kalindu")).toBe("K");
    expect(initial("")).toBe("?");
    expect(initial(null)).toBe("?");
    expect(initial(undefined)).toBe("?");
  });
});

describe("plural", () => {
  test("one is singular; zero and many take an s", () => {
    expect(plural(1, "task")).toBe("1 task");
    expect(plural(0, "task")).toBe("0 tasks");
    expect(plural(12, "update")).toBe("12 updates");
  });
});
