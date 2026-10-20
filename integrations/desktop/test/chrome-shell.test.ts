// The shell around the document in a real window: the theme toggle, the
// notification drawer, backup, and the Activity, Authors and Related tabs.

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { addTask } from "./chrome.ts";
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
const TITLE = ".task-header .task-title-display";

async function openTask(title: string): Promise<void> {
  await waitForRow(desktop.page, title);
  await desktop.page.locator("button.task-row", { hasText: title }).click();
  await desktop.page.locator(TITLE, { hasText: title }).waitFor();
}

const rootBg = () =>
  desktop.page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim());
const dataTheme = () => desktop.page.evaluate(() => document.documentElement.getAttribute("data-theme"));

describe("theme", () => {
  test("toggling flips data-theme and the --bg token, and the choice survives a reload", async () => {
    const { page } = desktop;
    const before = await dataTheme();
    expect(before === "light" || before === "dark").toBe(true);
    const bgBefore = await rootBg();
    expect(bgBefore).not.toBe("");

    await page.locator('button[aria-label^="Switch to"]').click();
    const after = before === "light" ? "dark" : "light";
    await expect.poll(dataTheme, POLL).toBe(after);
    await expect.poll(rootBg, POLL).not.toBe(bgBefore);
    const bgAfter = await rootBg();

    await page.reload();
    await waitForDashboard(page);
    expect(await dataTheme()).toBe(after);
    expect(await rootBg()).toBe(bgAfter);
  });
});

describe("notifications", () => {
  test("a task added from the CLI raises the badge, and dismissing its row clears both; no desktop alert", async () => {
    const { page } = desktop;
    await recordAlerts(page);
    await waitForLive(page);
    await addTask(desktop, "notify me");
    // The new task becomes the fallback active task, which closes open drawers; let that settle first.
    await waitForRow(page, "notify me");
    await page.locator(".notif-badge").waitFor();

    await page.locator('button[aria-label="Notifications"]').click();
    const row = page.locator(".notif-row", { hasText: "notify me" });
    await row.waitFor();
    await row.hover();
    await row.locator(".notif-dismiss").click();
    await row.waitFor({ state: "detached" });
    await page.locator(".notif-badge").waitFor({ state: "detached" });
    expect(await alerts(page)).toEqual([]);
  });
});

describe("backup", () => {
  test("Back up now reports a path under the test's config directory", async () => {
    const { page } = desktop;
    await page.locator('button[aria-label="Back up now"]').click();
    await page.locator('button[aria-label="Back up now"].btn-icon-active').waitFor();
    await page.mouse.move(0, 0);
    await page.locator('button[aria-label="Back up now"]').hover();
    const tip = page.locator(".tooltip-visible");
    await tip.waitFor();
    const text = (await tip.textContent()) ?? "";
    expect(text.startsWith("Backup saved to ")).toBe(true);
    const saved = fs.realpathSync(text.slice("Backup saved to ".length));
    const config = fs.realpathSync(desktop.env.XDG_CONFIG_HOME as string);
    expect(saved.startsWith(config + path.sep)).toBe(true);
    expect(fs.existsSync(saved)).toBe(true);
  });
});

describe("Activity, Authors and Related", () => {
  test("a posted update shows once, a seeded body expands, Authors lists both authors", async () => {
    const { page } = desktop;
    const id = await addTask(desktop, "activity target");
    await openTask("activity target");

    await page.getByRole("tab", { name: "Activity" }).click();
    await page.locator(".activity-compose .post-update-toggle").click();
    await page.locator(".compose textarea").fill("from the composer");
    await page.locator(".compose-foot button[type=submit]").click();
    const card = page.locator(".activity-thread .update-card", { hasText: "from the composer" });
    await card.waitFor();

    await desktop.cortex(["update", String(id), "--as", "probe-1234abcd", "-m", "seeded summary", "-b", "## Detail"]);
    const seeded = page.locator(".activity-thread .update-card", { hasText: "seeded summary" });
    await seeded.waitFor();
    // Both updates have arrived over the live stream; the composer's did not double.
    expect(await page.locator(".activity-thread .update-card", { hasText: "from the composer" }).count()).toBe(1);

    await seeded.locator(".update-card-toggle").click();
    await seeded.locator(".update-card-body .markdown-view h2", { hasText: "Detail" }).waitFor();
    await seeded.locator(".update-source summary").click();
    expect(await seeded.locator(".update-source pre").textContent()).toBe("## Detail");

    const shown = JSON.parse(await desktop.cortex(["show", String(id), "--json"])) as {
      updates: Array<{ summary: string; author: string }>;
    };
    const composerAuthor = shown.updates.find(u => u.summary === "from the composer")?.author;
    expect(composerAuthor).toBeTruthy();

    await page.getByRole("tab", { name: "Authors" }).click();
    await page.locator(".authors-table").waitFor();
    await expect
      .poll(async () => (await page.locator(".authors-table tbody tr").allTextContents()).join("|"), POLL)
      .toContain("probe-1234abcd");
    const authors = (await page.locator(".authors-table tbody tr").allTextContents()).join("|");
    expect(authors).toContain(composerAuthor as string);
  });

  test("Related lists a task whose body references the open task", async () => {
    const { page } = desktop;
    const id = await addTask(desktop, "referenced target");
    await addTask(desktop, "the referrer", { body: `Follows up on @${id}.` });
    await openTask("referenced target");

    await page.getByRole("tab", { name: "Related" }).click();
    const section = page.locator(".related-section", { hasText: "Referenced by" });
    await section.locator(".related-row", { hasText: "the referrer" }).waitFor();
  });
});
