// Real-window helpers for the dashboard's live state: the status bar's
// connection indicator and a recorder standing in for desktop alerts.

import type { Page } from "playwright-core";

export type Alert = { title: string; body?: string; tag?: string };

/** The status bar indicator's `data-state` (connecting, live or stale), or null before it renders. */
export function connectionState(page: Page): Promise<string | null> {
  return page.evaluate(() => document.querySelector(".status-bar .conn")?.getAttribute("data-state") ?? null);
}

/** Wait until the indicator reads live: the dashboard is following the daemon. */
export async function waitForLive(page: Page, timeout = 10_000): Promise<void> {
  await page.waitForSelector('.status-bar .conn[data-state="live"]', { state: "attached", timeout });
}

/**
 * Replace window.Notification (permission granted) with a recorder before any
 * page script runs, then reload so the dashboard boots with it; the first
 * load happened before a test could install anything.
 */
export async function recordAlerts(page: Page): Promise<void> {
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
  await page.reload();
}

/** Every alert the recorder has seen on the current page load. */
export function alerts(page: Page): Promise<Alert[]> {
  return page.evaluate(() => (window as unknown as { __cortexAlerts?: Alert[] }).__cortexAlerts ?? []);
}

/** Wait until a `.task-row` in the task list shows `title`. */
export async function waitForRow(page: Page, title: string, timeout = 5_000): Promise<void> {
  // Poll on a timer: the default polls on animation frames, which a never-shown test window gets about once a second
  // on Linux, so a row that renders in 50 ms would only be seen a second later.
  await page.waitForFunction(
    expected => Array.from(document.querySelectorAll(".task-row")).some(row => row.textContent?.includes(expected)),
    title,
    { timeout, polling: 50 },
  );
}

/** How many `.task-row`s show `title`. */
export function rowCount(page: Page, title: string): Promise<number> {
  return page.evaluate(
    expected => Array.from(document.querySelectorAll(".task-row")).filter(row => row.textContent?.includes(expected)).length,
    title,
  );
}
