// Keeping a task out of agent memory from the palette, in a real window: the
// header says "memory off", the status bar shows a notice for each outcome, and
// `cortex show --json` reads the stored flag back.

import type { Page } from "playwright-core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { addTask, runCommand } from "./chrome.ts";
import { type DesktopApp, launchDesktop, waitForDashboard, waitForText } from "./harness.ts";
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

const TITLE = ".task-header .task-title-display";
const WORD = ".task-header .document-kicker .task-memory-off";
const NOTICE = '.status-bar .status-notice[role="status"]';

async function excluded(id: number): Promise<boolean> {
  const shown = JSON.parse(await desktop.cortex(["show", String(id), "--json"])) as {
    task: { memory_excluded: boolean };
  };
  return shown.task.memory_excluded;
}

async function openTask(page: Page, title: string): Promise<void> {
  await waitForRow(page, title);
  await page.locator("button.task-row", { hasText: title }).click();
  await page.locator(TITLE, { hasText: title }).waitFor();
}

describe("agent memory from the palette", () => {
  test("keep out of memory shows 'memory off' and stores it; letting memory offer it again clears both", async () => {
    const { page } = desktop;
    const id = await addTask(desktop, "private notes");
    await openTask(page, "private notes");
    expect(await page.locator(WORD).count()).toBe(0);

    await runCommand(page, "keep out agent memory");
    await waitForText(page, NOTICE, `@${id} is out of agent memory; reading it by id still works`);
    await waitForText(page, WORD, "memory off");
    expect(await excluded(id)).toBe(true);

    await runCommand(page, "keep out agent memory");
    await waitForText(page, NOTICE, `@${id} is already out of agent memory`);
    expect(await excluded(id)).toBe(true);

    await runCommand(page, "let agent memory offer");
    await waitForText(page, NOTICE, `@${id} is back in agent memory`);
    await page.locator(WORD).waitFor({ state: "detached" });
    expect(await excluded(id)).toBe(false);
  });

  test("the settings and help pane lists both memory commands", async () => {
    const { page } = desktop;
    await addTask(desktop, "listed task");
    await openTask(page, "listed task");
    await runCommand(page, "settings and help");
    const pane = 'dialog[aria-label="Settings and help"][open]';
    await page.locator(`${pane} input[type="search"]`).fill("agent memory");
    await expect
      .poll(
        () =>
          page.evaluate(
            sel =>
              Array.from(document.querySelectorAll(`${sel} section[aria-label="Commands"] [data-help-id]`)).map(el =>
                el.getAttribute("data-help-id"),
              ),
            pane,
          ),
        { timeout: 10_000, interval: 50 },
      )
      .toEqual(["memory-off", "memory-on"]);
  });
});
