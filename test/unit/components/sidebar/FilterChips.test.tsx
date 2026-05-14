// FilterChips — renders one chip per active filter slot. Tag is multi-select:
// each entry in filters.value.tag (an array; OR-composed in computed.ts)
// gets its own chip, and removing a chip toggles JUST that entry.

import { describe, test, expect, beforeEach } from "bun:test";
import { render, fireEvent } from "@testing-library/preact";
import { FilterChips } from "../../../../src/ui/components/sidebar/FilterChips.tsx";
import { filters, modal } from "../../../../src/ui/state/signals.ts";
import { UNTAGGED } from "../../../../src/ui/state/computed.ts";

describe("FilterChips", () => {
  beforeEach(() => {
    filters.value = { status: null, lane: null, tag: [] };
    modal.value = null;
  });

  test("strip ALWAYS renders with the '+ tag' affordance, even when no filters are active", () => {
    const { container } = render(<FilterChips />);
    // Strip is always present (so the + tag affordance stays mouse-discoverable).
    expect(container.querySelector(".filter-chips")).not.toBeNull();
    // Zero active chips when filters are empty.
    expect(container.querySelectorAll(".filter-chip").length).toBe(0);
    // The + tag affordance is the only thing in the strip in this state.
    expect(container.querySelector(".filter-chip-add")).not.toBeNull();
  });

  test("clicking the '+ tag' affordance dispatches the filter-tags modal", () => {
    const { container } = render(<FilterChips />);
    const addBtn = container.querySelector<HTMLButtonElement>(".filter-chip-add");
    if (!addBtn) throw new Error("expected '+ tag' affordance");
    fireEvent.click(addBtn);
    expect(modal.value).toEqual({ kind: "filter-tags" });
  });

  test("renders one chip per active slot (status + lane + 1 tag = 3 chips)", () => {
    filters.value = { status: "review", lane: "now", tag: ["bug"] };
    const { container } = render(<FilterChips />);
    expect(container.querySelectorAll(".filter-chip").length).toBe(3);
  });

  test("renders one chip per tag in the multi-tag array", () => {
    filters.value = { status: null, lane: null, tag: ["bug", "ui", "infra"] };
    const { container } = render(<FilterChips />);
    expect(container.querySelectorAll(".filter-chip").length).toBe(3);
    const text = container.querySelector(".filter-chips")?.textContent ?? "";
    expect(text).toContain("#bug");
    expect(text).toContain("#ui");
    expect(text).toContain("#infra");
  });

  test("status chip text reflects the filter value", () => {
    filters.value = { status: "blocked", lane: null, tag: [] };
    const { container } = render(<FilterChips />);
    const chips = Array.from(container.querySelectorAll(".filter-chip"));
    expect(chips.some(c => (c.textContent ?? "").includes("blocked"))).toBe(true);
  });

  test("UNTAGGED in the tag array renders as 'untagged' chip", () => {
    filters.value = { status: null, lane: null, tag: [UNTAGGED] };
    const { container } = render(<FilterChips />);
    const chips = Array.from(container.querySelectorAll(".filter-chip"));
    expect(chips.some(c => (c.textContent ?? "").includes("untagged"))).toBe(true);
  });

  test("clicking the x-button on a tag chip removes JUST that tag", () => {
    filters.value = { status: null, lane: null, tag: ["bug", "ui"] };
    const { container } = render(<FilterChips />);
    const chips = Array.from(container.querySelectorAll(".filter-chip"));
    const bugChip = chips.find(c => (c.textContent ?? "").includes("#bug"));
    if (!bugChip) throw new Error("expected a #bug chip");
    const xBtn = bugChip.querySelector(".x") as HTMLButtonElement;
    fireEvent.click(xBtn);
    expect(filters.value.tag).toEqual(["ui"]);
  });

  test("clicking the x-button on the lane chip clears filters.value.lane", () => {
    filters.value = { status: null, lane: "now", tag: [] };
    const { container } = render(<FilterChips />);
    const xBtn = container.querySelector(".filter-chip .x") as HTMLButtonElement;
    expect(xBtn).toBeTruthy();
    fireEvent.click(xBtn);
    expect(filters.value.lane).toBeNull();
  });
});
