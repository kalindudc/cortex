// ModalRoot — routes modal.value.kind to the right child modal. Returns null
// when no modal is open.

import { describe, test, expect, mock, beforeEach } from "bun:test";

// LaneEditModal / TagEditModal pull lanes/tags signals and useSignal; render
// the real ones — but stub api so close-on-save doesn't hit fetch.
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
import { modal, lanes, tags } from "../../../../src/ui/state/signals.ts";

describe("ModalRoot", () => {
  beforeEach(() => {
    modal.value = null;
    lanes.value = [];
    tags.value = [];
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

  test("routes 'lane-edit' kind to LaneEditModal", () => {
    lanes.value = [{ name: "now", color: null, sort: 0 }];
    modal.value = { kind: "lane-edit", name: "now" };
    const { container } = render(<ModalRoot />);
    // LaneEditModal renders a heading "Edit lane".
    expect(container.textContent).toContain("Edit lane");
  });

  test("routes 'tag-edit' kind to TagEditModal", () => {
    tags.value = [{ name: "bug", color: null, created: 0, task_count: 0 }];
    modal.value = { kind: "tag-edit", name: "bug" };
    const { container } = render(<ModalRoot />);
    expect(container.textContent).toContain("Edit tag");
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
});
