// The command palette and the global shortcuts in a real window: opening and
// remembering queries, task search, running a command, the Escape cascade and
// bounded sheets on a narrow window.

import type { Page } from "playwright-core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { addTask, laneFilter, MOD } from "./chrome.ts";
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
const INPUT = ".palette-input";
const TITLE = ".task-header .task-title-display";

const selection = (page: Page) =>
  page.locator(INPUT).evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd]);
const focused = (page: Page, selector: string) =>
  page.locator(selector).evaluate(el => el === document.activeElement);

/** Press the palette chord and wait until the input has focus, so typed keys are not lost. */
async function openPalette(page: Page, key: "KeyP" | "KeyK"): Promise<void> {
  await page.keyboard.press(`${MOD}+${key}`);
  await page.locator(INPUT).waitFor();
  await expect.poll(() => focused(page, INPUT), POLL).toBe(true);
}

async function openTask(title: string): Promise<void> {
  await waitForRow(desktop.page, title);
  await desktop.page.locator("button.task-row", { hasText: title }).click();
  await desktop.page.locator(`${TITLE}`, { hasText: title }).waitFor();
}

describe("command palette", () => {
  test("Mod+P opens command mode, Mod+K search mode, and Escape closes", async () => {
    const { page } = desktop;
    await openPalette(page, "KeyP");
    expect(await page.locator(INPUT).inputValue()).toBe("/");
    await page.keyboard.press("Escape");
    await page.locator(INPUT).waitFor({ state: "detached" });

    await openPalette(page, "KeyK");
    expect(await page.locator(INPUT).inputValue()).toBe("");
    expect(await page.locator(INPUT).getAttribute("placeholder")).toBe("Search titles + bodies…");
    await page.keyboard.press("Escape");
    await page.locator(INPUT).waitFor({ state: "detached" });
  });

  test("the status bar hint opens the palette", async () => {
    const { page } = desktop;
    await page.locator('.status-bar button[aria-label="Open the command palette"]').click();
    await page.locator(INPUT).waitFor();
  });

  test("reopening selects the remembered query, and command mode keeps its leading slash out of the selection", async () => {
    const { page } = desktop;
    await addTask(desktop, "alpha task");
    await addTask(desktop, "beta task");
    await waitForRow(page, "beta task");
    await waitForRow(page, "alpha task");

    await openPalette(page, "KeyK");
    await page.locator(INPUT).pressSequentially("alpha");
    await page.locator(INPUT).press("Enter");
    await page.locator(INPUT).waitFor({ state: "detached" });
    await page.locator(TITLE, { hasText: "alpha task" }).waitFor();

    await openPalette(page, "KeyK");
    expect(await page.locator(INPUT).inputValue()).toBe("alpha");
    await expect.poll(() => selection(page), POLL).toEqual([0, 5]);
    await page.locator(INPUT).pressSequentially("beta");
    expect(await page.locator(INPUT).inputValue()).toBe("beta");
    await page.locator(".palette-row", { hasText: "beta task" }).waitFor();
    await page.locator(INPUT).press("Enter");
    await page.locator(TITLE, { hasText: "beta task" }).waitFor();

    await openPalette(page, "KeyP");
    expect(await page.locator(INPUT).inputValue()).toBe("/beta");
    await expect.poll(() => selection(page), POLL).toEqual([1, 5]);
    await page.locator(INPUT).pressSequentially("new lane");
    expect(await page.locator(INPUT).inputValue()).toBe("/new lane");
    await page.locator(".palette-row", { hasText: "New lane" }).first().waitFor();
    await page.keyboard.press("Escape");
    await page.locator(INPUT).waitFor({ state: "detached" });
  });

  test("search shows a highlighted body preview, and @ searches titles only", async () => {
    const { page } = desktop;
    await addTask(desktop, "alpha-title task");
    await addTask(desktop, "body-only task", { body: "The body contains alpha-body-only as the only searchable clue." });
    await waitForRow(page, "body-only task");
    await waitForRow(page, "alpha-title task");

    await openPalette(page, "KeyK");
    await page.locator(INPUT).fill("alpha-body-only");
    const bodyRow = page.locator(".palette-row", { hasText: "body-only task" });
    await bodyRow.waitFor();
    await bodyRow.locator(".task-search-preview").waitFor();
    expect(await bodyRow.locator(".task-search-preview mark.search-hit").textContent()).toBe("alpha-body-only");

    await page.locator(INPUT).fill("@alpha-body-only");
    await expect.poll(() => page.locator(".palette-list").textContent(), POLL).toContain("No matching tasks");

    await page.locator(INPUT).fill("@alpha-title");
    const titleRow = page.locator(".palette-row", { hasText: "alpha-title task" });
    await titleRow.waitFor();
    expect(await titleRow.locator(".task-search-title mark.search-hit").textContent()).toBe("alpha-title");
  });

  test("running Set status from the palette changes the task", async () => {
    const { page } = desktop;
    const id = await addTask(desktop, "status target");
    await openTask("status target");

    await openPalette(page, "KeyP");
    await page.locator(INPUT).pressSequentially("set status");
    await page.locator(".palette-row", { hasText: "Set status" }).first().click();
    await page.locator(".palette-row", { hasText: "Blocked" }).click();
    await page.locator(INPUT).waitFor({ state: "detached" });

    await expect
      .poll(async () => (JSON.parse(await desktop.cortex(["show", String(id), "--json"])) as { task: { status: string } }).task.status, POLL)
      .toBe("blocked");
  });
});

