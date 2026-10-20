// InboxTab — the side panel's notification list: server rows and local
// errors, the row actions (open, dismiss, mark unread), the footer actions,
// and the All, Unread and Blocked filters. The panel is not a popover, so
// no row action and no outside click ever hides it.

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { fireEvent, render } from "@testing-library/preact";

// Row actions dispatch REAL api methods (state/notifications.ts: dismiss →
// api.delNotif, markUnread → api.markNotifUnread). Mock explicitly and
// assert the dispatch, so the coverage is real.
const delNotif = mock((_id: number) => Promise.resolve());
const markNotifUnread = mock((_id: number) => Promise.resolve());
const markNotifRead = mock((_id: number) => Promise.resolve());
const markAllNotifRead = mock(() => Promise.resolve());
const clearNotifs = mock(() => Promise.resolve());
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
    clearNotifs,
  },
}));

import { InboxTab } from "../../../../src/ui/components/context/InboxTab.tsx";
import { notifications, localErrors, pushLocalError } from "../../../../src/ui/state/notifications.ts";
import { closeAllPopovers } from "../../../../src/ui/state/popovers.ts";
import { contextOpen, contextShown } from "../../../../src/ui/state/context.ts";
import { selectedId } from "../../../../src/ui/state/signals.ts";
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

// Mirrors the document-level handler installed by src/ui/dashboard.tsx.
function outsideClickHandler(e: MouseEvent): void {
  const t = e.target as HTMLElement | null;
  if (!t?.closest?.("[data-pop]")) closeAllPopovers();
}

const titles = (root: ParentNode): Array<string | null> =>
  [...root.querySelectorAll(".notif-row .summary")].map(n => n.textContent);

function chip(root: ParentNode, label: RegExp): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>(".ctx-chip")].find(b => label.test(b.textContent ?? ""));
  if (!found) throw new Error(`no chip ${label}`);
  return found;
}

describe("InboxTab row actions", () => {
  beforeEach(() => {
    notifications.value = [];
    localErrors.value = [];
    contextOpen.value = true;
    selectedId.value = null;
    delNotif.mockClear();
    markNotifUnread.mockClear();
    markNotifRead.mockClear();
    markAllNotifRead.mockClear();
    clearNotifs.mockClear();
    document.addEventListener("click", outsideClickHandler);
  });

  afterEach(() => {
    document.removeEventListener("click", outsideClickHandler);
  });

  test("the per-row dismiss (X) button dismisses through the API and the panel stays shown", () => {
    notifications.value = [notif({ id: 1 }), notif({ id: 2, created: 2 })];
    const { container } = render(<InboxTab />);
    document.body.appendChild(container);
    const dismissBtn = container.querySelector(".notif-dismiss");
    if (!(dismissBtn instanceof HTMLButtonElement)) throw new Error("dismiss button not rendered");
    fireEvent.click(dismissBtn);
    // Newest-first: the first rendered row is id 2.
    expect(delNotif).toHaveBeenCalledTimes(1);
    expect(delNotif).toHaveBeenCalledWith(2);
    expect(contextShown()).toBe(true);
    document.body.removeChild(container);
  });

  test("the per-row 'mark as unread' button marks it unread and the panel stays shown", () => {
    notifications.value = [notif({ id: 1, read: true })];
    const { container } = render(<InboxTab />);
    document.body.appendChild(container);
    const unreadBtn = container.querySelector(".notif-mark-unread");
    if (!(unreadBtn instanceof HTMLButtonElement)) throw new Error("mark-unread button not rendered");
    fireEvent.click(unreadBtn);
    expect(markNotifUnread).toHaveBeenCalledTimes(1);
    expect(markNotifUnread).toHaveBeenCalledWith(1);
    expect(contextShown()).toBe(true);
    document.body.removeChild(container);
  });

  test("clicking a row opens its task and marks it read, closing nothing", () => {
    notifications.value = [notif({ id: 7, task_id: 42 })];
    const { container } = render(<InboxTab />);
    document.body.appendChild(container);
    fireEvent.click(container.querySelector(".notif-row-body") as HTMLButtonElement);
    expect(selectedId.value).toBe(42);
    expect(markNotifRead).toHaveBeenCalledWith(7);
    expect(notifications.value[0]?.read).toBe(true);
    expect(contextShown()).toBe(true);
    document.body.removeChild(container);
  });

  test("the footer marks every row read and clears all", () => {
    notifications.value = [notif({ id: 1 }), notif({ id: 2, created: 2 })];
    const { getByRole } = render(<InboxTab />);
    fireEvent.click(getByRole("button", { name: "Mark all read" }));
    expect(markAllNotifRead).toHaveBeenCalledTimes(1);
    expect(notifications.value.every(n => n.read)).toBe(true);
    fireEvent.click(getByRole("button", { name: "Clear all" }));
    expect(clearNotifs).toHaveBeenCalledTimes(1);
    expect(notifications.value).toEqual([]);
  });
});

