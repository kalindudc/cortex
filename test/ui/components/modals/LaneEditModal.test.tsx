// LaneEditModal — rename + color + sort. Save dispatches api.editLane with
// only the fields the user changed, then calls close().

import { describe, test, expect, mock, beforeEach } from "bun:test";

const editLane = mock(() => Promise.resolve({}));
mock.module("../../../../src/ui/api/client.ts", () => ({
  api: {
    editLane,
    delLane: mock(() => Promise.resolve()),
  },
}));

import { render, fireEvent } from "@testing-library/preact";
import { LaneEditModal } from "../../../../src/ui/components/modals/LaneEditModal.tsx";
import { lanes, tasks, modal, filters } from "../../../../src/ui/state/signals.ts";

describe("LaneEditModal", () => {
  beforeEach(() => {
    lanes.value = [{ name: "next", color: "#dc2626", sort: 5 }];
    tasks.value = [];
    modal.value = null;
    filters.value = { status: null, lane: null, tag: [] };
    editLane.mockClear();
  });

  test("renders the lane name in the input and the current sort value", () => {
    const close = mock(() => {});
    const { container } = render(<LaneEditModal name="next" close={close} />);
    const nameInput = container.querySelector("input") as HTMLInputElement;
    expect(nameInput.value).toBe("next");
    const sortInput = container.querySelector('input[type="number"]') as HTMLInputElement;
    expect(sortInput.value).toBe("5");
  });

  test("Save with no changes closes without calling api.editLane", async () => {
    const close = mock(() => {});
    const { container } = render(<LaneEditModal name="next" close={close} />);
    const saveBtn = container.querySelector(".btn-primary") as HTMLButtonElement;
    fireEvent.click(saveBtn);
    await Promise.resolve();
    expect(editLane).toHaveBeenCalledTimes(0);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("Save with a rename dispatches api.editLane with { rename: <new> } and closes", async () => {
    const close = mock(() => {});
    const { container } = render(<LaneEditModal name="next" close={close} />);
    const nameInput = container.querySelector("input") as HTMLInputElement;
    fireEvent.input(nameInput, { target: { value: "soon" } });
    const saveBtn = container.querySelector(".btn-primary") as HTMLButtonElement;
    fireEvent.click(saveBtn);
    await Promise.resolve();
    await Promise.resolve();
    expect(editLane).toHaveBeenCalledTimes(1);
    expect(editLane).toHaveBeenCalledWith("next", { rename: "soon" });
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("Save with a different color includes color in the patch", async () => {
    const close = mock(() => {});
    const { container } = render(<LaneEditModal name="next" close={close} />);
    // Pick the second swatch (index 1) — different from the current #dc2626.
    const swatches = container.querySelectorAll(".color-swatch");
    // Find a swatch that isn't currently selected.
    const target = Array.from(swatches).find(s => !s.classList.contains("selected")) as HTMLElement | undefined;
    if (!target) throw new Error("expected an unselected color swatch");
    fireEvent.click(target);
    const saveBtn = container.querySelector(".btn-primary") as HTMLButtonElement;
    fireEvent.click(saveBtn);
    await Promise.resolve();
    await Promise.resolve();
    expect(editLane).toHaveBeenCalledTimes(1);
    const editLaneArgs = editLane.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(editLaneArgs[1]).toHaveProperty("color");
  });

  test("Cancel button calls close() without dispatching api.editLane", () => {
    const close = mock(() => {});
    const { container } = render(<LaneEditModal name="next" close={close} />);
    // The Cancel button is the .btn (not .btn-primary, not .btn-danger).
    const buttons = Array.from(container.querySelectorAll("button.btn")) as HTMLButtonElement[];
    const cancel = buttons.find(b => b.textContent === "Cancel");
    if (!cancel) throw new Error("expected Cancel button to render");
    fireEvent.click(cancel);
    expect(close).toHaveBeenCalledTimes(1);
    expect(editLane).toHaveBeenCalledTimes(0);
  });

  test("non-existent lane name short-circuits to close() and returns null", () => {
    const close = mock(() => {});
    const { container } = render(<LaneEditModal name="nope" close={close} />);
    expect(close).toHaveBeenCalledTimes(1);
    expect(container.firstChild).toBeNull();
  });

  test("the name input is disabled for the default 'now' lane", () => {
    lanes.value = [{ name: "now", color: null, sort: 0 }];
    const close = mock(() => {});
    const { container } = render(<LaneEditModal name="now" close={close} />);
    const nameInput = container.querySelector("input") as HTMLInputElement;
    expect(nameInput.disabled).toBe(true);
  });
});
