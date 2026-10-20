// Lane and tag search never caps its results and never waits for typing: every
// picker and filter panel renders every entry first, typing only narrows, and
// the tag picker offers to create a tag only for a valid name.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../../src/ui/api/client.ts", () => ({
  api: {
    tasks: mock(() => Promise.resolve([])),
    lanes: mock(() => Promise.resolve([])),
    tags: mock(() => Promise.resolve([])),
    updates: mock(() => Promise.resolve([])),
    moveLane: mock(() => Promise.resolve({})),
    versioned: { setStatus: mock(() => Promise.resolve({})), changeTags: mock(() => Promise.resolve({})) },
  },
}));

import { fireEvent, render } from "@testing-library/preact";
import { LanePicker } from "../../../src/ui/components/pickers/LanePicker.tsx";
import { TagPicker } from "../../../src/ui/components/pickers/TagPicker.tsx";
import { SidebarFilterPanel } from "../../../src/ui/components/sidebar/SidebarFilterPanel.tsx";
import { TagFilterPanel } from "../../../src/ui/components/sidebar/TagFilterPanel.tsx";
import { filters, lanePopover, lanes, tags, tagsPopover, tasks } from "../../../src/ui/state/signals.ts";
import type { Task } from "../../../src/ui/api/types.ts";

const COUNT = 1000;
const name = (i: number): string => `entry-${String(i).padStart(4, "0")}`;

const fx: Task = {
  id: 3,
  lane: "lane-0000",
  title: "t",
  body: null,
  status: "open",
  priority: 2,
  created: 0,
  updated: 0,
  tags: [],
  memory_excluded: false,
};

function input(root: ParentNode, selector: string): HTMLInputElement {
  const el = root.querySelector(selector);
  if (!(el instanceof HTMLInputElement)) throw new Error(`no input ${selector}`);
  return el;
}

describe("catalog search is never capped", () => {
  beforeEach(() => {
    lanes.value = Array.from({ length: COUNT }, (_, i) => ({
      name: `lane-${String(i).padStart(4, "0")}`,
      color: null,
      sort: i,
    }));
    tags.value = Array.from({ length: COUNT }, (_, i) => ({ name: name(i), color: null, created: 0, task_count: 1 }));
    tasks.value = [];
    filters.value = { status: null, lane: null, tag: [] };
    tagsPopover.value = true;
    lanePopover.value = true;
  });
  afterEach(() => {
    lanes.value = [];
    tags.value = [];
    tagsPopover.value = false;
    lanePopover.value = false;
  });

  test("TagPicker lists every tag before anything is typed, and typing only filters", () => {
    const { container } = render(<TagPicker task={fx} />);
    const rows = () => container.querySelectorAll(".tag-picker-row:not(.tag-picker-create-row)").length;
    expect(rows()).toBe(COUNT);
    expect(container.querySelector(".catalog-search-hint")?.textContent).toContain(`${COUNT} of ${COUNT} entries`);
    const search = input(container, ".tag-picker-search input");
    fireEvent.input(search, { target: { value: "entry-0042" } });
    expect(rows()).toBe(1);
    fireEvent.input(search, { target: { value: "" } });
    expect(rows()).toBe(COUNT);
  });

  test("TagPicker offers to create only valid tag names", () => {
    const { container } = render(<TagPicker task={fx} />);
    const search = input(container, ".tag-picker-search input");
    fireEvent.input(search, { target: { value: "Bad Name" } });
    expect(container.querySelector(".tag-picker-create-row")).toBeNull();
    fireEvent.input(search, { target: { value: "ok-name" } });
    expect(container.querySelectorAll(".tag-picker-create-row").length).toBe(1);
  });

  test("LanePicker lists every lane before anything is typed, and typing only filters", () => {
    const { container } = render(<LanePicker task={fx} />);
    expect(container.querySelectorAll(".picker-row").length).toBe(COUNT);
    const search = input(container, "input");
    fireEvent.input(search, { target: { value: "lane-0042" } });
    expect(container.querySelectorAll(".picker-row").length).toBe(1);
    fireEvent.input(search, { target: { value: "" } });
    expect(container.querySelectorAll(".picker-row").length).toBe(COUNT);
  });

  test("the lane filter panel lists every lane, plus the All lanes choice", () => {
    const { container } = render(<SidebarFilterPanel kind="lane" />);
    expect(container.querySelectorAll('[role="option"]').length).toBe(COUNT + 1);
    expect(container.querySelector(".catalog-search-hint")?.textContent).toContain(`${COUNT} of ${COUNT} entries`);
    const search = input(container, 'input[aria-label="Search lanes"]');
    fireEvent.input(search, { target: { value: "lane-0042" } });
    expect(container.querySelectorAll('[role="option"]').length).toBe(2);
    fireEvent.input(search, { target: { value: "" } });
    expect(container.querySelectorAll('[role="option"]').length).toBe(COUNT + 1);
  });

  test("the tag filter panel lists every tag plus the Untagged row", () => {
    const { container } = render(<TagFilterPanel close={() => {}} />);
    expect(container.querySelectorAll(".tag-filter-row").length).toBe(COUNT + 1);
    expect(container.querySelector(".catalog-search-hint")?.textContent).toContain(
      `${COUNT + 1} of ${COUNT + 1} entries`,
    );
    const search = input(container, 'input[aria-label="Search tags"]');
    fireEvent.input(search, { target: { value: "entry-0042" } });
    expect(container.querySelectorAll(".tag-filter-row").length).toBe(1);
    fireEvent.input(search, { target: { value: "" } });
    expect(container.querySelectorAll(".tag-filter-row").length).toBe(COUNT + 1);
  });
});
