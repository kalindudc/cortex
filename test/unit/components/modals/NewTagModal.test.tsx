// NewTagModal — name + color. Save dispatches api.addTag. Save is disabled
// until the name passes the TAG_NAME_RE check.

import { describe, test, expect, mock, beforeEach } from "bun:test";

const addTag = mock(() => Promise.resolve({}));
mock.module("../../../../src/ui/api/client.ts", () => ({
  api: {
    addTag,
    editTag: mock(() => Promise.resolve({})),
    delTag: mock(() => Promise.resolve()),
  },
}));

import { render, fireEvent } from "@testing-library/preact";
import { NewTagModal } from "../../../../src/ui/components/modals/NewTagModal.tsx";

describe("NewTagModal", () => {
  beforeEach(() => {
    addTag.mockClear();
  });

  test("renders an empty Name input and the heading 'New tag'", () => {
    const close = mock(() => {});
    const { container, getByText } = render(<NewTagModal close={close} />);
    const nameInput = container.querySelector("input") as HTMLInputElement;
    expect(nameInput.value).toBe("");
    expect(getByText("New tag")).toBeTruthy();
  });

  test("Create is disabled until a TAG_NAME_RE-valid name is typed; rejects invalid", () => {
    const close = mock(() => {});
    const { container } = render(<NewTagModal close={close} />);
    const create = container.querySelector(".btn-primary") as HTMLButtonElement;
    expect(create.disabled).toBe(true);

    const nameInput = container.querySelector("input") as HTMLInputElement;
    // Invalid: spaces aren't in TAG_NAME_RE.
    fireEvent.input(nameInput, { target: { value: "Hi There" } });
    expect(create.disabled).toBe(true);

    // Valid: lowercase, dash allowed.
    fireEvent.input(nameInput, { target: { value: "release-train" } });
    expect(create.disabled).toBe(false);
  });

  test("Create dispatches api.addTag with the trimmed name and closes", async () => {
    const close = mock(() => {});
    const { container } = render(<NewTagModal close={close} />);
    const nameInput = container.querySelector("input") as HTMLInputElement;
    fireEvent.input(nameInput, { target: { value: "  bug  " } });
    const create = container.querySelector(".btn-primary") as HTMLButtonElement;
    fireEvent.click(create);
    await Promise.resolve();
    await Promise.resolve();
    expect(addTag).toHaveBeenCalledTimes(1);
    const args = addTag.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(args[0].name).toBe("bug");
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("Cancel calls close without calling api.addTag", () => {
    const close = mock(() => {});
    const { container } = render(<NewTagModal close={close} />);
    const cancel = Array.from(container.querySelectorAll<HTMLButtonElement>("button.btn")).find(
      b => b.textContent === "Cancel",
    );
    if (!cancel) throw new Error("expected Cancel button");
    fireEvent.click(cancel);
    expect(close).toHaveBeenCalledTimes(1);
    expect(addTag).toHaveBeenCalledTimes(0);
  });
});
