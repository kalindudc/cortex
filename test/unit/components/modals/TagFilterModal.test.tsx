// TagFilterModal — multi-select tag filter for filters.tag (array; OR
// semantics in computed.ts:filteredTasks). Live commit on each toggle;
// modal stays open for batch picking; Done/Esc/overlay-click close.

import { describe, test, expect, mock, beforeEach } from "bun:test";

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
    editTag: mock(() => Promise.resolve({})),
    delLane: mock(() => Promise.resolve()),
    delTag: mock(() => Promise.resolve()),
    delTask: mock(() => Promise.resolve()),
    setStat: mock(() => Promise.resolve({})),
    editTask: mock(() => Promise.resolve({})),
    postUpd: mock(() => Promise.resolve({})),
    setTags: mock(() => Promise.resolve({})),
  },
}));

import { render, fireEvent } from "@testing-library/preact";
import { TagFilterModal } from "../../../../src/ui/components/modals/TagFilterModal.tsx";
import { tags, filters } from "../../../../src/ui/state/signals.ts";
import { UNTAGGED } from "../../../../src/ui/state/computed.ts";
import type { TagWithCount } from "../../../../src/ui/api/client.ts";

function tag(over: Partial<TagWithCount> = {}): TagWithCount {
  return { name: "bug", color: null, created: 0, task_count: 0, ...over };
}

describe("TagFilterModal", () => {
  beforeEach(() => {
    tags.value = [];
    filters.value = { status: null, lane: null, tag: [] };
  });

  test("renders heading 'Filter by tags', search input, Untagged sentinel, and one row per tag", () => {
    tags.value = [tag({ name: "bug" }), tag({ name: "ui" })];
    const close = mock(() => {});
    const { container, getByText } = render(<TagFilterModal close={close} />);
    expect(getByText("Filter by tags")).toBeTruthy();
    expect(container.querySelector(".tag-filter-search input")).not.toBeNull();
    const rows = container.querySelectorAll(".tag-filter-row");
    // Untagged sentinel + 2 tags
    expect(rows.length).toBe(3);
    expect(container.querySelector(".tag-filter-untagged-row")).not.toBeNull();
  });

  test("clicking a tag row commits to filters.tag (live commit; modal stays open)", () => {
    tags.value = [tag({ name: "bug" })];
    const close = mock(() => {});
    const { container } = render(<TagFilterModal close={close} />);
    const rows = Array.from(container.querySelectorAll<HTMLButtonElement>(".tag-filter-row"));
    const bugRow = rows.find(r => r.textContent?.includes("bug"));
    if (!bugRow) throw new Error("expected a 'bug' row");
    fireEvent.click(bugRow);
    expect(filters.value.tag).toEqual(["bug"]);
    // close was NOT called — modal stays open for batch picking.
    expect(close).toHaveBeenCalledTimes(0);
  });

  test("clicking the Untagged sentinel toggles UNTAGGED in filters.tag", () => {
    tags.value = [];
    const close = mock(() => {});
    const { container } = render(<TagFilterModal close={close} />);
    const untaggedRow = container.querySelector<HTMLButtonElement>(".tag-filter-untagged-row");
    if (!untaggedRow) throw new Error("expected an untagged row");
    fireEvent.click(untaggedRow);
    expect(filters.value.tag).toEqual([UNTAGGED]);
    fireEvent.click(untaggedRow);
    expect(filters.value.tag).toEqual([]);
  });

  test("selected-summary strip renders one mini-chip per active tag (UNTAGGED → 'untagged')", () => {
    tags.value = [tag({ name: "bug" }), tag({ name: "ui" })];
    filters.value = { status: null, lane: null, tag: ["bug", UNTAGGED] };
    const close = mock(() => {});
    const { container } = render(<TagFilterModal close={close} />);
    const summary = container.querySelector(".tag-filter-summary");
    expect(summary).not.toBeNull();
    const chips = container.querySelectorAll(".tag-filter-summary-chip");
    expect(chips.length).toBe(2);
    const text = summary?.textContent ?? "";
    expect(text).toContain("#bug");
    expect(text).toContain("untagged");
  });

  test("'Clear all' wipes filters.tag entirely; Done invokes close()", () => {
    tags.value = [tag({ name: "bug" })];
    filters.value = { status: null, lane: null, tag: ["bug"] };
    const close = mock(() => {});
    const { container } = render(<TagFilterModal close={close} />);
    const clear = Array.from(container.querySelectorAll<HTMLButtonElement>("button.btn")).find(
      b => b.textContent === "Clear all",
    );
    if (!clear) throw new Error("expected 'Clear all' button");
    fireEvent.click(clear);
    expect(filters.value.tag).toEqual([]);

    const done = Array.from(container.querySelectorAll<HTMLButtonElement>("button.btn-primary")).find(
      b => b.textContent === "Done",
    );
    if (!done) throw new Error("expected 'Done' button");
    fireEvent.click(done);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("'Clear all' is disabled when filters.tag is empty", () => {
    const close = mock(() => {});
    const { container } = render(<TagFilterModal close={close} />);
    const clear = Array.from(container.querySelectorAll<HTMLButtonElement>("button.btn")).find(
      b => b.textContent === "Clear all",
    );
    if (!clear) throw new Error("expected 'Clear all' button");
    expect(clear.disabled).toBe(true);
  });

  test("typing in the search filters tag rows by case-insensitive substring", async () => {
    tags.value = [tag({ name: "bug" }), tag({ name: "ui" })];
    const close = mock(() => {});
    const { container } = render(<TagFilterModal close={close} />);
    const input = container.querySelector<HTMLInputElement>(".tag-filter-search input");
    if (!input) throw new Error("expected the search input");
    fireEvent.input(input, { target: { value: "ui" } });
    // Signal-driven re-render needs a tick to flush.
    await new Promise(r => setTimeout(r, 5));
    const rowsAfter = Array.from(container.querySelectorAll<HTMLButtonElement>(".tag-filter-row"));
    const hasBug = rowsAfter.some(r => r.querySelector(".tag-pill")?.textContent?.trim() === "bug");
    expect(hasBug).toBe(false);
  });
});
