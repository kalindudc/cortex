// state/notifications — server-persisted feed + ephemeral local errors,
// merged for drawer rendering via a tagged-union computed signal.
//
// The previous in-memory ring (pushNotification + 50-entry cap) was
// replaced by a SQLite-backed feed so dashboard reloads no longer wipe
// history (see plan 126). This test file covers the new shape: signal
// initialization, the merged feed's newest-first ordering across both
// sources, unreadCount summation, and the id-sign routing for
// markRead/dismiss/markAllRead/clearAll.
//
// API calls fired by the mutators are best-effort (`.catch(() => {})`)
// so unhandled-rejection noise is suppressed even when /api/notifications
// is not reachable from happy-dom — that's the production contract too.

import { describe, test, expect, beforeEach } from "bun:test";
import {
  notifications,
  localErrors,
  merged,
  unreadCount,
  pushLocalError,
  markRead,
  markUnread,
  markAllRead,
  dismiss,
  clearAll,
  type LocalError,
} from "../../../src/ui/state/notifications.ts";
import type { Notification } from "../../../src/ui/api/types.ts";

const mkNotif = (id: number, created: number, status: Notification["status"] = "open"): Notification => ({
  id,
  task_id: id,
  author: "tester",
  status,
  title: `[${id}] task ${id}`,
  message: "created",
  read: false,
  created,
});

describe("state/notifications", () => {
  beforeEach(() => {
    notifications.value = [];
    localErrors.value = [];
  });

  test("initial signals are empty and unreadCount is 0", () => {
    expect(notifications.value).toEqual([]);
    expect(localErrors.value).toEqual([]);
    expect(merged.value).toEqual([]);
    expect(unreadCount.value).toBe(0);
  });

  test("merged feed orders unread+newest-first across persisted + ephemeral sources", () => {
    notifications.value = [mkNotif(1, 1000), mkNotif(2, 3000)];
    pushLocalError({ title: "Error", message: "boom" }); // ts = Date.now() (newest)
    const order = merged.value.map(r => (r.kind === "notif" ? `n${r.row.id}` : `e${r.row.id}`));
    // All three are unread (default), so the secondary newest-first key
    // alone determines order: newest local error first, then notif id=2
    // (created=3000), then notif id=1 (created=1000).
    expect(order[0].startsWith("e")).toBe(true);
    expect(order[1]).toBe("n2");
    expect(order[2]).toBe("n1");
  });

  test("merged feed pins unread above read regardless of created/ts", () => {
    // The READ row is the newest by timestamp; the UNREAD row is older.
    // The unread-first sort must pin the older unread row above it.
    notifications.value = [
      { ...mkNotif(1, 1000) }, // older + unread
      { ...mkNotif(2, 5000), read: true }, // newer but already read
    ];
    const order = merged.value.map(r => (r.kind === "notif" ? `n${r.row.id}` : `e${r.row.id}`));
    expect(order).toEqual(["n1", "n2"]);
  });

  test("merged feed orders within each read-state group by newest-first", () => {
    notifications.value = [
      { ...mkNotif(1, 1000) }, // unread, oldest
      { ...mkNotif(2, 4000) }, // unread, newer
      { ...mkNotif(3, 2000), read: true }, // read, older
      { ...mkNotif(4, 6000), read: true }, // read, newest of all
    ];
    const order = merged.value.map(r => (r.kind === "notif" ? r.row.id : -1));
    // Unread group first (newest-first inside): 2, 1; then read group (newest-first inside): 4, 3.
    expect(order).toEqual([2, 1, 4, 3]);
  });

  test("pushLocalError assigns negative id, read=false, prepends newest-first", () => {
    pushLocalError({ title: "Error", message: "first" });
    pushLocalError({ title: "Error", message: "second" });
    expect(localErrors.value.length).toBe(2);
    expect(localErrors.value[0].message).toBe("second");
    expect(localErrors.value[1].message).toBe("first");
    for (const e of localErrors.value) {
      expect(e.id).toBeLessThan(0);
      expect(e.read).toBe(false);
    }
    // Distinct ids.
    expect(localErrors.value[0].id).not.toBe(localErrors.value[1].id);
  });

  test("unreadCount sums unread across both sources", () => {
    notifications.value = [mkNotif(10, 100), { ...mkNotif(11, 200), read: true }];
    pushLocalError({ title: "Error", message: "x" });
    pushLocalError({ title: "Error", message: "y" });
    // 1 unread notif + 2 unread errors
    expect(unreadCount.value).toBe(3);
  });

  test("markRead with positive id flips only the persisted row's flag", () => {
    notifications.value = [mkNotif(1, 100), mkNotif(2, 200)];
    markRead(1);
    expect(notifications.value.find(n => n.id === 1)?.read).toBe(true);
    expect(notifications.value.find(n => n.id === 2)?.read).toBe(false);
  });

  test("markRead with negative id flips only the local error's flag", () => {
    pushLocalError({ title: "Error", message: "a" });
    pushLocalError({ title: "Error", message: "b" });
    const idA = localErrors.value[1].id; // older (the "a" entry)
    markRead(idA);
    expect((localErrors.value.find(e => e.id === idA) as LocalError).read).toBe(true);
    expect((localErrors.value.find(e => e.id !== idA) as LocalError).read).toBe(false);
  });

  test("markUnread with positive id flips a read persisted row back to unread", () => {
    notifications.value = [
      { ...mkNotif(1, 100), read: true },
      { ...mkNotif(2, 200), read: true },
    ];
    markUnread(1);
    expect(notifications.value.find(n => n.id === 1)?.read).toBe(false);
    expect(notifications.value.find(n => n.id === 2)?.read).toBe(true);
  });

  test("markUnread with negative id flips a read local error back to unread", () => {
    pushLocalError({ title: "Error", message: "a" });
    const id = localErrors.value[0].id;
    markRead(id);
    expect((localErrors.value.find(e => e.id === id) as LocalError).read).toBe(true);
    markUnread(id);
    expect((localErrors.value.find(e => e.id === id) as LocalError).read).toBe(false);
  });

  test("dismiss with positive id removes from notifications only", () => {
    notifications.value = [mkNotif(1, 100), mkNotif(2, 200)];
    pushLocalError({ title: "Error", message: "x" });
    dismiss(1);
    expect(notifications.value.some(n => n.id === 1)).toBe(false);
    expect(notifications.value.some(n => n.id === 2)).toBe(true);
    expect(localErrors.value.length).toBe(1);
  });

  test("dismiss with negative id removes from localErrors only", () => {
    notifications.value = [mkNotif(1, 100)];
    pushLocalError({ title: "Error", message: "x" });
    const errId = localErrors.value[0].id;
    dismiss(errId);
    expect(localErrors.value.length).toBe(0);
    expect(notifications.value.length).toBe(1);
  });

  test("markAllRead flips every unread row in both sources", () => {
    notifications.value = [mkNotif(1, 100), mkNotif(2, 200)];
    pushLocalError({ title: "Error", message: "x" });
    markAllRead();
    expect(unreadCount.value).toBe(0);
    expect(notifications.value.every(n => n.read)).toBe(true);
    expect(localErrors.value.every(e => e.read)).toBe(true);
  });

  test("clearAll empties both sources", () => {
    notifications.value = [mkNotif(1, 100)];
    pushLocalError({ title: "Error", message: "x" });
    clearAll();
    expect(notifications.value).toEqual([]);
    expect(localErrors.value).toEqual([]);
    expect(unreadCount.value).toBe(0);
  });
});
