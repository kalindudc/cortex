// StatusBar — footer summary computed from signals.
//
// Read-only component: reads `filters`, `tasks` (and derived `visibleTasks`,
// `blockedTasks`, UNTAGGED). No interactivity to drive; we just seed signal
// state in beforeEach and assert the rendered text.

import { describe, test, expect, beforeEach } from "bun:test";
import { act, fireEvent, render } from "@testing-library/preact";

import { StatusBar } from "../../../src/ui/components/StatusBar.tsx";
import { filters, tasks, showAllTasks, workspaceQuery, liveState } from "../../../src/ui/state/signals.ts";
import { tooltipState } from "../../../src/ui/state/tooltip.ts";
import { UNTAGGED } from "../../../src/ui/state/computed.ts";
import { notice, showNotice } from "../../../src/ui/state/notice.ts";
import { contextOpen, contextShown, contextTab } from "../../../src/ui/state/context.ts";
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
    memory_excluded: false,
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

  test("leads with the connection state and the summary; blocked and in-review counts carry their shapes", () => {
    tasks.value = [task({ id: 1, status: "blocked" }), task({ id: 2, status: "review" }), task({ id: 3 })];
    const { container } = render(<StatusBar />);
    const order = Array.from(container.querySelector(".status-bar")?.children ?? []).map(el => el.classList[0]);
    expect(order).toEqual(["conn", "filter-summary", "status-notice", "grow", "status-counts", "notif-bell", "hint"]);
    const counts = Array.from(container.querySelectorAll(".status-counts > span"));
    expect(counts.map(el => el.textContent)).toEqual(["3 shown", "1 blocked", "1 in review"]);
    expect(counts[0]?.querySelector(".dot")).toBeNull();
    expect(counts[1]?.classList.contains("status-count-blocked")).toBe(true);
    expect(counts[1]?.querySelector(".dot.dot-status-blocked")?.getAttribute("aria-hidden")).toBe("true");
    expect(counts[2]?.querySelector(".dot.dot-status-review")?.getAttribute("aria-hidden")).toBe("true");
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

describe("connection indicator", () => {
  beforeEach(() => {
    liveState.value = "connecting";
  });

  const cases = [
    ["connecting", "connecting", "Connecting to the cortex daemon"],
    ["live", "live", "Receiving changes from the cortex daemon"],
    ["stale", "stale \u00b7 reconnecting", "Connection lost; shown data may be out of date until it reconnects"],
  ] as const;
  for (const [state, label, tooltip] of cases) {
    test(`shows ${state} with its label and tooltip`, () => {
      liveState.value = state;
      const { container } = render(<StatusBar />);
      const conn = container.querySelector(".status-bar .conn");
      expect(conn?.getAttribute("data-state")).toBe(state);
      expect(conn?.getAttribute("role")).toBe("status");
      expect(conn?.textContent).toBe(label);
      if (conn) fireEvent.focus(conn);
      expect(tooltipState.value.text).toBe(tooltip);
    });
  }

  test("follows liveState after render", () => {
    const { container } = render(<StatusBar />);
    const conn = (): Element | null => container.querySelector(".status-bar .conn");
    expect(conn()?.getAttribute("data-state")).toBe("connecting");
    act(() => {
      liveState.value = "live";
    });
    expect(conn()?.getAttribute("data-state")).toBe("live");
    expect(conn()?.textContent).toBe("live");
    act(() => {
      liveState.value = "stale";
    });
    expect(conn()?.getAttribute("data-state")).toBe("stale");
    expect(conn()?.textContent).toBe("stale \u00b7 reconnecting");
  });
});

describe("StatusBar bell", () => {
  test("the bell opens the side panel at Inbox, and a second press hides it", () => {
    contextOpen.value = false;
    contextTab.value = "details";
    const { getByRole } = render(<StatusBar />);
    const bell = getByRole("button", { name: "Notifications" });
    expect(bell.hasAttribute("data-pop")).toBe(false);
    fireEvent.click(bell);
    expect(contextShown()).toBe(true);
    expect(contextTab.peek()).toBe("inbox");
    fireEvent.click(bell);
    expect(contextShown()).toBe(false);
    expect(contextTab.peek()).toBe("inbox");
    contextOpen.value = true;
    contextTab.value = "details";
  });
});

describe("StatusBar notice", () => {
  test("the notice line is always mounted as a status and shows the latest notice", () => {
    notice.value = null;
    const { container } = render(<StatusBar />);
    const line = () => container.querySelector('.status-notice[role="status"]');
    expect(line()?.textContent).toBe("");
    act(() => showNotice("@4 is back in agent memory"));
    expect(line()?.textContent).toBe("@4 is back in agent memory");
    act(() => showNotice("@4 is already in agent memory"));
    expect(line()?.textContent).toBe("@4 is already in agent memory");
    act(() => {
      notice.value = null;
    });
  });
});
