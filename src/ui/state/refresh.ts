// state/refresh.ts — Server-pull entrypoints, live synchronization and the
// reactive update fetcher.
//
// `connectLive()` follows the daemon's /events stream (index.tsx hands it
// the page's EventSource) and keeps the workspace signals in sync through
// GET /api/workspace snapshots; `refresh()` takes one snapshot on demand.
// `fetchAuthors()` is the lazy load of the author rollup invoked when the
// user opens the Authors tab.
//
// LIVE SYNCHRONIZATION (plan @400 N12). The daemon subscribes a stream
// BEFORE it sends `ready {cursor}`, and every later frame carries an
// `<epoch>:<seq>` id, so:
//   - after each `ready` the dashboard takes a workspace snapshot (unless
//     the applied one already covers the ready cursor) and applies only
//     frames past the snapshot's cursor;
//   - frames arriving while a snapshot is in flight are coalesced/buffered
//     and replayed against its cursor: nothing published during the fetch
//     is lost and nothing the snapshot already contains is applied twice;
//   - ONE snapshot is in flight at a time; a `ready` (a reconnect) makes the
//     in-flight one obsolete and its late response is ignored;
//   - `resync`, a sequence gap or a new epoch resnapshot; duplicate, stale
//     and out-of-order frames are dropped;
//   - `notification.changed` refetches the notifications, and an answer
//     overtaken by newer notification state is ignored;
//   - ONLY the explicit `task.blocked` transition raises the desktop alert:
//     never a snapshot, a reconnect or a task.updated frame whose task is
//     (still) blocked.
// There is no replay: the daemon keeps no event history, so reconnecting
// always resnapshots rather than claiming missed frames are redelivered.
//
// TASK-SAFE RELATED (task 330, N2): every Related fetch carries a request
// generation and re-checks the ACTIVE task before publishing — in BOTH
// async paths (a snapshot's follow-up and the activeTask effect). A slow
// response or failure for task A can never appear under task B, a stale
// response can never replace a newer success, and failures publish an
// explicit error/retry state (relatedError) instead of a silent empty
// success. Update lists are keyed by task id in the `updates` map, and only
// the newest request per task may publish its list.

import { batch, effect } from "@preact/signals";
import type { BlockedTransition, WorkspaceSnapshot } from "../../contracts.ts";
import { EVENT_KINDS, type EventKind, parseCursor } from "../../events.ts";
import { api } from "../api/client.ts";
import { showError } from "../api/errors.ts";
import type { Notification } from "../api/types.ts";
import {
  tasks,
  lanes,
  tags,
  updates,
  authors,
  relatedTasks,
  relatedLoading,
  relatedError,
  liveState,
} from "./signals.ts";
import { notifications } from "./notifications.ts";
import { activeTask } from "./computed.ts";
import { pruneTaskDrafts } from "../lib/useTaskDraft.ts";

// Lazy load of the author rollup. Called when the user opens the Authors
// tab. Errors surface via the standard toast.
export async function fetchAuthors(): Promise<void> {
  try {
    authors.value = await fetch("/api/authors").then(r => r.json());
  } catch (e) {
    showError(e);
  }
}

// Monotonic request generation for Related fetches. A publication is valid
// only when (a) its generation is still the newest AND (b) the task it was
// fetched for is still the active task.
let relatedGen = 0;

export async function fetchRelated(taskId: number): Promise<void> {
  // A refresh path may resume after its task was already replaced/deleted.
  // Reject that request BEFORE touching global state or issuing I/O.
  if (activeTask.peek()?.id !== taskId) return;

  const gen = ++relatedGen;
  relatedLoading.value = { taskId, generation: gen };
  relatedError.value = null;
  const current = (): boolean => gen === relatedGen && activeTask.peek()?.id === taskId;
  try {
    const r = await api.related(taskId);
    if (!current()) return; // stale generation or task switched — discard
    relatedTasks.value = r;
    relatedLoading.value = null;
  } catch (err) {
    if (!current()) return; // stale failure — never paint it on the current task
    relatedError.value = {
      taskId,
      message: err instanceof Error ? err.message : String(err),
    };
    relatedLoading.value = null;
  }
}

