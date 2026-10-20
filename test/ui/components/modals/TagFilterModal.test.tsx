// Tag-filter content migrated from the former modal into the attached
// sidebar panel. Keep the original multi-select/OR/untagged assertions.
// Legacy modal-kind redirection is covered by ModalRoot.test.tsx.

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
    versioned: { setStatus: mock(() => Promise.resolve({})), changeTags: mock(() => Promise.resolve({})) },
    editTask: mock(() => Promise.resolve({})),
    postUpd: mock(() => Promise.resolve({})),
    setTags: mock(() => Promise.resolve({})),
  },
}));

import { render, fireEvent } from "@testing-library/preact";
import { TagFilterPanel as TagFilterModal } from "../../../../src/ui/components/sidebar/TagFilterPanel.tsx";
import { tags, filters, workspaceQuery } from "../../../../src/ui/state/signals.ts";
import { UNTAGGED } from "../../../../src/ui/state/computed.ts";
import type { TagWithCount } from "../../../../src/ui/api/client.ts";

function tag(over: Partial<TagWithCount> = {}): TagWithCount {
  return { name: "bug", color: null, created: 0, task_count: 0, ...over };
}

describe("TagFilterPanel", () => {
  beforeEach(() => {
    tags.value = [];
    filters.value = { status: null, lane: null, tag: [] };
  });

  test("renders named search input, Untagged sentinel, and one row per tag without a dialog", () => {
    tags.value = [tag({ name: "bug" }), tag({ name: "ui" })];
    const close = mock(() => {});
    const { container, getByRole } = render(<TagFilterModal close={close} />);
    expect(getByRole("searchbox", { name: "Search tags" })).toBeTruthy();
    expect(container.querySelector("dialog, .modal, .overlay")).toBeNull();
    expect(container.querySelector(".tag-filter-search input")).not.toBeNull();
    const rows = container.querySelectorAll(".tag-filter-row");
    // Untagged sentinel + 2 tags
    expect(rows.length).toBe(3);
    expect(container.querySelector(".tag-filter-untagged-row")).not.toBeNull();
  });

  test("clicking a tag row commits to filters.tag (live commit; panel stays open)", () => {
    tags.value = [tag({ name: "bug" })];
    const close = mock(() => {});
    const { container } = render(<TagFilterModal close={close} />);
    const rows = Array.from(container.querySelectorAll<HTMLButtonElement>(".tag-filter-row"));
    const bugRow = rows.find(r => r.textContent?.includes("bug"));
    if (!bugRow) throw new Error("expected a 'bug' row");
    fireEvent.click(bugRow);
    expect(filters.value.tag).toEqual(["bug"]);
    // close was NOT called — the panel stays open for batch picking.
    expect(close).toHaveBeenCalledTimes(0);
    expect(bugRow.getAttribute("aria-pressed")).toBe("true");
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

  test("tag catalog search shows every row by default, matches keywords and keeps live selections", () => {
    tags.value = Array.from({ length: 2000 }, (_, index) =>
      tag({ name: `queue-${String(index).padStart(4, "0")}-ui` }),
    );
    filters.value = { status: "review", lane: "now", tag: ["queue-1999-ui"] };
    workspaceQuery.value = "task needle";
    const close = mock(() => {});
    const { container, getByRole } = render(<TagFilterModal close={close} />);
    const search = getByRole("searchbox", { name: "Search tags" });
    expect(container.querySelectorAll(".tag-filter-row").length).toBe(2001);
    expect(container.querySelector(".tag-filter-untagged-row")).not.toBeNull();
    expect(container.querySelector(".catalog-search-hint")?.textContent).toContain("2001 of 2001 entries");
    expect(container.querySelector(".catalog-search-hint")?.textContent).not.toContain("Refine search");
    fireEvent.input(search, { target: { value: "1999 QUE UI" } });
    expect(container.querySelectorAll(".tag-filter-row").length).toBe(1);
    expect(getByRole("button", { name: "Include #queue-1999-ui", exact: true }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(container.querySelector(".catalog-search-hint")?.textContent).toContain("1 of 2001 entries");
    expect(filters.value).toEqual({ status: "review", lane: "now", tag: ["queue-1999-ui"] });
    expect(workspaceQuery.value).toBe("task needle");
    fireEvent.input(search, { target: { value: "1998 ui" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(filters.value.tag).toEqual(["queue-1999-ui", "queue-1998-ui"]);
    expect(container.querySelectorAll(".tag-filter-summary-chip").length).toBe(2);
    expect(close).not.toHaveBeenCalled();
    fireEvent.input(search, { target: { value: "no match" } });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(container.querySelectorAll(".tag-filter-row").length).toBe(0);
    expect(filters.value.tag).toHaveLength(2);
    fireEvent.click(getByRole("button", { name: "Remove tag filter: #queue-1999-ui", exact: true }));
    expect(filters.value.tag).toEqual(["queue-1998-ui"]);
    expect(document.activeElement).toBe(search);
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
