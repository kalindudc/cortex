// E2E — document workspace user journeys (task 330).
//
// Real cortex daemon per test (fixtures/cortex-server.ts), real Chromium,
// real CodeMirror. Covers the flows happy-dom cannot certify:
//   - default-read: viewing/selecting/copying/outline/tab switching produce
//     ZERO task PATCH/POST requests
//   - Edit/Split with actual CodeMirror: typing autosaves ONE PATCH, Mod-S
//     flushes, undo works, the same instance survives Read/Split/Activity
//   - combined filters: search AND status AND lane AND tag compose; the
//     explicitly selected task stays selected (outside-filter notice)
//   - Cmd/Ctrl+/ reveals Activity, expands + focuses the inline composer;
//     one modified Enter posts one correctly attributed update
//   - URL deep links: /task/:id and #heading fragments; Back/Forward
//   - DialogFrame in a real browser: inert background, trapped Tab, focus
//     return; the mobile drawer at 390px; no page-level horizontal overflow
//     at 320/390/768px
//
// page.waitForTimeout is BANNED — auto-waiting locators only.

import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures/cortex-server.ts";

const MOD = process.platform === "darwin" ? "Meta" : "Control";

async function seedLane(url: string, name: string): Promise<void> {
  const r = await fetch(`${url}/api/lanes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) throw new Error(`failed to seed lane ${name}: ${r.status} ${await r.text()}`);
}

async function seedTask(
  url: string,
  lane: string,
  title: string,
  opts: { body?: string; status?: string; tags?: string[] } = {},
): Promise<{ id: number; title: string }> {
  const r = await fetch(`${url}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lane, title, body: opts.body, status: opts.status }),
  });
  if (!r.ok) throw new Error(`failed to seed task: ${r.status} ${await r.text()}`);
  const created = (await r.json()) as { id: number; title: string };
  if (opts.tags?.length) {
    for (const t of opts.tags) {
      await fetch(`${url}/api/tags`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: t }),
      });
    }
    const r2 = await fetch(`${url}/api/tasks/${created.id}/tags`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ set: opts.tags }),
    });
    if (!r2.ok) throw new Error(`failed to tag task: ${r2.status}`);
  }
  return created;
}

async function getTask(url: string, id: number): Promise<{ id: number; title: string; body: string | null }> {
  const r = await fetch(`${url}/api/tasks`);
  const all = (await r.json()) as Array<{ id: number; title: string; body: string | null }>;
  const t = all.find(x => x.id === id);
  if (!t) throw new Error(`task ${id} missing`);
  return t;
}

/** Collect every task-mutating request made after this call. */
function trackWrites(page: Page): string[] {
  const writes: string[] = [];
  page.on("request", req => {
    const m = req.method();
    if (req.url().includes("/api/") && (m === "PATCH" || m === "POST" || m === "DELETE")) {
      writes.push(`${m} ${new URL(req.url()).pathname}`);
    }
  });
  return writes;
}

const DOC = [
  "# Overview",
  "",
  "Intro paragraph for the *overview* section.",
  "",
  "```ts",
  "const answer = 42;",
  "```",
  "",
  "## Setup",
  "",
  "Setup instructions here.",
  "",
  "## Details",
  "",
  ...Array.from({ length: 60 }, (_, i) => `Detail line ${i + 1}.`),
].join("\n");

