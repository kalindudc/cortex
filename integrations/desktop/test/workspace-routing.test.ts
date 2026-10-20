import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type DesktopApp, launchDesktop, waitForDashboard, waitForText } from "./harness.ts";
import { waitForLive, waitForRow } from "./live.ts";

// Which task opens first: the address bar wins, then the task remembered
// from last time, then the highest-priority task. The order of the seed
// imports in dashboard.tsx decides it, and a wrong order opens another task
// without any error, so each rule is checked in the window.

let desktop: DesktopApp;
const titles = ["routing first", "routing second", "routing third"] as const;
let ids: number[] = [];

const LAST_TASK = "cortex-last-task";
const POLL = { timeout: 5_000, interval: 50 };

beforeAll(async () => {
  desktop = await launchDesktop();
  for (const title of titles) await desktop.cortex(["add", title, "--as", "agent-1"]);
  const listed = JSON.parse(await desktop.cortex(["ls", "--json"])) as { id: number; title: string }[];
  ids = titles.map(title => {
    const task = listed.find(t => t.title === title);
    if (!task) throw new Error(`cortex ls --json has no task "${title}"`);
    return task.id;
  });
  // The first task is the priority fallback, so a remembered task only wins if memory beats it.
  await desktop.cortex(["edit", String(ids[0]), "-p", "1"]);
  // The harness creates the database at launch, so boot runs again with the tasks present.
  await desktop.page.reload();
  await waitForDashboard(desktop.page);
  await waitForLive(desktop.page);
});

afterAll(async () => {
  await desktop?.close();
});

const storedTask = (): Promise<string | null> =>
  desktop.page.evaluate(key => localStorage.getItem(key), LAST_TASK);

async function rememberTask(id: number): Promise<void> {
  await desktop.page.evaluate(([key, value]) => localStorage.setItem(key, value), [LAST_TASK, String(id)] as const);
}

describe("workspace routing", () => {
  test("a reload keeps the selected task", async () => {
    const { page } = desktop;
    await waitForRow(page, titles[1]);
    await page.locator(".task-row", { hasText: titles[1] }).click();
    await expect.poll(() => page.url(), POLL).toBe(`cortex://app/task/${ids[1]}`);
    await page.reload();
    await waitForDashboard(page);
    expect(page.url()).toBe(`cortex://app/task/${ids[1]}`);
    await waitForText(page, ".task-title-text", titles[1]);
  });

  test("an address beats the remembered task", async () => {
    const { page } = desktop;
    await rememberTask(ids[0]);
    await page.goto(`cortex://app/task/${ids[2]}`);
    await waitForDashboard(page);
    await waitForText(page, ".task-title-text", titles[2]);
    expect(page.url()).toBe(`cortex://app/task/${ids[2]}`);
    await expect.poll(storedTask, POLL).toBe(String(ids[2]));
  });

  test("the remembered task beats the priority fallback", async () => {
    const { page } = desktop;
    await rememberTask(ids[1]);
    await page.goto("cortex://app/");
    await waitForDashboard(page);
    await expect.poll(() => page.url(), POLL).toBe(`cortex://app/task/${ids[1]}`);
    await waitForText(page, ".task-title-text", titles[1]);
  });

  test("the cortex:// handler serves the shell for routes and 404s for anything else", async () => {
    const probe = await desktop.page.evaluate(async () => {
      const missing = await fetch("/missing.js");
      const traversal = await fetch("/..%2f..%2fpackage.json");
      const route = await fetch("/task/99");
      return {
        missing: missing.status,
        traversal: traversal.status,
        route: route.status,
        routeType: route.headers.get("content-type") ?? "",
        permission: Notification.permission,
      };
    });
    expect(probe.missing).toBe(404);
    expect(probe.traversal).toBe(404);
    expect(probe.route).toBe(200);
    expect(probe.routeType).toMatch(/^text\/html/);
    expect(probe.permission).toBe("granted");
  });
});