// Explicit retry for the Related error state (N2).
export function retryRelated(): void {
  const at = activeTask.peek();
  if (at) void fetchRelated(at.id);
}

// Newest update-list request per task: a slower, older answer never
// replaces the list a newer request already published.
const updatesRequests = new Map<number, number>();
let updatesSeq = 0;

async function loadUpdates(taskId: number): Promise<void> {
  const request = ++updatesSeq;
  updatesRequests.set(taskId, request);
  const list = await api.updates(taskId);
  if (updatesRequests.get(taskId) !== request) return;
  // Keyed by the ORIGINAL task id — a task switch mid-flight cannot
  // misfile another task's thread (N2).
  updates.value = { ...updates.value, [taskId]: list };
}

// ---------- live synchronization (plan @400 N12) ----------

/** A stream position; comparable only within one epoch (one publisher lifetime). */
type Position = { epoch: string; seq: number };
type NotificationFrame = { kind: "notification.added" | "notification.changed"; at: Position; payload: unknown };

/** Default window that coalesces a burst of change frames into one snapshot. */
const COALESCE_MS = 50;

/** Frames whose change the next workspace snapshot picks up. */
const SNAPSHOT_KINDS: ReadonlySet<string> = new Set<EventKind>([
  "task.added",
  "task.updated",
  "task.removed",
  "update.posted",
  "lane.changed",
  "tag.changed",
  "task.blocked",
]);

let coalesceMs = COALESCE_MS;
/** Newest accepted frame of the current connection (null while disconnected). */
let stream: Position | null = null;
let everLive = false;
/** Cursor of the applied workspace snapshot. */
let applied: Position | null = null;
/** The applied snapshot must reach at least this position. */
let required: Position | null = null;
/** Notification frames received during a snapshot fetch, replayed against its cursor. */
let pendingNotifications: NotificationFrame[] = [];
/** Generation of the newest issued snapshot; any other response is obsolete. */
let snapshotGen = 0;
let snapshotInFlight = false;
let coalesceTimer: ReturnType<typeof setTimeout> | null = null;
/** Generation of the newest notifications read (a refetch or a snapshot). */
let notificationGen = 0;
let refetchToken = 0;
let refetchInFlight = false;
let refetchAgain = false;

const covers = (a: Position | null, b: Position): boolean => a !== null && a.epoch === b.epoch && a.seq >= b.seq;

function clearCoalesce(): void {
  if (coalesceTimer === null) return;
  clearTimeout(coalesceTimer);
  coalesceTimer = null;
}

/** Make sure a snapshot at or past `at` is (or will be) applied: now, or after the coalescing window. */
function requireSnapshot(at: Position, urgent: boolean): void {
  if (covers(applied, at)) return;
  if (!covers(required, at)) required = at;
  if (snapshotInFlight) return; // checked again when that snapshot lands
  if (urgent) void takeSnapshot();
  else if (coalesceTimer === null) coalesceTimer = setTimeout(() => void takeSnapshot(), coalesceMs);
}

function applyWorkspace(snapshot: WorkspaceSnapshot): void {
  // One consistent read, applied as one change.
  batch(() => {
    tasks.value = snapshot.tasks;
    lanes.value = snapshot.lanes;
    tags.value = snapshot.tags;
    notifications.value = snapshot.notifications;
  });
  // Confirmed deletions release their recovery drafts (D2).
  pruneTaskDrafts(snapshot.tasks.map(t => t.id));
}

/** The active task's thread and Related buckets, refreshed after every applied snapshot. */
async function loadActiveTaskDetails(): Promise<void> {
  const at = activeTask.peek();
  if (!at) {
    // Invalidate any request that began before this snapshot showed there
    // is no active task (for example, the selected task was deleted).
    relatedGen++;
    relatedTasks.value = null;
    relatedLoading.value = null;
    relatedError.value = null;
    return;
  }
  const taskId = at.id;
  try {
    await loadUpdates(taskId);
  } catch (err) {
    showError(err);
    return;
  }
  void fetchRelated(taskId);
}

/**
 * Fetch and apply one workspace snapshot. Every frame received before this
 * request is covered by its cursor, and a newer request makes it obsolete.
 */
