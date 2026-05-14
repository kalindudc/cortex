// Cardinal-flow e2e tests against a real cortex daemon.
//
// Every test owns an isolated daemon (per-test tmpdir + random port + clean
// DB) via the cortex-server fixture. The fresh DB has NO lanes — most tests
// seed one via the HTTP API before touching the UI so we're testing the UI
// path, not the empty-state path. The empty-state path is its own test.
//
// Selectors mirror the components' real class names (verified by reading
// src/ui/components/**/*.tsx). Where multiple flows could plausibly produce
// the same visible text, we narrow the locator with .first() / role / etc.
//
// page.waitForTimeout is BANNED in this file — all assertions go through
// Playwright auto-waiting locators (toBeVisible / toHaveText / toContainText)
// which retry up to actionTimeout (5s, see playwright.config.ts).

import { test, expect } from "./fixtures/cortex-server.ts";

/** Seed a lane via the REST API so the UI has somewhere to put tasks. */
async function seedLane(url: string, name: string): Promise<void> {
  const r = await fetch(`${url}/api/lanes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) throw new Error(`failed to seed lane ${name}: ${r.status} ${await r.text()}`);
}

/** Seed a task via the REST API. Returns the created task. */
async function seedTask(url: string, lane: string, title: string): Promise<{ id: number; title: string }> {
  const r = await fetch(`${url}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lane, title }),
  });
  if (!r.ok) throw new Error(`failed to seed task: ${r.status} ${await r.text()}`);
  return r.json();
}

test("dashboard boots; sidebar pane + status bar + Tasks-section '+' affordance render", async ({ url, page }) => {
  await page.goto(url);
  // Lanes pane is the canonical left rail.
  await expect(page.locator(".pane-lanes")).toBeVisible();
  // StatusBar is the bottom row (replaced the old new-task input as the
  // canonical "command palette entry" via its clickable hint).
  await expect(page.locator(".status-bar")).toBeVisible();
  // The Tasks section's '+' button is the new entry for task creation.
  await expect(page.locator('button[aria-label="New task"]')).toBeVisible();
});

test("create a task via the Tasks-section '+' button — untitled-<id> appears in the lane list", async ({
  url,
  page,
}) => {
  await seedLane(url, "inbox");
  await page.goto(url);
  // Click the Tasks-section '+' button. Server assigns an id; the title is
  // auto-set to `untitled-<id>` via the two-request POST + PATCH flow in
  // SidebarPane.createUntitledTask.
  await page.locator('button[aria-label="New task"]').click();
  // Auto-wait for the SSE round-trip; assert SOME .task-row with the
  // untitled-<n> shape appears (we don't know the exact id ahead of time).
  await expect(page.locator(".task-row .task-title", { hasText: /^untitled-\d+$/ }).first()).toBeVisible();
});

test("post an update on the active task via the compose form", async ({ url, page }) => {
  await seedLane(url, "inbox");
  await seedTask(url, "inbox", "post-update target");
  await page.goto(url);
  // Click the task row to make it active.
  await page.locator(".task-row", { hasText: "post-update target" }).click();
  await expect(page.locator(".pane-active")).toBeVisible();
  // Compose textarea in the active pane.
  const compose = page.locator(".compose textarea");
  await expect(compose).toBeVisible();
  await compose.fill("first update from e2e");
  // Submit button uses the form's onSubmit; pressing Enter alone would
  // produce a newline (textarea), so click the primary submit.
  await page.locator(".compose-foot button[type=submit]").click();
  // Updates render in the inbox pane (.pane-inbox) under .summary rows, not
  // inline in the active pane. Auto-wait for the SSE round-trip.
  await expect(page.locator(".pane-inbox .summary", { hasText: "first update from e2e" })).toBeVisible();
});

test("change status via the status pill popover", async ({ url, page }) => {
  await seedLane(url, "inbox");
  await seedTask(url, "inbox", "status-change target");
  await page.goto(url);
  await page.locator(".task-row", { hasText: "status-change target" }).click();
  // The status pill is .status-pill in the active header; popover rows are
  // .popover-row with the human label ("In review", not "review" — see
  // src/ui/lib/constants.ts STATUS_LABEL).
  await page.locator(".active-header .status-pill").click();
  await page.locator(".popover-row", { hasText: "In review" }).click();
  // Task row's status dot reflects "review" once the PATCH echoes back.
  await expect(page.locator(".task-row .dot-status-review")).toBeVisible();
});

