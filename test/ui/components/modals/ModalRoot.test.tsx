// ModalRoot — routes modal.value.kind to the right child modal. Returns null
// when no modal is open.

import { describe, test, expect, mock, beforeEach } from "bun:test";

// The create and confirm dialogs render for real; stub the api so their
// actions never reach the bridge.
mock.module("../../../../src/ui/api/client.ts", () => ({
  api: {
    editLane: mock(() => Promise.resolve({})),
    editTag: mock(() => Promise.resolve({})),
    delLane: mock(() => Promise.resolve()),
    delTag: mock(() => Promise.resolve()),
    delTask: mock(() => Promise.resolve()),
  },
}));

import { render } from "@testing-library/preact";
import { ModalRoot } from "../../../../src/ui/components/modals/ModalRoot.tsx";
import {
  modal,
  lanes,
  tags,
  navigationOpen,
  draggedTaskId,
  sidebarFilter,
  view,
  focusReading,
  narrowViewport,
} from "../../../../src/ui/state/signals.ts";

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0));

describe("ModalRoot", () => {
  beforeEach(() => {
    modal.value = null;
    lanes.value = [];
    tags.value = [];
    navigationOpen.value = false;
    draggedTaskId.value = null;
    sidebarFilter.value = null;
    view.value = "tasks";
    focusReading.value = false;
    narrowViewport.value = false;
  });

  test("returns null when modal signal is null", () => {
    const { container } = render(<ModalRoot />);
    expect(container.firstChild).toBeNull();
  });

  test("routes 'confirm-delete' kind to the task delete confirmation modal", () => {
    modal.value = { kind: "confirm-delete", id: 7 };
    const { container } = render(<ModalRoot />);
    expect(container.querySelector(".modal")).toBeTruthy();
    expect(container.textContent).toContain("Delete task");
  });

  test("routes 'confirm-lane-delete' kind to the lane delete confirmation modal", () => {
    modal.value = { kind: "confirm-lane-delete", name: "next" };
    const { container } = render(<ModalRoot />);
    expect(container.textContent).toContain("Delete lane");
    expect(container.textContent).toContain("next");
  });

  test("routes 'confirm-tag-delete' kind to the tag delete confirmation modal", () => {
    modal.value = { kind: "confirm-tag-delete", name: "bug", taskCount: 2 };
    const { container } = render(<ModalRoot />);
    expect(container.textContent).toContain("Delete tag");
    expect(container.textContent).toContain("bug");
  });

  test("routes 'update-detail' kind to UpdateDetailModal", () => {
    modal.value = {
      kind: "update-detail",
      update: {
        id: 1,
        task_id: 1,
        author: "alice",
        summary: "summary text",
        body: "# heading",
        severity: "progress",
        created: 1700000000,
      },
    };
    const { container } = render(<ModalRoot />);
    expect(container.textContent).toContain("summary text");
    expect(container.textContent).toContain("alice");
    expect(container.querySelector(".modal--wide")).toBeTruthy();
  });

  test("unknown modal kind renders nothing", () => {
    modal.value = { kind: "totally-not-a-kind" };
    const { container } = render(<ModalRoot />);
    expect(container.firstChild).toBeNull();
  });

  test("legacy filter-tags redirects to the sidebar without mounting a dialog or closing its drawer", () => {
    narrowViewport.value = true;
    navigationOpen.value = true;
    view.value = "tags";
    focusReading.value = true;
    modal.value = { kind: "filter-tags" };
    const { container } = render(<ModalRoot />);
    expect(container.querySelector("dialog, .modal, .overlay")).toBeNull();
    expect(modal.value).toBeNull();
    expect(sidebarFilter.value).toBe("tags");
    expect(navigationOpen.value).toBe(true);
    expect(view.peek()).toBe("tasks");
    expect(focusReading.value).toBe(false);
  });

  // ---- every actual modal kind rides the ONE DialogFrame ----
  const KINDS: Array<{ value: { kind: string; [k: string]: unknown }; name: string; setup?: () => void }> = [
    { value: { kind: "confirm-delete", id: 7 }, name: "Delete task" },
    { value: { kind: "new-lane" }, name: "New lane" },
    { value: { kind: "new-tag" }, name: "New tag" },
    { value: { kind: "confirm-lane-delete", name: "next" }, name: "Delete lane" },
    { value: { kind: "confirm-tag-delete", name: "bug", taskCount: 2 }, name: "Delete tag" },
    { value: { kind: "render-markdown", taskId: 1 }, name: "Task document" },
    {
      value: {
        kind: "update-detail",
        update: { id: 1, task_id: 1, author: "a", summary: "s", body: null, severity: "progress", created: 1 },
      },
      name: "Update",
    },
  ];

  test("every modal kind renders ONE named, open native dialog (single active layer)", () => {
    for (const k of KINDS) {
      k.setup?.();
      modal.value = k.value;
      const view = render(<ModalRoot />);
      const dialogs = view.container.querySelectorAll("dialog");
      expect(dialogs.length).toBe(1);
      const d = dialogs[0] as HTMLDialogElement;
      expect(d.open).toBe(true);
      expect(d.getAttribute("aria-label")).toBe(k.name);
      // No nested/duplicated legacy overlay wrappers.
      expect(view.container.querySelector(".overlay")).toBeNull();
      view.unmount();
      modal.value = null;
    }
  });

  test("initial focus lands inside the dialog; closing returns focus to the opener", async () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    modal.value = { kind: "confirm-delete", id: 7 };
    const view = render(<ModalRoot />);
    await tick();
    const d = view.container.querySelector("dialog") as HTMLDialogElement;
    expect(d.contains(document.activeElement)).toBe(true);
    modal.value = null; // owner-driven close transition
    await tick();
    expect(view.container.querySelector("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  test("opening a modal retargets lower transient layers (drawer/drag) first", async () => {
    navigationOpen.value = true;
    draggedTaskId.value = 3;
    modal.value = { kind: "new-lane" };
    render(<ModalRoot />);
    await tick();
    expect(navigationOpen.value).toBe(false);
    expect(draggedTaskId.value).toBeNull();
  });
});