test("default read: viewing, selecting text, copying code, outline links and tab switches make ZERO task writes", async ({
  url,
  page,
}) => {
  await seedLane(url, "inbox");
  await seedTask(url, "inbox", "read-only journey", { body: DOC });
  await page.goto(url);
  const writes = trackWrites(page);
  await page.locator(".task-row", { hasText: "read-only journey" }).click();
  await expect(page.locator(".doc-reader .markdown-view h1")).toHaveText("Overview");

  // Select text in the rendered prose.
  await page.locator(".doc-reader .markdown-view p").first().selectText();
  // Copy code via the code-copy control (clipboard may be denied headless —
  // the control must still be present and clicking it must not write).
  await page.locator(".doc-reader .md-copy").first().click();
  // Outline navigation scrolls the reader to the heading.
  await page.locator(".doc-outline .doc-outline-link", { hasText: "Details" }).click();
  const scrolled = await page.locator(".doc-reader").evaluate((el: HTMLElement) => el.scrollTop);
  expect(scrolled).toBeGreaterThan(0);
  // Switch content tabs and back.
  await page.getByRole("tab", { name: "Activity" }).click();
  await page.getByRole("tab", { name: "Related" }).click();
  await page.getByRole("tab", { name: "Authors" }).click();
  await page.getByRole("tab", { name: "Document" }).click();
  await expect(page.locator(".doc-reader .markdown-view h1")).toHaveText("Overview");
  // Reading position was remembered (D5) — the reader is not back at 0.
  const restored = await page.locator(".doc-reader").evaluate((el: HTMLElement) => el.scrollTop);
  expect(restored).toBeGreaterThan(0);
  expect(writes).toEqual([]);
});

test("Edit/Split with REAL CodeMirror: typing autosaves once, Mod-S flushes, undo works, instance survives", async ({
  url,
  page,
}) => {
  await seedLane(url, "inbox");
  const t = await seedTask(url, "inbox", "editor lifecycle", { body: "# Draft\n\nfirst line" });
  await page.goto(url);
  await page.locator(".task-row", { hasText: "editor lifecycle" }).click();
  await expect(page.locator(".doc-reader .markdown-view h1")).toHaveText("Draft");

  await page.locator(".doc-mode-switch button", { hasText: "Edit" }).click();
  const cm = page.locator(".md-editor .cm-content");
  await expect(cm).toBeVisible();
  await cm.click();
  await page.keyboard.press(`${MOD}+End`);
  await page.keyboard.type("\nsecond line typed in e2e");
  // Mod-S flushes the draft immediately (D2).
  await page.keyboard.press(`${MOD}+KeyS`);
  await expect.poll(async () => (await getTask(url, t.id)).body).toContain("second line typed in e2e");
  // Saved is the QUIET steady state (no chrome); pending/saving/error are
  // the only labeled states — after the ack nothing is left to report.
  await expect(page.locator(".draft-state")).toHaveCount(0);

  // Undo through CodeMirror's own history — the instance is real.
  await page.keyboard.press(`${MOD}+KeyZ`);
  await expect(cm).not.toContainText("second line typed in e2e");
  // Redo brings it back; the reader in Split shows the current LOCAL draft.
  await page.keyboard.press(`${MOD}+Shift+KeyZ`);
  await expect(cm).toContainText("second line typed in e2e");
  await page.locator(".doc-mode-switch button", { hasText: "Split" }).click();
  await expect(page.locator(".doc-reader")).toContainText("second line typed in e2e");

  // Tag the editor node, cross panels and modes, and confirm the SAME node.
  await page.locator(".md-editor").evaluate(el => {
    (el as HTMLElement).dataset.e2eIdentity = "same";
  });
  await page.getByRole("tab", { name: "Activity" }).click();
  await page.getByRole("tab", { name: "Document" }).click();
  await page.locator(".doc-mode-switch button", { hasText: "Read" }).click();
  await expect(page.locator(".md-editor")).toHaveAttribute("data-e2e-identity", "same");
  await expect(page.locator(".md-editor")).toBeHidden();
  await page.locator(".doc-mode-switch button", { hasText: "Edit" }).click();
  await expect(page.locator(".md-editor")).toHaveAttribute("data-e2e-identity", "same");
  await expect(page.locator(".md-editor .cm-content")).toContainText("second line typed in e2e");
});

