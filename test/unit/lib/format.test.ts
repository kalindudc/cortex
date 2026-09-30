// lib/format.ts — relative "… ago" timestamps.

import { describe, expect, test } from "bun:test";
import { fmtTime } from "../../../src/lib/format.ts";

describe("fmtTime", () => {
  test("seconds, minutes, hours and days ago", () => {
    const now = Date.now();
    expect(fmtTime(now - 5_000)).toBe("5s ago");
    expect(fmtTime(now - 5 * 60_000)).toBe("5m ago");
    expect(fmtTime(now - 5 * 3_600_000)).toBe("5h ago");
    expect(fmtTime(now - 5 * 86_400_000)).toBe("5d ago");
  });
});
