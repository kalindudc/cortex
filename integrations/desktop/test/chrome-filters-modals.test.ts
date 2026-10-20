// The sidebar's filters and its lane and tag management in a real window:
// status, lane, tag and search filters, Clear all, the uncapped catalogs, the
// modals' focus handling, and a tag that outlives its last task.

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { addTask, laneFilter, listTasks, statusFilter, tagsFilter } from "./chrome.ts";
import { type DesktopApp, launchDesktop, waitForDashboard } from "./harness.ts";
import { waitForLive, waitForRow } from "./live.ts";

let desktop: DesktopApp;

beforeEach(async () => {
  desktop = await launchDesktop();
  await waitForDashboard(desktop.page);
  await waitForLive(desktop.page);
});

afterEach(async () => {
  await desktop?.close();
});

const POLL = { timeout: 10_000, interval: 50 };

function rows(): Promise<string[]> {
  return desktop.page.locator(".task-row .task-title").allTextContents();
}

async function tagRow(name: string) {
  return desktop.page.locator(".tag-filter-row").filter({ has: desktop.page.locator(".tag-pill", { hasText: new RegExp(`^${name}$`) }) });
}

async function pickTag(name: string): Promise<void> {
  await (await tagRow(name)).click();
}

async function doneWithTags(): Promise<void> {
  await desktop.page.locator(".tag-filter-foot button.btn-primary", { hasText: "Done" }).click();
  await desktop.page.locator(".sidebar-filter-panel").waitFor({ state: "detached" });
}

/** Seed `count` lanes or tags named `<prefix>-0000`.. through the CLI in small parallel batches. */
async function seedMany(kind: "lane" | "tag", prefix: string, count: number): Promise<void> {
  for (let start = 0; start < count; start += 10) {
    await Promise.all(
      Array.from({ length: Math.min(10, count - start) }, (_, i) =>
        desktop.cortex([kind, "add", `${prefix}-${String(start + i).padStart(4, "0")}`]),
      ),
    );
  }
}

