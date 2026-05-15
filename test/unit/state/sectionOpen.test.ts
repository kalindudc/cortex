// Unit tests for the sectionOpen persistence module.
//
// Order-independent by construction: the parser is exported from the module
// and exercised as a pure function over an explicit (key → raw) map. No
// dependence on bun:test's per-file ESM-cache.
//
// Effect coverage drives the live signal and asserts each per-key write
// independently — safe regardless of which test file imported the module
// first because the effect is registered once at module load and stays
// subscribed.

import { describe, test, expect, beforeEach } from "bun:test";
import { sectionOpen } from "../../../src/ui/state/signals.ts";
import { KEYS, parseStored } from "../../../src/ui/state/sectionOpen.ts";

describe("state/sectionOpen parseStored", () => {
  test("all '0' → all-false override", () => {
    expect(parseStored({ views: "0", lanes: "0", tasks: "0" })).toEqual({ views: false, lanes: false, tasks: false });
  });
  test("all '1' → all-true override", () => {
    expect(parseStored({ views: "1", lanes: "1", tasks: "1" })).toEqual({ views: true, lanes: true, tasks: true });
  });
  test("mixed '1'/'0' → per-key override", () => {
    expect(parseStored({ views: "1", lanes: "0", tasks: "1" })).toEqual({ views: true, lanes: false, tasks: true });
  });
  test("null per key → omitted from override (caller merges with default)", () => {
    expect(parseStored({ views: null, lanes: "0", tasks: null })).toEqual({ lanes: false });
  });
  test("legacy 'true'/'false' per key → omitted (rejected, only '1'/'0' accepted)", () => {
    expect(parseStored({ views: "true", lanes: "false", tasks: "0" })).toEqual({ tasks: false });
  });
  test("all null → empty override (signal keeps every default)", () => {
    expect(parseStored({ views: null, lanes: null, tasks: null })).toEqual({});
  });
});

describe("state/sectionOpen effect", () => {
  beforeEach(() => {
    sectionOpen.value = { views: true, lanes: true, tasks: true };
    localStorage.removeItem(KEYS.views);
    localStorage.removeItem(KEYS.lanes);
    localStorage.removeItem(KEYS.tasks);
  });

  test("effect writes '1' to all three keys when sections are open", () => {
    sectionOpen.value = { views: true, lanes: true, tasks: true };
    expect(localStorage.getItem(KEYS.views)).toBe("1");
    expect(localStorage.getItem(KEYS.lanes)).toBe("1");
    expect(localStorage.getItem(KEYS.tasks)).toBe("1");
  });

  test("effect writes '0' per-key when a section is closed independently", () => {
    sectionOpen.value = { views: false, lanes: true, tasks: true };
    expect(localStorage.getItem(KEYS.views)).toBe("0");
    expect(localStorage.getItem(KEYS.lanes)).toBe("1");
    expect(localStorage.getItem(KEYS.tasks)).toBe("1");

    sectionOpen.value = { views: true, lanes: false, tasks: true };
    expect(localStorage.getItem(KEYS.views)).toBe("1");
    expect(localStorage.getItem(KEYS.lanes)).toBe("0");
    expect(localStorage.getItem(KEYS.tasks)).toBe("1");

    sectionOpen.value = { views: true, lanes: true, tasks: false };
    expect(localStorage.getItem(KEYS.views)).toBe("1");
    expect(localStorage.getItem(KEYS.lanes)).toBe("1");
    expect(localStorage.getItem(KEYS.tasks)).toBe("0");
  });
});
