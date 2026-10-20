// NavRail — the navigation rail: Tasks, Search, Lanes, Tags, Backup and
// Settings are destinations that set `view` and carry aria-current; Settings
// also asks its search field for focus (openSettings). Filter controls never
// live here (they stay in WorkspaceFilters). Writing a backup is the Backup
// panel's (BackupPanel.test.tsx).

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

// bun's mock.module is process-global; matching the canonical SidebarPane
// stub shape avoids cross-file pollution if a sibling test triggers
// refresh.ts.
mock.module("../../../src/ui/api/client.ts", () => ({
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
import { NavRail } from "../../../src/ui/components/NavRail.tsx";
import {
  filters,
  modal,
  paletteOpen,
  paletteQuery,
  view,
  showAllTasks,
  workspaceQuery,
  settingsFocusRequest,
} from "../../../src/ui/state/signals.ts";

// Widening reader: TS narrows view.value's literal type after a direct
// assignment and cannot see that click handlers mutate it.
const currentView = (): string => view.value;

const LABELS = ["Tasks", "Search", "Lanes", "Tags", "Backup", "Settings"];

function button(container: Element, label: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(`button[aria-label='${label}']`);
  if (!found) throw new Error(`expected the '${label}' rail item`);
  return found;
}

describe("NavRail", () => {
  beforeEach(() => {
    filters.value = { status: null, lane: null, tag: [] };
    workspaceQuery.value = "";
    view.value = "tasks";
    showAllTasks.value = false;
    paletteOpen.value = false;
    paletteQuery.value = "";
    modal.value = null;
  });
  afterEach(() => {
    paletteOpen.value = false;
    paletteQuery.value = "";
    modal.value = null;
    view.value = "tasks";
  });

  test("one labelled navigation landmark with the theme toggle and six labelled items, each once", () => {
    const { container } = render(<NavRail />);
    const nav = container.querySelectorAll("nav.nav-rail");
    expect(nav.length).toBe(1);
    expect(nav[0]?.getAttribute("aria-label")).toBe("Navigation");
    expect(container.querySelectorAll("button[aria-label^='Switch to']").length).toBe(1);
    for (const label of LABELS) {
      expect(container.querySelectorAll(`button[aria-label='${label}']`).length).toBe(1);
    }
  });

  test("Lanes, Tags, Backup and Tasks set the view and move aria-current, without touching filters", () => {
    filters.value = { status: "open", lane: "now", tag: ["bug"] };
    workspaceQuery.value = "needle";
    const { container } = render(<NavRail />);
    const current = () =>
      Array.from(container.querySelectorAll("[aria-current='page']")).map(el => el.getAttribute("aria-label"));
    expect(current()).toEqual(["Tasks"]);

    fireEvent.click(button(container, "Lanes"));
    expect(currentView()).toBe("lanes");
    expect(current()).toEqual(["Lanes"]);

    fireEvent.click(button(container, "Tags"));
    expect(currentView()).toBe("tags");
    expect(current()).toEqual(["Tags"]);

    fireEvent.click(button(container, "Backup"));
    expect(currentView()).toBe("backup");
    expect(current()).toEqual(["Backup"]);

    fireEvent.click(button(container, "Tasks"));
    expect(currentView()).toBe("tasks");
    expect(current()).toEqual(["Tasks"]);

    expect(filters.value).toEqual({ status: "open", lane: "now", tag: ["bug"] });
    expect(workspaceQuery.value).toBe("needle");
  });

  test("pressing the active item keeps its view (a destination, not a toggle)", () => {
    view.value = "tags";
    const { container } = render(<NavRail />);
    const tags = button(container, "Tags");
    expect(tags.getAttribute("aria-current")).toBe("page");
    fireEvent.click(tags);
    expect(currentView()).toBe("tags");
    expect(tags.getAttribute("aria-current")).toBe("page");
  });

  test("Search and Settings set their views and move aria-current; neither opens an overlay", () => {
    paletteQuery.value = "/new";
    workspaceQuery.value = "needle";
    const { container } = render(<NavRail />);
    const current = () =>
      Array.from(container.querySelectorAll("[aria-current='page']")).map(el => el.getAttribute("aria-label"));

    fireEvent.click(button(container, "Search"));
    expect(currentView()).toBe("search");
    expect(current()).toEqual(["Search"]);
    expect(paletteOpen.value).toBe(false);
    expect(paletteQuery.value).toBe("/new");

    const before = settingsFocusRequest.value;
    fireEvent.click(button(container, "Settings"));
    expect(currentView()).toBe("settings");
    expect(current()).toEqual(["Settings"]);
    expect(settingsFocusRequest.value).toBe(before + 1);
    expect(modal.value).toBeNull();
    expect(workspaceQuery.value).toBe("needle");

    fireEvent.click(button(container, "Tasks"));
    expect(current()).toEqual(["Tasks"]);
  });

  test("the rail holds no filter controls (they live in WorkspaceFilters)", () => {
    const { container } = render(<NavRail />);
    expect(container.querySelector("button[aria-label='Show done tasks too']")).toBeNull();
    expect(container.querySelector("button[aria-label='Hide done tasks']")).toBeNull();
    expect(container.querySelector("button[aria-label='Reset filters']")).toBeNull();
    expect(container.querySelector("button[aria-label='Clear all filters']")).toBeNull();
  });
});
