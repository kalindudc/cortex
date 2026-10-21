// TagPanel — the shown tag's one-Save form (only changed fields reach
// api.editTag; a rename follows the tag filter and the selection), the tasks
// that carry it, "Show its tasks", and the delete dialog with its count.

import { beforeEach, describe, expect, mock, test } from "bun:test";

const editTag = mock(() => Promise.resolve({}));
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
    editLane: mock(() => Promise.resolve({})),
    editTag: editTag,
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
import { TagPanel } from "../../../../src/ui/components/panels/TagPanel.tsx";
import { filters, modal, selectedId, selectedTag, tags, tasks, view } from "../../../../src/ui/state/signals.ts";
import type { Task } from "../../../../src/ui/api/types.ts";
import { sheetBody } from "./sheet.ts";

const task = (id: number, tagNames: string[]): Task => ({
  id,
  lane: "now",
  title: `task ${id}`,
  body: null,
  status: "open",
  priority: null,
  created: 0,
  updated: 0,
  tags: tagNames,
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

const nameInput = (root: ParentNode): HTMLInputElement =>
  root.querySelector('input[aria-label="Tag name"]') as HTMLInputElement;

describe("TagPanel", () => {
  beforeEach(() => {
    tags.value = [
      { name: "bug", color: "#16a34a", created: 0, task_count: 3 },
      { name: "alpha", color: null, created: 0, task_count: 0 },
    ];
    tasks.value = [];
    selectedTag.value = "bug";
    selectedId.value = null;
    modal.value = null;
    view.value = "tags";
    filters.value = { status: null, lane: null, tag: [] };
    editTag.mockClear();
  });

  test("shows the tag's name, and Save is disabled until a field changes", () => {
    const { container } = render(<TagPanel />);
    expect(container.querySelector(".panel-title .tag-pill")?.textContent).toBe("bug");
    expect(container.querySelector(".panel-lede")?.textContent).toBe("On 3 tasks.");
    expect(nameInput(container).value).toBe("bug");
    expect(button(container, "Save changes").disabled).toBe(true);
    fireEvent.input(nameInput(container), { target: { value: "defect" } });
    expect(button(container, "Save changes").disabled).toBe(false);
    fireEvent.click(button(container, "Discard changes"));
    expect(nameInput(container).value).toBe("bug");
  });

  test("lies on one dotted sheet, and the tag's name keeps its case in the uppercase heading", () => {
    const { container } = render(<TagPanel />);
    const body = sheetBody(container);
    expect(body.querySelector(".panel-title .tag-pill")?.textContent).toBe("bug");
    const headings = Array.from(body.querySelectorAll(".panel-card-title"));
    expect(headings.map(h => h.textContent)).toEqual(["Tag", "Tasks with #bug", "Delete"]);
    expect(headings[1]?.querySelector(".panel-card-title-name")?.textContent).toBe("#bug");
    // The colour row is the container its swatch grid reflows in on a narrow window.
    expect(body.querySelectorAll(".panel-row-colour > .color-grid > .color-swatch")).toHaveLength(16);
  });

  test("a rename sends only { rename }, swaps the filter entry and moves the selection", async () => {
    filters.value = { status: null, lane: null, tag: ["alpha", "bug"] };
    const { container } = render(<TagPanel />);
    fireEvent.input(nameInput(container), { target: { value: "defect" } });
    fireEvent.click(button(container, "Save changes"));
    await flush();
    expect(editTag).toHaveBeenCalledTimes(1);
    expect(editTag).toHaveBeenCalledWith("bug", { rename: "defect" });
    expect(filters.value.tag).toEqual(["alpha", "defect"]);
    expect(selectedTag.value).toBe("defect");
  });

  test("a different colour and Mod+Enter send the colour", async () => {
    const { container } = render(<TagPanel />);
    const target = Array.from(container.querySelectorAll<HTMLElement>(".color-swatch")).find(
      s => !s.classList.contains("selected"),
    ) as HTMLElement;
    fireEvent.click(target);
    fireEvent.keyDown(nameInput(container), { key: "Enter", ctrlKey: true });
    await flush();
    expect(editTag).toHaveBeenCalledTimes(1);
    const args = editTag.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(Object.keys(args[1])).toEqual(["color"]);
  });

  test("a missing selection falls back to the first tag by name", () => {
    selectedTag.value = "gone";
    const { container } = render(<TagPanel />);
    expect(nameInput(container).value).toBe("alpha");
  });

  test("lists the tasks that carry the tag; a click opens one on the Tasks view", () => {
    tasks.value = [task(4, ["bug"]), task(5, ["alpha"]), task(6, ["bug", "alpha"])];
    const { container } = render(<TagPanel />);
    const rows = Array.from(container.querySelectorAll<HTMLButtonElement>(".panel-task"));
    expect(rows.map(r => r.querySelector(".panel-task-id")?.textContent)).toEqual(["@4", "@6"]);
    fireEvent.click(rows[1] as HTMLButtonElement);
    expect(selectedId.value).toBe(6);
    expect(view.value).toBe("tasks");
  });

  test("Delete tag opens the confirm dialog with the task count", () => {
    const { container } = render(<TagPanel />);
    fireEvent.click(button(container, "Delete tag"));
    expect(modal.value).toEqual({ kind: "confirm-tag-delete", name: "bug", taskCount: 3 });
  });

  test("Show its tasks filters the task list by the tag and returns to Tasks", () => {
    filters.value = { status: null, lane: null, tag: ["alpha"] };
    const { container } = render(<TagPanel />);
    fireEvent.click(container.querySelector('button[aria-label="Show tasks tagged bug"]') as HTMLButtonElement);
    expect(filters.value.tag).toEqual(["bug"]);
    expect(view.value).toBe("tasks");
  });

  test("no tags: an empty state pointing to the + button", () => {
    tags.value = [];
    const { container } = render(<TagPanel />);
    expect(sheetBody(container).querySelector(".empty-title")?.textContent).toBe("No tags yet");
  });
});
