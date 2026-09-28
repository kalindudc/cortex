// state/signals.ts — The dumb-data slice of the cortex dashboard.
//
// Bare signal declarations only. No derivation, no side effects, no DOM. The
// computed values live in ./computed.ts; the reactive `effect` for active-task
// updates lives in ./refresh.ts. Other state/ slices import from here freely;
// this file imports nothing from the state/ directory (acyclic).

import { batch, signal } from "@preact/signals";
import type { Task, Lane, Update, Author, TaskStatus, RelatedTasks } from "../api/types.ts";
import type { ConnectionState } from "../../contracts.ts";

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
// Append-only variant used by clickable task tag pills: widen the active
// filter with `name` but never toggle it off. Idempotent so clicking a tag
// already in the filter is a no-op (no duplicate entry, no re-render churn).
export function addTagFilter(name: string): void {
  const cur = filters.value.tag;
  if (cur.includes(name)) return;
  setFilter("tag", [...cur, name]);
}
// Workspace search query (W3). A SEPARATE signal from `filters` so the
// legacy cortex-filters storage payload keeps its shape; persisted under
// its own versioned key by state/workspace.ts. Empty/whitespace-only means
// "no search restriction". Composed with the structured filters in
// computed.ts (full-pool search FIRST, then intersection).
export const workspaceQuery = signal<string>("");
// Clear-all clears every filtering slot INCLUDING the query, in one batch
// so downstream computeds settle once. It intentionally does NOT touch the
// include-done preference (showAllTasks) — that is a display preference,
// not a filter (W3).
export function clearAllFilters(): void {
  batch(() => {
    filters.value = { status: null, lane: null, tag: [] };
    workspaceQuery.value = "";
  });
}
export function hasActiveFilters(): boolean {
  const f = filters.value;
  return f.status !== null || f.lane !== null || f.tag.length > 0 || workspaceQuery.value.trim() !== "";
}
// Per-section open/closed state for the unified SidebarPane. Filtering
// lives in WorkspaceFilters and its attached panels; management lives in
// the dedicated sidebar modes. In-memory only; defaults reset on reload.
export const sectionOpen = signal<{ views: boolean; lanes: boolean; tasks: boolean }>({
  views: true,
  lanes: true,
  tasks: true,
});
// Sidebar mode toggle. "main" is the workspace surface (filters + task
// list); "tags" and "lanes" are explicit MANAGEMENT modes (labeled 'Manage
// tags' / 'Manage lanes' with a Back-to-tasks affordance). Entering a
// management mode never changes the active filters (W2). Live, in-memory
// only.
export const sidebarMode = signal<"main" | "tags" | "lanes">("main");
// Sidebar filters are navigation-owned, NOT active-task metadata popovers.
// A fallback active-task change during live filtering must not close them.
// One discriminant gives the three attached panels mutual exclusion.
export type SidebarFilter = "status" | "lane" | "tags";
export const sidebarFilter = signal<SidebarFilter | null>(null);