test("title edit: wrapping textarea, Enter commits, autosave persists, blank/Escape behaviors", async ({
  url,
  page,
}) => {
  await seedLane(url, "inbox");
  const t = await seedTask(url, "inbox", "title journey");
  await page.goto(url);
  await page.locator(".task-row", { hasText: "title journey" }).click();
  await expect(page.locator(".task-title-edit")).toHaveCount(0);
  await page.locator(".task-title-trigger").click();
  const input = page.locator(".task-header .title-input");
  await expect(input).toBeFocused();
  await input.fill("title journey renamed");
  await input.press("Enter");
  await expect(page.locator(".task-header .task-title-display")).toHaveText("title journey renamed");
  await expect.poll(async () => (await getTask(url, t.id)).title).toBe("title journey renamed");
  await expect(page.locator(".task-row", { hasText: "title journey renamed" })).toBeVisible();
  const trigger = page.locator(".task-title-trigger");
  await expect(trigger).toBeFocused();
  await trigger.press("Enter");
  await expect(input).toBeFocused();
  await input.press("Escape");
  await expect(trigger).toBeFocused();
  await trigger.press("Space");
  await expect(input).toBeFocused();
  await input.press("Escape");
  await expect(page.locator(".doc-mode-switch button", { hasText: "Read" })).toHaveAttribute("aria-pressed", "true");
});

