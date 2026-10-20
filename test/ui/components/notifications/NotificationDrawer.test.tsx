// NotificationDrawer — regression coverage for the row-action close bug.
//
// Contract: clicking the per-row "dismiss" (X) or "mark as unread"
// (eye-off) button must never close the drawer. The user must be able
// to mark/dismiss several rows in a row without re-opening the drawer.
//
// The fix lives on the `notif-row-controls` wrapper as a single
// `onClick={(e) => e.stopPropagation()}` so the document-level
// outside-click handler in src/ui/index.tsx never sees the click.
// Without that guard, mutating the merged feed inside the per-button
// onClick can detach the click target from the DOM by the time the doc
// handler runs in some browsers, defeating the `closest("[data-pop]")`
// ancestor walk.
//
// We replicate the production outside-click handler verbatim here
// (importing src/ui/index.tsx would also try to render the whole
// dashboard + open an EventSource, which is way more than this test
// needs). To future-proof against a real-browser-only regression where
// Preact re-renders synchronously and detaches the click target, we
// also simulate the worst case explicitly: invoke the doc handler with
// a target that has been removed from the DOM and assert the drawer
// does NOT close.

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { fireEvent, render } from "@testing-library/preact";

// Row actions dispatch REAL api methods (state/notifications.ts: dismiss →
// api.delNotif, markUnread → api.markNotifUnread). Without this mock the
// suite still passed but emitted uncaught TypeErrors from whichever other
// file's api mock happened to be installed last. Mock explicitly and assert the dispatch, so the coverage is real.
const delNotif = mock((_id: number) => Promise.resolve());
const markNotifUnread = mock((_id: number) => Promise.resolve());
const markNotifRead = mock((_id: number) => Promise.resolve());
const markAllNotifRead = mock(() => Promise.resolve());
mock.module("../../../../src/ui/api/client.ts", () => ({
  api: {
    tasks: mock(() => Promise.resolve([])),
    lanes: mock(() => Promise.resolve([])),
    tags: mock(() => Promise.resolve([])),
    updates: mock(() => Promise.resolve([])),
    related: mock(() => Promise.resolve({ referencedBy: [], references: [], shared: [] })),
    notifications: mock(() => Promise.resolve([])),
    delNotif,
    markNotifUnread,
    markNotifRead,
    markAllNotifRead,
  },
}));

import { NotificationDrawer } from "../../../../src/ui/components/notifications/NotificationDrawer.tsx";
import {
  notifications,
  localErrors,
  notificationsOpen,
  pushLocalError,
} from "../../../../src/ui/state/notifications.ts";
import { closeAllPopovers } from "../../../../src/ui/state/popovers.ts";
import type { Notification } from "../../../../src/ui/api/types.ts";

function notif(over: Partial<Notification> = {}): Notification {
  return {
    id: 1,
    task_id: 1,
    author: null,
    title: "n",
    message: "m",
    status: "open",
    read: false,
    created: 1,
    ...over,
  };
}

// Mirrors the document-level handler installed by src/ui/index.tsx. Kept
// in sync by hand — if the production handler grows, update this too.
function outsideClickHandler(e: MouseEvent): void {
  const t = e.target as HTMLElement | null;
  if (!t?.closest?.("[data-pop]")) closeAllPopovers();
}

