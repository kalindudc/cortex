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
let mockedSearchResults: unknown[] = [];
mock.module("../../../../src/ui/components/palette/buildCommands.ts", () => ({
  buildCommands: () => [
    { id: "alpha", label: "Alpha", icon: "plus", action: action1 },
    { id: "beta", label: "Beta", icon: "plus", action: action2 },
    { id: "gamma", label: "Gamma", icon: "plus", action: action3 },
  ],
}));
mock.module("../../../../src/ui/lib/fuzzy.ts", () => ({
  searchTasks: () => mockedSearchResults,
}));

import { render, fireEvent } from "@testing-library/preact";
import { CommandPalette } from "../../../../src/ui/components/palette/CommandPalette.tsx";
import { paletteOpen, paletteQuery, tasks, selectedId } from "../../../../src/ui/state/signals.ts";

describe("CommandPalette", () => {
  beforeEach(() => {
    paletteOpen.value = true;
    paletteQuery.value = "/";
    tasks.value = [];
    selectedId.value = null;
    action1.mockClear();
    action2.mockClear();
    action3.mockClear();
    mockedSearchResults = [];
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

  test("typing into the search input filters the command list", () => {
    paletteQuery.value = "/";
    const { container } = render(<CommandPalette />);
    const input = container.querySelector(".palette-input") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "/gam" } });
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

  test("empty query in search mode shows no results", () => {
    paletteQuery.value = "";
    const { container } = render(<CommandPalette />);
    const input = container.querySelector(".palette-input") as HTMLInputElement;
    const rows = container.querySelectorAll(".palette-row");
    expect(input.placeholder).toBe("Search titles + bodies…");
    expect(rows.length).toBe(0);
    expect(container.textContent).toContain("No matching tasks");
    expect(container.textContent).toContain("@ title only");
    expect(container.textContent).toContain("# tags");
  });

  test("search mode renders highlighted body preview snippets", () => {
    paletteQuery.value = "alpha";
    const resultTask = {
      id: 1,
      lane: "now",
      title: "Body result",
      body: "full body text",
      status: "open" as const,
      priority: 1,
      created: 0,
      updated: 0,
      tags: [],
    };
    tasks.value = [resultTask];
    mockedSearchResults = [
      {
        task: resultTask,
        score: 10,
        highlight: { field: "body", text: "body Alpha context", ranges: [{ start: 5, end: 10 }] },
      },
    ];

    const { container } = render(<CommandPalette />);
    const row = container.querySelector(".palette-row");
    expect(row?.querySelector(".task-search-title")?.textContent).toBe("Body result");
    const preview = row?.querySelector(".task-search-preview");
    expect(preview?.textContent).toBe("body Alpha context");
    expect(preview?.querySelector("mark.search-hit")?.textContent).toBe("Alpha");
  });

  test("typing / switches to command mode and shows commands", () => {
    paletteQuery.value = "";
    const { container } = render(<CommandPalette />);
    const input = container.querySelector(".palette-input") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "/" } });
    const rows = container.querySelectorAll(".palette-row");
    expect(rows.length).toBe(3);
    expect(rows[0].textContent).toContain("Alpha");
  });

  test("backspacing / returns to search mode", () => {
    paletteQuery.value = "/";
    const { container } = render(<CommandPalette />);
    const input = container.querySelector(".palette-input") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "" } });
    const rows = container.querySelectorAll(".palette-row");
    expect(rows.length).toBe(0);
    expect(container.textContent).toContain("No matching tasks");
  });

  test("search mode renders task results from searchTasks", () => {
    paletteQuery.value = "";
    tasks.value = [
      { id: 1, lane: "now", title: "Find me", body: "", status: "open", priority: 1, created: 0, updated: 0, tags: [] },
    ];
    mockedSearchResults = [{ task: tasks.value[0], score: 10 }];
    const { container } = render(<CommandPalette />);
    const rows = container.querySelectorAll(".palette-row");
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain("Find me");
  });

  test("selecting a search result sets selectedId and closes palette", () => {
    paletteQuery.value = "";
    tasks.value = [
      {
        id: 7,
        lane: "now",
        title: "Select me",
        body: "",
        status: "open",
        priority: 2,
        created: 0,
        updated: 0,
        tags: [],
      },
    ];
    mockedSearchResults = [{ task: tasks.value[0], score: 10 }];
    const { container } = render(<CommandPalette />);
    const rows = container.querySelectorAll(".palette-row");
    fireEvent.click(rows[0]);
    expect(selectedId.value).toBe(7);
    expect(paletteOpen.value).toBe(false);
  });

  test("task selection reveals the Document tab WITHOUT clearing workspace filters (task 330 W4)", async () => {
    const { filters, workspaceQuery, tab } = await import("../../../../src/ui/state/signals.ts");
    const currentTab = (): string => tab.value;
    paletteQuery.value = "";
    filters.value = { status: "open", lane: "now", tag: ["bug"] };
    workspaceQuery.value = "needle";
    tab.value = "updates";
    tasks.value = [
      {
        id: 8,
        lane: "elsewhere",
        title: "Outside the filters",
        body: "",
        status: "draft",
        priority: null,
        created: 0,
        updated: 0,
        tags: [],
      },
    ];
    mockedSearchResults = [{ task: tasks.value[0], score: 10 }];
    const { container } = render(<CommandPalette />);
    fireEvent.click(container.querySelectorAll(".palette-row")[0]);
    expect(selectedId.value).toBe(8);
    expect(currentTab()).toBe("document"); // revealed
    // Global search is global; selecting a result preserves the filters.
    expect(filters.value).toEqual({ status: "open", lane: "now", tag: ["bug"] });
    expect(workspaceQuery.value).toBe("needle");
  });
});
