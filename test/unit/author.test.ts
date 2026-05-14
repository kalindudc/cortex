import { test, expect, describe } from "bun:test";
import { validateAuthorTag } from "../../src/store.ts";

// ---------- pure-unit assertions on the validator ----------
//
// validateAuthorTag is the single chokepoint enforced from three sites:
//   1. CLI flag-parse (commands/update.ts) — defense in depth
//   2. HTTP handler (server.ts) — early 400 rejection
//   3. Store.addUpdate — final guard at the DB layer
// Tests below pin the contract (no newlines, max 80 chars).

describe("validateAuthorTag", () => {
  test("accepts a typical session-id tag and trims whitespace", () => {
    expect(validateAuthorTag("planner-7f3a")).toBe("planner-7f3a");
    expect(validateAuthorTag("  spaced-tag  ")).toBe("spaced-tag");
  });

  test("rejects embedded newlines (would corrupt per-line SSE/log rendering)", () => {
    expect(() => validateAuthorTag("x\ny")).toThrow(/newlines/);
  });

  test("rejects tags > 80 chars (sanity bound)", () => {
    expect(() => validateAuthorTag("a".repeat(81))).toThrow(/max 80/);
    // Boundary: exactly 80 chars must succeed.
    expect(() => validateAuthorTag("a".repeat(80))).not.toThrow();
  });
});