describe("global shortcuts", () => {
  test("Mod+/ reveals Activity and focuses the composer, and Mod+Enter posts the update", async () => {
    const { page } = desktop;
    const id = await addTask(desktop, "shortcut target");
    await openTask("shortcut target");

    await page.keyboard.press(`${MOD}+Slash`);
    await expect.poll(() => focused(page, ".compose textarea"), POLL).toBe(true);
    expect(await page.getByRole("tab", { name: "Activity" }).getAttribute("aria-selected")).toBe("true");

    await page.keyboard.type("posted from the keyboard");
    await page.keyboard.press(`${MOD}+Enter`);
    await page.locator(".activity-thread .update-card", { hasText: "posted from the keyboard" }).waitFor();
    const shown = JSON.parse(await desktop.cortex(["show", String(id), "--json"])) as { updates: Array<{ summary: string }> };
    expect(shown.updates.filter(u => u.summary === "posted from the keyboard")).toHaveLength(1);
  });

  test("Escape closes the top layer: the palette, then a modal, then a sidebar filter", async () => {
    const { page } = desktop;
    await laneFilter(page).click();
    await page.locator(".sidebar-filter-panel").waitFor();

    // Opening the palette retargets the filter: the palette is the top layer.
    await openPalette(page, "KeyP");
    await page.locator(".sidebar-filter-panel").waitFor({ state: "detached" });
    await page.locator(INPUT).fill("/new lane");
    await page.locator(".palette-row", { hasText: "New lane" }).first().click();
    const modal = page.locator('dialog[aria-label="New lane"][open]');
    await modal.waitFor();
    await page.locator(INPUT).waitFor({ state: "detached" });

    // Escape closes the modal and nothing below it.
    await page.keyboard.press("Escape");
    await modal.waitFor({ state: "detached" });
    expect(await page.locator(INPUT).count()).toBe(0);

    // With only a filter open, Escape closes it and returns focus to its trigger.
    await laneFilter(page).click();
    await page.locator(".sidebar-filter-panel").waitFor();
    await page.keyboard.press("Escape");
    await page.locator(".sidebar-filter-panel").waitFor({ state: "detached" });
    await expect.poll(() => laneFilter(page).evaluate(el => el === document.activeElement), POLL).toBe(true);

    // With the palette open, Escape closes the palette and forgets its query.
    await openPalette(page, "KeyK");
    await page.locator(INPUT).fill("anything");
    await page.keyboard.press("Escape");
    await page.locator(INPUT).waitFor({ state: "detached" });
    await openPalette(page, "KeyK");
    expect(await page.locator(INPUT).inputValue()).toBe("");
  });

  test("Mod+Alt+1, 2 and 3 do nothing while the palette is open", async () => {
    const { page } = desktop;
    await addTask(desktop, "mode target");
    await openTask("mode target");
    const read = page.getByRole("button", { name: "Read", exact: true });
    await read.waitFor();
    await openPalette(page, "KeyP");
    for (const digit of [2, 3, 1]) {
      await page.keyboard.press(`${MOD}+Alt+Digit${digit}`);
    }
    expect(await read.getAttribute("aria-pressed")).toBe("true");
    expect(await page.getByRole("button", { name: "Edit", exact: true }).getAttribute("aria-pressed")).toBe("false");
    expect(await page.locator(INPUT).count()).toBe(1);
  });
});

describe("narrow window", () => {
  test("a modal and a metadata popover stay inside a 390 px viewport with no horizontal scroll", async () => {
    const { page } = desktop;
    await addTask(desktop, "narrow target");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => window.innerWidth), POLL).toBe(390);
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const inside = (selector: string) =>
      page.locator(selector).evaluate(el => {
        const r = el.getBoundingClientRect();
        return r.left >= -1 && r.right <= window.innerWidth + 1 && r.width > 0;
      });

    await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    await page.locator("button.task-row", { hasText: "narrow target" }).click();
    await page.locator(TITLE, { hasText: "narrow target" }).waitFor();

    await page.locator(".lane-chip-button").click();
    await page.locator(".lane-picker").waitFor();
    expect(await inside(".lane-picker")).toBe(true);
    expect(await overflow()).toBeLessThanOrEqual(0);
    await page.keyboard.press("Escape");
    await page.locator(".lane-picker").waitFor({ state: "detached" });

    await openPalette(page, "KeyP");
    await page.locator(INPUT).fill("/new lane");
    await page.locator(".palette-row", { hasText: "New lane" }).first().click();
    await page.locator('dialog[aria-label="New lane"][open] .modal').waitFor();
    expect(await inside('dialog[aria-label="New lane"][open] .modal')).toBe(true);
    expect(await overflow()).toBeLessThanOrEqual(0);
  });
});
