// Workspace chrome stays independent of title/body draft ownership.
import { beforeEach, afterEach, describe, expect, mock, test } from "bun:test";
import { render, fireEvent } from "@testing-library/preact";
const setStatus = mock(() => Promise.resolve({}));
mock.module("../../../../src/ui/api/client.ts", () => ({
  api: {
    tasks: mock(() => Promise.resolve([])),
    lanes: mock(() => Promise.resolve([])),
    tags: mock(() => Promise.resolve([])),
    updates: mock(() => Promise.resolve([])),
    related: mock(() => Promise.resolve({ referencedBy: [], references: [], shared: [] })),
    notifications: mock(() => Promise.resolve([])),
    versioned: { setStatus },
    editTask: mock(() => Promise.resolve({})),
  },
}));
import { TaskToolbar } from "../../../../src/ui/components/active/TaskToolbar.tsx";
import { modeShortcutDigit } from "../../../../src/ui/lib/keys.ts";
import {
  lanes,
  readerMode,
  preferredReaderMode,
  tab,
  focusReading,
  modal,
  statusPopover,
  taskActionsPopover,
} from "../../../../src/ui/state/signals.ts";
import { contextOpen, contextTab } from "../../../../src/ui/state/context.ts";
import type { Task } from "../../../../src/ui/api/types.ts";
const task: Task = {
  id: 11,
  lane: "cortex",
  title: "Document",
  body: "## Body",
  status: "open",
  priority: 1,
  tags: [],
  memory_excluded: false,
  created: 0,
  updated: 0,
};

describe("TaskToolbar", () => {
  beforeEach(() => {
    lanes.value = [];
    preferredReaderMode.value = "read";
    readerMode.value = "read";
    tab.value = "document";
    focusReading.value = false;
    modal.value = null;
    statusPopover.value = false;
    taskActionsPopover.value = false;
    contextOpen.value = true;
    contextTab.value = "details";
    setStatus.mockClear();
  });
  afterEach(() => {
    focusReading.value = false;
    preferredReaderMode.value = "read";
    contextOpen.value = true;
  });

  test("one named toolbar and a native, labeled mode group; mode changes never write a task", () => {
    const view = render(<TaskToolbar task={task} />);
    expect(view.getByRole("toolbar").getAttribute("aria-label")).toBe("Task toolbar");
    expect(view.getByRole("group").tagName).toBe("FIELDSET");
    fireEvent.click(view.getByRole("button", { name: "Split", exact: true }));
    expect(readerMode.peek()).toBe("split");
    expect(setStatus).not.toHaveBeenCalled();
    expect(view.container.querySelector(".task-title-display")).toBeNull();
  });

  test("the breadcrumb shows the task's lane and @id", () => {
    lanes.value = [{ name: "cortex", color: "#ff8800", sort: 0 }];
    const view = render(<TaskToolbar task={task} />);
    const crumb = view.container.querySelector(".workspace-breadcrumb");
    expect(crumb?.textContent).toBe("cortex@11");
    expect(crumb?.querySelector(".num")?.textContent).toBe("@11");
    const swatch = crumb?.querySelector<HTMLElement>(".lane-color");
    expect(swatch?.getAttribute("aria-hidden")).toBe("true");
    expect(swatch?.getAttribute("style")).toContain("#ff8800");
  });

  test("no chord chip: each button carries only its digit and keeps its full chord in aria-keyshortcuts", () => {
    const view = render(<TaskToolbar task={task} />);
    expect(view.container.querySelector(".mode-switch-super")).toBeNull();
    for (const [mode, label] of [
      ["read", "Read"],
      ["edit", "Edit"],
      ["split", "Split"],
    ] as const) {
      const button = view.getByRole("button", { name: label, exact: true });
      // Only the digit is repeated per button; the full combo is never inlined.
      expect(button.textContent).toBe(`${label}${modeShortcutDigit(mode)}`);
      expect(button.getAttribute("aria-keyshortcuts")).toContain(`Alt+${modeShortcutDigit(mode)}`);
      const digit = button.querySelector(".mode-switch-digit");
      expect(digit?.getAttribute("aria-hidden")).toBe("true");
      if (!digit) throw new Error(`Missing ${label} digit`);
      fireEvent.click(digit);
      expect(readerMode.peek()).toBe(mode);
    }
  });

  test("next-status remains a distinct API-backed action", async () => {
    const view = render(<TaskToolbar task={task} />);
    fireEvent.click(view.getByRole("button", { name: "Move to review", exact: true }));
    await Promise.resolve();
    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledWith(11, { status: "review" });
    expect(view.getByRole("button", { name: "Change status", exact: true })).toBeTruthy();
  });

  test("focus reading changes only the view preference and can always be reversed", () => {
    const view = render(<TaskToolbar task={task} />);
    fireEvent.click(view.getByRole("button", { name: "Focus reading", exact: true }));
    expect(focusReading.peek()).toBe(true);
    fireEvent.click(view.getByRole("button", { name: "Show navigation", exact: true }));
    expect(focusReading.peek()).toBe(false);
    expect(setStatus).not.toHaveBeenCalled();
  });

  test("the tabs it is handed render right after the breadcrumb", () => {
    const view = render(
      <TaskToolbar
        task={task}
        tabs={
          <div role="tablist" aria-label="Task content">
            <button type="button" role="tab">
              Document
            </button>
          </div>
        }
      />,
    );
    const crumb = view.container.querySelector(".workspace-breadcrumb");
    const list = view.getByRole("tablist", { name: "Task content" });
    expect(crumb?.nextElementSibling).toBe(list);
    expect(view.getByRole("tab", { name: "Document" })).toBeTruthy();
  });

  test("the side panel toggle flips contextOpen and names what it will do", () => {
    const view = render(<TaskToolbar task={task} />);
    const hide = view.getByRole("button", { name: "Hide the side panel", exact: true });
    expect(hide.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(hide);
    expect(contextOpen.peek()).toBe(false);
    const show = view.getByRole("button", { name: "Show the side panel", exact: true });
    expect(show.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(show);
    expect(contextOpen.peek()).toBe(true);
    expect(contextTab.peek()).toBe("details");
    expect(setStatus).not.toHaveBeenCalled();
  });

  test("task actions still require the deletion confirmation", () => {
    const view = render(<TaskToolbar task={task} />);
    expect(view.queryByRole("menuitem", { name: "Delete task" })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Task actions", exact: true }));
    fireEvent.click(view.getByRole("menuitem", { name: "Delete task", exact: true }));
    expect(modal.peek()).toEqual({ kind: "confirm-delete", id: 11 });
  });
});