async function takeSnapshot(): Promise<void> {
  clearCoalesce();
  const gen = ++snapshotGen;
  snapshotInFlight = true;
  pendingNotifications = [];
  // Whatever an earlier notifications refetch could return is in this snapshot.
  notificationGen++;
  refetchAgain = false;
  let snapshot: WorkspaceSnapshot;
  try {
    snapshot = await api.workspace();
  } catch (err) {
    if (gen !== snapshotGen) return;
    snapshotInFlight = false;
    showError(err);
    // Nothing was applied, and an idle stream may send no further frame or
    // `ready`: the frames buffered meanwhile apply as if no snapshot had been
    // in flight (a row is prepended, a change refetches, and a frame with
    // nothing comparable shown requests a snapshot issued after it).
    const replay = pendingNotifications;
    pendingNotifications = [];
    for (const frame of replay) applyNotificationFrame(frame);
    return;
  }
  if (gen !== snapshotGen) return; // superseded: obsolete
  snapshotInFlight = false;
  const at = parseCursor(snapshot.cursor);
  if (!at) {
    showError(new Error(`workspace snapshot has an invalid cursor: ${String(snapshot.cursor)}`));
    return;
  }
  applyWorkspace(snapshot);
  applied = at;
  if (required !== null && covers(applied, required)) required = null;
  const replay = pendingNotifications;
  pendingNotifications = [];
  for (const frame of replay) applyNotificationFrame(frame);
  // Changes that landed after this snapshot's cursor need one more.
  if (required !== null) requireSnapshot(required, false);
  await loadActiveTaskDetails();
}

/** Re-read notifications; one request in flight, and an overtaken answer is dropped for a trailing one. */
function refetchNotifications(): void {
  if (refetchInFlight) {
    refetchAgain = true;
    return;
  }
  refetchInFlight = true;
  const token = ++refetchToken;
  const gen = ++notificationGen;
  void api
    .notifications()
    .then(
      rows => {
        if (gen === notificationGen && !refetchAgain) notifications.value = rows;
      },
      err => {
        if (gen === notificationGen) showError(err);
      },
    )
    .finally(() => {
      if (token !== refetchToken) return; // abandoned by a new connection
      refetchInFlight = false;
      if (refetchAgain) {
        refetchAgain = false;
        refetchNotifications();
      }
    });
}

function applyNotificationFrame(frame: NotificationFrame): void {
  if (covers(applied, frame.at)) return; // the applied snapshot already reflects it
  if (applied === null || applied.epoch !== frame.at.epoch) {
    requireSnapshot(frame.at, true); // not comparable with what is shown
    return;
  }
  if (frame.kind === "notification.changed") {
    refetchNotifications();
    return;
  }
  // The frame IS the persisted row: prepend it without a round-trip. An
  // in-flight refetch may predate it, so its answer is replaced.
  if (refetchInFlight) refetchAgain = true;
  const row = frame.payload as Notification;
  if (!notifications.value.some(n => n.id === row.id)) notifications.value = [row, ...notifications.value];
}

/** Desktop alert for an explicit transition into blocked, never inferred from task snapshots. */
function alertBlocked(transition: BlockedTransition): void {
  const Desktop = globalThis.Notification;
  if (typeof Desktop === "undefined") return;
  if (Desktop.permission === "granted") {
    try {
      // `tag` dedupes: blocked -> other -> blocked keeps only the latest alert per task visible.
      new Desktop("cortex: task blocked", { body: transition.task.title, tag: `task-${transition.task.id}` });
    } catch {
      /* some browsers throw if the page is not focused / secure */
    }
  } else if (Desktop.permission === "default") {
    // Try once more in case the user hasn't seen the prompt yet.
    Desktop.requestPermission().catch(() => {});
  }
}

function onReady(id: string): void {
  const at = parseCursor(id);
  if (!at) return; // not a ready this client understands
  stream = at;
  everLive = true;
  liveState.value = "live";
  pendingNotifications = [];
  // Every snapshot taken from now on covers what earlier connections still
  // required; an old-epoch position could never be covered by a new-epoch
  // snapshot, so keeping it would request snapshots forever.
  required = null;
  if (snapshotInFlight) {
    // Requested before this (re)connection, possibly from a daemon that is
    // gone: supersede it rather than trust its cursor.
    required = at;
    void takeSnapshot();
  } else {
    requireSnapshot(at, true);
  }
}

