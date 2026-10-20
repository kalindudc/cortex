// The four appearances in a real window: each chosen in the settings pane,
// "system" following the system preference live, high-contrast text at 7:1
// or more on every surface, and the choice surviving a relaunch.

import type { Page } from "playwright-core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { MOD } from "./chrome.ts";
import { type DesktopApp, launchDesktop, waitForDashboard } from "./harness.ts";
import { waitForLive } from "./live.ts";

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
const SELECT = "#setting-appearance";

const rootState = (page: Page) =>
  page.evaluate(() => ({
    theme: document.documentElement.getAttribute("data-theme"),
    contrast: document.documentElement.getAttribute("data-contrast"),
  }));

// The operating system's preference as the page sees it. Chromium's media
// emulation fires the same `change` event a real OS switch does; Electron's
// nativeTheme.themeSource did not reach a hidden test window (probed).
function setSystem(desktop: DesktopApp, scheme: "light" | "dark"): Promise<void> {
  return desktop.page.emulateMedia({ colorScheme: scheme });
}

async function openSettings(page: Page): Promise<void> {
  await page.keyboard.press(`${MOD}+Comma`);
  await page.locator(SELECT).waitFor();
}

/** WCAG 2 contrast ratios of the text tokens over the surface tokens, as the page resolves them. */
function contrastRatios(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    const rgb = (token: string): number[] => {
      const hex = style.getPropertyValue(token).trim().replace("#", "");
      return [0, 2, 4].map(i => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
    };
    const luminance = (token: string): number => {
      const [r, g, b] = rgb(token).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const out: Record<string, number> = {};
    for (const text of ["--text", "--text-content", "--text-2", "--text-3", "--text-4"]) {
      for (const surface of ["--bg", "--panel", "--tint"]) {
        const [hi, lo] = [luminance(text), luminance(surface)].sort((a, b) => b - a);
        out[`${text} on ${surface}`] = (hi + 0.05) / (lo + 0.05);
      }
    }
    return out;
  });
}

describe("appearance", () => {
  test("each appearance applies from the settings pane, and system follows the OS live", async () => {
    const { page } = desktop;
    await setSystem(desktop, "light");
    await openSettings(page);
    expect(await page.locator(SELECT).inputValue()).toBe("system");
    await expect.poll(() => rootState(page), POLL).toEqual({ theme: "light", contrast: null });

    await setSystem(desktop, "dark");
    await expect.poll(() => rootState(page), POLL).toEqual({ theme: "dark", contrast: null });
    await setSystem(desktop, "light");
    await expect.poll(() => rootState(page), POLL).toEqual({ theme: "light", contrast: null });

    await page.locator(SELECT).selectOption("dark");
    await expect.poll(() => rootState(page), POLL).toEqual({ theme: "dark", contrast: null });
    // An explicit choice no longer follows the OS.
    await setSystem(desktop, "dark");
    await setSystem(desktop, "light");
    expect(await rootState(page)).toEqual({ theme: "dark", contrast: null });

    await page.locator(SELECT).selectOption("light");
    await expect.poll(() => rootState(page), POLL).toEqual({ theme: "light", contrast: null });

    await page.locator(SELECT).selectOption("high-contrast");
    await expect.poll(() => rootState(page), POLL).toEqual({ theme: "dark", contrast: "high" });
    const ratios = await contrastRatios(page);
    for (const [pair, ratio] of Object.entries(ratios)) {
      expect(ratio, pair).toBeGreaterThanOrEqual(7);
    }

    await page.locator(SELECT).selectOption("system");
    await expect.poll(() => rootState(page), POLL).toEqual({ theme: "light", contrast: null });
    await setSystem(desktop, "dark");
    await expect.poll(() => rootState(page), POLL).toEqual({ theme: "dark", contrast: null });
  });

  test("the choice survives a relaunch", async () => {
    await openSettings(desktop.page);
    await desktop.page.locator(SELECT).selectOption("high-contrast");
    await expect.poll(() => rootState(desktop.page), POLL).toEqual({ theme: "dark", contrast: "high" });

    desktop = await desktop.relaunch();
    await waitForDashboard(desktop.page);
    expect(await rootState(desktop.page)).toEqual({ theme: "dark", contrast: "high" });
    await openSettings(desktop.page);
    expect(await desktop.page.locator(SELECT).inputValue()).toBe("high-contrast");
  });
});
