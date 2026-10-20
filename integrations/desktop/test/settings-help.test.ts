// The settings and help pane in a real window: opening it with Mod+, and
// from the palette, one search across settings, commands and shortcuts,
// every setting changing in place and surviving a relaunch, and every listed
// shortcut pressed for its visible effect (back and forward included).

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
const PANE = 'dialog[aria-label="Settings and help"][open]';
const SEARCH = `${PANE} input[type="search"]`;
const TITLE = ".task-header .task-title-display";
const isFocused = (page: Page, selector: string) =>
  page.locator(selector).evaluate(el => el === document.activeElement);

async function openSettings(page: Page): Promise<void> {
  await page.keyboard.press(`${MOD}+Comma`);
  await page.locator(SEARCH).waitFor();
  await expect.poll(() => isFocused(page, SEARCH), POLL).toBe(true);
}

async function closeSettings(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await page.locator(PANE).waitFor({ state: "detached" });
}

/** The ids shown in one section of the pane. */
function sectionIds(page: Page, section: "Settings" | "Commands" | "Shortcuts"): Promise<string[]> {
  return page.evaluate(
    ([pane, name]) =>
      Array.from(
        document.querySelectorAll(`${pane} section[aria-label="${name}"] [data-help-id], ${pane} section[aria-label="${name}"] [data-setting]`),
      ).map(el => el.getAttribute("data-help-id") ?? el.getAttribute("data-setting") ?? ""),
    [PANE, section] as const,
  );
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

describe("settings and help pane", () => {
  test("opens with Mod+, and from the palette, and one search filters all three sections", async () => {
    const { page } = desktop;
    await openSettings(page);
    expect(await sectionIds(page, "Settings")).toEqual(["appearance", "sort", "group", "done", "mode"]);
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

    await runCommand(page, "settings and help");
    await page.locator(SEARCH).waitFor();
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
    const choose = (key: string, value: string) => page.locator(`${PANE} #setting-${key}`).selectOption(value);
    await choose("appearance", "dark");
    await choose("sort", "-id");
    await choose("group", "status");
    await choose("done", "show");
    await choose("mode", "split");
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme), POLL).toBe("dark");
    await expect.poll(() => page.locator(".task-order").textContent(), POLL).toBe("Sorted by -id, grouped by status");
    await waitForRow(page, "finished one");
    // The Default button puts one setting back and is disabled at its default.
    const resetGroup = page.locator(PANE).getByRole("button", { name: "Reset Group to its default" });
    await resetGroup.click();
    await expect.poll(() => page.locator(".task-order").textContent(), POLL).toBe("Sorted by -id");
    expect(await resetGroup.isDisabled()).toBe(true);
    await choose("group", "status");
    await closeSettings(page);
    // The document mode applies to the next task opened.
    await openTask(page, "open one");
    expect(await modePressed(page, "Split")).toBe("true");

    desktop = await desktop.relaunch();
    const next = desktop.page;
    await waitForDashboard(next);
    await waitForLive(next);
    await openSettings(next);
    const values = await next.evaluate(pane =>
      Object.fromEntries(
        Array.from(document.querySelectorAll<HTMLSelectElement>(`${pane} select`)).map(s => [s.id, s.value]),
      ),
    PANE);
    expect(values).toEqual({
      "setting-appearance": "dark",
      "setting-sort": "-id",
      "setting-group": "status",
      "setting-done": "show",
      "setting-mode": "split",
    });
    await closeSettings(next);
    expect(await next.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
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
        await openSettings(page);
        await closeSettings(page);
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
