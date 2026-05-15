// Notifications drawer state — a capped in-memory ring of alerts the user
// might want to revisit. Drives the bell-trigger badge in StatusBar plus
// the right-anchored slide-in NotificationDrawer.
//
// Sources that push entries:
//   - SSE task.added            → kind "added"
//   - SSE task.updated (status transition) → "status" or "blocked"
//   - api/errors.showError      → "error"
//
// Persistence is intentionally NONE — the OS notification (`Notification`)
// remains the durable surface for `blocked` transitions; this drawer is
// session-scoped scratch space.
//
// Ring cap is 50; oldest entries fall off when capacity is exceeded so we
// never grow unbounded across a long-lived dashboard session.

import { computed, signal, type ReadonlySignal, type Signal } from "@preact/signals";

export type NotificationKind = "status" | "added" | "blocked" | "error";

export interface Notification {
  id: number; // monotonically increasing local id
  kind: NotificationKind;
  taskId?: number;
  title: string; // short heading line
  message: string; // body line (e.g. "moved to review", error text)
  ts: number; // Date.now()
  read: boolean;
}

const MAX = 50;

let nextId = 1;

export const notifications: Signal<Notification[]> = signal<Notification[]>([]);
export const notificationsOpen: Signal<boolean> = signal<boolean>(false);

export const unreadCount: ReadonlySignal<number> = computed(() =>
  notifications.value.reduce((n, x) => n + (x.read ? 0 : 1), 0),
);

export function pushNotification(n: Omit<Notification, "id" | "ts" | "read">): void {
  const entry: Notification = { id: nextId++, ts: Date.now(), read: false, ...n };
  // Newest-first ordering matches the drawer render. Cap by dropping the
  // tail — oldest in time = lowest priority to retain.
  const next = [entry, ...notifications.value];
  notifications.value = next.length > MAX ? next.slice(0, MAX) : next;
}

export function markRead(id: number): void {
  notifications.value = notifications.value.map(n => (n.id === id ? { ...n, read: true } : n));
}

export function markAllRead(): void {
  notifications.value = notifications.value.map(n => (n.read ? n : { ...n, read: true }));
}

export function dismiss(id: number): void {
  notifications.value = notifications.value.filter(n => n.id !== id);
}

export function clearAll(): void {
  notifications.value = [];
}
