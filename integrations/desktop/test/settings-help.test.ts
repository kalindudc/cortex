// The Settings panel in a real window: opening it with Mod+, and from the
// palette, one search across settings, commands and shortcuts, every setting
// changing in place and surviving a relaunch, and every listed shortcut
// pressed for its visible effect (back and forward included).

import type { Page } from "playwright-core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { addTask, MOD, openPalette, runCommand } from "./chrome.ts";
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
const PANE = ".settings-panel";
// The search field lives in the list column beside the panel.
const SEARCH = 'input[aria-label="Search settings, commands and shortcuts"]';
const TITLE = ".task-header .task-title-display";
const isFocused = (page: Page, selector: string) =>
  page.locator(selector).evaluate(el => el === document.activeElement);

async function openSettings(page: Page): Promise<void> {
  await page.keyboard.press(`${MOD}+Comma`);
  await page.locator(SEARCH).waitFor();
  await expect.poll(() => isFocused(page, SEARCH), POLL).toBe(true);
}

async function closeSettings(page: Page): Promise<void> {
  await page.locator('.nav-rail button[aria-label="Tasks"]').click();
  await page.locator(PANE).waitFor({ state: "detached" });
}

/** The settings shown in the panel, or the ids shown in its Commands or Shortcuts section. */
function sectionIds(page: Page, section: "Settings" | "Commands" | "Shortcuts"): Promise<string[]> {
  return page.evaluate(
    ([pane, name]) =>
      name === "Settings"
        ? Array.from(document.querySelectorAll(`${pane} [data-setting]`)).map(el => el.getAttribute("data-setting") ?? "")
        : Array.from(document.querySelectorAll(`${pane} section[aria-label="${name}"] [data-help-id]`)).map(
            el => el.getAttribute("data-help-id") ?? "",
          ),
    [PANE, section] as const,
  );
}

/** Choose `value` for setting `key` with whatever control it has: a select, radios (segmented or cards) or a switch. */
async function choose(page: Page, key: string, value: string): Promise<void> {
  const control = page.locator(`${PANE} #setting-${key}`);
  const kind = await control.evaluate(el => (el.tagName === "SELECT" ? "select" : el.getAttribute("role")));
  if (kind === "select") await control.selectOption(value);
  else if (kind === "radiogroup") await control.locator(`input[value="${value}"]`).check();
  else if ((await page.locator(`${PANE} [data-setting="${key}"]`).getAttribute("data-value")) !== value) {
    expect(kind).toBe("switch");
    await control.click();
  }
  await expect.poll(() => page.locator(`${PANE} [data-setting="${key}"]`).getAttribute("data-value"), POLL).toBe(value);
}

async function openTask(page: Page, title: string): Promise<void> {
  await waitForRow(page, title);
  await page.locator("button.task-row", { hasText: title }).click();
  await page.locator(TITLE, { hasText: title }).waitFor();
}

const shownTitle = (page: Page) => page.locator(TITLE).textContent();
const modePressed = (page: Page, mode: "Read" | "Edit" | "Split") =>
  page
    .locator('fieldset[aria-label="Body view mode"]')
    .getByRole("button", { name: mode, exact: true })
    .getAttribute("aria-pressed");

async function bodyOf(id: number): Promise<string> {
  const shown = JSON.parse(await desktop.cortex(["show", String(id), "--json"])) as { task: { body: string | null } };
  return shown.task.body ?? "";
}

