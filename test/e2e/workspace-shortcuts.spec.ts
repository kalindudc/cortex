// Mode shortcuts are app actions, not browser accelerators or text input.
// Uses the real editor and an isolated daemon; no task writes from switching.
import { test, expect } from "./fixtures/cortex-server.ts";
const MOD = process.platform === "darwin" ? "Meta" : "Control";
const MODE_KEY = "cortex-reader-mode-v1";
const shortcut = (digit: number): string => `${MOD}+Alt+Digit${digit}`;

async function seed(url: string): Promise<{ a: number; b: number }> {
  const post = async (path: string, body: object): Promise<Response> => {
    const response = await fetch(`${url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Shortcut fixture ${path}: ${response.status}`);
    return response;
  };
  await post("/api/lanes", { name: "cortex" });
  const body = "## Overview\n\nKeep this source unchanged.\n\n## Details\n\nShortcut fixture.";
  const a = (await post("/api/tasks", { lane: "cortex", title: "Shortcut task A", body }).then(response =>
    response.json(),
  )) as { id: number };
  const b = (await post("/api/tasks", { lane: "cortex", title: "Shortcut task B", body }).then(response =>
    response.json(),
  )) as { id: number };
  return { a: a.id, b: b.id };
}

test("mode shortcuts work inside CodeMirror, focus the chosen surface, and persist without task writes", async ({
  url,
  page,
}) => {
  const { a } = await seed(url);
  const writes: string[] = [];
  page.on("request", request => {
    if (["PATCH", "POST", "DELETE"].includes(request.method()) && request.url().includes("/api/tasks"))
      writes.push(request.url());
  });
  await page.goto(`${url}/task/${a}`);
  await page.keyboard.press(shortcut(2));
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveAttribute("aria-pressed", "true");
  const editor = page.locator(".cm-content");
  await expect(editor).toBeFocused();
  const source = await editor.textContent();
  await page.locator(".cm-editor").evaluate(element => {
    (element as HTMLElement).dataset.shortcutIdentity = "same";
  });
  await page.keyboard.press(shortcut(3));
  await expect(page.getByRole("button", { name: "Split", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(editor).toBeFocused();
  await expect(editor).toHaveText(source ?? "");
  await expect(page.locator(".cm-editor")).toHaveAttribute("data-shortcut-identity", "same");
  await page.keyboard.press(shortcut(1));
  await expect(page.getByRole("button", { name: "Read", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".doc-reader")).toBeFocused();
  await expect(page.locator(".md-editor")).toBeHidden();
  await page.keyboard.press(shortcut(3));
  await page.getByRole("tab", { name: "Activity", exact: true }).click();
  await page.keyboard.press(shortcut(2));
  await expect(page.getByRole("tab", { name: "Document", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(editor).toBeFocused();
  expect(await page.evaluate(key => localStorage.getItem(key), MODE_KEY)).toBe("edit");
  await page.locator(".task-row", { hasText: "Shortcut task B" }).click();
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(writes).toEqual([]);
});

test("mode buttons and palette commands expose the platform-specific shortcut", async ({ url, page }) => {
  const { a } = await seed(url);
  await page.goto(`${url}/task/${a}`);
  for (const [digit, label] of [
    [1, "Read"],
    [2, "Edit"],
    [3, "Split"],
  ] as const) {
    await expect(page.getByRole("button", { name: label, exact: true })).toHaveAttribute(
      "aria-keyshortcuts",
      `${MOD}+Alt+${digit}`,
    );
    // The button only carries its digit; the chord modifier is shown once.
    const digitHint = page.getByRole("button", { name: label, exact: true }).locator(".mode-switch-digit");
    await expect(digitHint).toBeVisible();
    await expect(digitHint).toHaveText(`${digit}`);
  }
  const superKey = page.locator(".doc-mode-switch .mode-switch-super");
  await expect(superKey).toHaveCount(1);
  await expect(superKey).toHaveText(MOD === "Meta" ? "⌘ + ⌥" : "Ctrl+Alt");
  await page.getByRole("button", { name: "Read", exact: true }).focus();
  await expect(page.locator(".tooltip-visible")).toContainText(MOD === "Meta" ? "⌘ + ⌥ + 1" : "Ctrl + Alt + 1");
  await page.keyboard.press(`${MOD}+KeyP`);
  await page.locator(".palette-input").fill("/Read document");
  await expect(page.locator(".palette-row")).toContainText(MOD === "Meta" ? "⌘ + ⌥ + 1" : "Ctrl + Alt + 1");
});

test("inline mode hints fit narrow and desktop toolbars for both platform labels", async ({ url, browser }) => {
  const { a } = await seed(url);
  for (const platform of ["MacIntel", "Win32"]) {
    const context = await browser.newContext();
    try {
      // Presentation check for the different hint lengths, not OS emulation.
      await context.addInitScript(
        value => Object.defineProperty(navigator, "platform", { get: () => value }),
        platform,
      );
      const page = await context.newPage();
      for (const width of [320, 390, 768, 1024, 1440]) {
        await page.setViewportSize({ width, height: 844 });
        await page.goto(`${url}/task/${a}`);
        await expect(page.locator(".doc-mode-switch .mode-switch-super")).toHaveCount(1);
        await expect(page.locator(".doc-mode-switch .mode-switch-digit")).toHaveCount(3);
        const group = page.locator(".doc-mode-switch");
        for (const hint of await page.locator(".mode-switch-super, .mode-switch-digit").all()) {
          await expect(hint).toBeVisible();
          const bounds = await hint.evaluate(
            (element, groupEl) => {
              const cap = element.getBoundingClientRect();
              const bounds = (groupEl as HTMLElement).getBoundingClientRect();
              return { fits: cap.left >= bounds.left - 1 && cap.right <= bounds.right + 1, right: cap.right };
            },
            await group.elementHandle(),
          );
          expect(bounds.fits).toBe(true);
          expect(bounds.right).toBeLessThanOrEqual(width);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
        if (width === 320 || width === 1440) {
          await page
            .locator(".workspace-toolbar")
            .screenshot({ path: `tmp/screenshots/polish/mode-hints-${platform}-${width}.png`, animations: "disabled" });
        }
      }
    } finally {
      await context.close();
    }
  }
});

test("palette, metadata menus, sidebar filters and navigation keep keyboard ownership", async ({ url, page }) => {
  const { a } = await seed(url);
  await page.goto(`${url}/task/${a}`);
  await page.keyboard.press(`${MOD}+KeyP`);
  const palette = page.locator(".palette-input");
  await expect(palette).toBeFocused();
  const query = await palette.inputValue();
  await page.keyboard.press(shortcut(2));
  await expect(palette).toBeFocused();
  await expect(palette).toHaveValue(query);
  expect(await page.evaluate(key => localStorage.getItem(key), MODE_KEY)).toBe("read");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Task actions", exact: true }).click();
  await page.keyboard.press(shortcut(3));
  await expect(page.locator(".task-actions-menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Lane filter", exact: true }).click();
  const search = page.getByRole("searchbox", { name: "Search lanes", exact: true });
  await expect(search).toBeFocused();
  await page.keyboard.press(shortcut(2));
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("");
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.keyboard.press(shortcut(2));
  await expect(page.getByRole("dialog", { name: "Navigation", exact: true })).toBeVisible();
  expect(await page.evaluate(key => localStorage.getItem(key), MODE_KEY)).toBe("read");
});

test("browser tab shortcuts, handled/IME events and held-key repeats do not change modes", async ({ url, page }) => {
  const { a } = await seed(url);
  await page.goto(`${url}/task/${a}`);
  await expect(page.locator(".task-document")).toBeVisible();
  const result = await page.evaluate(mac => {
    const base = {
      key: "2",
      code: "Digit2",
      bubbles: true,
      cancelable: true,
      altKey: true,
      metaKey: mac,
      ctrlKey: !mac,
    };
    const plainTab = new KeyboardEvent("keydown", { ...base, altKey: false });
    window.dispatchEvent(plainTab);
    const composing = new KeyboardEvent("keydown", { ...base, isComposing: true });
    window.dispatchEvent(composing);
    const handled = new KeyboardEvent("keydown", base);
    handled.preventDefault();
    window.dispatchEvent(handled);
    const repeated = new KeyboardEvent("keydown", { ...base, repeat: true });
    window.dispatchEvent(repeated);
    return {
      plainPrevented: plainTab.defaultPrevented,
      composingPrevented: composing.defaultPrevented,
      repeatedPrevented: repeated.defaultPrevented,
    };
  }, MOD === "Meta");
  expect(result).toEqual({ plainPrevented: false, composingPrevented: false, repeatedPrevented: true });
  await expect(page.getByRole("button", { name: "Read", exact: true })).toHaveAttribute("aria-pressed", "true");
});