// ---------- document workspace (task 330) ----------
// Body mode preference is global to this browser, not per task. Keep the
// effective view separate: a heading link can temporarily reveal Read
// without overwriting the user's preferred Edit/Split mode.
export type ReaderMode = "read" | "edit" | "split";
export const preferredReaderMode = signal<ReaderMode>("read");
export const readerMode = signal<ReaderMode>("read");
// Mobile/narrow-viewport navigation drawer visibility (V2). Desktop keeps
// the sidebar inline and ignores this signal.
export const navigationOpen = signal<boolean>(false);
// true at <= 900px (V2). Seeded + tracked from matchMedia by
// state/workspace.ts; App swaps the inline sidebar for the drawer frame and
// TaskDocument collapses the outline into a disclosure. Tests set it
// directly (happy-dom's matchMedia never matches).
export const narrowViewport = signal<boolean>(false);
// Focus reading hides the navigation column without becoming another
// data/view implementation (W1). Sticky across task navigation.
export const focusReading = signal<boolean>(false);
// Task id currently being dragged from the task list. Non-null ONLY during
// an actual drag — reveals the transient 'Move to lane' destination tray
// (W5). Cleared on drop/dragend/Escape and by clearWorkspaceTransientState.
export const draggedTaskId = signal<number | null>(null);
// One-shot editor (body) focus request, mirroring pendingTitleFocus below:
// holds the task id whose editor should grab focus once mounted/revealed.
// Set via workspace.requestMode(mode, "body"); consumed by TaskDocument.
export const pendingBodyFocus = signal<number | null>(null);
// Keyboard mode switching focuses the rendered reader once it is visible.
export const pendingReaderFocus = signal<number | null>(null);
// Monotonic counter bumped by workspace.requestPostUpdate() (A3). The
// inline composer subscribes and, on change, expands/scrolls/focuses its
// textarea. A counter (not boolean) so repeated requests re-focus.
export const postUpdateFocusRequest = signal<number>(0);
// Task id whose title-input should grab focus on next mount. Set by the
// "+ New task" affordance in SidebarPane (createUntitledTask) so the user
// can immediately rename the auto-generated `untitled-<id>` placeholder.
// TaskHeader consumes it once that task's draft has its atomic baseline
// (editing is disabled before, plan @400 N8) and clears it after focus
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
// Task-actions menu (header "⋯" trigger — holds Delete task). Same
// outside-click/Esc contract as the chip popovers; included in
// closeAllPopovers().
export const taskActionsPopover = signal<boolean>(false);
export const paletteOpen = signal<boolean>(false);
export const paletteQuery = signal<string>("");
// modal kinds: 'confirm-delete' | 'lane-edit' | 'confirm-lane-delete' |
// 'new-lane' | 'new-tag' | 'tag-edit' | 'confirm-tag-delete' |
// 'filter-tags' | 'update-detail' | 'render-markdown'
export const modal = signal<{ kind: string; [k: string]: unknown } | null>(null);

// ---------- misc ----------
// Resolved on boot from /api/me (gh hosts.yml -> git user.name -> hostname -> "me").
export const meAuthor = signal<string>("me");
// Task-content tab (one APG tablist in TaskDocument): "document" (default,
// the rendered/editable task body), "updates" (Activity — the active
// task's update thread + inline composer), "authors" (per-task author
// rollup), or "related" (three buckets from /api/tasks/:id/related,
// fetched into `relatedTasks` below).
export const tab = signal<"document" | "updates" | "authors" | "related">("document");

// Fetched RelatedTasks for the active task. null means "not yet fetched"
// (loading) — distinct from `{referencedBy:[],references:[],shared:[]}`
// which means "fetched and CONFIRMED empty". Populated by refresh.ts
// (generation-guarded — N2); consumed by the Related tab.
export const relatedTasks = signal<RelatedTasks | null>(null);
// Typed, TASK-KEYED load/error state for the Related fetch (N2): published
// ONLY for the still-current request/task generation, so a slow failure for
// task A can never paint an error (or spinner) under task B. The generation
// makes concurrent same-task requests observable in tests/debugging.
export interface RelatedLoadingState {
  taskId: number;
  generation: number;
}
export interface RelatedErrorState {
  taskId: number;
  message: string;
}
export const relatedLoading = signal<RelatedLoadingState | null>(null);
export const relatedError = signal<RelatedErrorState | null>(null);
// Heading fragment carried by the URL (`/task/5#task-5-beta`), consumed by
// TaskDocument once that TASK's Markdown has rendered. Keying prevents a
// delayed/deleted task-A target from scrolling task B.
export interface PendingHeadingFragment {
  taskId: number;
  id: string;
}
export const pendingHeadingFragment = signal<PendingHeadingFragment | null>(null);

// ---------- migrations ----------
// Populated on boot from GET /api/migrations. Non-empty means the DB has
// pending schema migrations; the UI shows a banner directing the user to
// run `cortex init`.
export const migrationsPending = signal<string[]>([]);

// ---------- live synchronization (plan @400 N12) ----------
// Health of the /events subscription, written only by state/refresh.ts
// connectLive(): "connecting" until the first `ready`, "live" after each
// `ready`, and "stale" while the stream is down after having been live
// (shown data may lag until the next `ready` resnapshots). The native
// clients' ConnectionState vocabulary; no UI renders it yet.
export const liveState = signal<ConnectionState>("connecting");
