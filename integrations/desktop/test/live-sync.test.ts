import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type DesktopApp, launchDesktop, waitForDashboard } from "./harness.ts";
import { alerts, connectionState, recordAlerts, rowCount, waitForLive, waitForRow } from "./live.ts";

let desktop: DesktopApp;

beforeAll(async () => {
  desktop = await launchDesktop();
  await waitForDashboard(desktop.page);
});

afterAll(async () => {
  await desktop?.close();
});

const POLL = { timeout: 5_000, interval: 50 };

async function add(title: string): Promise<number> {
  const task = JSON.parse(await desktop.cortex(["add", title, "--as", "agent-1", "--json"])) as { id: number };
  return task.id;
}

/** Add a task and wait for its row: every frame published before it has been handled by then. */
async function settle(title: string): Promise<void> {
  await add(title);
  await waitForRow(desktop.page, title);
}

describe("live sync in a real window", () => {
  test("a task added from a shell appears in the list within one second", async () => {
    const { page } = desktop;
    await waitForLive(page);
    await desktop.cortex(["add", "live probe", "--as", "agent-1"]);
    await waitForRow(page, "live probe", 1_000);
    expect(await rowCount(page, "live probe")).toBe(1);
  });

  test("a move into blocked raises exactly one alert; edits and reloads raise none", async () => {
    const { page } = desktop;
    const title = "alert probe";
    const id = String(await add(title));
    await recordAlerts(page);
    await waitForLive(page);
    await waitForRow(page, title);

    await desktop.cortex(["update", id, "-s", "blocked", "-m", "stuck", "--as", "agent-1"]);
    const expected = { title: "cortex: task blocked", body: title, tag: `task-${id}` };
    await expect.poll(() => alerts(page), POLL).toEqual([expected]);

    await desktop.cortex(["edit", id, "-p", "2"]);
    await settle("after edit");
    expect(await alerts(page)).toEqual([expected]);

    await page.reload();
    await waitForLive(page);
    await waitForRow(page, title);
    await settle("after reload");
    expect(await alerts(page)).toEqual([]);

    await desktop.cortex(["update", id, "-s", "open", "-m", "unstuck", "--as", "agent-1"]);
    await desktop.cortex(["update", id, "-s", "blocked", "-m", "stuck again", "--as", "agent-1"]);
    await expect.poll(() => alerts(page), POLL).toEqual([expected]);
    await settle("after second block");
    expect(await alerts(page)).toEqual([expected]);
  });

  test("a daemon restart goes stale, then catches up with what was written while it was down", async () => {
    const { page } = desktop;
    await waitForLive(page);
    await desktop.cortex(["stop"]);
    await expect.poll(() => connectionState(page), POLL).toBe("stale");
    await desktop.cortex(["add", "while down", "--as", "agent-1"]);
    await desktop.cortex(["serve"]);
    await expect.poll(() => connectionState(page), { timeout: 15_000, interval: 50 }).toBe("live");
    // No event was published for it, so only the new epoch's snapshot can show it.
    await waitForRow(page, "while down");
    await desktop.cortex(["add", "after restart", "--as", "agent-1"]);
    await waitForRow(page, "after restart");
  });
});
