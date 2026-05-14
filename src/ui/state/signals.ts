// state/signals.ts — The dumb-data slice of the cortex dashboard.
//
// Bare signal declarations only. No derivation, no side effects, no DOM. The
// computed values live in ./computed.ts; the reactive `effect` for active-task
// updates lives in ./refresh.ts. Other state/ slices import from here freely;
// this file imports nothing from the state/ directory (acyclic).

import { signal } from "@preact/signals";
import type { Task, Lane, Tag, Update, Author } from "../api/types.ts";

// ---------- task data ----------
export const tasks = signal<Task[]>([]);
export const lanes = signal<Lane[]>([]);
// Tag rollups: { name, color, created, task_count } from /api/tags. Refreshed
// in the same Promise.all as tasks/lanes so chip colors stay in sync after
// any tag.changed / task.updated SSE event. Server returns the rollup shape
// (Tag + task_count); the type below mirrors that runtime reality so typed
// callers can read .task_count without a cast.
export type { TagWithCount } from "../api/client.ts";
import type { TagWithCount } from "../api/client.ts";
export const tags = signal<TagWithCount[]>([]);
export const updates = signal<Record<number, Update[]>>({});
export const authors = signal<Author[]>([]);

// ---------- sidebar / selection ----------
// Sidebar mode: "lanes" (default LanesPane) or "tags" (TagsPane). The home
// button + a tag-mode button live in the sidebar's .pane-system strip.
// Switching is mostly non-destructive: it does NOT clear selectedLane or
// selectedId so the right-hand active task pane keeps its context. Exception:
// switching tags → lanes (Home button or "Switch to lane mode" palette entry)
// resets selectedTag to null so the lanes view never inherits stale tag-mode
// filter state. The reverse direction (lanes → tags) leaves selectedTag
// alone — entering tags mode with the previous filter restored is desired.
export const sidebarView = signal<"lanes" | "tags">("lanes");
// Optional single-tag filter applied to the visible task list. Combined with
// selectedLane via AND. Set by clicking a tag row in TagsPane (or via the
// command palette's "Filter by tag…" entry); cleared by clicking the same
// tag again or by the "All tags" entry.
export const selectedTag = signal<string | null>(null);
export const selectedLane = signal<string | null>(null);
export const selectedId = signal<number | null>(null);

// ---------- popovers / overlays ----------
// New-tag inline form open/closed (mirrors newLaneOpen).
export const newTagOpen = signal<boolean>(false);
export const newLaneOpen = signal<boolean>(false);
export const statusPopover = signal<boolean>(false);
// Active-task tags-chip popover. Mirrors statusPopover: click chip to toggle,
// outside-click closes via index.tsx's global handler + closeAllPopovers().
export const tagsPopover = signal<boolean>(false);
// Active-task lane chip popover. Same outside-click contract as tagsPopover.
// MUST be flipped inside closeAllPopovers() — this is the same Esc/outside-
// click contract that historically broke when a new popover signal was
// added without updating closeAllPopovers().
// (Priority no longer needs a popover signal: PriorityChipButton uses an
// inline <input> with local state — no global popover bookkeeping.)
export const lanePopover = signal<boolean>(false);
export const paletteOpen = signal<boolean>(false);
// modal kinds: 'confirm-delete' | 'lane-edit' | 'confirm-lane-delete'
export const modal = signal<{ kind: string; [k: string]: unknown } | null>(null);

// ---------- misc ----------
export const errorMsg = signal<string | null>(null);
// Resolved on boot from /api/me (gh hosts.yml -> git user.name -> hostname -> "me").
export const meAuthor = signal<string>("me");
// Inbox tab: "updates" (default, shows the active task's update thread) or
// "authors" (shows recent author activity from /api/authors).
export const tab = signal<"updates" | "authors">("updates");
