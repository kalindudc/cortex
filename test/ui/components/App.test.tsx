// App — root component. Verifies the unified sidebar mounts (no more lanes/
// tags swap), the StatusBar mounts unconditionally, the conditional mount of
// the CommandPalette gated on paletteOpen, and the side panel: an inline
// column on a wide window while it is open, a sheet on a narrow one.
//
// NOTE on the test design: we intentionally do NOT use bun's mock.module to
// stub App's children. Bun's mock.module persists across test files in the
// same run (the module registry is process-wide), so a mock installed here
// would break other test files that import the real ActivityPane / SidebarPane
// / CommandPalette. Instead we let the real components render and probe for
// stable class-name markers (e.g. .pane-lanes, .sidebar-pane, .status-bar).

import { describe, test, expect, beforeEach } from "bun:test";
import { act, render, fireEvent } from "@testing-library/preact";

import App from "../../../src/ui/components/App.tsx";
import {
  paletteOpen,
  tasks,
  lanes,
  tags,
  selectedId,
  filters,
  navigationOpen,
  narrowViewport,
  modal,
  focusReading,
  view,
} from "../../../src/ui/state/signals.ts";
import { notifications } from "../../../src/ui/state/notifications.ts";
import { contextOpen, contextSheetOpen } from "../../../src/ui/state/context.ts";

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0));

