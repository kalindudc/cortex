// Notifications drawer state — server-persisted feed + ephemeral local
// errors. Drives the bell-trigger badge in StatusBar plus the right-anchored
// slide-in NotificationDrawer.
//
// Two parallel sources, merged for rendering:
//
//   1. notifications (server-driven, persisted) — populated by refresh()
//      from the GET /api/workspace snapshot and kept live by connectLive
//      in src/ui/state/refresh.ts (a "notification.added" frame prepends
//      its row; "notification.changed" refetches GET /api/notifications,
//      so read/unread/dismiss state converges across tabs and the TUI).
//      These survive a dashboard reload because the server writes a row on
//      every task.added and on every PATCH /api/tasks/:id/status that
//      actually changes the status. Each row carries a `status` (TaskStatus) that
//      drives the dot color via `dot-status-${status}` — the same CSS
//      class family task rows use, so no bespoke notification colors are
//      needed.
//
//   2. localErrors (ephemeral, in-memory) — populated by api/errors.ts
//      via pushLocalError(). These exist because they fire when the
//      server is unreachable; persisting them would be impossible (no
//      server to write to) and surfacing stale errors after a reload
//      would be misleading.
//
// The drawer renders both via a tagged-union `merged` computed signal
// sorted newest-first. Persisted rows have positive ids (DB
// AUTOINCREMENT); ephemeral rows have negative ids (counter starting at
// -1). The id sign is the discriminator for read/dismiss routing — no
// extra field needed.

import { computed, signal, type ReadonlySignal, type Signal } from "@preact/signals";

import type { Notification } from "../api/types.ts";
import { api } from "../api/client.ts";

/** Ephemeral error toast — shape distinct from `Notification` because
 *  these are not status events. They never round-trip to the server. */
export interface LocalError {
  id: number; // negative; counter starts at -1
  title: string;
  message: string;
  ts: number;
  read: boolean;
}

/** Tagged union for the merged feed the drawer renders. */
export type MergedRow = { kind: "notif"; row: Notification } | { kind: "error"; row: LocalError };

export const notifications: Signal<Notification[]> = signal<Notification[]>([]);
export const localErrors: Signal<LocalError[]> = signal<LocalError[]>([]);
export const notificationsOpen: Signal<boolean> = signal<boolean>(false);

// Negative id counter for ephemeral local errors. KISS: id sign is the
// persisted-vs-ephemeral discriminator. Server ids are positive
// AUTOINCREMENT integers, so the spaces never collide.
let nextLocalId = -1;

/** Merged feed of persisted notifications and ephemeral local errors,
 *  sorted UNREAD-FIRST and then newest-first within each read-state
 *  group. The unread-first ordering keeps fresh attention-worthy items
 *  pinned to the top of the drawer even after a user marks them read,
 *  so historical context drops below the fold rather than mixing in
 *  with what still needs eyes. Both `created` (notif) and `ts` (error)
 *  are Date.now() millisecond values. */
export const merged: ReadonlySignal<MergedRow[]> = computed(() => {
  const notifs: MergedRow[] = notifications.value.map(row => ({ kind: "notif", row }));
  const errs: MergedRow[] = localErrors.value.map(row => ({ kind: "error", row }));
  const all = [...notifs, ...errs];
  all.sort((a, b) => {
    // Primary: unread (read=false) sorts before read (read=true). Both
    // row shapes carry a boolean `read` field, so the discriminator
    // doesn't matter here.
    const ra = a.row.read ? 1 : 0;
    const rb = b.row.read ? 1 : 0;
    if (ra !== rb) return ra - rb;
    // Secondary: newest-first by created/ts inside each group.
    const ta = a.kind === "notif" ? a.row.created : a.row.ts;
    const tb = b.kind === "notif" ? b.row.created : b.row.ts;
    return tb - ta;
  });
  return all;
});

/** Combined unread count across persisted + ephemeral. Drives the badge. */
export const unreadCount: ReadonlySignal<number> = computed(() => {
  const n = notifications.value.reduce((acc, x) => acc + (x.read ? 0 : 1), 0);
  const e = localErrors.value.reduce((acc, x) => acc + (x.read ? 0 : 1), 0);
  return n + e;
});

/** Push an ephemeral error toast. Used by api/errors.ts when a fetch
 *  rejects — the server is the wrong place to persist these (it might
 *  not even be reachable). */
export function pushLocalError(input: { title: string; message: string }): void {
  const entry: LocalError = {
    id: nextLocalId--,
    title: input.title,
    message: input.message,
    ts: Date.now(),
    read: false,
  };
  localErrors.value = [entry, ...localErrors.value];
}

/** Mark one entry read. Routes by id sign. Persisted reads fire-and-forget
 *  to the server; the local signal mutates immediately so the UI is
 *  responsive without waiting for the round-trip. */
export function markRead(id: number): void {
  if (id > 0) {
    notifications.value = notifications.value.map(n => (n.id === id && !n.read ? { ...n, read: true } : n));
    void api.markNotifRead(id).catch(() => {
      /* swallow — next refresh() will reconcile */
    });
  } else {
    localErrors.value = localErrors.value.map(e => (e.id === id && !e.read ? { ...e, read: true } : e));
  }
}

/** Flip a read entry back to unread. Mirror of markRead — routes by id
 *  sign, optimistic local mutation, fire-and-forget API call. The
 *  unread-first sort in `merged` will re-pin the row to the top of the
 *  drawer on the next render. */
export function markUnread(id: number): void {
  if (id > 0) {
    notifications.value = notifications.value.map(n => (n.id === id && n.read ? { ...n, read: false } : n));
    void api.markNotifUnread(id).catch(() => {
      /* swallow — next refresh() will reconcile */
    });
  } else {
    localErrors.value = localErrors.value.map(e => (e.id === id && e.read ? { ...e, read: false } : e));
  }
}

/** Mark every entry read across both sources. */
export function markAllRead(): void {
  notifications.value = notifications.value.map(n => (n.read ? n : { ...n, read: true }));
  localErrors.value = localErrors.value.map(e => (e.read ? e : { ...e, read: true }));
  void api.markAllNotifRead().catch(() => {
    /* swallow */
  });
}

/** Dismiss one entry. Routes by id sign. */
export function dismiss(id: number): void {
  if (id > 0) {
    notifications.value = notifications.value.filter(n => n.id !== id);
    void api.delNotif(id).catch(() => {
      /* swallow */
    });
  } else {
    localErrors.value = localErrors.value.filter(e => e.id !== id);
  }
}

/** Clear everything in both sources. */
export function clearAll(): void {
  notifications.value = [];
  localErrors.value = [];
  void api.clearNotifs().catch(() => {
    /* swallow */
  });
}
