// StatusBar — footer summary computed from signals.
//
// Read-only component: reads `filters`, `tasks` (and derived `visibleTasks`,
// `blockedTasks`, UNTAGGED). No interactivity to drive; we just seed signal
// state in beforeEach and assert the rendered text.

import { describe, test, expect, beforeEach } from "bun:test";
import { render } from "@testing-library/preact";

import { StatusBar } from "../../../src/ui/components/StatusBar.tsx";
import { filters, tasks, showAllTasks, workspaceQuery } from "../../../src/ui/state/signals.ts";
import { UNTAGGED } from "../../../src/ui/state/computed.ts";
import type { Task } from "../../../src/ui/api/types.ts";

function task(over: Partial<Task> = {}): Task {
  return {
    id: 1,
    lane: "now",
    title: "t",
    body: "",
    status: "open",
    priority: 3,
    created: 0,
    updated: 0,
    tags: [],
    ...over,
  };
}

describe("StatusBar", () => {
  beforeEach(() => {
    filters.value = { status: null, lane: null, tag: [] };
    tasks.value = [];
    showAllTasks.value = false;
    workspaceQuery.value = "";
  });

  test("filter summary reads 'All tasks' when no filters set", () => {
    const { container } = render(<StatusBar />);
    const summary = container.querySelector(".filter-summary");
    expect(summary?.textContent).toBe("All tasks");
  });

  test("filter summary describes active filters (status · lane · #tag)", () => {
    filters.value = { status: "blocked", lane: "now", tag: ["bug"] };
    const { container } = render(<StatusBar />);
    const text = container.querySelector(".filter-summary")?.textContent ?? "";
    expect(text).toContain("blocked");
    expect(text).toContain("now");
    expect(text).toContain("#bug");
    // Joined by middot · separator.
    expect(text).toContain("\u00b7");
  });

  test("UNTAGGED slot renders as 'untagged' in the summary", () => {
    filters.value = { status: null, lane: null, tag: [UNTAGGED] };
    const { container } = render(<StatusBar />);
    const text = container.querySelector(".filter-summary")?.textContent ?? "";
    expect(text).toContain("untagged");
  });

  test("shown count reflects filteredTasks", () => {
    tasks.value = [task({ id: 1, status: "open" }), task({ id: 2, status: "blocked" })];
    filters.value = { status: "open", lane: null, tag: [] };
    const { container } = render(<StatusBar />);
    const counts = container.querySelector(".status-counts")?.textContent ?? "";
    expect(counts).toContain("1 shown");
  });

  test("shown count excludes done tasks when showAllTasks is false, includes them when true", () => {
    tasks.value = [task({ id: 1, status: "open" }), task({ id: 2, status: "done" })];
    const { container, rerender } = render(<StatusBar />);

    let counts = container.querySelector(".status-counts")?.textContent ?? "";
    expect(counts).toContain("1 shown");

    showAllTasks.value = true;
    rerender(<StatusBar />);

    counts = container.querySelector(".status-counts")?.textContent ?? "";
    expect(counts).toContain("2 shown");
  });

  test("blocked chip only appears when blockedTasks.length > 0", () => {
    // No blocked tasks → chip absent.
    {
      tasks.value = [task({ id: 1, status: "open" })];
      const { container } = render(<StatusBar />);
      const counts = container.querySelector(".status-counts")?.textContent ?? "";
      expect(counts).not.toContain("blocked");
    }
    // One blocked task → chip present.
    {
      tasks.value = [task({ id: 2, status: "blocked" })];
      const { container } = render(<StatusBar />);
      const counts = container.querySelector(".status-counts")?.textContent ?? "";
      expect(counts).toContain("blocked");
    }
  });

  test("in-review chip only appears when at least one task is in review", () => {
    {
      tasks.value = [task({ id: 1, status: "open" })];
      const { container } = render(<StatusBar />);
      const counts = container.querySelector(".status-counts")?.textContent ?? "";
      expect(counts).not.toContain("in review");
    }
    {
      tasks.value = [task({ id: 2, status: "review" })];
      const { container } = render(<StatusBar />);
      const counts = container.querySelector(".status-counts")?.textContent ?? "";
      expect(counts).toContain("in review");
    }
  });

  test("filter summary is query-aware: active search term appears in the hint", () => {
    workspaceQuery.value = "needle";
    const { container } = render(<StatusBar />);
    const text = container.querySelector(".filter-summary")?.textContent ?? "";
    expect(text).toContain("needle");
    expect(text).not.toBe("All tasks");
  });

  test("shown count reflects the query intersection (shared visibleTasks)", () => {
    tasks.value = [task({ id: 1, title: "needle one" }), task({ id: 2, title: "haystack" })];
    workspaceQuery.value = "needle";
    const { container } = render(<StatusBar />);
    const counts = container.querySelector(".status-counts")?.textContent ?? "";
    expect(counts).toContain("1 shown");
  });

  test("palette hint renders both 'K' and 'P' key indicators", () => {
    const { container } = render(<StatusBar />);
    const kbdEls = container.querySelectorAll(".hint .kbd");
    expect(kbdEls.length).toBeGreaterThanOrEqual(2);
    const texts = Array.from(kbdEls)
      .map(el => el.textContent ?? "")
      .join(" ");
    expect(texts).toContain("K");
    expect(texts).toContain("P");
  });
});
