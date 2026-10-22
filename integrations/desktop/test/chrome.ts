// Helpers for the chrome specs (sidebar, pickers, modals, palette, shell):
// seeding through the CLI and the filter controls' accessible names.

import type { Page } from "playwright-core";
import type { DesktopApp } from "./harness.ts";

export const MOD = process.platform === "darwin" ? "Meta" : "Control";

export type Listed = { id: number; lane: string; tags: string[]; status: string; title: string };

/** Add a task through the CLI and return its id. */
export async function addTask(
  desktop: DesktopApp,
  title: string,
  options: { lane?: string; tags?: string[]; status?: string; body?: string } = {},
): Promise<number> {
  const args = ["add", title, "--json"];
  if (options.lane) args.push("--lane", options.lane);
  if (options.tags?.length) args.push("--tags", options.tags.join(","));
  if (options.status) args.push("--status", options.status);
  if (options.body) args.push(`--body=${options.body}`);
  const task = JSON.parse(await desktop.cortex(args)) as { id: number };
  return task.id;
}

export async function listTasks(desktop: DesktopApp): Promise<Listed[]> {
  return JSON.parse(await desktop.cortex(["ls", "--json"])) as Listed[];
}

/**
 * Resize the viewport and wait until the app has laid itself out for that width. The narrow layout
 * follows a matchMedia change event, which on Linux arrives after window.innerWidth has already
 * changed, so waiting for the width alone can measure the wide component tree under the narrow CSS.
 */
export async function setViewportWidth(page: Page, width: number, height = 844): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.waitForFunction(
    w => window.innerWidth === w && (document.querySelector("main .mobile-bar") !== null) === w <= 900,
    width,
    { timeout: 10_000 },
  );
}

export const statusFilter = (page: Page) => page.getByRole("button", { name: "Status filter", exact: true });
export const laneFilter = (page: Page) => page.getByRole("button", { name: "Lane filter", exact: true });
export const tagsFilter = (page: Page) => page.getByRole("button", { name: "Filter by tags", exact: true });

const PALETTE_INPUT = ".palette-input";

async function waitForPaletteFocus(page: Page): Promise<void> {
  await page.waitForFunction(sel => document.querySelector(sel) === document.activeElement, PALETTE_INPUT);
}

/** Press the palette chord and wait until its input has focus, so typed keys are not lost. */
export async function openPalette(page: Page, key: "KeyP" | "KeyK" = "KeyP"): Promise<void> {
  await page.keyboard.press(`${MOD}+${key}`);
  await page.locator(PALETTE_INPUT).waitFor();
  await waitForPaletteFocus(page);
}

/**
 * Run a palette command from the keyboard: each query narrows the current
 * menu to exactly one row, then Enter runs it or opens its submenu.
 */
export async function runCommand(page: Page, ...queries: string[]): Promise<void> {
  await openPalette(page, "KeyP");
  for (const [i, query] of queries.entries()) {
    await waitForPaletteFocus(page);
    await page.locator(PALETTE_INPUT).pressSequentially(query);
    await page.waitForFunction(() => document.querySelectorAll(".palette-list .palette-row").length === 1);
    await page.locator(PALETTE_INPUT).press("Enter");
    if (i < queries.length - 1) {
      // A submenu opened: its query starts empty.
      await page.waitForFunction(
        sel => (document.querySelector(sel) as HTMLInputElement | null)?.value === "",
        PALETTE_INPUT,
      );
    }
  }
  await page.locator(PALETTE_INPUT).waitFor({ state: "detached" });
}