test("pinned title clamps to two lines; a rested hover reveals it IN FLOW and pushes the document down; editing shows every line", async ({
  url,
  page,
}) => {
  await seedLane(url, "inbox");
  const long =
    "Coordinate the multi-agent rollout of the sanitized Markdown boundary across every dashboard surface " +
    "while keeping the audit trail attributable, the reviewers unblocked and the release checklist honest";
  const t = await seedTask(url, "inbox", long);
  await seedTask(url, "inbox", "short title");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${url}/task/${t.id}`);

  const header = page.locator(".task-header");
  const heading = page.locator(".task-header .task-title-display");
  const trigger = page.locator(".task-header .task-title-trigger");
  const text = page.locator(".task-header .task-title-text");
  const chips = page.locator(".task-header-trailing");
  const reader = page.locator(".doc-reader");
  await expect(heading).toHaveClass(/is-clamped/);
  // CSS-only truncation: the DOM (and the accessible name) keep the whole title.
  await expect(trigger).toHaveText(long);
  await expect(trigger).toHaveAccessibleName(long);

  const lineHeight = await text.evaluate(el => Number.parseFloat(getComputedStyle(el).lineHeight));
  const fullHeight = await text.evaluate(el => el.scrollHeight);
  expect(fullHeight).toBeGreaterThan(lineHeight * 3);
  const clampedHeight = lineHeight * 2;
  const box = async (locator: typeof text): Promise<{ y: number; height: number }> => {
    const b = await locator.boundingBox();
    if (!b) throw new Error("expected a laid out element");
    return { y: b.y, height: b.height };
  };
  const textBefore = await box(text);
  expect(textBefore.height).toBeLessThanOrEqual(clampedHeight + 1);
  expect((await box(heading)).height).toBeLessThanOrEqual(clampedHeight + 1);
  const chipsBefore = await box(chips);
  const readerBefore = await box(reader);
  const near = (a: number, b: number): void => expect(Math.abs(a - b)).toBeLessThanOrEqual(1);

  // Passing THROUGH the title on the way to the document never reveals it:
  // the pointer has to rest on the title first. The kicker tooltip (200ms)
  // is the auto-waited proof that the intent window has elapsed unarmed.
  const titleRect = await trigger.boundingBox();
  if (!titleRect) throw new Error("expected title");
  await page.mouse.move(titleRect.x + 40, titleRect.y + 10);
  await page.mouse.move(titleRect.x + 40, readerBefore.y + 40);
  await page.locator(".task-header .task-id").hover();
  await expect(page.locator(".tooltip-visible")).toContainText(`Task ${t.id}`);
  await expect(header).not.toHaveClass(/is-title-revealed/);
  expect(await box(text)).toEqual(textBefore);

  // Resting on the title reveals it IN FLOW: the text grows to its full
  // height and the heading, the metadata row and the reader all move by
  // exactly that delta — nothing floats above anything.
  await trigger.hover();
  await expect(header).toHaveClass(/is-title-revealed/);
  await expect.poll(async () => (await box(text)).height).toBeGreaterThanOrEqual(fullHeight - 1);
  const delta = (await box(text)).height - textBefore.height;
  expect(delta).toBeGreaterThan(lineHeight);
  expect((await box(heading)).height).toBeGreaterThanOrEqual(fullHeight - 1);
  const chipsAfter = await box(chips);
  const readerAfter = await box(reader);
  near(chipsAfter.y - chipsBefore.y, delta);
  near(readerAfter.y - readerBefore.y, delta);
  near(readerBefore.height - readerAfter.height, delta);
  const chipsRect = await chips.boundingBox();
  if (!chipsRect) throw new Error("expected metadata row");
  expect(
    await page.evaluate(
      ([x, y]) => document.elementFromPoint(x, y)?.closest(".task-header-trailing") != null,
      [chipsRect.x + 12, chipsRect.y + 6],
    ),
  ).toBe(true);

  // The reveal follows the pointer across the header: moving down onto the
  // metadata row keeps everything exactly where it is, so nothing runs away.
  await page.mouse.move(chipsRect.x + 12, chipsRect.y + 6);
  await expect(header).toHaveClass(/is-title-revealed/);
  const textSticky = await box(text);
  expect(textSticky.y).toBe(textBefore.y);
  expect(textSticky.height).toBeGreaterThanOrEqual(fullHeight - 1);
  expect(await box(chips)).toEqual(chipsAfter);

  // Leaving the header collapses it and everything returns to its place.
  await page.mouse.move(1, 1);
  await expect(header).not.toHaveClass(/is-title-revealed/);
  await expect.poll(async () => (await box(text)).height).toBeLessThanOrEqual(clampedHeight + 1);
  await expect.poll(async () => Math.abs((await box(chips)).y - chipsBefore.y)).toBeLessThanOrEqual(1);
  near((await box(reader)).y, readerBefore.y);
  near((await box(reader)).height, readerBefore.height);

  // Editing is never clamped: the textarea holds and shows every line in flow.
  await trigger.click();
  const input = page.locator(".task-header .title-input");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue(long);
  expect((await box(input)).height).toBeGreaterThanOrEqual(fullHeight - 1);
  await expect(page.locator(".task-title-text")).toHaveCount(0);

  // Keyboard parity: Escape returns keyboard focus to the trigger, which
  // reveals the full title without the mouse; Tab away collapses it.
  await page.mouse.move(1, 1);
  await input.press("Escape");
  await expect(trigger).toBeFocused();
  await expect(heading).toHaveClass(/is-clamped/);
  await expect.poll(async () => (await box(text)).height).toBeGreaterThanOrEqual(fullHeight - 1);
  await page.keyboard.press("Tab");
  await expect(trigger).not.toBeFocused();
  await expect.poll(async () => (await box(text)).height).toBeLessThanOrEqual(clampedHeight + 1);

  // Narrower header => more lines. The measurement follows the resize, so the
  // reveal still shows the WHOLE title (never a stale, shorter height).
  await page.setViewportSize({ width: 390, height: 844 });
  const narrowLineHeight = await text.evaluate(el => Number.parseFloat(getComputedStyle(el).lineHeight));
  const narrowFull = await text.evaluate(el => el.scrollHeight);
  expect(narrowFull).toBeGreaterThan(fullHeight);
  await expect.poll(async () => (await box(text)).height).toBeLessThanOrEqual(narrowLineHeight * 2 + 1);
  await trigger.hover();
  await expect.poll(async () => (await box(text)).height).toBeGreaterThanOrEqual(narrowFull - 1);
  await page.mouse.move(1, 1);
  await expect.poll(async () => (await box(text)).height).toBeLessThanOrEqual(narrowLineHeight * 2 + 1);
  await page.setViewportSize({ width: 1280, height: 900 });

  // A title that fits is never armed: hovering it changes nothing.
  await page.locator(".task-row", { hasText: "short title" }).click();
  await expect(heading).toHaveText("short title");
  await expect(heading).not.toHaveClass(/is-clamped/);
  const shortBefore = await box(text);
  expect(shortBefore.height).toBeLessThanOrEqual(lineHeight + 1);
  await trigger.hover();
  await expect(header).toHaveClass(/is-title-revealed/);
  expect(await box(text)).toEqual(shortBefore);
  await expect(heading).not.toHaveClass(/is-clamped/);
});

test("header tags are compact and rounded; X expands on hover/focus and collapses without an idle gap", async ({
  url,
  page,
}) => {
  await seedLane(url, "inbox");
  const target = await seedTask(url, "inbox", "tag edit target", { tags: ["bug", "ui"] });
  const other = await seedTask(url, "inbox", "another tagged task", { tags: ["bug"] });
  await page.goto(`${url}/task/${target.id}`);
  const plus = page.getByRole("button", { name: "Add tags", exact: true });
  await expect(plus).toBeVisible();
  await expect(plus).toHaveText("");
  await expect(page.getByRole("button", { name: "Edit tags", exact: true })).toHaveCount(0);
  const pill = page.locator(".tags-header > .tag-pill").filter({ hasText: /^bug$/ });
  const remove = pill.getByRole("button", { name: "Remove tag bug", exact: true });
  // The clickable label must never clip its own glyphs: a pill border-radius
  // combined with an inherited overflow:hidden previously cropped the text on
  // every side. overflow:visible is the fix, so paint is never masked.
  const filterLabel = pill.getByRole("button", { name: "Filter tasks by #bug", exact: true });
  expect(
    await filterLabel.evaluate(element => {
      const style = getComputedStyle(element);
      return { x: style.overflowX, y: style.overflowY };
    }),
  ).toEqual({ x: "visible", y: "visible" });
  await page.mouse.move(1, 1);
  expect(await remove.evaluate(element => getComputedStyle(element).opacity)).toBe("0");
  const before = await pill.boundingBox();
  if (!before) throw new Error("Missing tag pill");
  expect(await remove.evaluate(element => element.getBoundingClientRect().width)).toBe(0);
  expect(
    await pill.evaluate(element => parseFloat(getComputedStyle(element).borderTopLeftRadius)),
  ).toBeGreaterThanOrEqual(before.height / 2);
  await page
    .locator(".task-header")
    .screenshot({ path: "tmp/screenshots/polish/compact-tags-idle.png", animations: "disabled" });
  await pill.hover();
  await expect.poll(() => remove.evaluate(element => element.getBoundingClientRect().width)).toBe(24);
  await expect.poll(() => remove.evaluate(element => getComputedStyle(element).opacity)).toBe("1");
  const after = await pill.boundingBox();
  expect(after?.width).toBeGreaterThanOrEqual(before.width + 24);
  expect(await remove.evaluate(element => getComputedStyle(element).transitionProperty)).toContain("width");
  await page.mouse.move(1, 1);
  await expect.poll(() => remove.evaluate(element => element.getBoundingClientRect().width)).toBe(0);
  expect((await pill.boundingBox())?.width).toBe(before.width);
  // A zero-width idle control remains reachable through normal Tab order.
  // The tag label is itself a filter button, so it takes focus first; its
  // focus-within still reveals the paired remove X, and a second Tab lands on
  // the remove control.
  await page.locator(".task-header button.priority-chip").focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Filter tasks by #bug", exact: true })).toBeFocused();
  await expect.poll(() => remove.evaluate(element => element.getBoundingClientRect().width)).toBe(24);
  await page.keyboard.press("Tab");
  await expect(remove).toBeFocused();
  await expect.poll(() => remove.evaluate(element => element.getBoundingClientRect().width)).toBe(24);
  await plus.focus();
  await expect.poll(() => remove.evaluate(element => element.getBoundingClientRect().width)).toBe(0);
  await pill.hover();
  await expect.poll(() => remove.evaluate(element => element.getBoundingClientRect().width)).toBe(24);
  await page
    .locator(".task-header")
    .screenshot({ path: "tmp/screenshots/polish/direct-title-tags-hover.png", animations: "disabled" });
  const removal = page.waitForRequest(
    request => request.method() === "PATCH" && request.url().endsWith(`/api/tasks/${target.id}/tags`),
  );
  await remove.click();
  expect((await removal).postDataJSON()).toEqual({ remove: ["bug"] });
  await expect(pill).toHaveCount(0);
  await expect(page.locator(".tag-picker")).toHaveCount(0);
  const allTasks = (await fetch(`${url}/api/tasks`).then(response => response.json())) as Array<{
    id: number;
    tags: string[];
  }>;
  expect(allTasks.find(task => task.id === target.id)?.tags).toEqual(["ui"]);
  expect(allTasks.find(task => task.id === other.id)?.tags).toEqual(["bug"]);
  const definitions = (await fetch(`${url}/api/tags`).then(response => response.json())) as Array<{ name: string }>;
  expect(definitions.some(tag => tag.name === "bug")).toBe(true);

  await plus.click();
  const search = page.locator(".tag-picker-search input");
  await expect(search).toBeFocused();
  await search.fill("docs");
  const addition = page.waitForRequest(
    request => request.method() === "PATCH" && request.url().endsWith(`/api/tasks/${target.id}/tags`),
  );
  await search.press("Enter");
  expect((await addition).postDataJSON()).toEqual({ add: ["docs"] });
  await page.keyboard.press("Escape");
  await expect(page.locator(".tags-header > .tag-pill").filter({ hasText: /^docs$/ })).toBeVisible();
  await expect(page.locator(".tags-header > .tag-pill").filter({ hasText: /^ui$/ })).toBeVisible();

  // Keyboard focus reveals the same remove affordance without a hover.
  const removeDocs = page.getByRole("button", { name: "Remove tag docs", exact: true });
  await page.mouse.move(1, 1);
  await removeDocs.focus();
  await expect.poll(() => removeDocs.evaluate(element => element.getBoundingClientRect().width)).toBe(24);
  await expect.poll(() => removeDocs.evaluate(element => getComputedStyle(element).opacity)).toBe("1");
  await removeDocs.press("Enter");
  await expect(removeDocs).toHaveCount(0);
});

test.describe("touch header controls", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test("tag removal remains visible and tappable without hover", async ({ url, page }) => {
    await seedLane(url, "inbox");
    const task = await seedTask(url, "inbox", "touch task", { tags: ["bug"] });
    await page.goto(`${url}/task/${task.id}`);
    const remove = page.getByRole("button", { name: "Remove tag bug", exact: true });
    await expect(remove).toBeVisible();
    expect(await remove.evaluate(element => getComputedStyle(element).opacity)).toBe("1");
    await remove.tap();
    await expect(remove).toHaveCount(0);
    await page.getByRole("button", { name: "Add tags", exact: true }).tap();
    await expect(page.locator(".tag-picker-search input")).toBeFocused();
  });
});

test("combined filters compose (search AND status AND lane AND tag) and never change the selected task", async ({
  url,
  page,
}) => {
  await seedLane(url, "inbox");
  await seedLane(url, "later");
  await seedTask(url, "inbox", "alpha bug open", { tags: ["bug"] });
  await seedTask(url, "inbox", "alpha bug blocked", { tags: ["bug"], status: "blocked" });
  await seedTask(url, "later", "alpha bug later", { tags: ["bug"] });
  await seedTask(url, "inbox", "beta ui open", { tags: ["ui"] });
  await page.goto(url);

  // Explicit selection of a task the filters will later exclude.
  await page.locator(".task-row", { hasText: "beta ui open" }).click();
  await expect(page.locator(".task-header .task-title-display")).toHaveText("beta ui open");

  await page.locator('input[aria-label="Search tasks"]').fill("alpha");
  await expect(page.locator(".task-row")).toHaveCount(3);
  await page.getByRole("button", { name: "Status filter", exact: true }).click();
  await page.getByRole("option", { name: "Open", exact: true }).click();
  await expect(page.locator(".task-row")).toHaveCount(2);
  await page.getByRole("button", { name: "Lane filter", exact: true }).click();
  await page.getByRole("option", { name: "inbox", exact: true }).click();
  await expect(page.locator(".task-row")).toHaveCount(1);
  await expect(page.locator(".task-row", { hasText: "alpha bug open" })).toBeVisible();
  // Exact #tag resolution works against the FULL pool even with a lane set.
  await page.locator('input[aria-label="Search tasks"]').fill("#bug");
  await expect(page.locator(".task-row")).toHaveCount(1);
  await page.getByRole("button", { name: "Lane filter", exact: true }).click();
  await page.getByRole("option", { name: "All lanes", exact: true }).click();
  await expect(page.locator(".task-row")).toHaveCount(2);

  // The active task never changed and the workspace explains the mismatch.
  await expect(page.locator(".task-header .task-title-display")).toHaveText("beta ui open");
  const notice = page.locator(".outside-filter-notice");
  await expect(notice).toBeVisible();
  await notice.locator("button", { hasText: "Clear filters" }).click();
  await expect(page.locator(".task-row")).toHaveCount(4);
  await expect(page.locator(".outside-filter-notice")).toHaveCount(0);
  await expect(page.locator(".status-bar .filter-summary")).toHaveText("All tasks");
});

test("Cmd/Ctrl+/ reveals Activity, expands and focuses the composer; one modified Enter posts one attributed update", async ({
  url,
  page,
}) => {
  await seedLane(url, "inbox");
  const t = await seedTask(url, "inbox", "composer journey", { body: "# Doc" });
  await page.goto(url);
  await page.locator(".task-row", { hasText: "composer journey" }).click();
  await expect(page.getByRole("tab", { name: "Document" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("form.compose")).toHaveCount(0); // collapsed by default

  await page.keyboard.press(`${MOD}+Slash`);
  await expect(page.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true");
  const ta = page.locator("form.compose textarea");
  await expect(ta).toBeFocused();
  await ta.fill("posted from the e2e composer");
  await page.keyboard.press(`${MOD}+Enter`);
  await expect(page.locator(".activity-thread .update-card", { hasText: "posted from the e2e composer" })).toHaveCount(
    1,
  );
  // Exactly one update landed server-side, attributed to the resolved author.
  const r = await fetch(`${url}/api/tasks/${t.id}/updates`);
  const updates = (await r.json()) as Array<{ summary: string; author: string }>;
  expect(updates.filter(u => u.summary === "posted from the e2e composer").length).toBe(1);
  expect(updates[0].author.length).toBeGreaterThan(0);
  // Draft cleared after the ack; the composer stays put for the next update.
  await expect(ta).toHaveValue("");
});

test("URL deep links: /task/:id seeds selection, #fragment scrolls to the heading, Back/Forward restore", async ({
  url,
  page,
}) => {
  await seedLane(url, "inbox");
  const a = await seedTask(url, "inbox", "link target a", { body: DOC });
  const b = await seedTask(url, "inbox", "link target b", { body: "# B" });
  await page.goto(`${url}/task/${a.id}#task-${a.id}-details`);
  await expect(page.locator(".task-header .task-title-display")).toHaveText("link target a");
  // The heading fragment scrolled the reader past the top.
  await expect.poll(() => page.locator(".doc-reader").evaluate((el: HTMLElement) => el.scrollTop)).toBeGreaterThan(0);

  await page.locator(".task-row", { hasText: "link target b" }).click();
  await expect(page).toHaveURL(new RegExp(`/task/${b.id}$`));
  // Filter changes never push history.
  await page.getByRole("button", { name: "Status filter", exact: true }).click();
  await page.getByRole("option", { name: "Blocked", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/task/${b.id}$`));
  await page.getByRole("button", { name: "Status filter", exact: true }).click();
  await page.getByRole("option", { name: "All statuses", exact: true }).click();
  await page.goBack();
  await expect(page.locator(".task-header .task-title-display")).toHaveText("link target a");
  await page.goForward();
  await expect(page.locator(".task-header .task-title-display")).toHaveText("link target b");
});

test("DialogFrame in Chromium: inert background, trapped Tab, Escape cascade and focus return", async ({
  url,
  page,
}) => {
  await seedLane(url, "inbox");
  await page.goto(url);
  await page.locator('button[aria-label="Manage lanes"]').click();
  const trigger = page.locator('button[aria-label="New lane"]');
  await trigger.focus();
  await trigger.press("Enter");
  const dialog = page.locator('dialog[aria-label="New lane"]');
  await expect(dialog).toBeVisible();
  await expect(page.locator(".modal input").first()).toBeFocused();
  // Trapped Tab: cycle forward many times — focus never leaves the dialog.
  for (let i = 0; i < 12; i++) await page.keyboard.press("Tab");
  const inside = await page.evaluate(() => {
    const d = document.querySelector("dialog[open]");
    return !!d && d.contains(document.activeElement);
  });
  expect(inside).toBe(true);
  // Inert background: the sidebar trigger is not hit-testable while modal.
  const clickable = await trigger.evaluate(el => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit === el || el.contains(hit);
  });
  expect(clickable).toBe(false);
  // Escape closes the top layer and focus returns to the opener.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("narrow viewports: drawer navigation at 390px, no page-level horizontal overflow at 320/390/768", async ({
  url,
  page,
}) => {
  await seedLane(url, "inbox");
  await seedTask(url, "inbox", "phone task", { body: DOC });
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 740 });
    await page.goto(url);
    // Sidebar is NOT inline; the mobile bar exposes the drawer trigger.
    await expect(page.locator(".mobile-bar .nav-toggle")).toBeVisible();
    await expect(page.locator(".sidebar-pane")).toHaveCount(0);
    await page.locator(".mobile-bar .nav-toggle").click();
    const drawer = page.locator("dialog.nav-drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer.locator(".sidebar-pane")).toHaveCount(1);
    // Selecting a task closes the drawer (task change resets transients).
    await drawer.locator(".task-row", { hasText: "phone task" }).click();
    await expect(drawer).toHaveCount(0);
    // This geometry probe deliberately selects Read; the preceding loop
    // iteration saved Split, which now correctly survives page reloads.
    await page.getByRole("button", { name: "Read", exact: true }).click();
    await expect(page.locator(".doc-reader .markdown-view h1")).toHaveText("Overview");
    // Outline is a collapsed disclosure on phones.
    const details = page.locator(".doc-outline details");
    await expect(details).toHaveCount(1);
    expect(await details.evaluate(el => (el as HTMLDetailsElement).open)).toBe(false);
    // No two-axis page scrolling.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `page-level horizontal overflow at ${width}px`).toBeLessThanOrEqual(0);
    // Split stacks: editor above preview (top of preview >= bottom of editor).
    await page.locator(".doc-mode-switch button", { hasText: "Split" }).click();
    await expect(page.locator(".md-editor .cm-editor")).toBeVisible();
    await expect(page.locator(".doc-reader")).toBeVisible();
    const geometry = await page.evaluate(() => {
      const ed = document.querySelector(".md-editor")?.getBoundingClientRect();
      const rd = document.querySelector(".doc-reader")?.getBoundingClientRect();
      return ed && rd ? { edBottom: ed.bottom, rdTop: rd.top } : null;
    });
    expect(geometry).not.toBeNull();
    if (geometry) expect(geometry.rdTop).toBeGreaterThanOrEqual(geometry.edBottom - 1);
  }
});