describe("sidebar filters", () => {
  test("the status selector narrows the list and the status bar shows the summary and count", async () => {
    const { page } = desktop;
    await addTask(desktop, "open task");
    await addTask(desktop, "blocked task", { status: "blocked" });
    await waitForRow(page, "blocked task");
    await waitForRow(page, "open task");
    expect(await page.locator(".status-bar .filter-summary").textContent()).toBe("All tasks");
    expect(await page.locator(".status-bar .status-counts").textContent()).toContain("2 shown");

    await statusFilter(page).click();
    await page.getByRole("option", { name: "Blocked", exact: true }).click();
    await expect.poll(rows, POLL).toEqual(["blocked task"]);
    expect(await page.locator(".status-bar .filter-summary").textContent()).toContain("blocked");
    expect(await page.locator(".status-bar .status-counts").textContent()).toContain("1 shown");
    expect(await page.locator(".filter-chip").count()).toBe(0);

    await statusFilter(page).click();
    await page.getByRole("option", { name: "All statuses", exact: true }).click();
    await expect.poll(async () => (await rows()).sort(), POLL).toEqual(["blocked task", "open task"]);
  });

  test("two tag filters match either tag, and removing one chip keeps the other", async () => {
    const { page } = desktop;
    await addTask(desktop, "task with bug", { tags: ["bug"] });
    await addTask(desktop, "task with ui", { tags: ["ui"] });
    await addTask(desktop, "task with neither");
    await waitForRow(page, "task with neither");
    await waitForRow(page, "task with ui");

    await tagsFilter(page).click();
    await pickTag("bug");
    await pickTag("ui");
    expect(await page.locator(".tag-filter-summary-chip").count()).toBe(2);
    await doneWithTags();
    await expect.poll(async () => (await rows()).sort(), POLL).toEqual(["task with bug", "task with ui"]);

    await page.locator(".filter-chip", { hasText: "#bug" }).locator(".x").click();
    await expect.poll(rows, POLL).toEqual(["task with ui"]);
    expect(await page.locator(".filter-chip", { hasText: "#ui" }).count()).toBe(1);
  });

  test("the Untagged sentinel shows only tasks without tags", async () => {
    const { page } = desktop;
    await addTask(desktop, "tagged thing", { tags: ["bug"] });
    await addTask(desktop, "naked thing");
    await waitForRow(page, "naked thing");
    await waitForRow(page, "tagged thing");

    await tagsFilter(page).click();
    await page.locator(".tag-filter-untagged-row").click();
    await doneWithTags();
    await expect.poll(rows, POLL).toEqual(["naked thing"]);
    expect(await page.locator(".filter-chip", { hasText: "untagged" }).count()).toBe(1);
  });

  test("tag search is a case-insensitive substring", async () => {
    const { page } = desktop;
    for (const name of ["frontend", "backend", "docs"]) await desktop.cortex(["tag", "add", name]);
    await page.waitForFunction(() => document.querySelector('button[aria-label="Filter by tags"]') !== null);
    await tagsFilter(page).click();
    await page.locator(".tag-filter-row").nth(3).waitFor();
    const search = page.getByRole("searchbox", { name: "Search tags", exact: true });
    await search.fill("ENd");
    await expect
      .poll(async () => (await page.locator(".tag-filter-row .tag-pill").allTextContents()).sort(), POLL)
      .toEqual(["backend", "frontend"]);
    await search.fill("");
    await expect.poll(() => page.locator(".tag-filter-row").count(), POLL).toBe(4);
  });

  test("Clear all is disabled until a filter is set, then clears every slot", async () => {
    const { page } = desktop;
    await addTask(desktop, "review me", { status: "review", tags: ["bug"] });
    await waitForRow(page, "review me");
    const clear = page.locator('button[aria-label="Clear all filters"]');
    expect(await clear.isDisabled()).toBe(true);

    await page.locator('input[aria-label="Search tasks"]').fill("review");
    await statusFilter(page).click();
    await page.getByRole("option", { name: "In review", exact: true }).click();
    await laneFilter(page).click();
    await page.getByRole("option", { name: "now", exact: true }).click();
    await tagsFilter(page).click();
    await pickTag("bug");
    await doneWithTags();
    expect(await clear.isEnabled()).toBe(true);
    expect(await page.locator(".filter-chip", { hasText: "#bug" }).count()).toBe(1);
    await expect.poll(rows, POLL).toEqual(["review me"]);

    await clear.click();
    await expect.poll(() => clear.isDisabled(), POLL).toBe(true);
    expect(await page.locator(".filter-chip").count()).toBe(0);
    expect(await page.locator('input[aria-label="Search tasks"]').inputValue()).toBe("");
    expect(await statusFilter(page).textContent()).toContain("All statuses");
    expect(await laneFilter(page).textContent()).toContain("All lanes");
    expect(await page.locator(".status-bar .filter-summary").textContent()).toBe("All tasks");
  });

  test("with 60 lanes and 60 tags every entry shows before anything is typed", async () => {
    const { page } = desktop;
    await seedMany("lane", "queue", 60);
    await seedMany("tag", "team", 60);
    await addTask(desktop, "catalog task", { lane: "queue-0059", tags: ["team-0059"] });
    await waitForRow(page, "catalog task");

    // The built-in `now` lane is one of the lanes: 61 lanes plus All lanes.
    await laneFilter(page).click();
    await expect.poll(() => page.getByRole("option").count(), POLL).toBe(62);
    const laneSearch = page.getByRole("searchbox", { name: "Search lanes", exact: true });
    await laneSearch.fill("QUE 0059");
    await expect.poll(() => page.getByRole("option").count(), POLL).toBe(2);
    expect(await laneFilter(page).textContent()).toContain("All lanes");
    await page.keyboard.press("Escape");

    await tagsFilter(page).click();
    await expect.poll(() => page.locator(".tag-filter-row").count(), POLL).toBe(61);
    await page.getByRole("searchbox", { name: "Search tags", exact: true }).fill("TEAM 0059");
    await expect.poll(() => page.locator(".tag-filter-row").count(), POLL).toBe(1);
    await page.keyboard.press("Escape");

    await page.locator("button.task-row", { hasText: "catalog task" }).click();
    await page.locator(".lane-chip-button").click();
    await expect.poll(() => page.locator(".picker-row").count(), POLL).toBe(61);
    await page.keyboard.press("Escape");
    await page.locator('button[aria-label="Add tags"]').click();
    await expect.poll(() => page.locator(".tag-picker-row:not(.tag-picker-create-row)").count(), POLL).toBe(60);
  });
});

