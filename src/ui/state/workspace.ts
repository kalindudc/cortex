// state/workspace.ts — Document-workspace controller (task 330).
//
// Owns the cross-cutting workspace behaviours that no single component can:
//   - persistence of the workspace search query under its own VERSIONED key
//     (the legacy cortex-filters payload keeps its shape untouched — W3);
//   - browser-persisted Read/Edit/Split preference and Document entry on
//     task navigation, with task-owned transient state cleared;
//   - the state-level actions behind mode switching (requestMode), the
//     inline composer (requestPostUpdate — A3) and transient-state reset.
//
// Signal DECLARATIONS stay in signals.ts (this module imports them); this
// file adds derivations and side effects only. Side-effect module: index.tsx
// imports it after the existing preference seeds and before mount/refresh.
//
// `QUERY_KEY` and `parseStoredQuery` are exported ONLY for unit tests (the
// same pure-parser contract as state/filters.ts — the bun:test module cache
// means the seed itself runs once per process and cannot be re-exercised).

import { batch, effect } from "@preact/signals";
import {
  workspaceQuery,
  readerMode,
  preferredReaderMode,
  pendingHeadingFragment,
  type ReaderMode,
  tab,
  navigationOpen,
  draggedTaskId,
  pendingTitleFocus,
  pendingBodyFocus,
  pendingReaderFocus,
  postUpdateOpen,
  postUpdateFocusRequest,
  narrowViewport,
  selectedId,
  sidebarMode,
  sidebarFilter,
  type SidebarFilter,
  focusReading,
  paletteOpen,
} from "./signals.ts";
import { activeTask } from "./computed.ts";
import { closeAllPopovers, closeSidebarFilter } from "./popovers.ts";

// Versioned preference key. Bump the suffix if the stored semantics ever
// change; old keys are simply ignored (no migration — a lost search box
// string is cheap). Distinct from the legacy filter/collapse keys, which
// keep their existing names and shapes.
export const QUERY_KEY = "cortex-workspace-query-v1";
export const READER_MODE_KEY = "cortex-reader-mode-v1";

export function parseStoredReaderMode(raw: string | null): ReaderMode | null {
  return raw === "read" || raw === "edit" || raw === "split" ? raw : null;
}

function readStoredReaderMode(): ReaderMode | null {
  try {
    return parseStoredReaderMode(localStorage.getItem(READER_MODE_KEY));
  } catch {
    return null; // storage unavailable: the in-memory preference still works
  }
}

// Longest query we bother restoring. Anything larger is judged corrupt
// (nobody types 4 KiB into a filter box) and rejected whole, matching the
// whole-payload rejection stance of state/filters.ts.
const MAX_QUERY_LENGTH = 4096;

// Pure parser for the stored query preference. null → no stored preference;
// oversized payloads are rejected. The empty string is a VALID preference
// ("no query"), distinct from null.
export function parseStoredQuery(raw: string | null): string | null {
  if (raw == null) return null;
  if (raw.length > MAX_QUERY_LENGTH) return null;
  return raw;
}

function readStoredQuery(): string | null {
  try {
    return parseStoredQuery(localStorage.getItem(QUERY_KEY));
  } catch {
    return null; // private mode — localStorage.getItem can throw
  }
}

// Seed BEFORE registering effects so the first effect run doesn't overwrite
// storage with the compile-time default (same ordering as filters.ts).
const seed = readStoredQuery();
if (seed != null) workspaceQuery.value = seed;
preferredReaderMode.value = readStoredReaderMode() ?? "read";
readerMode.value = pendingHeadingFragment.peek()?.taskId === selectedId.peek() ? "read" : preferredReaderMode.peek();

// Persist only intentional user preference changes, not temporary Read
// mode used by URL heading navigation. Seed precedes this first write.
effect(() => {
  const mode = preferredReaderMode.value;
  try {
    localStorage.setItem(READER_MODE_KEY, mode);
  } catch {
    /* private mode / quota — retain the in-memory preference */
  }
});

effect(() => {
  const q = workspaceQuery.value;
  try {
    localStorage.setItem(QUERY_KEY, q);
  } catch {
    /* private mode — ignore */
  }
});

