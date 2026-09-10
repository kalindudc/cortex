// state/popovers.ts — Centralised popover bookkeeping.
//
// `closeAllPopovers` is centralised so the outside-click listener (index.tsx)
// and Esc handler (index.tsx) don't have to know which popover signals exist.
// Returns true iff at least one signal was actually open (and got closed) so
// the Esc cascade in index.tsx can branch on "did anything happen?" without
// enumerating signals at the call site — future-proofs against new popovers
// being added without the Esc handler being updated.

import type { Signal } from "@preact/signals";
import {
  statusPopover,
  tagsPopover,
  lanePopover,
  taskActionsPopover,
  sidebarFilter,
  type SidebarFilter,
} from "./signals.ts";
import { notificationsOpen } from "./notifications.ts";

// Only deliberate dismissal (selection / Done / Escape) restores focus.
// Outside clicks and navigation MUST leave focus with the clicked target.
export function closeSidebarFilter(restoreFocus = false): boolean {
  const kind = sidebarFilter.peek();
  if (kind == null) return false;
  sidebarFilter.value = null;
  if (restoreFocus) document.getElementById(`sidebar-filter-${kind}-trigger`)?.focus({ preventScroll: true });
  return true;
}

export function toggleSidebarFilter(kind: SidebarFilter): void {
  const wasOpen = sidebarFilter.peek() === kind;
  closeAllPopovers();
  if (!wasOpen) sidebarFilter.value = kind;
}

// Fallback task churn still clears stale metadata, but leaves the sidebar's
// live filter session alone. All explicit retargeting uses the default.
export function closeAllPopovers({ preserveSidebar = false }: { preserveSidebar?: boolean } = {}): boolean {
  let closed = preserveSidebar ? false : closeSidebarFilter();
  if (statusPopover.peek()) {
    statusPopover.value = false;
    closed = true;
  }
  if (tagsPopover.peek()) {
    tagsPopover.value = false;
    closed = true;
  }
  if (lanePopover.peek()) {
    lanePopover.value = false;
    closed = true;
  }
  if (taskActionsPopover.peek()) {
    taskActionsPopover.value = false;
    closed = true;
  }
  // The notification drawer follows the same close-on-outside-click +
  // close-on-Esc + mutual-exclusion contract as the chip popovers, so it
  // joins the same cascade. Drawer body + bell trigger both carry
  // data-pop so the outside-click handler in index.tsx skips them.
  if (notificationsOpen.peek()) {
    notificationsOpen.value = false;
    closed = true;
  }
  return closed;
}

// Mutually-exclusive popover toggle. Closes whatever was open, then opens
// the target if it wasn't already open. Use this from chip-click handlers
// instead of `targetSignal.value = !targetSignal.value` so opening one
// popover always closes the others — single-popover-at-a-time invariant.
export function togglePopover(targetSignal: Signal<boolean>): void {
  const wasOpen = targetSignal.value;
  closeAllPopovers();
  if (!wasOpen) targetSignal.value = true;
}
