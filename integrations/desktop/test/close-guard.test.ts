// The close guard in the running app. Closing the window, reloading it from
// the main process or quitting while a draft is unsaved asks Save all,
// Discard or Cancel, and unsaved text of a deleted task stays listed until it
// is exported or discarded. The native dialogs are replaced from the test
// through the main process, recording every call. Each case launches its own
// app, because most of them close it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ElectronApplication, Locator, Page } from "playwright-core";
import { afterEach, describe, expect, test } from "vitest";
import { type DesktopApp, launchDesktop, waitForDashboard } from "./harness.ts";
import { waitForLive } from "./live.ts";

const MOD = process.platform === "darwin" ? "Meta" : "Control";
const POLL = { timeout: 10_000, interval: 100 };
const SAVE_ALL = 0;
const DISCARD = 1;
const CANCEL = 2;

let desktop: DesktopApp | null = null;
let scratch: string | null = null;

afterEach(async () => {
  await desktop?.close();
  desktop = null;
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

async function launch(): Promise<DesktopApp> {
  desktop = await launchDesktop();
  await waitForDashboard(desktop.page);
  await waitForLive(desktop.page);
  return desktop;
}

async function addTask(app: DesktopApp, title: string, body: string): Promise<number> {
  const task = JSON.parse(await app.cortex(["add", title, `--body=${body}`, "--json"])) as { id: number };
  return task.id;
}

async function bodyOf(app: DesktopApp, id: number): Promise<string> {
  const shown = JSON.parse(await app.cortex(["show", String(id), "--json"])) as { task: { body: string | null } };
  return shown.task.body ?? "";
}

/** Open the task in Edit mode and return its editor. */
async function openEditor(page: Page, id: number): Promise<Locator> {
  await page.goto(`cortex://app/task/${id}`);
  await waitForDashboard(page);
  await waitForLive(page);
  await page.locator('fieldset[aria-label="Body view mode"]').getByRole("button", { name: "Edit", exact: true }).click();
  const cm = page.locator(".md-editor .cm-content");
  await cm.waitFor();
  return cm;
}

/** Open the task from the task list (no page load, which the guard would stop) in Edit mode. */
async function openEditorFromList(page: Page, title: string): Promise<Locator> {
  await page.locator(".task-row", { hasText: title }).click();
  await page.locator(".task-document", { hasText: title }).waitFor();
  await page.locator('fieldset[aria-label="Body view mode"]').getByRole("button", { name: "Edit", exact: true }).click();
  const cm = page.locator(".md-editor .cm-content");
  await cm.waitFor();
  return cm;
}

async function typeAtEnd(page: Page, cm: Locator, text: string, delay = 0): Promise<void> {
  await cm.click();
  await page.keyboard.press(`${MOD}+End`);
  await page.keyboard.type(text, { delay });
}

/**
 * Replace the guard's message box. A number answers at once with that
 * button; "later" holds the answer until answerGuard() is called.
 */
async function stubGuard(app: ElectronApplication, answer: number | "later"): Promise<void> {
  await app.evaluate(({ dialog }, choice) => {
    const g = globalThis as unknown as { __guardDialogs: string[][]; __answerGuard?: (response: number) => void };
    g.__guardDialogs = [];
    dialog.showMessageBox = (async (_win: unknown, options: { buttons?: string[] }) => {
      g.__guardDialogs.push(options.buttons ?? []);
      if (choice !== "later") return { response: choice, checkboxChecked: false };
      return new Promise(resolve => {
        g.__answerGuard = response => resolve({ response, checkboxChecked: false });
      });
    }) as unknown as typeof dialog.showMessageBox;
  }, answer);
}

const guardDialogs = (app: ElectronApplication): Promise<string[][]> =>
  app.evaluate(() => (globalThis as unknown as { __guardDialogs?: string[][] }).__guardDialogs ?? []);

const answerGuard = (app: ElectronApplication, response: number): Promise<void> =>
  app.evaluate((_electron, r) => {
    (globalThis as unknown as { __answerGuard?: (response: number) => void }).__answerGuard?.(r);
  }, response);

const windowCount = (app: ElectronApplication): Promise<number> =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

const closeWindow = (app: ElectronApplication): Promise<void> =>
  app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.close();
  });

