// LanePanel — the shown lane's breakdown, its one-Save form (only changed
// fields reach api.editLane; a rename follows the lane filter and the
// selection), "Show its tasks", and the delete section's guard and dialog.

import { beforeEach, describe, expect, mock, test } from "bun:test";

const editLane = mock(() => Promise.resolve({}));
// bun's mock.module is process-global: the canonical SidebarPane stub shape
// keeps a sibling test that triggers refresh.ts from reaching a missing method.
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
    editLane: editLane,
    editTag: mock(() => Promise.resolve({})),
    delLane: mock(() => Promise.resolve()),
    delTag: mock(() => Promise.resolve()),
    delTask: mock(() => Promise.resolve()),
    versioned: { setStatus: mock(() => Promise.resolve({})), changeTags: mock(() => Promise.resolve({})) },
    editTask: mock(() => Promise.resolve({})),
    postUpd: mock(() => Promise.resolve({})),
    backup: mock(() => Promise.resolve({})),
  },
}));

import { fireEvent, render } from "@testing-library/preact";
import { LanePanel } from "../../../../src/ui/components/panels/LanePanel.tsx";
import { filters, lanes, modal, selectedLane, tasks, view } from "../../../../src/ui/state/signals.ts";
import type { Task } from "../../../../src/ui/api/types.ts";
import { sheetBody } from "./sheet.ts";

const task = (id: number, lane: string, status: Task["status"]): Task => ({
  id,
  lane,
  title: `task ${id}`,
  body: null,
  status,
  priority: null,
  created: 0,
  updated: 0,
  tags: [],
  memory_excluded: false,
});

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

function button(root: ParentNode, text: string): HTMLButtonElement {
  const b = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(x => x.textContent?.trim() === text);
  if (!b) throw new Error(`no button "${text}"`);
  return b;
}

function input(root: ParentNode, label: string): HTMLInputElement {
  const el = root.querySelector(`input[aria-label="${label}"]`);
  if (!(el instanceof HTMLInputElement)) throw new Error(`no input ${label}`);
  return el;
}

