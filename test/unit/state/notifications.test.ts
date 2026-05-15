// state/notifications — capped in-memory ring for dashboard alerts.
// Verifies pushNotification's id+ts assignment, newest-first ordering,
// 50-entry cap, and the unreadCount / markRead / markAllRead / dismiss /
// clearAll mutators.

import { describe, test, expect, beforeEach } from "bun:test";
import {
  notifications,
  unreadCount,
  pushNotification,
  markRead,
  markAllRead,
  dismiss,
  clearAll,
} from "../../../src/ui/state/notifications.ts";

describe("state/notifications", () => {
  beforeEach(() => {
    notifications.value = [];
  });

  test("pushNotification appends with auto id+ts+read=false, newest first", () => {
    const before = Date.now();
    pushNotification({ kind: "added", title: "first", message: "m1" });
    pushNotification({ kind: "status", title: "second", message: "m2" });
    const after = Date.now();

    expect(notifications.value.length).toBe(2);
    // Newest-first: the second-pushed sits at index 0.
    expect(notifications.value[0].title).toBe("second");
    expect(notifications.value[1].title).toBe("first");
    for (const n of notifications.value) {
      expect(typeof n.id).toBe("number");
      expect(n.read).toBe(false);
      expect(n.ts).toBeGreaterThanOrEqual(before);
      expect(n.ts).toBeLessThanOrEqual(after);
    }
    // Auto ids are distinct.
    expect(notifications.value[0].id).not.toBe(notifications.value[1].id);
  });

  test("pushNotification caps the ring at 50 (drops oldest)", () => {
    for (let i = 0; i < 51; i++) {
      pushNotification({ kind: "added", title: `t${i}`, message: `m${i}` });
    }
    expect(notifications.value.length).toBe(50);
    // The first-pushed (title "t0") should have been dropped from the tail.
    expect(notifications.value.some(n => n.title === "t0")).toBe(false);
    // Newest sits at index 0.
    expect(notifications.value[0].title).toBe("t50");
    // Oldest retained is the second-pushed ("t1") at the tail.
    expect(notifications.value[49].title).toBe("t1");
  });

  test("unreadCount tracks unread entries", () => {
    pushNotification({ kind: "added", title: "a", message: "" });
    pushNotification({ kind: "added", title: "b", message: "" });
    pushNotification({ kind: "added", title: "c", message: "" });
    expect(unreadCount.value).toBe(3);
    const firstId = notifications.value[0].id;
    markRead(firstId);
    expect(unreadCount.value).toBe(2);
    markAllRead();
    expect(unreadCount.value).toBe(0);
  });

  test("markRead flips only the matching id", () => {
    pushNotification({ kind: "added", title: "a", message: "" });
    pushNotification({ kind: "added", title: "b", message: "" });
    const targetId = notifications.value[0].id;
    markRead(targetId);
    const target = notifications.value.find(n => n.id === targetId);
    const other = notifications.value.find(n => n.id !== targetId);
    expect(target?.read).toBe(true);
    expect(other?.read).toBe(false);
  });

  test("dismiss removes the entry", () => {
    pushNotification({ kind: "added", title: "a", message: "" });
    pushNotification({ kind: "added", title: "b", message: "" });
    const idToDrop = notifications.value[0].id;
    dismiss(idToDrop);
    expect(notifications.value.length).toBe(1);
    expect(notifications.value.some(n => n.id === idToDrop)).toBe(false);
  });

  test("clearAll empties the ring", () => {
    pushNotification({ kind: "added", title: "a", message: "" });
    pushNotification({ kind: "error", title: "b", message: "oops" });
    expect(notifications.value.length).toBe(2);
    clearAll();
    expect(notifications.value.length).toBe(0);
    expect(unreadCount.value).toBe(0);
  });
});
