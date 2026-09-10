// Motion is presentation, never a gate on interaction. Real Chromium checks
// the duration/property contract, rapid state changes, focus and reduced
// motion. Reaction timings are reported, not asserted as a machine-specific
// performance budget. The daemon/database are isolated by the shared fixture.
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures/cortex-server.ts";

const MOD = process.platform === "darwin" ? "Meta" : "Control";
async function seed(url: string): Promise<number> {
  const create = async (path: string, body: object): Promise<Response> => {
    const response = await fetch(`${url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Motion fixture ${path}: ${response.status}`);
    return response;
  };
  await create("/api/lanes", { name: "cortex" });
  const response = await create("/api/tasks", {
    lane: "cortex",
    title: "Responsive workspace",
    body: "## Outcome\n\nKeep the interface responsive.\n\n## Details\n\nA stable document.",
    priority: 1,
  });
  const { id } = (await response.json()) as { id: number };
  await create(`/api/tasks/${id}/updates`, {
    author: "reviewer-a1b2c3d4",
    summary: "Ready to read",
    body: "## Review\n\nThe content is available immediately.",
  });
  return id;
}

async function animation(page: Page, selector: string): Promise<{ name: string; duration: number; delay: number }> {
  return page.locator(selector).evaluate(element => {
    const style = getComputedStyle(element);
    return {
      name: style.animationName,
      duration: parseFloat(style.animationDuration) * 1000,
      delay: parseFloat(style.animationDelay) * 1000,
    };
  });
}

test("menus and dialogs use short non-delayed compositor animations and keep native focus behavior", async ({
  url,
  page,
}) => {
  const id = await seed(url);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(`${url}/task/${id}`);
  await page.locator(".lane-chip-button").click();
  await expect(page.locator(".popover.picker")).toBeVisible();
  const menu = await animation(page, ".popover.picker");
  expect(menu.name).toBe("ui-menu-in");
  expect(menu.duration).toBeGreaterThan(0);
  expect(menu.duration).toBeLessThanOrEqual(180);
  expect(menu.delay).toBe(0);
  await expect(page.locator(".picker-search input")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator(".popover.picker")).toHaveCount(0);

  const trigger = page.getByRole("button", { name: "Open the command palette", exact: true });
  await trigger.focus();
  await trigger.press("Enter");
  await expect(page.locator(".palette-input")).toBeFocused();
  const dialog = await animation(page, ".modal.palette");
  expect(dialog.name).toBe("ui-dialog-in");
  expect(dialog.duration).toBeLessThanOrEqual(180);
  expect(dialog.delay).toBe(0);
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(trigger).toBeFocused();

  // Inspect the actual shipped CSS, not source text or a timing guess.
  const animatedProperties = await page.evaluate(() => {
    const found: string[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      for (const rule of Array.from(sheet.cssRules)) {
        if (!(rule instanceof CSSKeyframesRule) || !rule.name.startsWith("ui-")) continue;
        for (const frame of Array.from(rule.cssRules)) {
          if (frame instanceof CSSKeyframeRule) found.push(...Array.from(frame.style));
        }
      }
    }
    return [...new Set(found)];
  });
  expect(animatedProperties.length).toBeGreaterThan(0);
  expect(animatedProperties.every(property => property === "opacity" || property === "transform")).toBe(true);
});

test("rapid Read/Edit/Split and tab changes settle on the last request without remounting CodeMirror", async ({
  url,
  page,
}) => {
  const id = await seed(url);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(String(error)));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(`${url}/task/${id}`);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator(".cm-editor")).toBeVisible();
  await page.locator(".cm-editor").evaluate(element => {
    (element as HTMLElement).dataset.motionIdentity = "same-editor";
  });

  const timings = await page.evaluate(async () => {
    const samples: Array<{ mode: string; milliseconds: number }> = [];
    for (const mode of ["Read", "Split", "Edit", "Read", "Split", "Read"]) {
      const button = Array.from(document.querySelectorAll<HTMLButtonElement>(".doc-mode-switch button")).find(
        element => element.getAttribute("aria-label") === mode,
      );
      if (!button) throw new Error(`Missing mode ${mode}`);
      const start = performance.now();
      button.click();
      await new Promise(requestAnimationFrame);
      if (button.getAttribute("aria-pressed") !== "true")
        throw new Error(`Mode ${mode} waited for animation completion`);
      samples.push({ mode, milliseconds: Math.round((performance.now() - start) * 10) / 10 });
    }
    return samples;
  });
  console.info("Mode reaction timings (ms):", JSON.stringify(timings));
  const reader = await animation(page, ".doc-reader");
  expect(reader.name).toBe("ui-content-in");
  expect(reader.duration).toBeLessThanOrEqual(180);
  await expect(page.locator(".cm-editor")).toHaveAttribute("data-motion-identity", "same-editor");
  await expect(page.locator(".md-editor")).toBeHidden();

  await page.getByRole("tab", { name: "Activity", exact: true }).click();
  await page.getByRole("tab", { name: "Related", exact: true }).click();
  await page.getByRole("tab", { name: "Document", exact: true }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator(".cm-editor")).toHaveAttribute("data-motion-identity", "same-editor");
  expect(errors).toEqual([]);
});

