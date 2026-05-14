// state/popovers.ts — Centralised popover bookkeeping.
//
// `closeAllPopovers` is centralised so the outside-click listener (index.tsx)
// and Esc handler (index.tsx) don't have to know which popover signals exist.
// Returns true iff at least one signal was actually open (and got closed) so
// the Esc cascade in index.tsx can branch on "did anything happen?" without
// enumerating signals at the call site — future-proofs against new popovers
// being added without the Esc handler being updated.

import type { Signal } from "@preact/signals";
import { statusPopover, newLaneOpen, tagsPopover, newTagOpen, lanePopover } from "./signals.ts";

export function closeAllPopovers(): boolean {
  let closed = false;
  if (statusPopover.value) {
    statusPopover.value = false;
    closed = true;
  }
  if (newLaneOpen.value) {
    newLaneOpen.value = false;
    closed = true;
  }
  if (tagsPopover.value) {
    tagsPopover.value = false;
    closed = true;
  }
  if (newTagOpen.value) {
    newTagOpen.value = false;
    closed = true;
  }
  if (lanePopover.value) {
    lanePopover.value = false;
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
