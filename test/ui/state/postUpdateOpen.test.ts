// Unit tests for the postUpdateOpen persistence module.
//
// Order-independent by construction: the parser is exported from the module
// and exercised as a pure function (no dependence on bun:test's per-file
// ESM-cache, which silently makes any seed test that re-imports the module
// in a sibling test file vacuous).
//
// Effect coverage drives the live signal and asserts localStorage writes —
// safe regardless of which test file imported the module first because the
// effect is registered once at module load and stays subscribed.

import { describe, test, expect, beforeEach } from "bun:test";
import { postUpdateOpen } from "../../../src/ui/state/signals.ts";
import { KEY, parseStored } from "../../../src/ui/state/postUpdateOpen.ts";

describe("state/postUpdateOpen parseStored", () => {
  test("'1' → true", () => {
    expect(parseStored("1")).toBe(true);
  });
  test("'0' → false", () => {
    expect(parseStored("0")).toBe(false);
  });
  test("null → null (missing key)", () => {
    expect(parseStored(null)).toBeNull();
  });
  test("legacy 'true' / 'false' → null (rejected — only '1'/'0' are accepted)", () => {
    expect(parseStored("true")).toBeNull();
    expect(parseStored("false")).toBeNull();
  });
  test("garbage → null", () => {
    expect(parseStored("xyz")).toBeNull();
    expect(parseStored("")).toBeNull();
  });
});

describe("state/postUpdateOpen effect", () => {
  beforeEach(() => {
    postUpdateOpen.value = false;
    localStorage.removeItem(KEY);
  });

  test("effect writes '1' to localStorage when the wrapper opens", () => {
    postUpdateOpen.value = true;
    expect(localStorage.getItem(KEY)).toBe("1");
  });

  test("effect writes '0' to localStorage when the wrapper closes", () => {
    postUpdateOpen.value = true;
    postUpdateOpen.value = false;
    expect(localStorage.getItem(KEY)).toBe("0");
  });
});
