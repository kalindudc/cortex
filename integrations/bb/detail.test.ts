import { describe, expect, test } from "vitest";
import { classifyAuthor, NOTE_SUMMARY_MAX, planProgress, splitNote, updateKind } from "./detail";
import { initiallyOpen, plainLine, splitSections } from "./panel/sections";
import { dayLabel, groupByDay, relativeTime } from "./panel/time";

describe("updateKind", () => {
  test("status audits carry the new status; cortex's created row and anything else are notes", () => {
    expect(updateKind("status \u2192 blocked")).toEqual({ kind: "status", to: "blocked" });
    expect(updateKind("created")).toEqual({ kind: "created" });
    expect(updateKind("status \u2192 nonsense")).toEqual({ kind: "note" });
    expect(updateKind("task 3: done")).toEqual({ kind: "note" });
  });
});

describe("planProgress (the Herdr label's rule)", () => {
  const body = [
    "## Low-Level Tasks",
    "1. one",
    "```",
    "## not a heading inside a fence",
    "2. not a task",
    "```",
    "2. two",
    "## Next",
    "3. not counted",
  ].join("\n");
  test("counts numbered lines in Low-Level Tasks outside fences against distinct task N: updates", () => {
    expect(planProgress(["plan"], body, ["task 1: a", "task 1: again", "task 2: b", "task 5: out of range"])).toEqual({
      done: 2,
      total: 2,
    });
    expect(planProgress(["plan"], body, [])).toEqual({ done: 0, total: 2 });
  });
  test("null without the plan tag, a body, or numbered tasks", () => {
    expect(planProgress([], body, [])).toBeNull();
    expect(planProgress(["plan"], null, [])).toBeNull();
    expect(planProgress(["plan"], "## Low-Level Tasks\n- a bullet", [])).toBeNull();
  });
});

describe("classifyAuthor", () => {
  test("the user, a bb thread, a pi session, anything else", () => {
    expect(classifyAuthor("kal", "kal")).toEqual({ kind: "you", label: "You" });
    expect(classifyAuthor("bb-thr_abc12345", "kal")).toEqual({ kind: "thread", threadId: "thr_abc12345" });
    expect(classifyAuthor("pi-0192f00d-aaaa-7bbb", "kal")).toEqual({ kind: "pi", label: "pi session 0192f00d" });
    expect(classifyAuthor("kal", null)).toEqual({ kind: "other", label: "kal" });
    expect(classifyAuthor("bb-thr_x", "kal")).toEqual({ kind: "other", label: "bb-thr_x" });
  });
});

describe("splitNote", () => {
  test("the first non-empty line is the summary, the trimmed rest the body", () => {
    expect(splitNote("\n  hello  \n\n  more\n  lines\n")).toEqual({ summary: "hello", body: "more\n  lines" });
    expect(splitNote("just one")).toEqual({ summary: "just one", body: null });
    expect(splitNote("  \n ")).toEqual({ error: "Write a note first." });
    expect(splitNote("x".repeat(NOTE_SUMMARY_MAX))).toEqual({ summary: "x".repeat(NOTE_SUMMARY_MAX), body: null });
    expect("error" in splitNote("x".repeat(NOTE_SUMMARY_MAX + 1))).toBe(true);
  });
});

describe("splitSections", () => {
  test("splits at ## outside fences, drops the leading title, keeps the lead text", () => {
    const body = [
      "# Plan: a title",
      "",
      "> Lead text.",
      "",
      "## First",
      "- one",
      "- two",
      "  - nested",
      "",
      "## Second",
      "```",
      "## README heading inside an UPDATE block",
      "```",
      "~~~md",
      "## another fenced heading",
      "~~~",
      "1. numbered",
      "### Sub stays inside",
    ].join("\n");
    const sections = splitSections(body);
    expect(sections.map(s => s.heading)).toEqual([null, "First", "Second"]);
    expect(sections[0]?.markdown).toBe("> Lead text.");
    expect(sections[1]).toMatchObject({ preview: "one", items: 2 });
    expect(sections[2]?.markdown).toContain("## README heading inside an UPDATE block");
    expect(sections[2]?.markdown).toContain("### Sub stays inside");
    expect(sections[2]).toMatchObject({ preview: "numbered", items: 1 });
  });

  test("a body without headings is one open lead block; an empty body has none", () => {
    expect(splitSections("Just a paragraph.")).toEqual([
      { heading: null, markdown: "Just a paragraph.", preview: "Just a paragraph.", items: 0 },
    ]);
    expect(splitSections("")).toEqual([]);
    expect(splitSections("# Only a title\n")).toEqual([]);
  });

  test("plainLine strips list markers, emphasis, code ticks and link targets", () => {
    expect(plainLine("```\ncode\n```\n- **Bold** `code` and [a link](https://x.test)")).toBe("Bold code and a link");
  });

  test("short bodies and bodies with two sections open fully; long ones open on their first section", () => {
    const long = `## A\n${"x".repeat(3000)}\n## B\nb\n## C\nc`;
    const sections = splitSections(`lead\n${long}`);
    expect(initiallyOpen(sections, 3100)).toEqual([true, true, false, false]);
    expect(initiallyOpen(sections, 2000)).toEqual([true, true, true, true]);
    const two = splitSections(`## A\n${"x".repeat(3000)}\n## B\nb`);
    expect(initiallyOpen(two, 3010)).toEqual([true, true]);
  });
});

describe("time", () => {
  const now = new Date(2026, 9, 17, 12, 0, 0).getTime();
  test("relative times", () => {
    expect(relativeTime(now - 10_000, now)).toBe("just now");
    expect(relativeTime(now - 4 * 60_000, now)).toBe("4m ago");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2d ago");
  });
  test("days and grouping, newest first", () => {
    expect(dayLabel(new Date(2026, 9, 17, 1).getTime(), now)).toBe("Today");
    expect(dayLabel(new Date(2026, 9, 16, 23).getTime(), now)).toBe("Yesterday");
    const items = [new Date(2026, 9, 17, 9), new Date(2026, 9, 17, 8), new Date(2026, 9, 16, 20), new Date(2026, 9, 14, 1)];
    const groups = groupByDay(items, d => d.getTime(), now);
    expect(groups.map(g => [g.label === "Today" || g.label === "Yesterday" ? g.label : "date", g.items.length])).toEqual([
      ["Today", 2],
      ["Yesterday", 1],
      ["date", 1],
    ]);
  });
});