/** Resolves once the Electron process has exited. */
function exited(app: ElectronApplication): Promise<void> {
  const child = app.process();
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => child.once("exit", () => resolve()));
}

const BUTTONS = ["Save all", "Discard", "Cancel"];

describe("close guard", () => {
  test("closing with a dirty draft asks once; Cancel keeps the window and the text", async () => {
    const app = await launch();
    const id = await addTask(app, "cancel case", "# Cancel\n\nbase");
    const cm = await openEditor(app.page, id);
    await stubGuard(app.app, CANCEL);
    await typeAtEnd(app.page, cm, " kept");
    await closeWindow(app.app);
    await expect.poll(() => guardDialogs(app.app), POLL).toEqual([BUTTONS]);
    expect(await windowCount(app.app)).toBe(1);
    expect(await cm.textContent()).toContain("base kept");
  });

  test("Save all writes the text, then the window closes", async () => {
    const app = await launch();
    const id = await addTask(app, "save case", "# Save\n\nbase");
    const cm = await openEditor(app.page, id);
    await stubGuard(app.app, SAVE_ALL);
    const gone = exited(app.app);
    await typeAtEnd(app.page, cm, " saved on close");
    await closeWindow(app.app);
    await gone;
    expect(await bodyOf(app, id)).toBe("# Save\n\nbase saved on close");
  });

  test("Discard closes without writing", async () => {
    const app = await launch();
    const id = await addTask(app, "discard case", "# Discard\n\nbase");
    const cm = await openEditor(app.page, id);
    await stubGuard(app.app, DISCARD);
    const gone = exited(app.app);
    await typeAtEnd(app.page, cm, " thrown away");
    await closeWindow(app.app);
    await gone;
    expect(await bodyOf(app, id)).toBe("# Discard\n\nbase");
  });

  test("a conflicted draft cannot be saved, so Save all keeps the window open", async () => {
    const app = await launch();
    const id = await addTask(app, "conflict case", "# Conflict\n\nbase");
    const cm = await openEditor(app.page, id);
    const typed = " typed slowly here..";
    await typeAtEnd(app.page, cm, typed.slice(0, 2));
    const typing = app.page.keyboard.type(typed.slice(2), { delay: 100 });
    await app.cortex(["edit", String(id), "--body", "from the CLI"]);
    await typing;
    await app.page.locator(".external-change-banner").waitFor({ timeout: 10_000 });
    await stubGuard(app.app, SAVE_ALL);
    await closeWindow(app.app);
    await expect.poll(() => guardDialogs(app.app), POLL).toEqual([BUTTONS]);
    expect(await windowCount(app.app)).toBe(1);
    expect(await bodyOf(app, id)).toBe("from the CLI");
  });

  test("a reload from the main process goes through the same dialog", async () => {
    const app = await launch();
    const id = await addTask(app, "reload case", "# Reload\n\nbase");
    const cm = await openEditor(app.page, id);
    await stubGuard(app.app, CANCEL);
    await app.page.evaluate(() => {
      (window as unknown as { __sameDocument: boolean }).__sameDocument = true;
    });
    await typeAtEnd(app.page, cm, " before reload");
    const reload = (): Promise<void> =>
      app.app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.webContents.reload();
      });
    await reload();
    await expect.poll(() => guardDialogs(app.app), POLL).toEqual([BUTTONS]);
    // Cancel: the same document, with the text, is still there.
    expect(await app.page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument)).toBe(true);
    expect(await cm.textContent()).toContain("base before reload");

    // Keep the draft dirty: a CLI write turns it into a conflict, which pauses its autosave.
    await app.cortex(["edit", String(id), "--body", "from the CLI"]);
    await app.page.locator(".external-change-banner").waitFor({ timeout: 10_000 });
    await stubGuard(app.app, DISCARD);
    await reload();
    await expect.poll(() => guardDialogs(app.app), POLL).toEqual([BUTTONS]);
    await expect
      .poll(
        () =>
          app.page
            .evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument ?? false)
            .catch(() => true),
        POLL,
      )
      .toBe(false);
    await waitForDashboard(app.page);
  });

  test("app.quit() waits for the answer", async () => {
    const app = await launch();
    const id = await addTask(app, "quit case", "# Quit\n\nbase");
    const cm = await openEditor(app.page, id);
    await stubGuard(app.app, "later");
    await typeAtEnd(app.page, cm, " at quit");
    const gone = exited(app.app);
    let hasExited = false;
    void gone.then(() => {
      hasExited = true;
    });
    await app.app.evaluate(({ app: electronApp }) => {
      electronApp.quit();
    });
    await expect.poll(() => guardDialogs(app.app), POLL).toEqual([BUTTONS]);
    // Unanswered: the app is still running with its window.
    expect(await windowCount(app.app)).toBe(1);
    expect(hasExited).toBe(false);
    await answerGuard(app.app, SAVE_ALL);
    await gone;
    expect(await bodyOf(app, id)).toBe("# Quit\n\nbase at quit");
  });

  test("unsaved text of a deleted task stays listed; Export writes it exactly and Discard removes it", async () => {
    const app = await launch();
    const { page } = app;
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-export-"));
    const exportPath = path.join(scratch, "exported.md");
    const first = await addTask(app, "deleted first", "# First\n\nbase");
    const second = await addTask(app, "deleted second", "# Second\n\nbase");

    // Delete each task while its body is dirty: its save then fails and the text is kept.
    await page.locator(".task-row", { hasText: "deleted second" }).waitFor();
    for (const [id, title, typed] of [
      [first, "deleted first", " rescued one"],
      [second, "deleted second", " rescued two"],
    ] as const) {
      const cm = await openEditorFromList(page, title);
      await typeAtEnd(page, cm, typed);
      await app.cortex(["rm", String(id), "--force"]);
      await page.locator(".orphan-draft", { hasText: `Task ${id}` }).waitFor({ timeout: 10_000 });
    }
    const region = page.getByRole("region", { name: "Unsaved text from deleted tasks" });
    expect(await region.locator(".orphan-draft").count()).toBe(2);

    const saveDialogs: unknown[] = [];
    await app.app.evaluate(({ dialog }, filePath) => {
      const g = globalThis as unknown as { __saveDialogs: unknown[] };
      g.__saveDialogs = [];
      dialog.showSaveDialog = (async (_win: unknown, options: unknown) => {
        g.__saveDialogs.push(options);
        return { canceled: false, filePath };
      }) as unknown as typeof dialog.showSaveDialog;
    }, exportPath);
    await region.locator(".orphan-draft", { hasText: `Task ${first}` }).getByRole("button", { name: "Export" }).click();
    await expect.poll(() => fs.existsSync(exportPath), POLL).toBe(true);
    expect(fs.readFileSync(exportPath, "utf8")).toBe("# First\n\nbase rescued one");
    saveDialogs.push(
      ...(await app.app.evaluate(() => (globalThis as unknown as { __saveDialogs: unknown[] }).__saveDialogs)),
    );
    expect(saveDialogs).toHaveLength(1);
    expect((saveDialogs[0] as { defaultPath: string }).defaultPath).toMatch(
      new RegExp(`cortex-task-${first}-body-draft\\.md$`),
    );
    await expect.poll(() => region.locator(".orphan-draft").count(), POLL).toBe(1);

    await region.locator(".orphan-draft", { hasText: `Task ${second}` }).getByRole("button", { name: "Discard" }).click();
    await expect.poll(() => page.locator(".orphan-drafts").count(), POLL).toBe(0);
  });
});
