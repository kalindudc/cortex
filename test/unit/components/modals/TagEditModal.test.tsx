// TagEditModal — mirrors LaneEditModal. Save dispatches api.editTag with the
// fields the user changed.

import { describe, test, expect, mock, beforeEach } from "bun:test";

const editTag = mock(() => Promise.resolve({}));
mock.module("../../../../src/ui/api/client.ts", () => ({
  api: {
    editTag,
    delTag: mock(() => Promise.resolve()),
  },
}));

import { render, fireEvent } from "@testing-library/preact";
import { TagEditModal } from "../../../../src/ui/components/modals/TagEditModal.tsx";
import { tags, modal, selectedTag } from "../../../../src/ui/state/signals.ts";

describe("TagEditModal", () => {
  beforeEach(() => {
    tags.value = [{ name: "bug", color: "#16a34a", created: 0, task_count: 3 }];
    modal.value = null;
    selectedTag.value = null;
    editTag.mockClear();
  });

  test("renders the tag name in the rename input", () => {
    const close = mock(() => {});
    const { container } = render(<TagEditModal name="bug" close={close} />);
    const nameInput = container.querySelector("input") as HTMLInputElement;
    expect(nameInput.value).toBe("bug");
  });

  test("Save with no changes closes without calling api.editTag", async () => {
    const close = mock(() => {});
    const { container } = render(<TagEditModal name="bug" close={close} />);
    const saveBtn = container.querySelector(".btn-primary") as HTMLButtonElement;
    fireEvent.click(saveBtn);
    await Promise.resolve();
    expect(editTag).toHaveBeenCalledTimes(0);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("Save with a rename dispatches api.editTag with { rename }", async () => {
    const close = mock(() => {});
    const { container } = render(<TagEditModal name="bug" close={close} />);
    const nameInput = container.querySelector("input") as HTMLInputElement;
    fireEvent.input(nameInput, { target: { value: "defect" } });
    const saveBtn = container.querySelector(".btn-primary") as HTMLButtonElement;
    fireEvent.click(saveBtn);
    await Promise.resolve();
    await Promise.resolve();
    expect(editTag).toHaveBeenCalledTimes(1);
    expect(editTag).toHaveBeenCalledWith("bug", { rename: "defect" });
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("picking a different color includes color in the patch", async () => {
    const close = mock(() => {});
    const { container } = render(<TagEditModal name="bug" close={close} />);
    const target = Array.from(container.querySelectorAll(".color-swatch")).find(
      s => !s.classList.contains("selected"),
    ) as HTMLElement;
    fireEvent.click(target);
    const saveBtn = container.querySelector(".btn-primary") as HTMLButtonElement;
    fireEvent.click(saveBtn);
    await Promise.resolve();
    await Promise.resolve();
    expect(editTag).toHaveBeenCalledTimes(1);
    const editTagArgs = editTag.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(editTagArgs[1]).toHaveProperty("color");
  });

  test("Cancel calls close() without dispatching api.editTag", () => {
    const close = mock(() => {});
    const { container } = render(<TagEditModal name="bug" close={close} />);
    const cancel = Array.from(container.querySelectorAll("button.btn")).find(
      b => b.textContent === "Cancel",
    ) as HTMLButtonElement;
    fireEvent.click(cancel);
    expect(close).toHaveBeenCalledTimes(1);
    expect(editTag).toHaveBeenCalledTimes(0);
  });

  test("clicking 'Delete tag' opens the confirm-tag-delete modal", () => {
    const close = mock(() => {});
    const { container } = render(<TagEditModal name="bug" close={close} />);
    const danger = container.querySelector(".btn-danger") as HTMLButtonElement;
    fireEvent.click(danger);
    expect(modal.value).toEqual({ kind: "confirm-tag-delete", name: "bug", taskCount: 3 });
  });

  test("non-existent tag name short-circuits to close() and returns null", () => {
    const close = mock(() => {});
    const { container } = render(<TagEditModal name="nope" close={close} />);
    expect(close).toHaveBeenCalledTimes(1);
    expect(container.firstChild).toBeNull();
  });
});
