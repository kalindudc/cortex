// App — root component. Wraps the panes + overlays in a transparent
// (display:contents) div so the panes are direct children of the <main>
// grid.
//
// Navigation placement: on desktop the SidebarPane renders
// inline as the first grid column. At <= 900px (narrowViewport, driven by
// ONE matchMedia in state/workspace.ts) the same SidebarPane renders INSIDE
// a labeled, dismissible DialogFrame drawer opened from the mobile bar —
// exactly one sidebar instance exists at any time, never both.
//
// The document workspace (ActiveTaskPane) is keyed so drawer/viewport
// swaps in the sibling slot can never remount it (editor identity, cursor
// and undo history survive a rotation or a drawer toggle).

import type { VNode } from "preact";

import { paletteOpen, migrationsPending, navigationOpen, narrowViewport, focusReading } from "../state/signals.ts";
import { notificationsOpen } from "../state/notifications.ts";
import { SidebarPane } from "./sidebar/SidebarPane.tsx";
import { ActiveTaskPane } from "./active/ActiveTaskPane.tsx";
import { StatusBar } from "./StatusBar.tsx";
import { CommandPalette } from "./palette/CommandPalette.tsx";
import { NotificationDrawer } from "./notifications/NotificationDrawer.tsx";
import { ModalRoot } from "./modals/ModalRoot.tsx";
import { DialogFrame } from "./modals/DialogFrame.tsx";
import { Tooltip } from "./Tooltip.tsx";
import { Icon } from "./Icon.tsx";

export default function App(): VNode {
  const narrow = narrowViewport.value;
  const drawerOpen = narrow && navigationOpen.value;
  // CommandPalette is mounted ONLY when paletteOpen.value is true. The
  // ternary here is load-bearing: if we rendered it unconditionally and it
  // self-gated with `return null`, the component would never unmount and its
  // useEffect-based autofocus would only fire on the very first open. See
  // the comment above CommandPalette for the full failure mode.
  return (
    <div class={`contents${focusReading.value && !narrow ? " focus-reading" : ""}`}>
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
      {narrow || focusReading.value ? null : <SidebarPane key="sidebar" />}
      <ActiveTaskPane key="active" />
      {/* Task context (Activity / Related / Authors) belongs to the document
          workspace — TaskDocument renders it inside the active pane's tablist. */}
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
            <SidebarPane />
          </div>
        </DialogFrame>
      ) : null}
      {paletteOpen.value ? <CommandPalette /> : null}
      {notificationsOpen.value ? <NotificationDrawer /> : null}
      <ModalRoot />
      <Tooltip />
    </div>
  );
}
