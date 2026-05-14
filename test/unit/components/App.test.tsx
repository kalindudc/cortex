// App — root component. Verifies the unified sidebar mounts (no more lanes/
// tags swap), the StatusBar mounts unconditionally, the conditional mount of
// the CommandPalette gated on paletteOpen, and the errorMsg toast.
//
// NOTE on the test design: we intentionally do NOT use bun's mock.module to
// stub App's children. Bun's mock.module persists across test files in the
// same run (the module registry is process-wide), so a mock installed here
// would break other test files that import the real InboxPane / SidebarPane
// / CommandPalette. Instead we let the real components render and probe for
// stable class-name markers (e.g. .pane-lanes, .sidebar-pane, .status-bar).
// errorMsg is independent of children so its assertion is unaffected.

import { describe, test, expect, beforeEach } from "bun:test";
import { render } from "@testing-library/preact";

import App from "../../../src/ui/components/App.tsx";
import { paletteOpen, errorMsg, tasks, lanes, tags, selectedId, filters } from "../../../src/ui/state/signals.ts";

describe("App", () => {
  beforeEach(() => {
    paletteOpen.value = false;
    errorMsg.value = null;
    tasks.value = [];
    lanes.value = [];
    tags.value = [];
    selectedId.value = null;
    filters.value = { status: null, lane: null, tag: [] };
  });

  test("renders the unified SidebarPane (single pane, no lanes/tags swap)", () => {
    const { container } = render(<App />);
    // .sidebar-pane is rendered by SidebarPane on top of the legacy
    // .pane-lanes class. The legacy .pane-tags class is gone with TagsPane.
    expect(container.querySelector(".sidebar-pane")).toBeTruthy();
    expect(container.querySelector(".pane-lanes")).toBeTruthy();
    expect(container.querySelector(".pane-tags")).toBeNull();
  });

  test("StatusBar is always mounted (row 2 of the main grid)", () => {
    const { container } = render(<App />);
    expect(container.querySelector(".status-bar")).toBeTruthy();
  });

  test("CommandPalette is NOT mounted when paletteOpen is false", () => {
    paletteOpen.value = false;
    const { container } = render(<App />);
    // .palette is the real CommandPalette's root class.
    expect(container.querySelector(".palette")).toBeNull();
  });

  test("CommandPalette IS mounted when paletteOpen is true", () => {
    paletteOpen.value = true;
    const { container } = render(<App />);
    expect(container.querySelector(".palette")).toBeTruthy();
  });

  test("renders the .toast when errorMsg signal is set", () => {
    errorMsg.value = "something broke";
    const { container } = render(<App />);
    const toast = container.querySelector(".toast");
    expect(toast).toBeTruthy();
    expect(toast?.textContent).toBe("something broke");
  });

  test("ActiveTaskPane and InboxPane are always mounted", () => {
    const { container } = render(<App />);
    expect(container.querySelector(".pane-active")).toBeTruthy();
    expect(container.querySelector(".pane-inbox")).toBeTruthy();
  });
});
