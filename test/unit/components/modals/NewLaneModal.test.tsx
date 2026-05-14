// NewLaneModal — name + color + sort. Save dispatches api.addLane, then
// closes. Save is disabled until a non-blank name is entered.

import { describe, test, expect, mock, beforeEach } from "bun:test";

const addLane = mock(() => Promise.resolve({}));
mock.module("../../../../src/ui/api/client.ts", () => ({
  api: {
    addLane,
    editLane: mock(() => Promise.resolve({})),
    delLane: mock(() => Promise.resolve()),
  },
}));

import { render, fireEvent } from "@testing-library/preact";
import { NewLaneModal } from "../../../../src/ui/components/modals/NewLaneModal.tsx";
import { lanes } from "../../../../src/ui/state/signals.ts";

describe("NewLaneModal", () => {
  beforeEach(() => {
    lanes.value = [];
    addLane.mockClear();
  });

  test("renders an empty Name input and the heading 'New lane'", () => {
    const close = mock(() => {});
    const { container, getByText } = render(<NewLaneModal close={close} />);
    const nameInput = container.querySelector("input") as HTMLInputElement;
    expect(nameInput.value).toBe("");
    expect(getByText("New lane")).toBeTruthy();
  });

  test("Create button is disabled until a non-blank name is typed", () => {
    const close = mock(() => {});
    const { container } = render(<NewLaneModal close={close} />);
    const createBtn = container.querySelector(".btn-primary") as HTMLButtonElement;
    expect(createBtn.disabled).toBe(true);
    const nameInput = container.querySelector("input") as HTMLInputElement;
    fireEvent.input(nameInput, { target: { value: "soon" } });
    expect(createBtn.disabled).toBe(false);
  });

  test("Create dispatches api.addLane with the trimmed name and closes", async () => {
    const close = mock(() => {});
    const { container } = render(<NewLaneModal close={close} />);
    const nameInput = container.querySelector("input") as HTMLInputElement;
    fireEvent.input(nameInput, { target: { value: "  later  " } });
    const createBtn = container.querySelector(".btn-primary") as HTMLButtonElement;
    fireEvent.click(createBtn);
    await Promise.resolve();
    await Promise.resolve();
    expect(addLane).toHaveBeenCalledTimes(1);
    const args = addLane.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(args[0].name).toBe("later");
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("Cancel calls close without calling api.addLane", () => {
    const close = mock(() => {});
    const { container } = render(<NewLaneModal close={close} />);
    const cancel = Array.from(container.querySelectorAll<HTMLButtonElement>("button.btn")).find(
      b => b.textContent === "Cancel",
    );
    if (!cancel) throw new Error("expected Cancel button");
    fireEvent.click(cancel);
    expect(close).toHaveBeenCalledTimes(1);
    expect(addLane).toHaveBeenCalledTimes(0);
  });

  test("default sort is max(existing lane.sort) + 1 so new lanes append", () => {
    lanes.value = [
      { name: "now", color: null, sort: 0 },
      { name: "next", color: null, sort: 7 },
    ];
    const close = mock(() => {});
    const { container } = render(<NewLaneModal close={close} />);
    const sortInput = container.querySelector('input[type="number"]') as HTMLInputElement;
    expect(sortInput.value).toBe("8");
  });
});
