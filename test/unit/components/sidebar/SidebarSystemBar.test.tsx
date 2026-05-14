// SidebarSystemBar — top app-chrome strip on the unified SidebarPane.
//
// Two controls: theme toggle (left) + reset-filters button (right). The
// previous tag-filter button + popover were removed when tag filtering
// moved to TagFilterModal (opened from the FilterChips "+ tag" affordance
// or the command palette). Tests cover the surviving controls.

import { describe, test, expect, mock, beforeEach } from "bun:test";

// SidebarSystemBar imports nothing API-touching directly, but bun's
// mock.module is process-global; matching the canonical SidebarPane stub
// shape avoids cross-file pollution if a sibling test triggers refresh.ts.
mock.module("../../../../src/ui/api/client.ts", () => ({
  api: {
    tasks: mock(() => Promise.resolve([])),
    lanes: mock(() => Promise.resolve([])),
    tags: mock(() => Promise.resolve([])),
    updates: mock(() => Promise.resolve([])),
    addLane: mock(() => Promise.resolve({})),
    addTag: mock(() => Promise.resolve({})),
    addTask: mock(() => Promise.resolve({})),
    moveLane: mock(() => Promise.resolve({})),
    editLane: mock(() => Promise.resolve({})),
    editTag: mock(() => Promise.resolve({})),
    delLane: mock(() => Promise.resolve()),
    delTag: mock(() => Promise.resolve()),
    delTask: mock(() => Promise.resolve()),
    setStat: mock(() => Promise.resolve({})),
    editTask: mock(() => Promise.resolve({})),
    postUpd: mock(() => Promise.resolve({})),
    setTags: mock(() => Promise.resolve({})),
  },
}));

import { render, fireEvent } from "@testing-library/preact";
import { SidebarSystemBar } from "../../../../src/ui/components/sidebar/SidebarSystemBar.tsx";
import { filters, sidebarMode, showAllTasks } from "../../../../src/ui/state/signals.ts";

describe("SidebarSystemBar", () => {
  beforeEach(() => {
    filters.value = { status: null, lane: null, tag: [] };
    sidebarMode.value = "main";
    showAllTasks.value = false;
  });

  test("main mode: renders theme + manage-tags + show-done + reset (left to right)", () => {
    const { container } = render(<SidebarSystemBar />);
    const themeBtn = container.querySelector("button.btn-icon[aria-label^='Switch to']");
    const tagsBtn = container.querySelector("button.btn-icon[aria-label='Manage tags']");
    const showDoneBtn = container.querySelector("button.btn-icon[aria-label='Show done tasks too']");
    const resetBtn = container.querySelector("button.btn-icon[aria-label='Reset filters']");
    if (!themeBtn || !tagsBtn || !showDoneBtn || !resetBtn) {
      throw new Error("expected theme + manage-tags + show-done + reset in pane-system");
    }
    // Tag-FILTERING button (replaced by FilterChips '+ tag' affordance) must NOT render here.
    expect(container.querySelector("button[aria-label='Filter by tags']")).toBeNull();
    // Order: theme → manage-tags → show-done → reset.
    expect(themeBtn.compareDocumentPosition(tagsBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeGreaterThan(0);
    expect(tagsBtn.compareDocumentPosition(showDoneBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeGreaterThan(0);
    expect(showDoneBtn.compareDocumentPosition(resetBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeGreaterThan(0);
  });

  test("show-done toggle flips showAllTasks and its aria-label / icon variant", () => {
    const { container } = render(<SidebarSystemBar />);
    const findBtn = () =>
      container.querySelector<HTMLButtonElement>(
        "button[aria-label='Show done tasks too'], button[aria-label='Hide done tasks']",
      );
    let btn = findBtn();
    if (!btn) throw new Error("expected show-done toggle");
    expect(btn.getAttribute("aria-label")).toBe("Show done tasks too");
    fireEvent.click(btn);
    expect(showAllTasks.value).toBe(true);
    btn = findBtn();
    expect(btn?.getAttribute("aria-label")).toBe("Hide done tasks");
  });

  test("clicking the manage-tags button flips sidebarMode to 'tags' (and label/icon switch)", () => {
    const { container } = render(<SidebarSystemBar />);
    const tagsBtn = container.querySelector<HTMLButtonElement>("button[aria-label='Manage tags']");
    if (!tagsBtn) throw new Error("expected 'Manage tags' button");
    fireEvent.click(tagsBtn);
    expect(sidebarMode.value).toBe("tags");
  });

  test("tags mode: manage-tags becomes 'Back', show-done + reset are hidden (tag-mode-irrelevant controls)", () => {
    sidebarMode.value = "tags";
    const { container } = render(<SidebarSystemBar />);
    expect(container.querySelector("button[aria-label='Back to main sidebar']")).not.toBeNull();
    // Reset-filters + show-done are main-mode only.
    expect(container.querySelector("button[aria-label='Reset filters']")).toBeNull();
    expect(container.querySelector("button[aria-label='Show done tasks too']")).toBeNull();
    expect(container.querySelector("button[aria-label='Hide done tasks']")).toBeNull();
  });

  test("reset-filters is disabled when no filters are active", () => {
    const { container } = render(<SidebarSystemBar />);
    const resetBtn = container.querySelector<HTMLButtonElement>("button.btn-icon[aria-label='Reset filters']");
    if (!resetBtn) throw new Error("expected reset-filters button");
    expect(resetBtn.disabled).toBe(true);
  });

  test("reset-filters is enabled when at least one filter is active and clears every slot", () => {
    filters.value = { status: "blocked", lane: "now", tag: ["bug", "ui"] };
    const { container } = render(<SidebarSystemBar />);
    const resetBtn = container.querySelector<HTMLButtonElement>("button.btn-icon[aria-label='Reset filters']");
    if (!resetBtn) throw new Error("expected reset-filters button");
    expect(resetBtn.disabled).toBe(false);
    fireEvent.click(resetBtn);
    expect(filters.value).toEqual({ status: null, lane: null, tag: [] });
  });
});
