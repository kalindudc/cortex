// The main loop in the running app: create a lane and a task, tag it, move it,
// narrow the list, and post an update. Every outcome is read back from the CLI,
// never from the window.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type DesktopApp, launchDesktop, waitForDashboard } from "./harness.ts";
import { waitForLive, waitForRow } from "./live.ts";

let desktop: DesktopApp;

beforeAll(async () => {
  desktop = await launchDesktop();
  await waitForDashboard(desktop.page);
  await waitForLive(desktop.page);
});

afterAll(async () => {
  await desktop?.close();
});

type Listed = { id: number; lane: string; tags: string[] };
type Shown = { task: Listed; updates: Array<{ summary: string; author: string }> };

describe("the main loop in a real window", () => {
  test("create a task, tag it, move it, filter to it and post an update", async () => {
    const { page } = desktop;

    await page.locator('button[aria-label="Lanes"]').click();
    await page.locator('button[aria-label="New lane"]').click();
    const laneName = page.locator('input[placeholder="lane name"]');
    await laneName.fill("later");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await page.locator(".lane-row", { hasText: "later" }).waitFor();
    await page.locator('button[aria-label="Tasks"]').click();

    await page.locator('button[aria-label="New task"]').click();
    await page.locator(".task-row").first().waitFor();
    const created = JSON.parse(await desktop.cortex(["ls", "--json"])) as Listed[];
    expect(created).toHaveLength(1);
    const id = created[0]?.id as number;
    await page.locator(".task-row.active").waitFor();

    await page.locator('button[aria-label="Add tags"]').click();
    await page.locator(".tag-picker-search input").fill("smoke");
    await page.locator(".tag-picker-create-row").click();
    await page.locator(`button[aria-label="Remove tag smoke"]`).waitFor({ state: "attached" });
    await page.keyboard.press("Escape");

    await page.locator(".lane-chip-button").click();
    await page.locator(".picker-row", { hasText: "later" }).click();
    await page.locator(".lane-chip-button", { hasText: "later" }).waitFor();

    await page.locator('[aria-label="Search tasks"]').fill(`untitled-${id}`);
    await waitForRow(page, `untitled-${id}`);
    await page.locator('[aria-label="Lane filter"]').click();
    await page.locator('[role="option"]', { hasText: "later" }).click();
    expect(await page.locator(".task-row").count()).toBe(1);

    await page.getByRole("tab", { name: "Activity" }).click();
    await page.locator(".activity-compose .post-update-toggle").click();
    await page.locator(".compose textarea").fill("smoke update");
    await page.locator(".compose-foot button[type=submit]").click();
    await page.locator(".activity-thread .update-card", { hasText: "smoke update" }).waitFor();

    const shown = JSON.parse(await desktop.cortex(["show", String(id), "--json"])) as Shown;
    expect(shown.task.lane).toBe("later");
    expect(shown.task.tags).toEqual(["smoke"]);
    const posted = shown.updates.find(u => u.summary === "smoke update");
    expect(posted?.author).toBeTruthy();

    const listed = JSON.parse(await desktop.cortex(["ls", "--json"])) as Listed[];
    expect(listed.find(t => t.id === id)).toMatchObject({ lane: "later", tags: ["smoke"] });
  });
});
