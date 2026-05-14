// StatusBar — footer summary computed from signals.
//
// Read-only component: reads `filters`, `tasks` (and derived `filteredTasks`,
// `blockedTasks`, UNTAGGED). No interactivity to drive; we just seed signal
// state in beforeEach and assert the rendered text.

import { describe, test, expect, beforeEach } from "bun:test";
import { render } from "@testing-library/preact";

import { StatusBar } from "../../../src/ui/components/StatusBar.tsx";
import { filters, tasks } from "../../../src/ui/state/signals.ts";
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

  test("palette hint always renders with a 'P' key indicator", () => {
    const { container } = render(<StatusBar />);
    const kbdEl = container.querySelector(".hint .kbd");
    expect(kbdEl).toBeTruthy();
    expect(kbdEl?.textContent ?? "").toContain("P");
  });
});
