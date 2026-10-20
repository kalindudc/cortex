// WorkspaceFilters — the ONE workspace filtering surface: a single
// search input, a single status/view selector, a single lane selector, a
// single Tags filter trigger, selected-tag tokens, the include-done toggle
// and one Clear-all action. Bound to the same global signals the task list
// and StatusBar consume.

import { describe, test, expect, beforeEach } from "bun:test";
import { render, fireEvent } from "@testing-library/preact";
import { WorkspaceFilters } from "../../../../src/ui/components/sidebar/WorkspaceFilters.tsx";
import {
  filters,
  lanes,
  tasks,
  tags,
  modal,
  sidebarFilter,
  showAllTasks,
  workspaceQuery,
} from "../../../../src/ui/state/signals.ts";
import { SidebarFilterPanel } from "../../../../src/ui/components/sidebar/SidebarFilterPanel.tsx";
import type { Lane } from "../../../../src/ui/api/types.ts";

function lane(over: Partial<Lane> = {}): Lane {
  return { name: "now", color: null, sort: 0, ...over };
}

function FilterSurface() {
  const kind = sidebarFilter.value;
  return (
    <aside class="sidebar-pane">
      <WorkspaceFilters />
      {kind ? <SidebarFilterPanel key={kind} kind={kind} /> : null}
    </aside>
  );
}

