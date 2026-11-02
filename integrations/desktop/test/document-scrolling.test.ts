import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type DesktopApp, launchDesktop, waitForDashboard } from "./harness.ts";
import { waitForLive } from "./live.ts";

let desktop: DesktopApp;
const POLL = { timeout: 10_000, interval: 50 };
const BODY = Array.from({ length: 70 }, (_, i) => `## Section ${i + 1}\n\nParagraph ${i + 1}, written on the sheet.\n`).join("\n");
let taskId: number;

beforeAll(async () => {
  desktop = await launchDesktop();
  await waitForDashboard(desktop.page);
  await waitForLive(desktop.page);
  const task = JSON.parse(await desktop.cortex(["add", "A scrolling paper task", "--body", BODY, "--json"])) as { id: number };
  taskId = task.id;
});

afterAll(async () => {
  await desktop?.close();
});

async function scroll(top: number): Promise<void> {
  // Markdown is inserted after paint; a premature scroll is clamped to zero.
  if (top > 0) {
    await expect.poll(() => desktop.page.locator(".doc-page").evaluate(el => el.scrollHeight - el.clientHeight), POLL).toBeGreaterThanOrEqual(top);
  }
  await desktop.page.locator(".doc-page").evaluate((el, offset) => { el.scrollTop = offset; }, top);
  await expect.poll(() => desktop.page.locator(".doc-sheet").evaluate(el => el.style.getPropertyValue("--paper-scroll")), POLL).toBe(`${top}px`);
}

async function openTask(): Promise<void> {
  await desktop.page.goto(`cortex://app/task/${taskId}`);
  await waitForDashboard(desktop.page);
  await waitForLive(desktop.page);
  await desktop.page.locator(".task-header").waitFor();
  await desktop.page.evaluate(() => document.fonts.ready);
}