describe("App", () => {
  beforeEach(() => {
    paletteOpen.value = false;
    notifications.value = [];
    contextOpen.value = true;
    contextSheetOpen.value = false;
    focusReading.value = false;
    tasks.value = [];
    lanes.value = [];
    tags.value = [];
    selectedId.value = null;
    filters.value = { status: null, lane: null, tag: [] };
    navigationOpen.value = false;
    narrowViewport.value = false;
    modal.value = null;
    view.value = "tasks";
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

  test("wide: the side panel is an inline column while it is open, and the wrapper marks it", () => {
    const { container } = render(<App />);
    expect(container.querySelectorAll("aside.context-panel").length).toBe(1);
    expect(container.querySelector(".contents")?.classList.contains("ctx-open")).toBe(true);
    expect(container.querySelector("dialog.ctx-sheet")).toBeNull();
  });

  test("wide: no panel when it is closed or focus reading is on", async () => {
    contextOpen.value = false;
    const { container } = render(<App />);
    expect(container.querySelector(".context-panel")).toBeNull();
    expect(container.querySelector(".contents")?.classList.contains("ctx-open")).toBe(false);
    contextOpen.value = true;
    focusReading.value = true;
    await tick();
    expect(container.querySelector(".context-panel")).toBeNull();
    expect(container.querySelector(".contents")?.classList.contains("ctx-open")).toBe(false);
  });

  test("narrow: the panel is a named sheet only while the sheet is open, never inline", async () => {
    narrowViewport.value = true;
    const { container } = render(<App />);
    expect(container.querySelector(".context-panel")).toBeNull();
    expect(container.querySelector(".contents")?.classList.contains("ctx-open")).toBe(false);
    act(() => {
      contextSheetOpen.value = true;
    });
    const sheet = container.querySelector("dialog.ctx-sheet") as HTMLDialogElement | null;
    if (!sheet) throw new Error("expected the side panel sheet");
    expect(sheet.open).toBe(true);
    expect(sheet.getAttribute("aria-label")).toBe("Side panel");
    expect(container.querySelectorAll(".context-panel").length).toBe(1);
    fireEvent.click(sheet.querySelector('button[aria-label="Close the side panel"]') as HTMLButtonElement);
    await tick();
    expect(contextSheetOpen.value).toBe(false);
    expect(container.querySelector("dialog.ctx-sheet")).toBeNull();
    // Escape goes through the frame's cancel path.
    act(() => {
      contextSheetOpen.value = true;
    });
    (container.querySelector("dialog.ctx-sheet") as HTMLDialogElement).dispatchEvent(
      new Event("cancel", { cancelable: true }),
    );
    await tick();
    expect(contextSheetOpen.value).toBe(false);
  });

  // ---- task 330 (V2/V3): palette + mobile navigation ride DialogFrame ----
  test("the palette is a named native dialog (single frame, no legacy overlay)", () => {
    paletteOpen.value = true;
    const { container } = render(<App />);
    const d = container.querySelector("dialog") as HTMLDialogElement | null;
    expect(d).not.toBeNull();
    expect(d?.getAttribute("aria-label")).toBe("Command palette");
    expect(d?.open).toBe(true);
    expect(d?.querySelector(".palette")).not.toBeNull();
    expect(container.querySelector(".overlay")).toBeNull();
  });

  test("desktop: rail and sidebar are inline, no mobile bar and no drawer dialog", () => {
    const { container } = render(<App />);
    expect(container.querySelectorAll(".nav-rail").length).toBe(1);
    expect(container.querySelectorAll(".sidebar-pane").length).toBe(1);
    expect(container.querySelector("dialog.nav-drawer")).toBeNull();
    expect(container.querySelector(".mobile-bar")).toBeNull();
  });

  test("narrow: sidebar becomes a labeled dismissible drawer — never duplicated", async () => {
    narrowViewport.value = true;
    const { container } = render(<App />);
    // Closed drawer: no rail and no sidebar at all, but a labeled trigger in the mobile bar.
    expect(container.querySelectorAll(".nav-rail").length).toBe(0);
    expect(container.querySelectorAll(".sidebar-pane").length).toBe(0);
    const trigger = container.querySelector(".mobile-bar .nav-toggle") as HTMLButtonElement | null;
    if (!trigger) throw new Error("expected the navigation trigger");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    await tick();
    expect(navigationOpen.value).toBe(true);
    const drawer = container.querySelector("dialog.nav-drawer") as HTMLDialogElement | null;
    if (!drawer) throw new Error("expected the navigation drawer dialog");
    expect(drawer.open).toBe(true);
    expect(drawer.getAttribute("aria-label")).toBe("Navigation");
    expect(container.querySelectorAll(".sidebar-pane").length).toBe(1); // exactly one, inside the drawer
    expect(drawer.querySelector(".sidebar-pane")).not.toBeNull();
    expect(container.querySelectorAll(".nav-rail").length).toBe(1); // the one rail, inside the drawer
    expect(drawer.querySelector(".nav-rail")).not.toBeNull();
    // Dismiss through the frame's cancel path (Escape).
    drawer.dispatchEvent(new Event("cancel", { cancelable: true }));
    await tick();
    expect(navigationOpen.value).toBe(false);
    expect(container.querySelector("dialog.nav-drawer")).toBeNull();
  });

  test("drawer, viewport and side panel toggles never remount the document workspace", async () => {
    tasks.value = [
      {
        id: 1,
        lane: "now",
        title: "stay",
        body: "# H",
        status: "open",
        priority: null,
        created: 0,
        updated: 0,
        tags: [],
        memory_excluded: false,
      },
    ];
    selectedId.value = 1;
    const { container } = render(<App />);
    const before = container.querySelector(".task-document");
    expect(before).not.toBeNull();
    narrowViewport.value = true;
    await tick();
    navigationOpen.value = true;
    await tick();
    navigationOpen.value = false;
    narrowViewport.value = false;
    await tick();
    expect(container.querySelector(".task-document")).toBe(before); // SAME node — no remount
    contextOpen.value = false;
    await tick();
    expect(container.querySelector(".context-panel")).toBeNull();
    contextOpen.value = true;
    await tick();
    expect(container.querySelector(".context-panel")).not.toBeNull();
    expect(container.querySelector(".task-document")).toBe(before); // showing and hiding the panel never remounts it
  });

  test("a trip to Lanes hides the document without remounting it, and drops the side panel", async () => {
    tasks.value = [
      {
        id: 1,
        lane: "now",
        title: "stay",
        body: "# H",
        status: "open",
        priority: null,
        created: 0,
        updated: 0,
        tags: [],
        memory_excluded: false,
      },
    ];
    selectedId.value = 1;
    const { container } = render(<App />);
    const before = container.querySelector(".task-document");
    expect(before).not.toBeNull();
    act(() => {
      view.value = "lanes";
    });
    const pane = container.querySelector("section.pane-active") as HTMLElement;
    expect(pane.hidden).toBe(true);
    expect(container.querySelector(".task-document")).toBe(before);
    expect(container.querySelector("section.lane-panel")).not.toBeNull();
    expect(container.querySelector(".sidebar-pane")).not.toBeNull();
    expect(container.querySelector(".context-panel")).toBeNull();
    expect(container.querySelector(".contents")?.classList.contains("ctx-open")).toBe(false);
    act(() => {
      view.value = "tasks";
    });
    expect(pane.hidden).toBe(false);
    expect(container.querySelector("section.lane-panel")).toBeNull();
    expect(container.querySelector(".task-document")).toBe(before);
    expect(container.querySelector(".context-panel")).not.toBeNull();
  });

  test("Tags and Backup show their panels; Backup has no list column", () => {
    view.value = "tags";
    const { container } = render(<App />);
    expect(container.querySelector("section.tag-panel")).not.toBeNull();
    expect(container.querySelector(".sidebar-pane")).not.toBeNull();
    act(() => {
      view.value = "backup";
    });
    expect(container.querySelector("section.backup-panel")).not.toBeNull();
    expect(container.querySelector(".sidebar-pane")).toBeNull();
    expect(container.querySelector(".contents")?.classList.contains("no-list")).toBe(true);
  });

  test("focus reading hides the list only on Tasks", () => {
    focusReading.value = true;
    view.value = "lanes";
    const { container } = render(<App />);
    expect(container.querySelector(".sidebar-pane")).not.toBeNull();
    expect(container.querySelector(".contents")?.classList.contains("focus-reading")).toBe(false);
    act(() => {
      view.value = "tasks";
    });
    expect(container.querySelector(".sidebar-pane")).toBeNull();
    expect(container.querySelector(".contents")?.classList.contains("focus-reading")).toBe(true);
  });

  test("narrow: the drawer on Backup holds the rail but no list, and no side panel sheet opens", async () => {
    narrowViewport.value = true;
    navigationOpen.value = true;
    contextSheetOpen.value = true;
    view.value = "backup";
    const { container } = render(<App />);
    await tick();
    const drawer = container.querySelector("dialog.nav-drawer") as HTMLDialogElement | null;
    if (!drawer) throw new Error("expected the navigation drawer dialog");
    expect(drawer.querySelector(".nav-rail")).not.toBeNull();
    expect(container.querySelector(".sidebar-pane")).toBeNull();
    expect(container.querySelector("dialog.ctx-sheet")).toBeNull();
    expect(container.querySelector("section.backup-panel")).not.toBeNull();
  });

  test("ActiveTaskPane is mounted; the Activity view is NOT an App-level column", () => {
    const { container } = render(<App />);
    expect(container.querySelector(".pane-active")).toBeTruthy();
    // Task context now belongs to the document workspace (TaskDocument
    // renders it inside the active pane) — with no task selected there is
    // no inbox surface at all.
    expect(container.querySelector(".pane-inbox")).toBeNull();
  });
});
