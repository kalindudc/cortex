// SidebarSystemBar — top app-chrome strip on the unified SidebarPane.
//
// Covers theme, tag-management, show-done, on-demand backup, and reset
// controls. The previous tag-filter button + popover were removed when tag
// filtering moved to TagFilterModal (opened from the FilterChips "+ tag"
// affordance or the command palette).

import { describe, test, expect, mock, beforeEach } from "bun:test";

const backup = mock(() =>
  Promise.resolve({
    outPath: "/tmp/cortex/backups/cortex-test.zip",
    bytes: 123,
    stats: { lanes: 1, tags: 0, tasks: 2, updates: 0, task_tags: 0, notifications: 0 },
  }),
);

// SidebarSystemBar imports one API method for the backup button, and
// bun's mock.module is process-global; matching the canonical SidebarPane
// stub shape avoids cross-file pollution if a sibling test triggers refresh.ts.
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
    backup,
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
    backup.mockClear();
  });

  test("main mode: renders theme + manage-tags + show-done + backup + reset (left to right)", () => {
    const { container } = render(<SidebarSystemBar />);
    const themeBtn = container.querySelector("button.btn-icon[aria-label^='Switch to']");
    const tagsBtn = container.querySelector("button.btn-icon[aria-label='Manage tags']");
    const showDoneBtn = container.querySelector("button.btn-icon[aria-label='Show done tasks too']");
    const backupBtn = container.querySelector("button.btn-icon[aria-label='Back up now']");
    const resetBtn = container.querySelector("button.btn-icon[aria-label='Reset filters']");
    if (!themeBtn || !tagsBtn || !showDoneBtn || !backupBtn || !resetBtn) {
      throw new Error("expected theme + manage-tags + show-done + backup + reset in pane-system");
    }
    // Tag-FILTERING button (replaced by FilterChips '+ tag' affordance) must NOT render here.
    expect(container.querySelector("button[aria-label='Filter by tags']")).toBeNull();
    // Order: theme → manage-tags → show-done → backup → reset.
    expect(themeBtn.compareDocumentPosition(tagsBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeGreaterThan(0);
    expect(tagsBtn.compareDocumentPosition(showDoneBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeGreaterThan(0);
    expect(showDoneBtn.compareDocumentPosition(backupBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeGreaterThan(0);
    expect(backupBtn.compareDocumentPosition(resetBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeGreaterThan(0);
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

  test("tags mode: backup remains available; show-done + reset are hidden (tag-mode-irrelevant controls)", () => {
    sidebarMode.value = "tags";
    const { container } = render(<SidebarSystemBar />);
    expect(container.querySelector("button[aria-label='Back to main sidebar']")).not.toBeNull();
    expect(container.querySelector("button[aria-label='Back up now']")).not.toBeNull();
    // Reset-filters + show-done are main-mode only.
    expect(container.querySelector("button[aria-label='Reset filters']")).toBeNull();
    expect(container.querySelector("button[aria-label='Show done tasks too']")).toBeNull();
    expect(container.querySelector("button[aria-label='Hide done tasks']")).toBeNull();
  });

  test("clicking backup calls the API and shows a saved state", async () => {
    const { container } = render(<SidebarSystemBar />);
    const backupBtn = container.querySelector<HTMLButtonElement>("button.btn-icon[aria-label='Back up now']");
    if (!backupBtn) throw new Error("expected backup button");
    fireEvent.click(backupBtn);
    expect(backup.mock.calls).toHaveLength(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(container.querySelector("button.btn-icon-active[aria-label='Back up now']")).not.toBeNull();
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