describe("scrolling task paper", () => {
  for (const mode of ["Read", "Edit", "Split"] as const) {
    test(`${mode} scrolls the title, body and dots together, without moving the toolbar`, async () => {
      const { page } = desktop;
      await openTask();
      await page.getByRole("button", { name: mode, exact: true }).click();
      if (mode !== "Read") await page.locator(".md-editor .cm-content").waitFor();
      await scroll(0);
      const title = page.locator(".task-title-row");
      const body = page.locator(mode === "Edit" ? ".cm-content" : ".markdown-view");
      const before = { title: await title.boundingBox(), body: await body.boundingBox(), toolbar: await page.locator(".workspace-toolbar").boundingBox() };
      await page.locator(".doc-running-title").waitFor({ state: "hidden" });
      await scroll(173);
      await page.locator(".doc-running-title").waitFor({ state: "visible" });
      const after = { title: await title.boundingBox(), body: await body.boundingBox(), toolbar: await page.locator(".workspace-toolbar").boundingBox() };
      expect(before.title!.y - after.title!.y).toBeCloseTo(173, 0);
      expect(before.body!.y - after.body!.y).toBeCloseTo(173, 0);
      expect(before.toolbar!.y).toBe(after.toolbar!.y);
      expect(await page.locator(".doc-sheet > .paper-layer").evaluate(el => getComputedStyle(el, "::before").backgroundPosition)).toContain("-162px");
      if (mode !== "Edit") {
        expect(await page.locator(".doc-reader").evaluate(el => getComputedStyle(el).overflowY)).toBe("visible");
      }
      if (mode !== "Read") {
        expect(await page.locator(".cm-scroller").evaluate(el => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
      }
      const sheetHeight = (await page.locator(".doc-page").boundingBox())!.height;
      await page.getByRole("button", { name: "Back to task title: A scrolling paper task", exact: true }).click();
      await page.locator(".doc-running-title").waitFor({ state: "hidden" });
      await expect.poll(() => page.locator(".task-title-trigger").evaluate(el => el === document.activeElement), POLL).toBe(true);
      expect(await page.locator(".doc-page").evaluate(el => el.scrollTop)).toBe(0);
      expect((await page.locator(".doc-page").boundingBox())!.height).toBe(sheetHeight);
    });
  }

  for (const mode of ["Edit", "Split"] as const) {
    test(`${mode} keeps the keyboard caret below the breadcrumb while moving upward`, async () => {
      const { page } = desktop;
      await openTask();
      await page.getByRole("button", { name: mode, exact: true }).click();
      await page.locator(".cm-content").click();
      await page.keyboard.press(process.platform === "darwin" ? "Meta+End" : "Control+End");
      await page.locator(".doc-running-title").waitFor({ state: "visible" });
      for (let i = 0; i < 60; i++) await page.keyboard.press("ArrowUp");
      await expect.poll(() => page.locator(".cm-cursor").evaluate(el => {
        const breadcrumb = document.querySelector(".doc-running-title");
        if (!breadcrumb) throw new Error("expected breadcrumb");
        return el.getBoundingClientRect().top >= breadcrumb.getBoundingClientRect().bottom;
      }), POLL).toBe(true);
    });
  }

  test("the breadcrumb waits for a long title to fully leave view, updates live, and truncates on a narrow window", async () => {
    const { page } = desktop;
    const long = "A long title that grows naturally on its scrolling sheet ".repeat(5).trim();
    await desktop.cortex(["edit", String(taskId), "--title", long]);
    await openTask();
    await page.getByRole("button", { name: "Read", exact: true }).click();
    await scroll(0);
    expect(await page.locator(".task-title-text").evaluate(el => getComputedStyle(el).webkitLineClamp)).toBe("none");
    const titleBottom = await page.locator(".task-title-row").evaluate(el => el.getBoundingClientRect().bottom);
    const pageTop = await page.locator(".doc-page").evaluate(el => el.getBoundingClientRect().top);
    const threshold = Math.ceil(titleBottom - pageTop);
    await scroll(threshold - 2);
    await page.locator(".doc-running-title").waitFor({ state: "hidden" });
    await scroll(threshold + 2);
    await page.locator(".doc-running-title").waitFor({ state: "visible" });
    await desktop.cortex(["edit", String(taskId), "--title", `${long} renamed`]);
    await expect.poll(() => page.locator(".doc-running-title button").textContent(), POLL).toBe(`${long} renamed`);
    await page.setViewportSize({ width: 580, height: 800 });
    await scroll(700);
    await page.locator(".doc-running-title").waitFor({ state: "visible" });
    expect(await page.locator(".doc-running-title button").evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.setViewportSize({ width: 1440, height: 900 });
    await desktop.cortex(["edit", String(taskId), "--title", "A scrolling paper task"]);
  });

  test("an immediate scroll after returning to Edit is not overwritten by delayed restoration", async () => {
    const { page } = desktop;
    await openTask();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.locator(".cm-content").waitFor();
    await page.getByRole("tab", { name: "Activity", exact: true }).click();
    await scroll(0);
    const applied = await page.evaluate(async () => {
      const tab = document.querySelector<HTMLButtonElement>("#doc-tab-document");
      if (!tab) throw new Error("expected document tab");
      tab.click();
      await Promise.resolve();
      await Promise.resolve();
      const host = document.querySelector(".doc-page");
      if (!host) throw new Error("expected document page");
      host.scrollTop = 173;
      return host.scrollTop;
    });
    expect(applied).toBe(173);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect.poll(() => page.locator(".doc-page").evaluate(el => el.scrollTop), POLL).toBe(173);
    await expect.poll(() => page.locator(".doc-sheet").evaluate(el => el.style.getPropertyValue("--paper-scroll")), POLL).toBe("173px");
  });

  test("Read position survives Activity and mode switches, and an outline jump wins over the saved position", async () => {
    const { page } = desktop;
    await openTask();
    await page.getByRole("button", { name: "Read", exact: true }).click();
    await scroll(500);
    await page.getByRole("tab", { name: "Activity", exact: true }).click();
    await scroll(0);
    await page.getByRole("tab", { name: "Document", exact: true }).click();
    await expect.poll(() => page.locator(".doc-page").evaluate(el => el.scrollTop), POLL).toBe(500);
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await scroll(0);
    await page.getByRole("button", { name: "Read", exact: true }).click();
    await expect.poll(() => page.locator(".doc-page").evaluate(el => el.scrollTop), POLL).toBe(500);
    await page.getByRole("tab", { name: "Outline", exact: true }).click();
    await page.locator(".doc-outline-link", { hasText: "Section 40" }).click();
    await expect.poll(() => page.locator(`#task-${taskId}-section-40`).evaluate(el => {
      const page = document.querySelector(".doc-page")!;
      const delta = el.getBoundingClientRect().top - page.getBoundingClientRect().top;
      return delta >= 32 && delta <= 80;
    }), POLL).toBe(true);
  });
});
