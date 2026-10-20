// App — root component. Verifies the unified sidebar mounts (no more lanes/
// tags swap), the StatusBar mounts unconditionally, the conditional mount of
// the CommandPalette gated on paletteOpen, and the conditional mount of
// the NotificationDrawer gated on notificationsOpen.
//
// NOTE on the test design: we intentionally do NOT use bun's mock.module to
// stub App's children. Bun's mock.module persists across test files in the
// same run (the module registry is process-wide), so a mock installed here
// would break other test files that import the real InboxPane / SidebarPane
// / CommandPalette. Instead we let the real components render and probe for
// stable class-name markers (e.g. .pane-lanes, .sidebar-pane, .status-bar).

import { describe, test, expect, beforeEach } from "bun:test";
import { render, fireEvent } from "@testing-library/preact";

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
} from "../../../src/ui/state/signals.ts";
import { notifications, notificationsOpen } from "../../../src/ui/state/notifications.ts";

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0));

describe("App", () => {
  beforeEach(() => {
    paletteOpen.value = false;
    notificationsOpen.value = false;
    notifications.value = [];
    tasks.value = [];
    lanes.value = [];
    tags.value = [];
    selectedId.value = null;
    filters.value = { status: null, lane: null, tag: [] };
    navigationOpen.value = false;
    narrowViewport.value = false;
    modal.value = null;
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

  test("NotificationDrawer is NOT mounted when notificationsOpen is false", () => {
    notificationsOpen.value = false;
    const { container } = render(<App />);
    expect(container.querySelector(".notif-drawer")).toBeNull();
  });

  test("NotificationDrawer IS mounted when notificationsOpen is true", () => {
    notificationsOpen.value = true;
    const { container } = render(<App />);
    expect(container.querySelector(".notif-drawer")).toBeTruthy();
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

  test("desktop: sidebar is inline, no mobile bar and no drawer dialog", () => {
    const { container } = render(<App />);
    expect(container.querySelectorAll(".sidebar-pane").length).toBe(1);
    expect(container.querySelector("dialog.nav-drawer")).toBeNull();
    expect(container.querySelector(".mobile-bar")).toBeNull();
  });

  test("narrow: sidebar becomes a labeled dismissible drawer — never duplicated", async () => {
    narrowViewport.value = true;
    const { container } = render(<App />);
    // Closed drawer: no sidebar at all, but a labeled trigger in the mobile bar.
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
    // Dismiss through the frame's cancel path (Escape).
    drawer.dispatchEvent(new Event("cancel", { cancelable: true }));
    await tick();
    expect(navigationOpen.value).toBe(false);
    expect(container.querySelector("dialog.nav-drawer")).toBeNull();
  });

  test("drawer/viewport toggles never remount the document workspace", async () => {
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
  });

  test("ActiveTaskPane is mounted; InboxPane is NOT an App-level column anymore (task 330)", () => {
    const { container } = render(<App />);
    expect(container.querySelector(".pane-active")).toBeTruthy();
    // Task context now belongs to the document workspace (TaskDocument
    // renders it inside the active pane) — with no task selected there is
    // no inbox surface at all.
    expect(container.querySelector(".pane-inbox")).toBeNull();
  });
});