describe("the Settings panel", () => {
  test("opens with Mod+, and from the palette, and one search filters all three sections", async () => {
    const { page } = desktop;
    await openSettings(page);
    expect(await sectionIds(page, "Settings")).toEqual([
      "appearance",
      "density",
      "sort",
      "direction",
      "group",
      "done",
      "mode",
      "alert",
      "backup",
    ]);
    expect((await sectionIds(page, "Commands")).length).toBeGreaterThan(5);
    expect(await sectionIds(page, "Shortcuts")).toContain("settings");

    await page.locator(SEARCH).fill("GROUP");
    await expect.poll(() => sectionIds(page, "Settings"), POLL).toEqual(["group"]);
    expect(await sectionIds(page, "Commands")).toEqual(["sort-group"]);
    expect(await sectionIds(page, "Shortcuts")).toEqual([]);

    await page.locator(SEARCH).fill("task opened");
    await expect.poll(() => sectionIds(page, "Shortcuts"), POLL).toEqual(["history-back", "history-forward"]);
    expect(await sectionIds(page, "Settings")).toEqual([]);
    expect(await sectionIds(page, "Commands")).toEqual([]);

    await page.locator(SEARCH).fill("palette");
    await expect.poll(() => sectionIds(page, "Shortcuts"), POLL).toEqual(
      expect.arrayContaining(["palette-commands", "escape"]),
    );

    await page.locator(SEARCH).fill("no such words anywhere");
    await page.locator(`${PANE} .settings-empty`, { hasText: "No setting, command or shortcut matches" }).waitFor();
    await closeSettings(page);

    await runCommand(page, "settings");
    await page.locator(PANE).waitFor();
    await expect.poll(() => isFocused(page, SEARCH), POLL).toBe(true);
    await closeSettings(page);
  });

  test("each setting changes in place and survives a relaunch", async () => {
    const { page } = desktop;
    await addTask(desktop, "open one");
    await addTask(desktop, "open two");
    await addTask(desktop, "finished one", { status: "done" });
    await waitForRow(page, "open one");
    await openTask(page, "open two");
    expect(await page.locator("button.task-row", { hasText: "finished one" }).count()).toBe(0);

    await openSettings(page);
    await choose(page, "appearance", "dark");
    await choose(page, "density", "compact");
    await choose(page, "sort", "title");
    await choose(page, "direction", "desc");
    await choose(page, "group", "status");
    await choose(page, "done", "show");
    await choose(page, "mode", "split");
    await choose(page, "alert", "off");
    await choose(page, "backup", "10");
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme), POLL).toBe("dark");
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.density), POLL).toBe("compact");
    // The list column shows the settings sections while the panel is open.
    await closeSettings(page);
    await expect.poll(() => page.locator(".task-order").textContent(), POLL).toBe("Sorted by title descending, grouped by status");
    await waitForRow(page, "finished one");
    // Compact density keeps one line per task.
    expect(await page.locator("button.task-row .task-row-meta").first().isVisible()).toBe(false);
    // The document mode applies to the next task opened.
    await openTask(page, "open one");
    expect(await modePressed(page, "Split")).toBe("true");

    desktop = await desktop.relaunch();
    const next = desktop.page;
    await waitForDashboard(next);
    await waitForLive(next);
    await openSettings(next);
    const values = await next.evaluate(
      pane =>
        Object.fromEntries(
          Array.from(document.querySelectorAll(`${pane} [data-setting]`)).map(row => [
            row.getAttribute("data-setting"),
            row.getAttribute("data-value"),
          ]),
        ),
      PANE,
    );
    expect(values).toEqual({
      appearance: "dark",
      density: "compact",
      sort: "title",
      direction: "desc",
      group: "status",
      done: "show",
      mode: "split",
      alert: "off",
      backup: "10",
    });
    await closeSettings(next);
    expect(await next.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
    expect(await next.evaluate(() => document.documentElement.dataset.density)).toBe("compact");
    await waitForRow(next, "finished one");
    await openTask(next, "open one");
    expect(await modePressed(next, "Split")).toBe("true");
  });

  test("every listed shortcut presses for its visible effect", async () => {
    const { page } = desktop;
    const target = await addTask(desktop, "second task", { body: "# Second\n\nthe referenced task" });
    const first = await addTask(desktop, "first task", { body: `# First\n\nsee @${target}` });
    await waitForRow(page, "second task");
    await openTask(page, "first task");

    const checks: Record<string, () => Promise<void>> = {
      "palette-commands": async () => {
        await openPalette(page, "KeyP");
        expect(await page.locator(".palette-input").inputValue()).toMatch(/^\//);
        await page.keyboard.press("Escape");
        await page.locator(".palette-input").waitFor({ state: "detached" });
      },
      "palette-search": async () => {
        await openPalette(page, "KeyK");
        expect(await page.locator(".palette-input").getAttribute("placeholder")).toBe("Search titles + bodies…");
        await page.keyboard.press("Escape");
        await page.locator(".palette-input").waitFor({ state: "detached" });
      },
      escape: async () => {
        await openPalette(page, "KeyK");
        await page.keyboard.press("Escape");
        await page.locator(".palette-input").waitFor({ state: "detached" });
      },
      settings: async () => {
        await openSettings(page);
        await closeSettings(page);
      },
      "post-update": async () => {
        await page.keyboard.press(`${MOD}+Slash`);
        await expect.poll(() => isFocused(page, ".compose textarea"), POLL).toBe(true);
      },
      "post-submit": async () => {
        await page.keyboard.press(`${MOD}+Slash`);
        await expect.poll(() => isFocused(page, ".compose textarea"), POLL).toBe(true);
        await page.keyboard.type("posted from the help test");
        await page.keyboard.press(`${MOD}+Enter`);
        await page.locator(".activity-thread .update-card", { hasText: "posted from the help test" }).waitFor();
      },
      "mode-edit": async () => {
        await page.keyboard.press(`${MOD}+Alt+Digit2`);
        await expect.poll(() => modePressed(page, "Edit"), POLL).toBe("true");
      },
      "mode-split": async () => {
        await page.keyboard.press(`${MOD}+Alt+Digit3`);
        await expect.poll(() => modePressed(page, "Split"), POLL).toBe("true");
      },
      "mode-read": async () => {
        await page.keyboard.press(`${MOD}+Alt+Digit1`);
        await expect.poll(() => modePressed(page, "Read"), POLL).toBe("true");
      },
      "editor-save": async () => {
        await page.keyboard.press(`${MOD}+Alt+Digit2`);
        const cm = page.locator(".md-editor .cm-content");
        await cm.click();
        await page.keyboard.press(`${MOD}+End`);
        await page.keyboard.type(" saved");
        await page.keyboard.press(`${MOD}+KeyS`);
        // Autosave waits 600 ms after the last key; Mod+S saves at once.
        await expect.poll(() => bodyOf(first), { timeout: 400, interval: 25 }).toContain(" saved");
      },
      "ref-follow": async () => {
        await page.keyboard.press(`${MOD}+Alt+Digit2`);
        const ref = page.locator(".md-editor .cm-cortex-ref", { hasText: `@${target}` });
        await ref.click({ modifiers: [MOD] });
        await expect.poll(() => shownTitle(page), POLL).toBe("second task");
        await openTask(page, "first task");
      },
      "form-submit": async () => {
        await runCommand(page, "new lane");
        const name = page.locator('dialog[aria-label="New lane"][open]').getByRole("textbox", { name: "Name" });
        await expect.poll(() => name.evaluate(el => el === document.activeElement), POLL).toBe(true);
        await name.pressSequentially("from-the-keyboard");
        await page.keyboard.press(`${MOD}+Enter`);
        await page.locator('dialog[aria-label="New lane"]').waitFor({ state: "detached" });
        const lanes = JSON.parse(await desktop.cortex(["lane", "ls", "--json"])) as Array<{ name: string }>;
        expect(lanes.map(l => l.name)).toContain("from-the-keyboard");
      },
      "history-back": async () => {
        await openTask(page, "first task");
        await openTask(page, "second task");
        await page.keyboard.press(`${MOD}+BracketLeft`);
        await expect.poll(() => shownTitle(page), POLL).toBe("first task");
      },
      "history-forward": async () => {
        await page.keyboard.press(`${MOD}+BracketRight`);
        await expect.poll(() => shownTitle(page), POLL).toBe("second task");
        // The mouse's back button does the same as Mod+[.
        await page.evaluate(() => window.dispatchEvent(new MouseEvent("mouseup", { button: 3, bubbles: true })));
        await expect.poll(() => shownTitle(page), POLL).toBe("first task");
        await page.evaluate(() => window.dispatchEvent(new MouseEvent("mouseup", { button: 4, bubbles: true })));
        await expect.poll(() => shownTitle(page), POLL).toBe("second task");
        await openTask(page, "first task");
      },
      focus: async () => {
        const rows = page.locator("button.task-row");
        await rows.last().focus();
        await page.keyboard.press("Tab");
        await expect
          .poll(() => page.evaluate(() => document.activeElement?.closest(".section-tasks") === null), POLL)
          .toBe(true);
        await page.keyboard.press("Shift+Tab");
        await expect.poll(() => rows.last().evaluate(el => el === document.activeElement), POLL).toBe(true);
      },
    };

    await openSettings(page);
    const listed = await sectionIds(page, "Shortcuts");
    await closeSettings(page);
    // A shortcut added to the help registry without a check here fails this test.
    expect(Object.keys(checks).sort()).toEqual([...listed].sort());
    for (const id of listed) {
      const check = checks[id];
      if (!check) throw new Error(`no check for shortcut ${id}`);
      await check();
    }
  });
});
