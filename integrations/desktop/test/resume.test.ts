// Resume in a real window: the Authors tab offers Resume on bb and pi
// authors only; a bb thread opens through BB_CLI (a shim that logs its argv),
// a pi session's command goes to the clipboard, a failing bb shows an error,
// the main process refuses any request it did not find on the task, and the
// palette path works from the keyboard.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { addTask, runCommand } from "./chrome.ts";
import { type DesktopApp, launchDesktop, waitForDashboard } from "./harness.ts";
import { waitForLive, waitForRow } from "./live.ts";

const THREAD = "thr_2qj8qzdqqr";
const BB = `bb-${THREAD}`;
const PI_SESSION = "01923f3a-9201-7c0e-b1c8-abcdef012345";
const PI = `pi-${PI_SESSION}`;
const POLL = { timeout: 10_000, interval: 50 };

let shimDir: string;
let shim: string;
const argvLog = () => path.join(shimDir, "argv.log");
const exitFile = () => path.join(shimDir, "exit-code");
const logged = (): string[] =>
  fs.existsSync(argvLog()) ? fs.readFileSync(argvLog(), "utf8").trim().split("\n").filter(Boolean) : [];

beforeAll(() => {
  shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-resume-shim-"));
  shim = path.join(shimDir, "bb-shim");
  // Appends one line per call (its argv, space-joined) and exits with the code in exit-code.
  fs.writeFileSync(
    shim,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${argvLog()}'\nexit "$(cat '${exitFile()}')"\n`,
    { mode: 0o755 },
  );
});

afterAll(() => {
  fs.rmSync(shimDir, { recursive: true, force: true });
});

let desktop: DesktopApp;
let savedClipboard = "";
let taskId: number;

beforeEach(async () => {
  fs.writeFileSync(exitFile(), "0");
  fs.rmSync(argvLog(), { force: true });
  desktop = await launchDesktop({ env: { BB_CLI: shim } });
  // The clipboard is the developer's real one on macOS: keep it and put it back.
  savedClipboard = await desktop.app.evaluate(({ clipboard }) => clipboard.readText());
  await waitForDashboard(desktop.page);
  await waitForLive(desktop.page);
  taskId = await addTask(desktop, "resume me");
  for (const author of [PI, BB, "alice"]) {
    await desktop.cortex(["update", String(taskId), "-m", `from ${author}`, "--as", author]);
  }
  await waitForRow(desktop.page, "resume me");
  await desktop.page.locator("button.task-row", { hasText: "resume me" }).click();
  await desktop.page.locator(".task-header .task-title-display", { hasText: "resume me" }).waitFor();
});

afterEach(async () => {
  await desktop?.app.evaluate(({ clipboard }, text) => clipboard.writeText(text), savedClipboard).catch(() => {});
  await desktop?.close();
});

async function openAuthors(page: Page): Promise<void> {
  await page.getByRole("tab", { name: "Details" }).click();
  await page.locator(".author-list").waitFor();
  // The three authors arrive over the live stream.
  await expect.poll(() => page.locator(".author-row").count(), POLL).toBe(3);
}

const status = (page: Page) => page.locator(".resume-outcome[role=status]").textContent();
const clipboardText = () => desktop.app.evaluate(({ clipboard }) => clipboard.readText());

describe("resume", () => {
  test("Resume shows on bb and pi authors only; bb opens the thread, pi copies the command", async () => {
    const { page } = desktop;
    await openAuthors(page);
    const buttons = page.locator(".author-list button", { hasText: "Resume" });
    expect(await buttons.evaluateAll(els => els.map(el => el.getAttribute("aria-label")))).toEqual(
      expect.arrayContaining([`Resume ${BB}`, `Resume ${PI}`]),
    );
    expect(await buttons.count()).toBe(2);
    expect(await page.getByRole("button", { name: "Resume alice" }).count()).toBe(0);

    await page.getByRole("button", { name: `Resume ${BB}` }).click();
    await expect.poll(() => status(page), POLL).toBe(`Opened ${THREAD} in bb`);
    expect(logged()).toEqual([`thread open ${THREAD}`]);

    await page.getByRole("button", { name: `Resume ${PI}` }).click();
    const command = `pi --session ${PI_SESSION}`;
    await expect.poll(() => status(page), POLL).toBe(`Copied ${command}: paste it into a terminal to resume that session`);
    expect(await clipboardText()).toBe(command);
    // pi runs nothing.
    expect(logged()).toEqual([`thread open ${THREAD}`]);
  });

  test("a bb that exits non-zero shows its error", async () => {
    const { page } = desktop;
    fs.writeFileSync(exitFile(), "7");
    await openAuthors(page);
    await page.getByRole("button", { name: `Resume ${BB}` }).click();
    await page.locator(".notif-badge").waitFor();
    await page.locator('button[aria-label="Notifications"]').click();
    await page.locator(".notif-row", { hasText: "bb thread open exited with status 7" }).waitFor();
    expect(logged()).toEqual([`thread open ${THREAD}`]);
  });

  test("main refuses a request it did not find on the task, and never runs the shim", async () => {
    const { page } = desktop;
    const other = await addTask(desktop, "no authors");
    const results = await page.evaluate(
      async ([id, otherId, bb]) => {
        const ask = (request: unknown) =>
          window.cortex.resume(request as { taskId: number; author: string }).then(r => r.ok);
        return [
          await ask({ taskId: String(id), author: bb }),
          await ask({ taskId: id, author: "alice" }),
          await ask({ taskId: id, author: "bb-thr_wellformedbutabsent" }),
          await ask({ taskId: otherId, author: bb }),
          await ask({ taskId: id, author: `${bb} ; touch /tmp/x` }),
          await ask({ taskId: id, author: "x".repeat(81) }),
          await ask({ taskId: -1, author: bb }),
          await ask(null),
        ];
      },
      [taskId, other, BB] as const,
    );
    expect(results).toEqual([false, false, false, false, false, false, false, false]);
    expect(logged()).toEqual([]);
  });

  test("the palette's Resume a session… works from the keyboard", async () => {
    const { page } = desktop;
    // The candidates come from the active task's updates, loaded once its Activity is read.
    await openAuthors(page);
    await runCommand(page, "resume a session", `resume-${BB}`);
    await expect.poll(() => status(page), POLL).toBe(`Opened ${THREAD} in bb`);
    expect(logged()).toEqual([`thread open ${THREAD}`]);
  });
});