describe("LanePanel", () => {
  beforeEach(() => {
    lanes.value = [
      { name: "now", color: null, sort: 0 },
      { name: "next", color: "#dc2626", sort: 5 },
    ];
    tasks.value = [];
    selectedLane.value = "next";
    modal.value = null;
    view.value = "lanes";
    filters.value = { status: null, lane: null, tag: [] };
    editLane.mockClear();
  });

  test("shows the selected lane's name and position, and Save is disabled until a field changes", () => {
    const { container } = render(<LanePanel />);
    expect(container.querySelector(".panel-title")?.textContent).toBe("next");
    expect(input(container, "Lane name").value).toBe("next");
    expect(input(container, "Position").value).toBe("5");
    expect(button(container, "Save changes").disabled).toBe(true);
    expect(button(container, "Discard changes").disabled).toBe(true);
    fireEvent.input(input(container, "Position"), { target: { value: "2" } });
    expect(button(container, "Save changes").disabled).toBe(false);
    fireEvent.click(button(container, "Discard changes"));
    expect(input(container, "Position").value).toBe("5");
    expect(button(container, "Save changes").disabled).toBe(true);
  });

  test("lies on one dotted sheet: the title, breakdown, form and delete section scroll inside it", () => {
    const { container } = render(<LanePanel />);
    const body = sheetBody(container);
    expect(body.querySelector(".panel-title")?.textContent).toBe("next");
    expect(body.querySelector(".panel-title-swatch")?.getAttribute("style")).toContain("background: #dc2626");
    expect(Array.from(body.querySelectorAll(".panel-card-title")).map(h => h.textContent)).toEqual([
      "Breakdown",
      "Lane",
      "Delete",
    ]);
    expect(body.querySelector("#lane-panel-name")).not.toBeNull();
    // The colour row is the container its swatch grid reflows in on a narrow window.
    expect(body.querySelectorAll(".panel-row-colour > .color-grid > .color-swatch")).toHaveLength(16);
  });

  test("a rename sends only { rename }, follows the lane filter and moves the selection", async () => {
    filters.value = { status: null, lane: "next", tag: [] };
    const { container } = render(<LanePanel />);
    fireEvent.input(input(container, "Lane name"), { target: { value: "  soon " } });
    fireEvent.click(button(container, "Save changes"));
    await flush();
    expect(editLane).toHaveBeenCalledTimes(1);
    expect(editLane).toHaveBeenCalledWith("next", { rename: "soon" });
    expect(filters.value.lane).toBe("soon");
    expect(selectedLane.value).toBe("soon");
  });

  test("a different colour and Mod+S send the colour", async () => {
    const { container } = render(<LanePanel />);
    const target = Array.from(container.querySelectorAll<HTMLElement>(".color-swatch")).find(
      s => !s.classList.contains("selected"),
    );
    if (!target) throw new Error("expected an unselected color swatch");
    fireEvent.click(target);
    fireEvent.keyDown(input(container, "Lane name"), { key: "s", metaKey: true });
    await flush();
    expect(editLane).toHaveBeenCalledTimes(1);
    const args = editLane.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(Object.keys(args[1])).toEqual(["color"]);
  });

  test("the default lane's name is disabled and it cannot be deleted", () => {
    selectedLane.value = "now";
    const { container } = render(<LanePanel />);
    expect(input(container, "Lane name").disabled).toBe(true);
    expect(button(container, "Delete lane").disabled).toBe(true);
    expect(container.querySelector(".lane-delete-reason")?.textContent).toContain("cannot be deleted");
  });

  test("a missing selection falls back to the first lane by position", () => {
    selectedLane.value = "gone";
    const { container } = render(<LanePanel />);
    expect(container.querySelector(".panel-title")?.textContent).toBe("now");
  });

  test("the breakdown counts tasks by status, and a lane with tasks says why it cannot be deleted", () => {
    tasks.value = [
      task(1, "next", "draft"),
      task(2, "next", "draft"),
      task(3, "next", "review"),
      task(4, "next", "done"),
      task(5, "now", "open"),
    ];
    const { container } = render(<LanePanel />);
    expect(container.querySelector(".panel-lede")?.textContent).toBe("4 tasks, 3 not done.");
    const legend = Object.fromEntries(
      Array.from(container.querySelectorAll<HTMLElement>(".breakdown-legend li")).map(li => [
        li.dataset.status,
        li.textContent?.trim(),
      ]),
    );
    expect(legend).toEqual({
      draft: "2 draft",
      open: "0 open",
      review: "1 in review",
      blocked: "0 blocked",
      done: "1 done",
    });
    expect(container.querySelectorAll(".breakdown-seg").length).toBe(3);
    expect(button(container, "Delete lane").disabled).toBe(true);
    expect(container.querySelector(".lane-delete-reason")?.textContent).toBe(
      "Move its 4 tasks to another lane first; only an empty lane can be deleted.",
    );
  });

  test("an empty lane opens the confirm dialog", () => {
    const { container } = render(<LanePanel />);
    fireEvent.click(button(container, "Delete lane"));
    expect(modal.value).toEqual({ kind: "confirm-lane-delete", name: "next" });
  });

  test("Show its tasks filters the task list by the lane and returns to Tasks", () => {
    const { container } = render(<LanePanel />);
    fireEvent.click(container.querySelector('button[aria-label="Show tasks in next"]') as HTMLButtonElement);
    expect(filters.value.lane).toBe("next");
    expect(view.value).toBe("tasks");
  });

  test("no lanes: an empty state pointing to the + button", () => {
    lanes.value = [];
    const { container } = render(<LanePanel />);
    expect(sheetBody(container).querySelector(".empty-title")?.textContent).toBe("No lanes yet");
    expect(container.querySelector("input")).toBeNull();
  });
});