describe("InboxTab sources", () => {
  const OriginalNotification = globalThis.Notification;
  const constructed = mock(() => {});

  beforeEach(() => {
    notifications.value = [];
    localErrors.value = [];
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
    const { container } = render(<InboxTab />);
    expect(titles(container)).toEqual(["local error", "server row"]);

    const dismiss = container.querySelectorAll(".notif-dismiss");
    fireEvent.click(dismiss[1]);
    expect(delNotif).toHaveBeenCalledTimes(1);
    expect(delNotif).toHaveBeenCalledWith(5);
    expect(notifications.value).toEqual([]);

    fireEvent.click(container.querySelector(".notif-dismiss") as HTMLButtonElement);
    expect(delNotif).toHaveBeenCalledTimes(1);
    expect(localErrors.value).toEqual([]);
  });

  test("the inbox raises no desktop Notification", () => {
    notifications.value = [notif({ id: 6 })];
    pushLocalError({ title: "boom", message: "x" });
    const { container } = render(<InboxTab />);
    fireEvent.click(container.querySelector(".notif-row-body") as HTMLButtonElement);
    expect(constructed).not.toHaveBeenCalled();
  });

  test("an empty inbox says so and offers no footer", () => {
    const { container } = render(<InboxTab />);
    expect(container.textContent).toContain("No notifications.");
    expect(container.querySelector(".notif-foot")).toBeNull();
  });
});

describe("InboxTab filters", () => {
  beforeEach(() => {
    notifications.value = [
      notif({ id: 1, title: "blocked row", status: "blocked", created: 30 }),
      notif({ id: 2, title: "review row", status: "review", created: 20 }),
      notif({ id: 3, title: "read row", status: "done", created: 10, read: true }),
    ];
    localErrors.value = [];
  });

  test("All is pressed by default and lists every row", () => {
    const { container } = render(<InboxTab />);
    expect(chip(container, /^All$/).getAttribute("aria-pressed")).toBe("true");
    expect(titles(container)).toEqual(["blocked row", "review row", "read row"]);
  });

  test("Unread shows the unread count and only unread rows", () => {
    const { container } = render(<InboxTab />);
    const unread = chip(container, /^Unread/);
    expect(unread.textContent).toBe("Unread 2");
    fireEvent.click(unread);
    expect(unread.getAttribute("aria-pressed")).toBe("true");
    expect(chip(container, /^All$/).getAttribute("aria-pressed")).toBe("false");
    expect(titles(container)).toEqual(["blocked row", "review row"]);
  });

  test("Blocked shows blocked rows and local errors, and its empty state when there are none", async () => {
    pushLocalError({ title: "local error", message: "offline" });
    const { container } = render(<InboxTab />);
    fireEvent.click(chip(container, /^Blocked$/));
    expect(titles(container)).toEqual(["local error", "blocked row"]);

    notifications.value = notifications.value.filter(n => n.status !== "blocked");
    localErrors.value = [];
    await new Promise(r => setTimeout(r, 0));
    expect(container.textContent).toContain("No blocked notifications.");
    // The footer still acts on the whole inbox.
    expect(container.querySelector(".notif-foot")).not.toBeNull();
  });
});
