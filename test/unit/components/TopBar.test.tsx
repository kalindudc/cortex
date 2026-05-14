// TopBar — sticky red banner that only renders when there's at least one
// blocked task. Click jumps selectedId to the first blocked task.

import { describe, test, expect, beforeEach } from "bun:test";
import { render, fireEvent } from "@testing-library/preact";

import { TopBar } from "../../../src/ui/components/TopBar.tsx";
import { tasks, selectedId } from "../../../src/ui/state/signals.ts";
import type { Task } from "../../../src/ui/api/types.ts";

function task(over: Partial<Task>): Task {
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

describe("TopBar", () => {
  beforeEach(() => {
    tasks.value = [];
    selectedId.value = null;
  });

  test("returns null when there are no blocked tasks", () => {
    tasks.value = [task({ id: 1, status: "open" })];
    const { container } = render(<TopBar />);
    expect(container.firstChild).toBeNull();
  });

  test("renders the blocked banner when at least one task is blocked", () => {
    tasks.value = [task({ id: 1, status: "blocked" })];
    const { container } = render(<TopBar />);
    const banner = container.querySelector(".topbar.blocked");
    expect(banner).toBeTruthy();
    expect(banner?.textContent).toContain("1 task");
    expect(banner?.textContent).toContain("blocked");
  });

  test("pluralises 'tasks' when more than one is blocked", () => {
    tasks.value = [
      task({ id: 1, status: "blocked" }),
      task({ id: 2, status: "blocked" }),
      task({ id: 3, status: "open" }),
    ];
    const { container } = render(<TopBar />);
    expect(container.querySelector(".topbar.blocked")?.textContent).toContain("2 tasks");
  });

  test("clicking the banner selects the first blocked task", () => {
    tasks.value = [
      task({ id: 7, status: "open" }),
      task({ id: 11, status: "blocked" }),
      task({ id: 12, status: "blocked" }),
    ];
    selectedId.value = null;
    const { container } = render(<TopBar />);
    const blockedTopbar = container.querySelector(".topbar.blocked");
    if (!blockedTopbar) throw new Error("expected .topbar.blocked to render");
    fireEvent.click(blockedTopbar);
    // Cast widens the type narrowed by `selectedId.value = null` above.
    expect(selectedId.value as number | null).toBe(11);
  });
});
