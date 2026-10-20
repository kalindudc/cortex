// Launch links in a real window: `--task=<id> --heading=<slug>` on the app's
// command line shows that task in Read mode at that heading, and a second
// launch with new flags exits and hands its link to the first window.

import { spawn } from "node:child_process";
import type { Page } from "playwright-core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
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
const TITLE = ".task-header .task-title-display";

// Separate paragraphs, so each section is taller than the reader.
const filler = (label: string): string[] => Array.from({ length: 40 }, (_, i) => `${label} paragraph ${i + 1}.\n`);

async function addDocument(title: string): Promise<number> {
  const body = ["# Intro", "", ...filler("intro"), "", "## Details", "", ...filler("details"), "", "## Last", "", ...filler("last")].join(
    "\n",
  );
  const task = JSON.parse(await desktop.cortex(["add", title, `--body=${body}`, "--json"])) as { id: number };
  return task.id;
}

/** True when the heading's top edge is inside the reader's visible area. */
function inReaderViewport(page: Page, id: string): Promise<boolean> {
  return page.evaluate(headingId => {
    const reader = document.querySelector(".doc-reader");
    const el = document.getElementById(headingId);
    if (!reader || !el) return false;
    const r = reader.getBoundingClientRect();
    const top = el.getBoundingClientRect().top;
    return top >= r.top - 2 && top < r.bottom;
  }, id);
}

const readPressed = (page: Page) =>
  page
    .locator('fieldset[aria-label="Body view mode"]')
    .getByRole("button", { name: "Read", exact: true })
    .getAttribute("aria-pressed");

/** Start a second instance with the harness's launch spec plus `flags`; resolve its exit code. */
function secondLaunch(flags: string[]): Promise<number | null> {
  const second = spawn(desktop.electronPath, [...desktop.launchArgs, ...flags], { env: desktop.env, stdio: "ignore" });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      second.kill("SIGKILL");
      reject(new Error("the second instance did not exit"));
    }, 20_000);
    second.on("exit", code => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

describe("launch links", () => {
  test("launch flags open that task in Read mode with the heading in view", async () => {
    await desktop.cortex(["add", "another task"]);
    const id = await addDocument("linked document");
    await waitForRow(desktop.page, "linked document");

    desktop = await desktop.relaunch({ args: [`--task=${id}`, `--heading=task-${id}-details`] });
    const { page } = desktop;
    await waitForDashboard(page);
    await waitForLive(page);
    await page.locator(TITLE, { hasText: "linked document" }).waitFor();
    expect(page.url()).toBe(`cortex://app/task/${id}#task-${id}-details`);
    expect(await readPressed(page)).toBe("true");
    await expect.poll(() => inReaderViewport(page, `task-${id}-details`), POLL).toBe(true);
    expect(await inReaderViewport(page, `task-${id}-intro`)).toBe(false);
  });

  test("a second launch exits 0 and the first window shows its task and heading", async () => {
    const { page } = desktop;
    const first = await addDocument("first document");
    const second = await addDocument("second document");
    await waitForRow(page, "second document");
    await page.locator("button.task-row", { hasText: "first document" }).click();
    await page.locator(TITLE, { hasText: "first document" }).waitFor();

    expect(await secondLaunch([`--task=${second}`, `--heading=last`])).toBe(0);
    await page.locator(TITLE, { hasText: "second document" }).waitFor();
    expect(await readPressed(page)).toBe("true");
    await expect.poll(() => inReaderViewport(page, `task-${second}-last`), POLL).toBe(true);
    expect(desktop.app.windows()).toHaveLength(1);

    // A bad link focuses the window and changes nothing; a link to the shown task still scrolls.
    expect(await secondLaunch(["--task=0", "--heading=intro"])).toBe(0);
    expect(await page.locator(TITLE).textContent()).toBe("second document");
    expect(await secondLaunch([`--task=${second}`, "--heading=intro"])).toBe(0);
    await expect.poll(() => inReaderViewport(page, `task-${second}-intro`), POLL).toBe(true);

    // Each link is a history entry: back returns through them to the task shown before.
    await page.evaluate(() => history.back());
    await expect.poll(() => page.url(), POLL).toBe(`cortex://app/task/${second}#last`);
    await page.evaluate(() => history.back());
    await expect.poll(() => page.url(), POLL).toBe(`cortex://app/task/${first}`);
    await expect.poll(() => page.locator(TITLE).textContent(), POLL).toBe("first document");
  });
});
