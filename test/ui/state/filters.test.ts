// Unit tests for the filters persistence module.
//
// Order-independent by construction: the parser is exported from the module
// and exercised as a pure function over the raw localStorage string. No
// dependence on bun:test's per-file ESM-cache.
//
// Effect coverage drives the live signal and asserts JSON round-trips —
// safe regardless of which test file imported the module first because the
// effect is registered once at module load and stays subscribed.

import { describe, test, expect, beforeEach } from "bun:test";
import { filters } from "../../../src/ui/state/signals.ts";
import { KEY, parseStored } from "../../../src/ui/state/filters.ts";

describe("state/filters parseStored", () => {
  test("valid all-set payload → typed Filters object", () => {
    const raw = JSON.stringify({ status: "review", lane: "now", tag: ["alpha", "beta"] });
    expect(parseStored(raw)).toEqual({ status: "review", lane: "now", tag: ["alpha", "beta"] });
  });
  test("valid all-null payload → typed Filters object with empty tag", () => {
    const raw = JSON.stringify({ status: null, lane: null, tag: [] });
    expect(parseStored(raw)).toEqual({ status: null, lane: null, tag: [] });
  });
  test("null / empty raw → null (missing key)", () => {
    expect(parseStored(null)).toBeNull();
    expect(parseStored("")).toBeNull();
  });
  test("non-JSON raw → null", () => {
    expect(parseStored("not-json")).toBeNull();
  });
  test("non-object JSON → null", () => {
    expect(parseStored("42")).toBeNull();
    expect(parseStored("null")).toBeNull();
    expect(parseStored("[]")).toBeNull();
  });
  test("invalid status value → whole payload rejected (no partial-merge)", () => {
    const raw = JSON.stringify({ status: "bogus", lane: null, tag: [] });
    expect(parseStored(raw)).toBeNull();
  });
  test("non-null non-string lane → whole payload rejected", () => {
    const raw = JSON.stringify({ status: null, lane: 42, tag: [] });
    expect(parseStored(raw)).toBeNull();
  });
  test("tag is not an array → whole payload rejected", () => {
    const raw = JSON.stringify({ status: null, lane: null, tag: "alpha" });
    expect(parseStored(raw)).toBeNull();
  });
  test("tag array contains non-strings → whole payload rejected", () => {
    const raw = JSON.stringify({ status: null, lane: null, tag: ["alpha", 7] });
    expect(parseStored(raw)).toBeNull();
  });
  test("each known TaskStatus literal is accepted", () => {
    for (const s of ["draft", "open", "review", "blocked", "done"] as const) {
      const raw = JSON.stringify({ status: s, lane: null, tag: [] });
      expect(parseStored(raw)).toEqual({ status: s, lane: null, tag: [] });
    }
  });
});

describe("state/filters effect", () => {
  beforeEach(() => {
    filters.value = { status: null, lane: null, tag: [] };
    localStorage.removeItem(KEY);
  });

  test("effect writes JSON-stringified filters back to localStorage on mutation", () => {
    filters.value = { status: "blocked", lane: "later", tag: ["beta", "gamma"] };
    const raw = localStorage.getItem(KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toEqual({ status: "blocked", lane: "later", tag: ["beta", "gamma"] });
  });

  test("effect writes the empty-default shape when filters are reset", () => {
    filters.value = { status: "review", lane: "now", tag: ["x"] };
    filters.value = { status: null, lane: null, tag: [] };
    const raw = localStorage.getItem(KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toEqual({ status: null, lane: null, tag: [] });
  });
});
