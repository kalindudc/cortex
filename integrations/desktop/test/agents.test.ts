// Agent tools in a real window: the panel checks the sandbox's skill and
// extension folders through main, Install writes them, a hand edit shows as
// out of date, Reset asks first and drops a stray file, and main refuses any
// action it does not know. The harness pins CORTEX_SKILL_DIR and
// CORTEX_PI_EXTENSION_DIR to temporary folders and turns bb off.

import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runCommand } from "./chrome.ts";
import { type DesktopApp, launchDesktop, waitForDashboard, waitForText } from "./harness.ts";

const SKILLS = ["cortex", "cortex-planner", "cortex-implementer", "cortex-research"];
const BB_OFF = "bb is turned off (CORTEX_BB_CLI is empty)";
const TIMEOUT = 20_000;

let desktop: DesktopApp;

beforeEach(async () => {
  desktop = await launchDesktop();
  await waitForDashboard(desktop.page);
});

afterEach(async () => {
  await desktop?.close();
});

const headline = (page: Page, text: string) => waitForText(page, ".agents-headline", text, TIMEOUT);
const badge = (page: Page, tool: string) =>
  page.locator(`[data-agent-tool="${tool}"] .agents-badge`).textContent();

describe("agent tools", () => {
  test("check, install, a hand edit, then reset with confirmation", async () => {
    const { page, env } = desktop;
    const skillRoot = env.CORTEX_SKILL_DIR ?? "";
    await page.getByRole("button", { name: "Agent tools", exact: true }).click();
    await headline(page, "5 agent tools to install or update");
    for (const name of SKILLS) expect(await badge(page, name)).toBe("Not installed");
    expect(await badge(page, "pi extension")).toBe("Not installed");
    expect(await badge(page, "bb plugin")).toBe("Skipped");
    expect(await page.locator('[data-agent-tool="bb plugin"]').textContent()).toContain(BB_OFF);
    expect(fs.existsSync(skillRoot)).toBe(false);

    await page.getByRole("button", { name: "Install", exact: true }).click();
    await headline(page, "Every agent tool is up to date");
    await waitForText(
      page,
      ".agents-outcome[role=status]",
      `Installed 4 skills and the pi extension; skipped the bb plugin: ${BB_OFF}`,
    );
    for (const name of SKILLS) expect(fs.existsSync(path.join(skillRoot, name, "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(env.CORTEX_PI_EXTENSION_DIR ?? "", "cortex", "index.ts"))).toBe(true);

    fs.appendFileSync(path.join(skillRoot, "cortex-planner", "SKILL.md"), "\nhand edit");
    const stray = path.join(skillRoot, "cortex", "stray.md");
    fs.writeFileSync(stray, "left behind");
    await page.getByRole("button", { name: "Check again", exact: true }).click();
    await headline(page, "1 agent tool to install or update");
    expect(await badge(page, "cortex-planner")).toBe("Out of date");

    await page.getByRole("button", { name: "Reset…", exact: true }).click();
    const dialog = page.locator('dialog[aria-label="Reset agent tools"][open]');
    await dialog.waitFor();
    expect(await dialog.locator(".agents-reset-dirs li").allTextContents()).toEqual([
      ...SKILLS.map(name => path.join(skillRoot, name)),
      path.join(env.CORTEX_PI_EXTENSION_DIR ?? "", "cortex"),
    ]);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "detached" });
    expect(fs.existsSync(stray)).toBe(true);

    await page.getByRole("button", { name: "Reset…", exact: true }).click();
    await dialog.getByRole("button", { name: "Reset", exact: true }).click();
    await headline(page, "Every agent tool is up to date");
    expect(fs.existsSync(stray)).toBe(false);
    expect(fs.readFileSync(path.join(skillRoot, "cortex-planner", "SKILL.md"), "utf8")).not.toContain("hand edit");
  });

  test("the palette opens the panel, and main refuses an action it does not know", async () => {
    const { page } = desktop;
    await runCommand(page, "agent tools");
    await page.locator("section.agents-panel").waitFor();
    await headline(page, "5 agent tools to install or update");
    const refused = await page.evaluate(() =>
      window.cortex.agents({ action: "uninstall" } as unknown as Parameters<typeof window.cortex.agents>[0]),
    );
    expect(refused).toEqual({ ok: false, error: "invalid agents request" });
    expect(fs.existsSync(desktop.env.CORTEX_SKILL_DIR ?? "")).toBe(false);
  });
});