describe("WorkspaceFilters", () => {
  beforeEach(() => {
    tasks.value = [];
    tags.value = [];
    sidebarFilter.value = null;
    lanes.value = [lane({ name: "now" }), lane({ name: "later" })];
    filters.value = { status: null, lane: null, tag: [] };
    workspaceQuery.value = "";
    showAllTasks.value = false;
    modal.value = null;
  });

  test("renders exactly one control per filter slot", () => {
    const { container } = render(<WorkspaceFilters />);
    expect(container.querySelectorAll("input[aria-label='Search tasks']").length).toBe(1);
    expect(container.querySelectorAll("button[aria-label='Status filter']").length).toBe(1);
    expect(container.querySelectorAll("button[aria-label='Lane filter']").length).toBe(1);
    expect(container.querySelector("select")).toBeNull();
    expect(container.querySelectorAll("button[aria-label='Filter by tags']").length).toBe(1);
    expect(container.querySelectorAll("button[aria-label='Clear all filters']").length).toBe(1);
    // The legacy second '+ tag' strip affordance must NOT exist here.
    expect(container.querySelector(".filter-chip-add")).toBeNull();
  });

  test("one field, then one chip row: Status, Lane, Tags, Done and Clear, in that order", () => {
    const { container } = render(<WorkspaceFilters />);
    expect(container.querySelector<HTMLInputElement>("input[aria-label='Search tasks']")?.placeholder).toBe(
      "Filter tasks",
    );
    const chips = Array.from(container.querySelectorAll(".ws-chips > button"));
    expect(chips.map(c => c.getAttribute("aria-label"))).toEqual([
      "Status filter",
      "Lane filter",
      "Filter by tags",
      "Show done tasks too",
      "Clear all filters",
    ]);
    expect(chips.map(c => c.textContent)).toEqual(["Status", "Lane", "Tags", "Done", "Clear"]);
    expect(container.textContent).not.toContain("@id \u00b7 @title");
  });

  test("typing in the search input writes workspaceQuery", () => {
    const { container } = render(<WorkspaceFilters />);
    const input = container.querySelector<HTMLInputElement>("input[aria-label='Search tasks']");
    if (!input) throw new Error("expected search input");
    input.value = "needle";
    fireEvent.input(input);
    expect(workspaceQuery.value).toBe("needle");
  });

  test("status selector sets the status filter; 'All statuses' clears ONLY status", () => {
    filters.value = { status: null, lane: "now", tag: ["bug"] };
    workspaceQuery.value = "needle";
    const { getByRole } = render(<FilterSurface />);
    const trigger = getByRole("button", { name: "Status filter", exact: true });
    fireEvent.click(trigger);
    fireEvent.click(getByRole("option", { name: "In review", exact: true }));
    expect(filters.value.status).toBe("review");

    fireEvent.click(trigger);
    fireEvent.click(getByRole("option", { name: "All statuses", exact: true }));
    expect(filters.value.status).toBeNull();
    // ONLY status cleared — lane, tags and query survive.
    expect(filters.value.lane).toBe("now");
    expect(filters.value.tag).toEqual(["bug"]);
    expect(workspaceQuery.value).toBe("needle");
  });

  test("lane selector sets and clears the lane filter", () => {
    const { getByRole } = render(<FilterSurface />);
    const trigger = getByRole("button", { name: "Lane filter", exact: true });
    fireEvent.click(trigger);
    fireEvent.click(getByRole("option", { name: "later", exact: true }));
    expect(filters.value.lane).toBe("later");
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    fireEvent.click(getByRole("option", { name: "All lanes", exact: true }));
    expect(filters.value.lane).toBeNull();
  });

  test("lane catalog search is optional, shows every row, finds late keywords and preserves filters", () => {
    lanes.value = Array.from({ length: 2000 }, (_, index) =>
      lane({ name: `queue-${String(index).padStart(4, "0")}-ui` }),
    );
    filters.value = { status: "open", lane: "queue-1999-ui", tag: ["bug"] };
    workspaceQuery.value = "task needle";
    const { container, getByRole } = render(<FilterSurface />);
    const trigger = getByRole("button", { name: "Lane filter", exact: true });
    fireEvent.click(trigger);
    expect(container.querySelector('input[aria-label="Search lanes"]')).not.toBeNull();
    const search = getByRole("searchbox", { name: "Search lanes" });
    expect(document.activeElement).toBe(search);
    expect(container.querySelectorAll('[role="option"]').length).toBe(2001); // every lane + All lanes
    expect(getByRole("option", { name: "queue-1999-ui", exact: true }).getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector(".catalog-search-hint")?.textContent).toContain("2000 of 2000 entries");
    expect(container.querySelector(".catalog-search-hint")?.textContent).not.toContain("Refine search");

    fireEvent.input(search, { target: { value: "1999 QUE UI" } });
    expect(container.querySelectorAll('[role="option"]').length).toBe(2);
    expect(getByRole("option", { name: "queue-1999-ui", exact: true })).toBeTruthy();
    expect(container.querySelector(".catalog-search-hint")?.textContent).toContain("1 of 2000 entries");
    expect(filters.value).toEqual({ status: "open", lane: "queue-1999-ui", tag: ["bug"] });
    expect(workspaceQuery.value).toBe("task needle");

    fireEvent.input(search, { target: { value: "no-such-lane" } });
    expect(container.querySelectorAll('[role="option"]').length).toBe(1);
    expect(getByRole("option", { name: "All lanes", exact: true })).toBeTruthy();
    expect(container.textContent).toContain("no lanes match");
    fireEvent.keyDown(search, { key: "Enter" });
    expect(filters.value.lane).toBe("queue-1999-ui"); // no match must not clear selection
    fireEvent.keyDown(search, { key: "Escape" });
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    expect((getByRole("searchbox", { name: "Search lanes" }) as HTMLInputElement).value).toBe("");
    expect(document.activeElement).toBe(getByRole("searchbox", { name: "Search lanes" }));
  });

  test("a stored lane missing from the lane list still renders as a selectable option", () => {
    filters.value = { status: null, lane: "ghost-lane", tag: [] };
    const { getByRole } = render(<FilterSurface />);
    const trigger = getByRole("button", { name: "Lane filter", exact: true });
    expect(trigger.textContent).toContain("ghost-lane (missing)");
    fireEvent.click(trigger);
    const option = getByRole("option", { name: "ghost-lane (missing)", exact: true });
    expect(option.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(getByRole("searchbox", { name: "Search lanes" }));
  });

  test("Tags uses one nonmodal panel; opening, switching and closing never mutate filters", () => {
    filters.value = { status: "open", lane: "now", tag: ["bug"] };
    const { container, getByRole } = render(<FilterSurface />);
    const tagsTrigger = getByRole("button", { name: "Filter by tags", exact: true });
    fireEvent.click(tagsTrigger);
    expect(sidebarFilter.value).toBe("tags");
    expect(modal.value).toBeNull();
    expect(container.querySelector("dialog, .overlay")).toBeNull();
    expect(tagsTrigger.getAttribute("aria-expanded")).toBe("true");
    const search = getByRole("searchbox", { name: "Search tags" });
    expect(document.activeElement).toBe(search);
    fireEvent.input(search, { target: { value: "needle" } });
    fireEvent.click(getByRole("button", { name: "Status filter", exact: true }));
    expect(container.querySelectorAll(".sidebar-filter-panel").length).toBe(1);
    expect(tagsTrigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(tagsTrigger);
    expect((getByRole("searchbox", { name: "Search tags" }) as HTMLInputElement).value).toBe("");
    expect(document.activeElement).toBe(getByRole("searchbox", { name: "Search tags" }));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    expect(sidebarFilter.value).toBeNull();
    expect(document.activeElement).toBe(tagsTrigger);
    expect(filters.value).toEqual({ status: "open", lane: "now", tag: ["bug"] });
  });

  test("selected-tag tokens render and are removable", () => {
    filters.value = { status: null, lane: null, tag: ["bug", "ui"] };
    const { container } = render(<WorkspaceFilters />);
    const chips = Array.from(container.querySelectorAll(".filter-chip"));
    expect(chips.length).toBe(2);
    const bugChip = chips.find(c => (c.textContent ?? "").includes("#bug"));
    if (!bugChip) throw new Error("expected #bug token");
    fireEvent.click(bugChip.querySelector(".x") as HTMLButtonElement);
    expect(filters.value.tag).toEqual(["ui"]);
  });

  test("include-done toggle lives here and flips showAllTasks", () => {
    const { container } = render(<WorkspaceFilters />);
    const btn = container.querySelector<HTMLButtonElement>("button[aria-label='Show done tasks too']");
    if (!btn) throw new Error("expected include-done toggle");
    fireEvent.click(btn);
    expect(showAllTasks.value).toBe(true);
  });

  test("Clear all is disabled when no filters are active", () => {
    const { container } = render(<WorkspaceFilters />);
    const btn = container.querySelector<HTMLButtonElement>("button[aria-label='Clear all filters']");
    if (!btn) throw new Error("expected clear-all button");
    expect(btn.disabled).toBe(true);
  });

  test("Clear all clears query/status/lane/tags but keeps the include-done preference", () => {
    filters.value = { status: "open", lane: "now", tag: ["bug"] };
    workspaceQuery.value = "needle";
    showAllTasks.value = true;
    const { container } = render(<WorkspaceFilters />);
    const btn = container.querySelector<HTMLButtonElement>("button[aria-label='Clear all filters']");
    if (!btn) throw new Error("expected clear-all button");
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(filters.value).toEqual({ status: null, lane: null, tag: [] });
    expect(workspaceQuery.value).toBe("");
    expect(showAllTasks.value).toBe(true); // include-done preference survives
  });
});
