// SidebarSystemBar — top app-chrome strip on the unified SidebarPane.
//
// Task 330 (W2): the bar keeps theme + REAL backup and gains explicit
// management entries ('Manage lanes' / 'Manage tags') plus a 'Back to
// tasks' affordance while a management mode is active. The show-done and
// reset-filters toggles moved INTO WorkspaceFilters (covered there).

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
import { filters, sidebarMode, showAllTasks, workspaceQuery } from "../../../../src/ui/state/signals.ts";

// Widening reader: TS narrows sidebarMode.value's literal type after a
// direct assignment and cannot see that click handlers mutate it.
const currentSidebarMode = (): string => sidebarMode.value;

describe("SidebarSystemBar", () => {
  beforeEach(() => {
    filters.value = { status: null, lane: null, tag: [] };
    workspaceQuery.value = "";
    sidebarMode.value = "main";
    showAllTasks.value = false;
    backup.mockClear();
  });

  test("main mode: theme + Manage lanes + Manage tags + backup; no show-done/reset (moved into filters)", () => {
    const { container } = render(<SidebarSystemBar />);
    const themeBtn = container.querySelector("button.btn-icon[aria-label^='Switch to']");
    const lanesBtn = container.querySelector("button.btn-icon[aria-label='Manage lanes']");
    const tagsBtn = container.querySelector("button.btn-icon[aria-label='Manage tags']");
    const backupBtn = container.querySelector("button.btn-icon[aria-label='Back up now']");
    if (!themeBtn || !lanesBtn || !tagsBtn || !backupBtn) {
      throw new Error("expected theme + manage-lanes + manage-tags + backup in pane-system");
    }
    // Moved into WorkspaceFilters:
    expect(container.querySelector("button[aria-label='Show done tasks too']")).toBeNull();
    expect(container.querySelector("button[aria-label='Hide done tasks']")).toBeNull();
    expect(container.querySelector("button[aria-label='Reset filters']")).toBeNull();
    // No Back affordance while already on the task list.
    expect(container.querySelector("button[aria-label='Back to tasks']")).toBeNull();
  });

  test("clicking 'Manage tags' enters tags mode WITHOUT touching filters (W2)", () => {
    filters.value = { status: "open", lane: "now", tag: ["bug"] };
    workspaceQuery.value = "needle";
    const { container } = render(<SidebarSystemBar />);
    fireEvent.click(container.querySelector("button[aria-label='Manage tags']") as HTMLButtonElement);
    expect(sidebarMode.value).toBe("tags");
    expect(filters.value).toEqual({ status: "open", lane: "now", tag: ["bug"] });
    expect(workspaceQuery.value).toBe("needle");
  });

  test("clicking 'Manage lanes' enters lanes mode", () => {
    const { container } = render(<SidebarSystemBar />);
    fireEvent.click(container.querySelector("button[aria-label='Manage lanes']") as HTMLButtonElement);
    expect(sidebarMode.value).toBe("lanes");
  });

  test("management mode shows 'Back to tasks'; clicking returns to main and preserves filters", () => {
    filters.value = { status: "blocked", lane: null, tag: [] };
    sidebarMode.value = "lanes";
    const { container } = render(<SidebarSystemBar />);
    const back = container.querySelector<HTMLButtonElement>("button[aria-label='Back to tasks']");
    if (!back) throw new Error("expected 'Back to tasks' affordance in management mode");
    fireEvent.click(back);
    expect(currentSidebarMode()).toBe("main");
    expect(filters.value.status).toBe("blocked");
  });

  test("clicking the active management toggle also returns to main", () => {
    sidebarMode.value = "tags";
    const { container } = render(<SidebarSystemBar />);
    const tagsBtn = container.querySelector<HTMLButtonElement>("button[aria-label='Manage tags']");
    if (!tagsBtn) throw new Error("expected 'Manage tags' button");
    expect(tagsBtn.classList.contains("btn-icon-active")).toBe(true);
    fireEvent.click(tagsBtn);
    expect(currentSidebarMode()).toBe("main");
  });

  test("backup remains available in management modes and calls the real API", async () => {
    sidebarMode.value = "tags";
    const { container } = render(<SidebarSystemBar />);
    const backupBtn = container.querySelector<HTMLButtonElement>("button.btn-icon[aria-label='Back up now']");
    if (!backupBtn) throw new Error("expected backup button");
    fireEvent.click(backupBtn);
    expect(backup.mock.calls).toHaveLength(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(container.querySelector("button.btn-icon-active[aria-label='Back up now']")).not.toBeNull();
  });
});