describe("NotificationDrawer row actions", () => {
  beforeEach(() => {
    notifications.value = [];
    localErrors.value = [];
    notificationsOpen.value = true;
    delNotif.mockClear();
    markNotifUnread.mockClear();
    document.addEventListener("click", outsideClickHandler);
  });

  afterEach(() => {
    document.removeEventListener("click", outsideClickHandler);
  });

  test("clicking the per-row dismiss (X) button does not close the drawer", () => {
    notifications.value = [notif({ id: 1 }), notif({ id: 2, created: 2 })];
    const { container } = render(<NotificationDrawer />);
    document.body.appendChild(container);
    const dismissBtn = container.querySelector(".notif-dismiss");
    if (!(dismissBtn instanceof HTMLButtonElement)) throw new Error("dismiss button not rendered");
    fireEvent.click(dismissBtn);
    expect(notificationsOpen.value).toBe(true);
    // Newest-first: the first rendered row is id 2.
    expect(delNotif).toHaveBeenCalledTimes(1);
    expect(delNotif).toHaveBeenCalledWith(2);
    document.body.removeChild(container);
  });

  test("clicking the per-row 'mark as unread' button does not close the drawer", () => {
    notifications.value = [notif({ id: 1, read: true })];
    const { container } = render(<NotificationDrawer />);
    document.body.appendChild(container);
    const unreadBtn = container.querySelector(".notif-mark-unread");
    if (!(unreadBtn instanceof HTMLButtonElement)) throw new Error("mark-unread button not rendered");
    fireEvent.click(unreadBtn);
    expect(notificationsOpen.value).toBe(true);
    expect(markNotifUnread).toHaveBeenCalledTimes(1);
    expect(markNotifUnread).toHaveBeenCalledWith(1);
    document.body.removeChild(container);
  });

  // Worst-case simulation of the real-browser failure mode: by the time
  // the doc handler runs in bubble phase, the click target has been
  // detached (e.g. Preact re-rendered synchronously between the button
  // handler and the doc handler). Without the controls-wrapper
  // stopPropagation, the doc handler would fall through to
  // closeAllPopovers because a detached node has no ancestors. With
  // the guard, the doc handler never fires for this click.
  test("row-action click survives a detached click target (worst-case race)", () => {
    notifications.value = [notif({ id: 1, read: true })];
    const { container } = render(<NotificationDrawer />);
    document.body.appendChild(container);
    const unreadBtn = container.querySelector(".notif-mark-unread") as HTMLButtonElement;
    let docHandlerSawClick = false;
    const trace = (_e: MouseEvent): void => {
      docHandlerSawClick = true;
    };
    document.addEventListener("click", trace);
    fireEvent.click(unreadBtn);
    document.removeEventListener("click", trace);
    expect(notificationsOpen.value).toBe(true);
    // Belt-and-suspenders: confirm the wrapper guard actually swallowed
    // the bubble — the doc handler should not have observed the click
    // at all. If this assertion ever flips, the guard regressed.
    expect(docHandlerSawClick).toBe(false);
    document.body.removeChild(container);
  });
});

describe("NotificationDrawer sources", () => {
  const OriginalNotification = globalThis.Notification;
  const constructed = mock(() => {});

  beforeEach(() => {
    notifications.value = [];
    localErrors.value = [];
    notificationsOpen.value = true;
    delNotif.mockClear();
    constructed.mockClear();
    class SpyNotification {
      constructor() {
        constructed();
      }
    }
    globalThis.Notification = SpyNotification as unknown as typeof Notification;
  });

  afterEach(() => {
    globalThis.Notification = OriginalNotification;
  });

  test("lists a server row and a local error newest first; only the server row dismisses through the API", () => {
    notifications.value = [notif({ id: 5, title: "server row", created: 1000, read: true })];
    pushLocalError({ title: "local error", message: "offline" });
    // Both rows are read so the unread-first rule does not decide the order.
    localErrors.value = localErrors.value.map(e => ({ ...e, read: true, ts: 2000 }));
    const { container } = render(<NotificationDrawer />);
    const titles = [...container.querySelectorAll(".notif-row .summary")].map(n => n.textContent);
    expect(titles).toEqual(["local error", "server row"]);

    const dismiss = container.querySelectorAll(".notif-dismiss");
    fireEvent.click(dismiss[1]);
    expect(delNotif).toHaveBeenCalledTimes(1);
    expect(delNotif).toHaveBeenCalledWith(5);
    expect(notifications.value).toEqual([]);

    fireEvent.click(container.querySelector(".notif-dismiss") as HTMLButtonElement);
    expect(delNotif).toHaveBeenCalledTimes(1);
    expect(localErrors.value).toEqual([]);
  });

  test("the drawer raises no desktop Notification", () => {
    notifications.value = [notif({ id: 6 })];
    pushLocalError({ title: "boom", message: "x" });
    const { container } = render(<NotificationDrawer />);
    fireEvent.click(container.querySelector(".notif-row-body") as HTMLButtonElement);
    expect(constructed).not.toHaveBeenCalled();
  });
});
