// The Search panel in a real window: one search over every task (another
// lane and a done task included, the task list's filters untouched) with
// highlighted matches, Enter opening a result beside the list while the
// results stay; and the Settings panel's blocked alert switch silencing the
// system notification.

import type { Page } from "playwright-core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { addTask, MOD } from "./chrome.ts";
import { type DesktopApp, launchDesktop, waitForDashboard } from "./harness.ts";
import { alerts, recordAlerts, waitForLive, waitForRow } from "./live.ts";

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
const FIELD = 'input[aria-label="Search all tasks"]';
const TITLE = ".task-header .task-title-display";
const rail = (page: Page, label: string) => page.locator(`.nav-rail button[aria-label="${label}"]`);
const isFocused = (page: Page, selector: string) =>
  page.locator(selector).evaluate(el => el === document.activeElement);

describe("the Search panel", () => {
  test("finds a body match in another lane and a done task, and Enter opens one while the results stay", async () => {
    const { page } = desktop;
    await addTask(desktop, "lane task", { lane: "elsewhere", body: "this body hides a zebracorn deep inside" });
    await addTask(desktop, "zebracorn finished", { status: "done" });
    await addTask(desktop, "plain task");
    await waitForRow(page, "plain task");

    await rail(page, "Search").click();
    await expect.poll(() => isFocused(page, FIELD), POLL).toBe(true);
    expect(await rail(page, "Search").getAttribute("aria-current")).toBe("page");
    await page.locator(FIELD).pressSequentially("zebracorn");

    const rows = page.locator(".search-results .search-row");
    await expect.poll(() => rows.count(), POLL).toBe(2);
    await page.locator(".search-meta", { hasText: "2 results · every lane, done included" }).waitFor();
    const titles = await rows.locator(".search-row-title").allTextContents();
    expect(titles.sort()).toEqual(["lane task", "zebracorn finished"]);
    for (const row of await rows.all()) {
      expect(await row.locator("mark.search-hit").first().textContent()).toBe("zebracorn");
    }
    const excerpt = rows.filter({ hasText: "lane task" }).locator(".search-row-excerpt");
    expect(await excerpt.textContent()).toContain("hides a zebracorn deep");

    const first = (await rows.first().locator(".search-row-title").textContent()) ?? "";
    await page.locator(FIELD).press("Enter");
    await page.locator(TITLE, { hasText: first }).waitFor();
    // The results and the Search view stay beside the opened task.
    expect(await rows.count()).toBe(2);
    expect(await rows.first().getAttribute("aria-current")).toBe("page");
    expect(await rail(page, "Search").getAttribute("aria-current")).toBe("page");
    expect(await page.locator(FIELD).inputValue()).toBe("zebracorn");

    // The task list's own search field never saw the query.
    await rail(page, "Tasks").click();
    expect(await page.locator("#workspace-search").inputValue()).toBe("");
    await waitForRow(page, "plain task");
  });
});

describe("the blocked alert setting", () => {
  test("a move into blocked alerts while the setting is on and stays silent once it is off", async () => {
    const { page } = desktop;
    await recordAlerts(page);
    await waitForLive(page);
    const id = String(await addTask(desktop, "alert target"));
    await waitForRow(page, "alert target");

    await desktop.cortex(["update", id, "-s", "blocked", "-m", "stuck", "--as", "agent-1"]);
    const expected = { title: "cortex: task blocked", body: "alert target", tag: `task-${id}` };
    await expect.poll(() => alerts(page), POLL).toEqual([expected]);

    await page.keyboard.press(`${MOD}+Comma`);
    const toggle = page.locator('.settings-panel button[role="switch"]#setting-alert');
    expect(await toggle.getAttribute("aria-checked")).toBe("true");
    await toggle.click();
    await expect.poll(() => toggle.getAttribute("aria-checked"), POLL).toBe("false");
    await rail(page, "Tasks").click();

    await desktop.cortex(["update", id, "-s", "open", "-m", "unstuck", "--as", "agent-1"]);
    await desktop.cortex(["update", id, "-s", "blocked", "-m", "stuck again", "--as", "agent-1"]);
    // A task added afterwards has its row only once every earlier frame was handled.
    await addTask(desktop, "after the second block");
    await waitForRow(page, "after the second block");
    expect(await alerts(page)).toEqual([expected]);
  });
});
