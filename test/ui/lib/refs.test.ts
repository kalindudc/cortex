// refs.test.ts — Parser + navigation helper for in-text @id / #tag
// references. The grammar lives in src/ui/lib/refs.ts; these tests pin
// down the segmentation contract that RefText + the CM6 extension both
// rely on.

import { describe, test, expect, beforeEach } from "bun:test";
import { parseRefs, navigateRef, REF_RE } from "../../../src/ui/lib/refs.ts";
import { selectedId, filters, clearAllFilters, tasks } from "../../../src/ui/state/signals.ts";
import type { Task } from "../../../src/ui/api/types.ts";

function fakeTask(id: number): Task {
  return {
    id,
    lane: "now",
    title: `task-${id}`,
    body: null,
    status: "open",
    priority: 3,
    created: 0,
    updated: 0,
    tags: [],
    memory_excluded: false,
  };
}

describe("parseRefs", () => {
  test("interleaves text + task ref (no brackets)", () => {
    expect(parseRefs("hello @12 world")).toEqual([
      { kind: "text", text: "hello " },
      { kind: "task", id: 12 },
      { kind: "text", text: " world" },
    ]);
  });

  test("mixes task + tag refs in order", () => {
    expect(parseRefs("see #done and @1")).toEqual([
      { kind: "text", text: "see " },
      { kind: "tag", name: "done" },
      { kind: "text", text: " and " },
      { kind: "task", id: 1 },
    ]);
  });

  test("rejects refs inside identifiers — `path@123` and `#BadTag` stay plain", () => {
    expect(parseRefs("path@123 not a ref, #BadTag uppercase")).toEqual([
      { kind: "text", text: "path@123 not a ref, #BadTag uppercase" },
    ]);
  });

  test("rejects refs glued to a word char on either side", () => {
    expect(parseRefs("@123abc")).toEqual([{ kind: "text", text: "@123abc" }]);
    expect(parseRefs("a@123")).toEqual([{ kind: "text", text: "a@123" }]);
  });

  test("matches at start of input and after whitespace", () => {
    expect(parseRefs("@7")).toEqual([{ kind: "task", id: 7 }]);
    expect(parseRefs(" @7")).toEqual([
      { kind: "text", text: " " },
      { kind: "task", id: 7 },
    ]);
  });

  test("matches refs followed by punctuation", () => {
    expect(parseRefs("see @7, @12; #ops.")).toEqual([
      { kind: "text", text: "see " },
      { kind: "task", id: 7 },
      { kind: "text", text: ", " },
      { kind: "task", id: 12 },
      { kind: "text", text: "; " },
      { kind: "tag", name: "ops" },
      { kind: "text", text: "." },
    ]);
  });

  test("markdown heading `# Heading` is NOT matched as #h… (space breaks the tag class)", () => {
    expect(parseRefs("# Heading")).toEqual([{ kind: "text", text: "# Heading" }]);
  });

  test("empty input yields []", () => {
    expect(parseRefs("")).toEqual([]);
  });

  test("multi-digit id parses to a number", () => {
    expect(parseRefs("@12345")).toEqual([{ kind: "task", id: 12345 }]);
  });

  test("REF_RE has the global flag (required by matchAll / MatchDecorator)", () => {
    expect(REF_RE.flags).toContain("g");
  });
});

describe("navigateRef", () => {
  beforeEach(() => {
    selectedId.value = null;
    clearAllFilters();
    tasks.value = [fakeTask(5), fakeTask(42)];
  });

  test('kind="task" sets selectedId and clears all filters when the task exists', () => {
    filters.value = { status: "open", lane: "now", tag: ["foo"] };
    navigateRef("task", "5");
    expect(selectedId.value).toBe(5);
    expect(filters.value).toEqual({ status: null, lane: null, tag: [] });
  });

  test('kind="task" no-ops when the task does NOT exist (Bug A guard)', () => {
    selectedId.value = 42;
    filters.value = { status: "open", lane: "now", tag: ["foo"] };
    navigateRef("task", "999"); // not in tasks
    expect(selectedId.value).toBe(42);
    expect(filters.value).toEqual({ status: "open", lane: "now", tag: ["foo"] });
  });

  test('kind="tag" sets the tag filter to a single entry without touching status/lane', () => {
    filters.value = { status: "open", lane: "now", tag: ["foo"] };
    navigateRef("tag", "ops");
    expect(filters.value.tag).toEqual(["ops"]);
    expect(filters.value.status).toBe("open");
    expect(filters.value.lane).toBe("now");
  });

  test('kind="task" with a non-numeric value is a no-op (defensive)', () => {
    selectedId.value = 42;
    navigateRef("task", "abc");
    expect(selectedId.value).toBe(42);
  });
});