test("Activity reveals stay interruptible and a hidden composer cannot submit during a transition", async ({
  url,
  page,
}) => {
  const id = await seed(url);
  const writes: string[] = [];
  page.on("request", request => {
    if (["PATCH", "POST", "DELETE"].includes(request.method()) && request.url().includes("/api/tasks"))
      writes.push(request.url());
  });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(`${url}/task/${id}`);
  await page.keyboard.press(`${MOD}+Slash`);
  await expect(page.locator("#post-update-input")).toBeFocused();
  expect((await animation(page, ".compose")).name).toBe("ui-content-in");
  await page.locator("#post-update-input").fill("Keep this draft, do not post it.");
  const card = page.locator(".update-card-toggle");
  for (let count = 0; count < 3; count++) {
    await card.click();
    await expect(page.locator(".update-card-body")).toBeVisible();
    expect((await animation(page, ".update-card-body")).name).toBe("ui-content-in");
    await card.click();
    await expect(page.locator(".update-card-body")).toHaveCount(0);
  }
  await page.getByRole("tab", { name: "Document", exact: true }).click();
  await expect(page.locator(".compose")).toHaveCount(0);
  expect(await page.evaluate(() => typeof window.__cortexPostUpdate)).toBe("undefined");
  await page.keyboard.press(`${MOD}+Enter`);
  expect(writes).toEqual([]);
  await page.keyboard.press(`${MOD}+Slash`);
  await expect(page.locator("#post-update-input")).toBeFocused();
  await expect(page.locator("#post-update-input")).toHaveValue("Keep this draft, do not post it.");
});

test("SSE metadata refresh keeps reader/editor identity and never replays document motion", async ({ url, page }) => {
  const id = await seed(url);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(`${url}/task/${id}`);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator(".cm-editor")).toBeVisible();
  await page.locator(".cm-editor").evaluate(element => {
    (element as HTMLElement).dataset.motionIdentity = "unchanged";
  });
  await page.getByRole("button", { name: "Read", exact: true }).click();
  await expect(page.locator(".doc-reader")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .getAnimations()
            .filter(
              item =>
                item instanceof CSSAnimation && item.animationName.startsWith("ui-") && item.playState === "running",
            ).length,
      ),
    )
    .toBe(0);
  await page.evaluate(() => {
    for (const element of document.querySelectorAll<HTMLElement>(".task-header, .doc-reader")) {
      element.dataset.motionStarts = "0";
      element.addEventListener("animationstart", event => {
        if (event.target === element) element.dataset.motionStarts = String(Number(element.dataset.motionStarts) + 1);
      });
    }
  });
  const changed = await fetch(`${url}/api/tasks/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ priority: 2 }),
  });
  expect(changed.ok).toBe(true);
  await expect(page.locator(".task-header .priority-chip")).toContainText("P2");
  await expect(page.locator(".task-header")).toHaveAttribute("data-motion-starts", "0");
  await expect(page.locator(".doc-reader")).toHaveAttribute("data-motion-starts", "0");
  await expect(page.locator(".cm-editor")).toHaveAttribute("data-motion-identity", "unchanged");
});

test("drawers stay within 180ms and reduced motion disables all decorative motion immediately", async ({
  url,
  page,
}) => {
  const id = await seed(url);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(`${url}/task/${id}`);
  const trigger = page.getByRole("button", { name: "Open navigation", exact: true });
  await trigger.click();
  await expect(page.locator("dialog.nav-drawer")).toBeVisible();
  const drawer = await animation(page, ".nav-drawer-body");
  expect(drawer.name).toBe("ui-drawer-in");
  expect(drawer.duration).toBeLessThanOrEqual(180);
  expect(drawer.delay).toBe(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect((await animation(page, ".nav-drawer-body")).name).toBe("none");
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await page.getByRole("button", { name: "Notifications", exact: true }).click();
  await expect(page.locator(".notif-drawer")).toBeVisible();
  expect((await animation(page, ".notif-drawer")).name).toBe("none");
  const durations = await page.locator(".notif-bell").evaluate(element => getComputedStyle(element).transitionDuration);
  expect(durations.split(",").every(duration => parseFloat(duration) === 0)).toBe(true);
  await page.keyboard.press("Escape");
  await page.keyboard.press(`${MOD}+Slash`);
  await expect(page.locator("#post-update-input")).toBeFocused();
  expect((await animation(page, ".compose")).name).toBe("none");
});
