// App — root component. Wraps the panes + overlays in a transparent
// (display:contents) div so the panes are direct children of the <main>
// grid.
//
// Navigation placement: on desktop the NavRail and the SidebarPane (the
// list column) render inline as the first two grid columns. At <= 900px
// (narrowViewport, driven by ONE matchMedia in state/workspace.ts) the same
// rail and list render INSIDE a labeled, dismissible DialogFrame drawer
// opened from the mobile bar — exactly one rail and one list instance exist
// at any time, never both.
//
// The side panel (ContextPanel) is the fourth grid column on a wide window
// while it is open and focus reading is off; at <= 900px the same panel
// opens as a sheet from the right instead. Exactly one instance exists at
// any time, and it is never modal on a wide window. It shows only in the
// views that show the task document (TASK_VIEWS).
//
// The main area follows the rail's view: the task document on Tasks and
// Search, the Lanes, Tags, Backup or Settings panel otherwise. Backup has no
// list column.
//
// The document workspace (ActiveTaskPane) is keyed so drawer/viewport
// swaps in the sibling slot can never remount it (editor identity, cursor
// and undo history survive a rotation or a drawer toggle), and a panel only
// hides it, never unmounts it.

import type { VNode } from "preact";

import {
  paletteOpen,
  migrationsPending,
  navigationOpen,
  narrowViewport,
  focusReading,
  view,
  TASK_VIEWS,
} from "../state/signals.ts";
import { contextOpen, contextSheetOpen } from "../state/context.ts";
import { NavRail } from "./NavRail.tsx";
import { SidebarPane } from "./sidebar/SidebarPane.tsx";
import { ActiveTaskPane } from "./active/ActiveTaskPane.tsx";
import { StatusBar } from "./StatusBar.tsx";
import { CommandPalette } from "./palette/CommandPalette.tsx";
import { ContextPanel } from "./context/ContextPanel.tsx";
import { LanePanel } from "./panels/LanePanel.tsx";
import { TagPanel } from "./panels/TagPanel.tsx";
import { BackupPanel } from "./panels/BackupPanel.tsx";
import { SettingsPanel } from "./panels/SettingsPanel.tsx";
import { ModalRoot } from "./modals/ModalRoot.tsx";
import { DialogFrame } from "./modals/DialogFrame.tsx";
import { Tooltip } from "./Tooltip.tsx";
import { Icon } from "./Icon.tsx";

export default function App(): VNode {
  const narrow = narrowViewport.value;
  const drawerOpen = narrow && navigationOpen.value;
  const taskView = TASK_VIEWS.has(view.value);
  const listless = view.value === "backup";
  // Focus reading hides the list only on Tasks: every other view needs it.
  const reading = focusReading.value && view.value === "tasks";
  const inline = taskView && !narrow && !focusReading.value && contextOpen.value;
  // CommandPalette is mounted ONLY when paletteOpen.value is true. The
  // ternary here is load-bearing: if we rendered it unconditionally and it
  // self-gated with `return null`, the component would never unmount and its
  // useEffect-based autofocus would only fire on the very first open. See
  // the comment above CommandPalette for the full failure mode.
  return (
    <div
      class={`contents${reading && !narrow ? " focus-reading" : ""}${listless ? " no-list" : ""}${inline ? " ctx-open" : ""}`}
    >
      {migrationsPending.value.length > 0 ? (
        <div class="migration-banner">
          <span class="migration-banner-text">
            Database migrations pending ({migrationsPending.value.join(", ")}) — run <code>cortex init</code> to apply
            them safely.
          </span>
        </div>
      ) : null}
      {narrow ? (
        <header class="mobile-bar" key="mobile-bar">
          <button
            type="button"
            class="btn-icon nav-toggle"
            aria-label="Open navigation"
            aria-expanded={drawerOpen}
            aria-controls="nav-drawer"
            onClick={() => {
              navigationOpen.value = true;
            }}
          >
            <Icon name="menu" size={18} />
          </button>
          <span class="mobile-bar-title">cortex</span>
        </header>
      ) : null}
      {narrow ? null : <NavRail key="rail" />}
      {narrow || listless || reading ? null : <SidebarPane key="sidebar" />}
      <ActiveTaskPane key="active" hidden={!taskView} />
      {view.value === "lanes" ? (
        <LanePanel key="lanes" />
      ) : view.value === "tags" ? (
        <TagPanel key="tags" />
      ) : view.value === "backup" ? (
        <BackupPanel key="backup" />
      ) : view.value === "settings" ? (
        <SettingsPanel key="settings" />
      ) : null}
      {inline ? <ContextPanel key="ctx" /> : null}
      <StatusBar key="status" />
      {drawerOpen ? (
        <DialogFrame
          label="Navigation"
          className="nav-drawer dialog-frame--sheet"
          onClose={() => {
            navigationOpen.value = false;
          }}
        >
          <div id="nav-drawer" class="nav-drawer-body">
            <div class="nav-drawer-head">
              <span class="visually-hidden">Navigation</span>
              <button
                type="button"
                class="btn-icon"
                aria-label="Close navigation"
                onClick={() => {
                  navigationOpen.value = false;
                }}
              >
                <Icon name="x" />
              </button>
            </div>
            <NavRail />
            {listless ? null : <SidebarPane />}
          </div>
        </DialogFrame>
      ) : null}
      {paletteOpen.value ? <CommandPalette /> : null}
      {taskView && narrow && contextSheetOpen.value ? (
        <DialogFrame
          label="Side panel"
          className="ctx-sheet dialog-frame--sheet"
          onClose={() => {
            contextSheetOpen.value = false;
          }}
        >
          <div class="ctx-sheet-body">
            <button
              type="button"
              class="btn-icon ctx-sheet-close"
              aria-label="Close the side panel"
              onClick={() => {
                contextSheetOpen.value = false;
              }}
            >
              <Icon name="x" />
            </button>
            <ContextPanel />
          </div>
        </DialogFrame>
      ) : null}
      <ModalRoot />
      <Tooltip />
    </div>
  );
}
