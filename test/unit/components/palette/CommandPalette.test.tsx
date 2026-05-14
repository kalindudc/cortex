// CommandPalette — keyboard navigation + execution of the highlighted
// command. Mounted only when paletteOpen.value === true (gated by App).

import { describe, test, expect, mock, beforeEach } from "bun:test";

// We replace buildCommands with a fixture so the test isn't coupled to the
// real command set. The mock factory must return a stable list (one per call)
// or the cursor logic gets reset on every render — return a fresh array but
// with stable label identity.
const action1 = mock(() => {});
const action2 = mock(() => {});
const action3 = mock(() => {});
mock.module("../../../../src/ui/components/palette/buildCommands.ts", () => ({
  buildCommands: () => [
    { id: "alpha", label: "Alpha", icon: "plus", action: action1 },
    { id: "beta", label: "Beta", icon: "plus", action: action2 },
    { id: "gamma", label: "Gamma", icon: "plus", action: action3 },
  ],
}));

import { render, fireEvent } from "@testing-library/preact";
import { CommandPalette } from "../../../../src/ui/components/palette/CommandPalette.tsx";
import { paletteOpen } from "../../../../src/ui/state/signals.ts";

describe("CommandPalette", () => {
  beforeEach(() => {
    paletteOpen.value = true;
    action1.mockClear();
    action2.mockClear();
    action3.mockClear();
  });

  test("renders all root commands with the first highlighted", () => {
    const { container } = render(<CommandPalette />);
    const rows = container.querySelectorAll(".palette-row");
    expect(rows.length).toBe(3);
    expect(rows[0].classList.contains("active")).toBe(true);
    expect(rows[0].textContent).toContain("Alpha");
    expect(rows[1].textContent).toContain("Beta");
    expect(rows[2].textContent).toContain("Gamma");
  });

  test("ArrowDown moves the highlight to the next row", () => {
    const { container } = render(<CommandPalette />);
    const input = container.querySelector(".palette-input") as HTMLInputElement;
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const rows = container.querySelectorAll(".palette-row");
    expect(rows[1].classList.contains("active")).toBe(true);
  });

  test("Enter executes the highlighted command's action and closes the palette", async () => {
    const { container } = render(<CommandPalette />);
    const input = container.querySelector(".palette-input") as HTMLInputElement;
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    // exec() awaits the action; flush the microtask queue.
    await Promise.resolve();
    expect(action2).toHaveBeenCalledTimes(1);
    expect(paletteOpen.value).toBe(false);
  });

  test("typing into the search input filters the list", () => {
    const { container } = render(<CommandPalette />);
    const input = container.querySelector(".palette-input") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "gam" } });
    const rows = container.querySelectorAll(".palette-row");
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain("Gamma");
  });

  test("clicking a row executes its action", async () => {
    const { container } = render(<CommandPalette />);
    const rows = container.querySelectorAll(".palette-row");
    fireEvent.click(rows[2]);
    await Promise.resolve();
    expect(action3).toHaveBeenCalledTimes(1);
  });

  test("Escape at root does NOT pop a scope (falls through to global handler)", () => {
    // The component only intercepts Escape when in a submenu (`inSubmenu &&
    // e.key === "Escape"`). At root, the keydown handler doesn't touch
    // paletteOpen — that's index.tsx's global Esc listener's job.
    const { container } = render(<CommandPalette />);
    const input = container.querySelector(".palette-input") as HTMLInputElement;
    fireEvent.keyDown(input, { key: "Escape" });
    expect(paletteOpen.value).toBe(true);
  });
});