describe("lane and tag management", () => {
  test("the new lane modal focuses its name, traps Tab, and returns focus to the trigger", async () => {
    const { page } = desktop;
    await page.locator('button[aria-label="Manage lanes"]').click();
    const trigger = page.locator('button[aria-label="New lane"]');
    await trigger.click();
    const dialog = page.locator('dialog[aria-label="New lane"][open]');
    await dialog.waitFor();
    const name = dialog.locator("input").first();
    await expect.poll(() => name.evaluate(el => el === document.activeElement), POLL).toBe(true);
    const create = dialog.getByRole("button", { name: "Create", exact: true });
    expect(await create.isDisabled()).toBe(true);
    await name.fill("next");
    expect(await create.isEnabled()).toBe(true);

    for (let i = 0; i < 25; i++) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => document.activeElement?.closest("dialog") !== null)).toBe(true);
    }
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press("Shift+Tab");
      expect(await page.evaluate(() => document.activeElement?.closest("dialog") !== null)).toBe(true);
    }

    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    await expect.poll(() => trigger.evaluate(el => el === document.activeElement), POLL).toBe(true);
    expect((await desktop.cortex(["lane", "ls", "--json"])).includes("next")).toBe(false);
  });

  test("a lane can be created, renamed and deleted from its modals", async () => {
    const { page } = desktop;
    await page.locator('button[aria-label="Manage lanes"]').click();
    await page.locator('button[aria-label="New lane"]').click();
    await page.locator("dialog[open] input").first().fill("soon");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await page.locator(".lane-row .lane-name", { hasText: /^soon$/ }).waitFor();
    await expect.poll(async () => (await desktop.cortex(["lane", "ls", "--json"])).includes('"soon"'), POLL).toBe(true);

    await page.locator(".lane-row", { hasText: "soon" }).click();
    const name = page.locator('dialog[aria-label="Edit lane"] input').first();
    await name.fill("sooner");
    await page.locator("dialog[open] button.btn-primary", { hasText: "Save" }).click();
    await page.locator(".lane-row .lane-name", { hasText: /^sooner$/ }).waitFor();

    await page.locator(".lane-row", { hasText: "sooner" }).click();
    await page.getByRole("button", { name: "Delete lane", exact: true }).click();
    await page.locator("dialog[open] button.btn-primary", { hasText: "Delete lane" }).click();
    await page.locator(".lane-row", { hasText: "sooner" }).waitFor({ state: "detached" });
    const lanes = await desktop.cortex(["lane", "ls", "--json"]);
    expect(lanes.includes("sooner")).toBe(false);
    expect(lanes.includes("soon")).toBe(false);
  });

  test("a tag can be created, edited and deleted from its modals", async () => {
    const { page } = desktop;
    await page.locator('button[aria-label="Manage tags"]').click();
    await page.locator('button[aria-label="New tag"]').click();
    const dialog = page.locator('dialog[aria-label="New tag"][open]');
    const name = dialog.locator("input").first();
    await expect.poll(() => name.evaluate(el => el === document.activeElement), POLL).toBe(true);
    const create = dialog.getByRole("button", { name: "Create", exact: true });
    expect(await create.isDisabled()).toBe(true);
    await name.fill("release-train");
    await create.click();
    const row = page.locator(".lane-row").filter({ has: page.locator(".tag-pill", { hasText: /^release-train$/ }) });
    await row.waitFor();

    await row.click();
    await page.locator('dialog[aria-label="Edit tag"] input').first().fill("release");
    await page.locator("dialog[open] button.btn-primary", { hasText: "Save" }).click();
    const renamed = page.locator(".lane-row").filter({ has: page.locator(".tag-pill", { hasText: /^release$/ }) });
    await renamed.waitFor();

    await renamed.click();
    await page.getByRole("button", { name: "Delete tag", exact: true }).click();
    await page.locator('dialog[aria-label="Delete tag"] button.btn-primary').click();
    await renamed.waitFor({ state: "detached" });
    const tags = await desktop.cortex(["tag", "ls", "--json"]);
    expect(tags.includes("release")).toBe(false);
  });

  test("opening the manage modes leaves the filters alone", async () => {
    const { page } = desktop;
    await addTask(desktop, "blocked one", { status: "blocked" });
    await waitForRow(page, "blocked one");
    await statusFilter(page).click();
    await page.getByRole("option", { name: "Blocked", exact: true }).click();
    await page.locator('button[aria-label="Manage tags"]').click();
    await page.locator(".section-head .eyebrow", { hasText: "Manage tags" }).waitFor();
    await page.locator('button[aria-label="Back to tasks"]').click();
    await page.locator('button[aria-label="Manage lanes"]').click();
    await page.locator('button[aria-label="Back to tasks"]').click();
    await page.locator(".section-toggle .section-label", { hasText: "Tasks" }).waitFor();
    expect(await statusFilter(page).textContent()).toContain("Blocked");
  });

  test("removing a tag from its last task leaves the tag defined", async () => {
    const { page } = desktop;
    const id = await addTask(desktop, "only holder", { tags: ["keeper"] });
    await waitForRow(page, "only holder");
    await page.locator("button.task-row", { hasText: "only holder" }).click();
    await page.locator(".task-header .tag-pill-removable", { hasText: "keeper" }).hover();
    await page.locator('button[aria-label="Remove tag keeper"]').click();
    await expect
      .poll(async () => (await listTasks(desktop)).find(t => t.id === id)?.tags, POLL)
      .toEqual([]);

    await page.locator('button[aria-label="Manage tags"]').click();
    await page
      .locator(".lane-row")
      .filter({ has: page.locator(".tag-pill", { hasText: /^keeper$/ }) })
      .waitFor();
    const tags = JSON.parse(await desktop.cortex(["tag", "ls", "--json"])) as Array<{ name: string; task_count: number }>;
    expect(tags.find(t => t.name === "keeper")).toMatchObject({ task_count: 0 });
  });
});
