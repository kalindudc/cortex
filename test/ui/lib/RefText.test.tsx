// RefText.test.tsx — DOM render + click semantics for the plain-text ref
// renderer. The plan calls out three behaviours: shape, ordering, and
// click-routing through navigateRef. We verify click by observing the
// signal effect (no module spying needed since signals.ts is the public
// API for navigation).

import { describe, test, expect, beforeEach } from "bun:test";
import { render, fireEvent } from "@testing-library/preact";
import { RefText } from "../../../src/ui/lib/RefText.tsx";
import { selectedId, filters, clearAllFilters, tasks } from "../../../src/ui/state/signals.ts";
import type { Task } from "../../../src/ui/api/types.ts";

function fakeTask(id: number): Task {
  return {
    id,
    lane: "now",
    title: `task-${id}`,
    body: null,
    status: "open",
    priority: 3,
    created: 0,
    updated: 0,
    tags: [],
    memory_excluded: false,
  };
}

describe("RefText", () => {
  beforeEach(() => {
    selectedId.value = null;
    clearAllFilters();
    // navigateRef now guards against non-existent tasks; seed the ones
    // used in click tests so the nav fires.
    tasks.value = [fakeTask(7), fakeTask(12)];
  });

  test('"@7" renders one anchor with visible label "@7"', () => {
    const { container } = render(<RefText text="@7" />);
    const links = container.querySelectorAll("a.cortex-ref");
    expect(links.length).toBe(1);
    expect(links[0].textContent).toBe("@7");
    expect(links[0].classList.contains("cortex-ref-task")).toBe(true);
  });

  test("mixed text renders two anchors in order with surrounding text preserved", () => {
    const { container } = render(<RefText text="see @7 and #ops" />);
    const links = container.querySelectorAll("a.cortex-ref");
    expect(links.length).toBe(2);
    expect(links[0].textContent).toBe("@7");
    expect(links[0].classList.contains("cortex-ref-task")).toBe(true);
    expect(links[1].textContent).toBe("#ops");
    expect(links[1].classList.contains("cortex-ref-tag")).toBe(true);
    expect(container.textContent).toBe("see @7 and #ops");
  });

  test("clicking a task anchor routes through navigateRef → selectedId + cleared filters", () => {
    filters.value = { status: "open", lane: "now", tag: ["foo"] };
    const { container } = render(<RefText text="@12" />);
    const a = container.querySelector("a.cortex-ref-task") as HTMLAnchorElement;
    fireEvent.click(a);
    expect(selectedId.value).toBe(12);
    expect(filters.value).toEqual({ status: null, lane: null, tag: [] });
  });

  test("clicking a tag anchor sets the tag filter to that single name", () => {
    const { container } = render(<RefText text="#ops" />);
    const a = container.querySelector("a.cortex-ref-tag") as HTMLAnchorElement;
    fireEvent.click(a);
    expect(filters.value.tag).toEqual(["ops"]);
  });

  test("empty text renders no anchors and no text content", () => {
    const { container } = render(<RefText text="" />);
    expect(container.querySelectorAll("a.cortex-ref").length).toBe(0);
    expect(container.textContent).toBe("");
  });
});
