// state/signals.ts — The dumb-data slice of the cortex dashboard.
//
// Bare signal declarations only. No derivation, no side effects, no DOM. The
// computed values live in ./computed.ts; the reactive `effect` for active-task
// updates lives in ./refresh.ts. Other state/ slices import from here freely;
// this file imports nothing from the state/ directory (acyclic).

import { signal } from "@preact/signals";
import type { Task, Lane, Update, Author, TaskStatus } from "../api/types.ts";

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
// Unified composable filter state. Three slots produce the visible task list
// (see state/computed.ts:filteredTasks). status and lane AND together; tag is
// an array OR-composed across its entries (any task carrying ANY selected
// tag is included). The UNTAGGED sentinel from state/computed.ts may appear
// as an array entry to mean "also include untagged tasks" — handled inline
// in filteredTasks, NOT a separate code path.
export interface Filters {
  status: TaskStatus | null;
  lane: string | null;
  // OR-composed list of tag names (or UNTAGGED sentinel). Empty = no filter.
  tag: string[];
}
export const filters = signal<Filters>({ status: null, lane: null, tag: [] });
export function setFilter<K extends keyof Filters>(k: K, v: Filters[K]): void {
  filters.value = { ...filters.value, [k]: v };
}
// Convenience helpers for the multi-tag filter — keeps callers from open-
// coding `[...filters.value.tag, name]` / Array.filter dance.
export function toggleTagFilter(name: string): void {
  const cur = filters.value.tag;
  const next = cur.includes(name) ? cur.filter(n => n !== name) : [...cur, name];
  setFilter("tag", next);
}
export function clearAllFilters(): void {
  filters.value = { status: null, lane: null, tag: [] };
}
export function hasActiveFilters(): boolean {
  const f = filters.value;
  return f.status !== null || f.lane !== null || f.tag.length > 0;
}
// Per-section open/closed state for the unified SidebarPane. Tag-FILTERING
// lives in TagFilterModal (FilterChips "+ tag" affordance / command palette);
// tag MANAGEMENT lives in the dedicated tags-mode SidebarPane (toggled via
// SidebarSystemBar). In-memory only; defaults reset on reload (matches how
// theme.ts deferred persistence until later).
export const sectionOpen = signal<{ views: boolean; lanes: boolean; tasks: boolean }>({
  views: true,
  lanes: true,
  tasks: true,
});
// Sidebar mode toggle. "main" shows Views + Lanes + Tasks; "tags" swaps the
// pane to a single TAGS management section (add / edit tags). Toggled by
// the hash-icon button in SidebarSystemBar. Live, in-memory only.
export const sidebarMode = signal<"main" | "tags">("main");
// Task id whose title-input should grab focus on next mount. Set by the
// "+ New task" affordance in SidebarPane (createUntitledTask) so the user
// can immediately rename the auto-generated `untitled-<id>` placeholder.
// EditableTaskBody picks this up via useEffect and clears it after focus
// (one-shot semantics).
export const pendingTitleFocus = signal<number | null>(null);
export const selectedId = signal<number | null>(null);
// Tasks-list filter toggle. false (default) = hide done tasks; true = show
// everything. Persisted via state/showAllTasks.ts.
export const showAllTasks = signal<boolean>(false);
// Active-task "Post update" form collapse state. false (default) = collapsed.
// Persisted via state/postUpdateOpen.ts. Single global boolean (not per-task)
// by design — see the plan's Implementation Notes for the KISS rationale.
export const postUpdateOpen = signal<boolean>(false);

// ---------- popovers / overlays ----------
// Lane creation flows through the NewLaneModal (modal.value = { kind:
// "new-lane" }) instead of an inline sidebar popover form — keeps create /
// edit / delete on a single consistent surface and dodges the autoFocus
// race that the inline form had. Tag creation flows through the active-
// task TagPicker (type a new name → "Create #foo" row appears).
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
export const paletteQuery = signal<string>("");
// modal kinds: 'confirm-delete' | 'lane-edit' | 'confirm-lane-delete' |
// 'new-lane' | 'new-tag' | 'tag-edit' | 'confirm-tag-delete' |
// 'filter-tags' | 'update-detail' | 'render-markdown'
export const modal = signal<{ kind: string; [k: string]: unknown } | null>(null);

// ---------- misc ----------
// Resolved on boot from /api/me (gh hosts.yml -> git user.name -> hostname -> "me").
export const meAuthor = signal<string>("me");
// Inbox tab: "updates" (default, shows the active task's update thread) or
// "authors" (shows recent author activity from /api/authors).
export const tab = signal<"updates" | "authors">("updates");

// ---------- migrations ----------
// Populated on boot from GET /api/migrations. Non-empty means the DB has
// pending schema migrations; the UI shows a banner directing the user to
// run `cortex init`.
export const migrationsPending = signal<string[]>([]);
