import { describe, expect, test } from "bun:test";
import { authorForBbThread } from "../../../src/lib/bbAuthor.ts";

describe("authorForBbThread", () => {
  test("an explicit author wins over a valid bb thread", () => {
    expect(authorForBbThread("planner-7f3a9201", "thr_2qj8qzdqqr")).toBe("planner-7f3a9201");
  });

  test("an explicit author is returned unchanged even when it is not a valid tag", () => {
    // The store's validator, not this selector, rejects bad tags.
    expect(authorForBbThread("x\ny", "thr_2qj8qzdqqr")).toBe("x\ny");
    expect(authorForBbThread("", undefined)).toBe("");
  });

  test("a valid bb thread id becomes bb-<thread id> when no author is given", () => {
    expect(authorForBbThread(undefined, "thr_2qj8qzdqqr")).toBe("bb-thr_2qj8qzdqqr");
    expect(authorForBbThread(undefined, "thr_abc123")).toBe("bb-thr_abc123");
    expect(authorForBbThread(undefined, `thr_${"a".repeat(40)}`)).toBe(`bb-thr_${"a".repeat(40)}`);
  });

  test("an invalid bb thread id gives no author", () => {
    for (const id of ["", "thr_", "thr_abc12", `thr_${"a".repeat(41)}`, "thr_ABC123", "abc_123456", " thr_abc123"]) {
      expect(authorForBbThread(undefined, id)).toBeUndefined();
    }
  });

  test("no author and no bb thread gives no author", () => {
    expect(authorForBbThread(undefined, undefined)).toBeUndefined();
  });
});