function onFrame(kind: EventKind | "resync", id: string, data: string): void {
  const at = parseCursor(id);
  if (stream === null || at === null) return; // not subscribed yet, or not a sequenced frame
  let missed = false;
  if (at.epoch !== stream.epoch) {
    missed = true; // another publisher lifetime: nothing shown is comparable
  } else if (at.seq <= stream.seq) {
    return; // duplicate, stale or out of order
  } else if (at.seq > stream.seq + 1) {
    missed = true; // a missed sequence number means missed writes
  }
  stream = at;
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    requireSnapshot(at, true); // a malformed frame: trust a snapshot instead
    return;
  }
  if (missed || kind === "resync") requireSnapshot(at, true);
  if (kind === "notification.added" || kind === "notification.changed") {
    const frame: NotificationFrame = { kind, at, payload };
    if (snapshotInFlight) pendingNotifications.push(frame);
    else applyNotificationFrame(frame);
  } else if (SNAPSHOT_KINDS.has(kind)) {
    requireSnapshot(at, false);
  }
  if (kind === "task.blocked") alertBlocked(payload as BlockedTransition);
}

function onError(): void {
  // EventSource reconnects by itself and the next `ready` resnapshots as
  // needed, so positions from this connection stop mattering.
  stream = null;
  required = null;
  liveState.value = everLive ? "stale" : "connecting";
}

/** Forget everything observed on an earlier subscription; in-flight reads become obsolete. */
function resetLive(): void {
  clearCoalesce();
  stream = null;
  everLive = false;
  liveState.value = "connecting";
  applied = null;
  required = null;
  pendingNotifications = [];
  snapshotGen++;
  snapshotInFlight = false;
  notificationGen++;
  refetchToken++;
  refetchInFlight = false;
  refetchAgain = false;
}

/**
 * Follow the daemon's change stream through `source` (the page's
 * EventSource on /events; tests pass a plain EventTarget dispatching
 * MessageEvents). Snapshots start at the first `ready`. Returns a detach
 * function that removes every listener.
 */
export function connectLive(source: EventTarget, options: { coalesceMs?: number } = {}): () => void {
  resetLive();
  coalesceMs = options.coalesceMs ?? COALESCE_MS;
  const listeners: [string, EventListener][] = [
    ["ready", e => onReady((e as MessageEvent).lastEventId)],
    ["error", () => onError()],
  ];
  for (const kind of [...EVENT_KINDS, "resync" as const]) {
    listeners.push([
      kind,
      e => {
        const message = e as MessageEvent;
        onFrame(kind, message.lastEventId, String(message.data));
      },
    ]);
  }
  for (const [type, listener] of listeners) source.addEventListener(type, listener);
  return () => {
    for (const [type, listener] of listeners) source.removeEventListener(type, listener);
  };
}

/**
 * Take a workspace snapshot now, superseding any in flight. Resolves once it
 * is applied (with the active task's thread/Related follow-up), superseded
 * or failed (failures surface through the error toast).
 */
export function refresh(): Promise<void> {
  return takeSnapshot();
}

// Reactive: when activeTask changes id, lazily fetch its updates so the
// Activity panel is populated even if the task was created mid-session.
let lastActive: number | null = null;
effect(() => {
  const at = activeTask.value;
  if (!at) {
    if (lastActive == null) return;
    lastActive = null;
    // No current owner: invalidate all pending generations and clear every
    // part of the global Related view state synchronously.
    relatedGen++;
    relatedTasks.value = null;
    relatedLoading.value = null;
    relatedError.value = null;
    return;
  }
  if (at.id === lastActive) return;

  lastActive = at.id;
  const taskId = at.id;
  loadUpdates(taskId).catch(() => {
    /* swallow — listing is non-critical */
  });
  // Clear stale data so the Related tab shows a loading state instead
  // of the previous task's buckets while the fetch is in flight.
  relatedTasks.value = null;
  void fetchRelated(taskId);
});
