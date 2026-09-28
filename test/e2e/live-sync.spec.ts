// Live synchronization in real Chromium (plan @400 N12). index.tsx hands the
// page's EventSource to state/refresh.ts connectLive, which snapshots after
// every `ready` and follows the stream past the snapshot cursor. This spec
// certifies that wiring end to end: pages converge on notification
// acknowledgement changes made anywhere (notification.changed), and the
// desktop alert fires ONLY on the explicit task.blocked transition event,
// never on edits of an already-blocked task or on a fresh snapshot.
// window.Notification is replaced by a recorder before any page script
// runs; the daemon/database are isolated by the shared fixture.
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures/cortex-server.ts";

const AGENT = "agent-1a2b3c4d";

async function call(url: string, method: string, path: string, body?: object): Promise<unknown> {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function seedTask(url: string, title: string): Promise<number> {
  const task = (await call(url, "POST", "/api/tasks", { title, body: "Initial body." })) as { id: number };
  return task.id;
}

type Alert = { title: string; body?: string; tag?: string };

/** Replace window.Notification (permission granted) with a recorder before the app boots. */
async function recordAlerts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const shown: { title: string; body?: string; tag?: string }[] = [];
    class RecordingNotification {
      static permission = "granted";
      static requestPermission(): Promise<string> {
        return Promise.resolve("granted");
      }
      constructor(title: string, options: NotificationOptions = {}) {
        shown.push({ title, body: options.body, tag: options.tag });
      }
    }
    Object.defineProperty(window, "Notification", { value: RecordingNotification, configurable: true, writable: true });
    (window as unknown as { __cortexAlerts: typeof shown }).__cortexAlerts = shown;
  });
}

const alerts = (page: Page): Promise<Alert[]> =>
  page.evaluate(
    () => (window as unknown as { __cortexAlerts: { title: string; body?: string; tag?: string }[] }).__cortexAlerts,
  );

test("the desktop alert fires once per transition into blocked, never for edits of a blocked task", async ({
  url,
  page,
}) => {
  const id = await seedTask(url, "Live alerts");
  await recordAlerts(page);
  await page.goto(`${url}/task/${id}`);
  // The first snapshot is taken after the stream's `ready`, so the stream is live now.
  await expect(page.locator(".task-title-text")).toHaveText("Live alerts");

  await call(url, "PATCH", `/api/tasks/${id}/status`, { status: "blocked", author: AGENT });
  await expect(page.locator(".status-bar .status-counts")).toContainText("1 blocked");
  const expected: Alert = { title: "cortex: task blocked", body: "Live alerts", tag: `task-${id}` };
  await expect.poll(() => alerts(page)).toEqual([expected]);

  // Edits of the blocked task publish task.updated frames whose task is blocked.
  await call(url, "PATCH", `/api/tasks/${id}`, { body: "Edited while blocked." });
  await call(url, "PATCH", `/api/tasks/${id}`, { priority: 2 });
  await expect(page.locator(".doc-reader")).toContainText("Edited while blocked.");
  await expect(page.locator(".task-header .priority-chip")).toContainText("P2");
  expect(await alerts(page)).toEqual([expected]);

  // A fresh page snapshots a task that is already blocked: no alert.
  await page.reload();
  await expect(page.locator(".task-title-text")).toHaveText("Live alerts");
  await expect(page.locator(".doc-reader")).toContainText("Edited while blocked.");
  expect(await alerts(page)).toEqual([]);

  // blocked -> open -> blocked is one more transition: exactly one alert.
  await call(url, "PATCH", `/api/tasks/${id}/status`, { status: "open", author: AGENT });
  await expect(page.locator(".status-bar .status-counts")).not.toContainText("blocked");
  await call(url, "PATCH", `/api/tasks/${id}/status`, { status: "blocked", author: AGENT });
  await expect(page.locator(".status-bar .status-counts")).toContainText("1 blocked");
  await expect.poll(() => alerts(page)).toEqual([expected]);
});

test("notification acknowledgement changes converge across pages without a reload", async ({ url, page }) => {
  await seedTask(url, "Converging notifications"); // persists one unread `created` notification
  const other = await page.context().newPage();
  await page.goto(url);
  await other.goto(url);
  for (const p of [page, other]) await expect(p.locator(".notif-bell .notif-badge")).toHaveText("1");

  // Read elsewhere (another client, e.g. the CLI or a terminal session).
  const [row] = (await call(url, "GET", "/api/notifications")) as { id: number }[];
  await call(url, "PATCH", `/api/notifications/${row.id}/read`);
  for (const p of [page, other]) await expect(p.locator(".notif-bell .notif-badge")).toHaveCount(0);

  await call(url, "PATCH", `/api/notifications/${row.id}/unread`);
  for (const p of [page, other]) await expect(p.locator(".notif-bell .notif-badge")).toHaveText("1");

  // Read from one page's drawer: the other page follows.
  await page.getByRole("button", { name: "Notifications", exact: true }).click();
  await page.locator(".notif-foot").getByRole("button", { name: "Mark all read" }).click();
  for (const p of [page, other]) await expect(p.locator(".notif-bell .notif-badge")).toHaveCount(0);

  // A dismissal elsewhere removes the row from the open drawer too.
  await expect(page.locator(".notif-drawer .notif-row")).toHaveCount(1);
  await call(url, "DELETE", `/api/notifications/${row.id}`);
  await expect(page.locator(".notif-drawer .empty-title")).toHaveText("No notifications.");
  await other.close();
});