// Narrow-viewport tracking (V2). One media query is the single source of
// truth for "drawer instead of inline sidebar" so CSS breakpoints and the
// component tree can never disagree. Kept in a side-effect module (not a
// component) so the drawer decision exists before first paint.
export const NARROW_QUERY = "(max-width: 900px)";
if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
  const mq = window.matchMedia(NARROW_QUERY);
  narrowViewport.value = mq.matches;
  const onChange = (e: MediaQueryListEvent): void => {
    narrowViewport.value = e.matches;
    // Leaving the narrow layout drops the drawer: the sidebar is inline again.
    if (!e.matches) navigationOpen.value = false;
  };
  if (typeof mq.addEventListener === "function") mq.addEventListener("change", onChange);
}

// ONE reset path. Metadata/drag state belongs to a task; the navigation
// drawer and sidebar filters belong to a filtering session. Explicit task
// navigation or deliberate retargeting clears both. A fallback task change
// clears only task-owned state, so live filtering never dismisses itself.
// focusReading is a sticky reading preference, not transient state.
export function clearWorkspaceTransientState({ preserveSidebar = false }: { preserveSidebar?: boolean } = {}): boolean {
  let changed = draggedTaskId.peek() != null || (!preserveSidebar && navigationOpen.peek());
  batch(() => {
    pendingReaderFocus.value = null;
    draggedTaskId.value = null;
    if (!preserveSidebar) navigationOpen.value = false;
    if (closeAllPopovers({ preserveSidebar })) changed = true;
  });
  return changed;
}

// Palette/legacy-modal entry: reveal the SAME sidebar and attached panel,
// even from focus reading, a management pane or a narrow viewport. No
// filter mutation and no timer waiting for an outgoing animation.
export function revealSidebarFilter(kind: SidebarFilter): void {
  batch(() => {
    clearWorkspaceTransientState();
    paletteOpen.value = false;
    sidebarMode.value = "main";
    focusReading.value = false;
    navigationOpen.value = narrowViewport.peek();
    sidebarFilter.value = kind;
  });
}

// A hidden/unmounted navigation surface cannot retain an open filter.
// Do this in state, never from a component's unmount cleanup.
effect(() => {
  if (sidebarMode.value !== "main" || (narrowViewport.value ? !navigationOpen.value : focusReading.value)) {
    closeSidebarFilter();
  }
});

// Task navigation restores the saved body mode, not a hard-coded Read
// default. Track EXPLICIT selection separately from
// activeTask's fallback: tag/query/status/lane changes may replace that
// fallback without constituting navigation. Even explicitly selecting the
// current fallback closes navigation; same-task data churn does not.
let lastTaskId: number | null = null;
let lastSelection = selectedId.peek();
effect(() => {
  const selection = selectedId.value;
  const id = activeTask.value?.id ?? null;
  const navigated = selection !== lastSelection;
  lastSelection = selection;
  if (id === lastTaskId) {
    if (navigated) clearWorkspaceTransientState();
    return;
  }
  lastTaskId = id;
  batch(() => {
    readerMode.value = pendingHeadingFragment.peek()?.taskId === id ? "read" : preferredReaderMode.peek();
    tab.value = "document";
    clearWorkspaceTransientState({ preserveSidebar: !navigated });
  });
});

// Explicit user body-mode choice: update the browser preference and reveal
// the Document tab. Optional one-shot focus request routes to
// the title input or the body editor of the ACTIVE task; consumed by
// TaskHeader / TaskDocument after they can actually focus the target.
export function requestMode(mode: ReaderMode, focus?: "title" | "body" | "reader"): void {
  const at = activeTask.value;
  batch(() => {
    preferredReaderMode.value = mode;
    readerMode.value = mode;
    tab.value = "document";
    pendingReaderFocus.value = at != null && focus === "reader" ? at.id : null;
    if (at != null && focus === "title") pendingTitleFocus.value = at.id;
    if (at != null && focus === "body") pendingBodyFocus.value = at.id;
  });
}

// One entry point for "post an update" (A3) — serves Cmd/Ctrl+/ and the
// palette. Reveals Activity, expands the inline composer disclosure (the
// persisted global collapse preference — A2) and requests textarea focus
// via the monotonic counter. No active task → deliberate no-op.
export function requestPostUpdate(): void {
  if (activeTask.value == null) return;
  batch(() => {
    // Retarget lower transient layers before revealing Activity. Palette and
    // modal are higher overlays and are handled by their caller/global key
    // guard; this action owns workspace drawer/drag/popover cleanup.
    clearWorkspaceTransientState();
    tab.value = "updates";
    postUpdateOpen.value = true;
    postUpdateFocusRequest.value = postUpdateFocusRequest.value + 1;
  });
}
