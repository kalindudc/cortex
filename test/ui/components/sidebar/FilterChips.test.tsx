// FilterChips — selected-TAG tokens only. Status and lane
// have their own visible selectors in WorkspaceFilters, so chips for them
// are gone, as is the old '+ tag' affordance (the Tags trigger lives in
// WorkspaceFilters proper). Renders nothing when no tags are selected.

import { describe, test, expect, beforeEach } from "bun:test";
import { render, fireEvent } from "@testing-library/preact";
import { FilterChips } from "../../../../src/ui/components/sidebar/FilterChips.tsx";
import { filters } from "../../../../src/ui/state/signals.ts";
import { UNTAGGED } from "../../../../src/ui/state/computed.ts";

describe("FilterChips", () => {
  beforeEach(() => {
    filters.value = { status: null, lane: null, tag: [] };
  });

  test("renders nothing when no tags are selected", () => {
    const { container } = render(<FilterChips />);
    expect(container.querySelector(".filter-chips")).toBeNull();
  });

  test("no '+ tag' affordance — the Tags trigger lives in WorkspaceFilters", () => {
    filters.value = { status: null, lane: null, tag: ["bug"] };
    const { container } = render(<FilterChips />);
    expect(container.querySelector(".filter-chip-add")).toBeNull();
  });

  test("status/lane filters do NOT render chips here (they own selectors now)", () => {
    filters.value = { status: "review", lane: "now", tag: [] };
    const { container } = render(<FilterChips />);
    expect(container.querySelector(".filter-chips")).toBeNull();
  });

  test("renders one token per selected tag", () => {
    filters.value = { status: null, lane: null, tag: ["bug", "ui", "infra"] };
    const { container } = render(<FilterChips />);
    expect(container.querySelectorAll(".filter-chip").length).toBe(3);
    const text = container.querySelector(".filter-chips")?.textContent ?? "";
    expect(text).toContain("#bug");
    expect(text).toContain("#ui");
    expect(text).toContain("#infra");
  });

  test("UNTAGGED in the tag array renders as 'untagged' token", () => {
    filters.value = { status: null, lane: null, tag: [UNTAGGED] };
    const { container } = render(<FilterChips />);
    const chips = Array.from(container.querySelectorAll(".filter-chip"));
    expect(chips.some(c => (c.textContent ?? "").includes("untagged"))).toBe(true);
  });

  test("clicking the x-button on a tag token removes JUST that tag", () => {
    filters.value = { status: null, lane: null, tag: ["bug", "ui"] };
    const { container } = render(<FilterChips />);
    const chips = Array.from(container.querySelectorAll(".filter-chip"));
    const bugChip = chips.find(c => (c.textContent ?? "").includes("#bug"));
    if (!bugChip) throw new Error("expected a #bug chip");
    fireEvent.click(bugChip.querySelector(".x") as HTMLButtonElement);
    expect(filters.value.tag).toEqual(["ui"]);
  });
});