test("toggle theme via the sun/moon button and reload — theme persists", async ({ url, page }) => {
  await seedLane(url, "inbox");
  await page.goto(url);
  // The ThemeToggle uses aria-label="Switch to <next> mode". The initial
  // mode is "light" so the button label is "Switch to dark mode".
  // After the click, the data-theme attr on <html> flips.
  const toggle = page.locator('button[aria-label^="Switch to"]').first();
  await toggle.click();
  // Auto-wait for data-theme to settle to either "dark" or "system" — the
  // exact next-state depends on ThemeToggle's cycle order; just assert it
  // CHANGED away from the initial "light".
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", "light");
  const themedTo = await page.locator("html").getAttribute("data-theme");
  await page.reload();
  // Theme survives the reload (persisted via localStorage by ThemeToggle).
  if (!themedTo) throw new Error("expected data-theme attribute to be set");
  await expect(page.locator("html")).toHaveAttribute("data-theme", themedTo);
});

test("inline-edit a task title — autosave fires and survives reload", async ({ url, page }) => {
  await seedLane(url, "inbox");
  const t = await seedTask(url, "inbox", "rename-me");
  await page.goto(url);
  await page.locator(".task-row", { hasText: "rename-me" }).click();
  // EditableTaskBody renders the title as <input class="title-input"> inside
  // .pane-active. fill() replaces the value and dispatches onInput, which
  // calls titleSave.schedule().
  const titleInput = page.locator(".pane-active .title-input");
  await expect(titleInput).toBeVisible();
  await titleInput.fill("renamed-by-e2e");
  // Tab away to blur — flushes the autosave debounce immediately.
  await titleInput.press("Tab");
  // Lane-row reflects the new title within the auto-wait window.
  await expect(page.locator(".task-row", { hasText: "renamed-by-e2e" })).toBeVisible();
  // Reload + verify persistence via the API too.
  await page.reload();
  await expect(page.locator(".task-row", { hasText: "renamed-by-e2e" })).toBeVisible();
  const r = await fetch(`${url}/api/tasks`);
  const tasks = (await r.json()) as Array<{ id: number; title: string }>;
  expect(tasks.find(x => x.id === t.id)?.title).toBe("renamed-by-e2e");
});

test("open command palette with Cmd+P / Ctrl+P", async ({ url, page }) => {
  await seedLane(url, "inbox");
  await page.goto(url);
  // The dashboard binds Cmd+P / Ctrl+P globally to open the palette.
  // Playwright keyboard shortcut: Modifier+P. Use Meta on darwin, Control elsewhere.
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${mod}+KeyP`);
  // The palette modal appears as .modal.palette (one of the surfaces with .palette-input).
  await expect(page.locator(".palette-input")).toBeVisible();
  // Esc closes it.
  await page.keyboard.press("Escape");
  await expect(page.locator(".palette-input")).toHaveCount(0);
});

test("tooltip refreshes its text on click without requiring the cursor to move (show-all-tasks toggle)", async ({
  url,
  page,
}) => {
  // The show-all-tasks toggle in the Tasks section header flips its tip
  // text every click ("Include done tasks in the list" ↔ "Hide done tasks
  // from the list"). The tooltip is shown on hover; clicking the button
  // used to leave the OLD text on screen until the cursor left and re-
  // entered. This regression guard asserts the tip text updates in place.
  await seedLane(url, "inbox");
  await page.goto(url);
  // Toggle's aria-label flips between "Show done tasks too" (initial) and
  // "Hide done tasks" (after click). The tip text is more verbose:
  // "Include done tasks in the list" ↔ "Hide done tasks from the list".
  const toggle = page.locator('button[aria-label="Show done tasks too"], button[aria-label="Hide done tasks"]');
  await expect(toggle).toBeVisible();
  await toggle.hover();
  await expect(page.locator(".tooltip-visible")).toContainText("Include done tasks");
  // Click WITHOUT moving the mouse. The button re-renders with the new
  // aria-label / tip text; the global click handler in tooltip.ts
  // dispatches a synthetic mouseenter on rAF, so the tip refreshes in
  // place without the cursor leaving and returning.
  await toggle.click();
  await expect(page.locator(".tooltip-visible")).toContainText("Hide done tasks from the list");
});

test("hover a truncated task title — tooltip appears with full text", async ({ url, page }) => {
  await seedLane(url, "inbox");
  // Title long enough that the lane row will likely truncate it (the
  // .task-title CSS uses ellipsis past ~25ch).
  const longTitle = "this is a deliberately long task title that the lane row will truncate";
  await seedTask(url, "inbox", longTitle);
  await page.goto(url);
  const row = page.locator(".task-row", { hasText: longTitle.slice(0, 20) });
  await expect(row).toBeVisible();
  await row.hover();
  // The tooltip is rendered as .tooltip-visible with the full title text.
  await expect(page.locator(".tooltip-visible")).toContainText(longTitle);
});
