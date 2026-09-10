// Prototype-B presentation contract. These checks complement behavior tests:
// the title/content alignment, type scale and control geometry must look
// intentional, not merely exist. Uses only the isolated daemon fixture.
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures/cortex-server.ts";

const TITLE = "Keep agent handoffs clear and actionable";
const BODY = `## Outcome

A reviewer can open a task, understand the intended outcome, and find the next decision without reconstructing the conversation. Keep the document and its agent updates connected.

> Review question: Should routine updates stay beside the document, or move into its activity section?

## Decisions

- **One source of truth.** Keep the task description in Markdown; presentation should not rewrite its content.
- **Keep provenance visible.** An update should retain its author and time, even when its body is collapsed.
- **Separate reading from writing.** Selecting text should not accidentally start an edit.

## Work breakdown

### Make the handoff scannable

- [x] Gather the review questions
- [ ] Make the next decision easy to find

\`\`\`ts
const nextStep = "Review the document";
console.log(nextStep);
\`\`\`

## Validation

| Surface | Expectation |
| --- | --- |
| Reading | Comfortable text and a clear hierarchy |
| Activity | Updates stay with the document |

## Open questions

What needs a human decision before the next implementation step?
`;

async function post(url: string, path: string, body: object): Promise<Response> {
  const response = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Fixture ${path}: ${response.status} ${await response.text()}`);
  return response;
}

async function seed(url: string): Promise<number> {
  await post(url, "/api/lanes", { name: "cortex", color: "#ed8e60" });
  const response = await post(url, "/api/tasks", {
    lane: "cortex",
    title: TITLE,
    body: BODY,
    status: "review",
    priority: 1,
  });
  const { id } = (await response.json()) as { id: number };
  for (const [name, color] of [
    ["plan", "#8b5cf6"],
    ["ux", "#ed8e60"],
  ]) {
    await post(url, "/api/tags", { name, color });
  }
  const tagged = await fetch(`${url}/api/tasks/${id}/tags`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ set: ["plan", "ux"] }),
  });
  if (!tagged.ok) throw new Error(`Fixture tags: ${tagged.status}`);
  await post(url, "/api/tasks", { lane: "cortex", title: "Keyboard navigation audit", status: "blocked", priority: 0 });
  await post(url, "/api/tasks", { lane: "cortex", title: "Document the release checklist", status: "open" });
  await post(url, `/api/tasks/${id}/updates`, {
    author: "implementer-a1b2c3d4",
    summary: "The document and updates now share a workspace.",
  });
  await post(url, `/api/tasks/${id}/updates`, {
    author: "reviewer-a1b2c3d4",
    summary: "One decision left before approval",
    body: "## Review note\n\nThe document is ready to discuss. Keep **agent activity** readable without losing the task context.\n\n- Review the open question.\n- Keep the next step explicit.",
  });
  return id;
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `tmp/screenshots/polish/${name}.png`, animations: "disabled" });
}

for (const theme of ["light", "dark"] as const) {
  test(`unset priority has a dotted affordance and preserves editing geometry (${theme})`, async ({ url, page }) => {
    await seed(url);
    const response = await post(url, "/api/tasks", { lane: "cortex", title: "Choose a priority" });
    const { id } = (await response.json()) as { id: number };
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`${url}/task/${id}`);
      const unset = page.getByRole("button", { name: "Set priority", exact: true });
      await expect(unset).toHaveCSS("border-top-style", "dotted");
      await expect(unset).toHaveCSS("cursor", "pointer");
      await page.mouse.move(1, 1);
      const idle = await unset.evaluate(element => ({
        color: getComputedStyle(element).borderTopColor,
        background: getComputedStyle(element).backgroundColor,
      }));
      expect(idle.color).not.toBe("rgba(0, 0, 0, 0)");
      await page
        .locator(".task-header")
        .screenshot({ path: `tmp/screenshots/polish/unset-priority-${theme}-${width}.png`, animations: "disabled" });
      await unset.hover();
      expect(await unset.evaluate(element => getComputedStyle(element).borderTopColor)).not.toBe(idle.color);
      expect(await unset.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(idle.background);
      await unset.focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      await expect(unset).toBeFocused();
      await expect(unset).toHaveCSS("outline-style", "solid");
      const before = await unset.boundingBox();
      await unset.click();
      const input = page.getByRole("spinbutton", { name: "Priority", exact: true });
      await expect(input).toBeFocused();
      await expect(input).toHaveCSS("border-top-style", "solid");
      const editing = await input.boundingBox();
      expect(editing?.width).toBe(before?.width);
      expect(editing?.height).toBe(before?.height);
      await input.fill("2");
      await input.press("Enter");
      const assigned = page.locator(".task-header button.priority-chip");
      await expect(assigned).toContainText("P2");
      await expect(assigned).not.toHaveCSS("border-top-style", "dotted");
      await assigned.click();
      await input.fill("");
      await input.press("Enter");
      await expect(unset).toHaveCSS("border-top-style", "dotted");
    }
  });

  test(`prototype B: document hierarchy and matching controls (${theme})`, async ({ url, page }) => {
    const id = await seed(url);
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto(`${url}/task/${id}`);
    await expect(page.locator(".doc-reader .markdown-view h2").first()).toHaveText("Outcome");
    await shot(page, `desktop-${theme}-read`);

    const metrics = await page.evaluate(() => {
      const title = document.querySelector<HTMLElement>(".task-title-display");
      const head = document.querySelector<HTMLElement>(".task-header");
      const prose = document.querySelector<HTMLElement>(".doc-reader .markdown-view");
      const tabs = document.querySelector<HTMLElement>(".doc-tabs");
      const sidebar = document.querySelector<HTMLElement>(".sidebar-pane");
      if (!title || !head || !prose || !tabs || !sidebar) throw new Error("Missing workspace surface");
      return {
        titleSize: parseFloat(getComputedStyle(title).fontSize),
        titleTop: title.getBoundingClientRect().top,
        tabsBottom: tabs.getBoundingClientRect().bottom,
        headLeft: head.getBoundingClientRect().left,
        proseLeft: prose.getBoundingClientRect().left,
        proseWidth: prose.getBoundingClientRect().width,
        sidebarRight: sidebar.getBoundingClientRect().right,
      };
    });
    expect(metrics.titleSize).toBeGreaterThanOrEqual(28);
    expect(metrics.titleTop).toBeGreaterThan(metrics.tabsBottom + 24);
    expect(Math.abs(metrics.headLeft - metrics.proseLeft)).toBeLessThanOrEqual(1);
    expect(metrics.proseLeft - metrics.sidebarRight).toBeGreaterThanOrEqual(64);
    expect(metrics.proseWidth).toBeLessThanOrEqual(760);
    await expect(page.locator(".sidebar-brand")).toContainText("cortex");
    await expect(page.getByRole("button", { name: "Filter by tags", exact: true })).toContainText("Tags");
    await expect(page.locator(".task-row.active .task-row-meta")).toContainText("In review");
    for (const [kind, label] of [
      ["status", "Status filter"],
      ["lane", "Lane filter"],
      ["tags", "Filter by tags"],
    ]) {
      await page.getByRole("button", { name: label, exact: true }).click();
      await expect(page.locator(".sidebar-filter-panel")).toBeVisible();
      await expect(page.locator("dialog[open]")).toHaveCount(0);
      await shot(page, `desktop-${theme}-filter-${kind}`);
      await page.keyboard.press("Escape");
    }

    const lane = page.locator(".task-header .lane-chip-button");
    const priority = page.locator(".task-header button.priority-chip");
    const before = await priority.boundingBox();
    const laneBox = await lane.boundingBox();
    if (!before || !laneBox) throw new Error("Missing property controls");
    expect(before.height).toBe(laneBox.height);
    expect(before.height).toBeGreaterThanOrEqual(30);
    await priority.click();
    const input = page.locator(".task-header input.priority-chip-input");
    await expect(input).toBeFocused();
    const during = await input.boundingBox();
    if (!during) throw new Error("Missing priority input");
    expect(during.height).toBe(before.height);
    expect(during.width).toBe(before.width);
    await input.press("Escape");

    for (const [kind, name] of [
      ["status", "Status filter"],
      ["lane", "Lane filter"],
      ["tags", "Filter by tags"],
    ]) {
      await page.getByRole("button", { name, exact: true }).click();
      await expect(page.locator(".sidebar-filter-panel")).toBeVisible();
      await expect(page.locator("dialog[open]")).toHaveCount(0);
      const surfaceRadius = await page
        .locator(".sidebar-filter-surface")
        .evaluate(element => parseFloat(getComputedStyle(element).borderTopLeftRadius));
      expect(surfaceRadius).toBeGreaterThanOrEqual(12);
      if (kind === "tags") {
        const rounded = await page.getByRole("button", { name, exact: true }).evaluate(element => ({
          radius: parseFloat(getComputedStyle(element).borderTopLeftRadius),
          height: element.getBoundingClientRect().height,
        }));
        expect(rounded.radius).toBeGreaterThanOrEqual(rounded.height / 2);
      }
      await shot(page, `desktop-${theme}-sidebar-${kind}`);
      await page.keyboard.press("Escape");
    }

    await page.locator(".task-document").evaluate(node => {
      (node as HTMLElement).dataset.presentationIdentity = "same-document";
    });
    await page.getByRole("button", { name: "Focus reading", exact: true }).click();
    await expect(page.locator(".sidebar-pane")).toHaveCount(0);
    await expect(page.locator(".task-document")).toHaveAttribute("data-presentation-identity", "same-document");
    await shot(page, `desktop-${theme}-focus`);
    await page.getByRole("button", { name: "Show navigation", exact: true }).click();
    await expect(page.locator(".sidebar-pane")).toHaveCount(1);
    await expect(page.locator(".task-document")).toHaveAttribute("data-presentation-identity", "same-document");

    await page.getByRole("tab", { name: "Activity", exact: true }).click();
    await page.locator(".update-card-toggle").first().click();
    await expect(page.locator(".update-card-body .markdown-view h2")).toHaveText("Review note");
    await page.locator(".post-update-toggle").click();
    await expect(page.getByLabel("Update summary", { exact: true })).toBeVisible();
    await shot(page, `desktop-${theme}-activity`);
    const activity = await page.locator(".activity-thread").boundingBox();
    const header = await page.locator(".task-header").boundingBox();
    if (!activity || !header) throw new Error("Missing activity surface");
    expect(Math.abs(activity.x - header.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(activity.width - header.width)).toBeLessThanOrEqual(1);
    expect(activity.width).toBeLessThanOrEqual(760);
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`narrow controls, metadata sheets, and attached sidebar filters stay bounded (${theme})`, async ({
    url,
    page,
  }) => {
    const id = await seed(url);
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: theme });
    for (const [width, height] of [
      [320, 740],
      [390, 844],
      [768, 900],
      [844, 390],
    ]) {
      await page.setViewportSize({ width, height });
      await page.goto(`${url}/task/${id}`);
      await expect(page.locator(".task-title-display")).toHaveText(TITLE);
      await shot(page, `mobile-${theme}-${width}-read`);
      await page.getByRole("button", { name: "Add tags", exact: true }).click();
      const picker = page.locator(".popover.tag-picker");
      await expect(picker).toBeVisible();
      const bounds = await picker.boundingBox();
      if (!bounds) throw new Error("Missing tag picker");
      expect(bounds.x).toBeGreaterThanOrEqual(8);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width - 8);
      expect(bounds.width).toBeGreaterThanOrEqual(width - 32);
      expect(bounds.y).toBeGreaterThanOrEqual(8);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(height - 8);
      const row = await picker.locator(".tag-picker-row").first().boundingBox();
      if (!row) throw new Error("Missing picker row");
      expect(row.height).toBeGreaterThanOrEqual(44);
      await shot(page, `mobile-${theme}-${width}-picker`);
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Open navigation", exact: true }).click();
      const drawer = page.getByRole("dialog", { name: "Navigation", exact: true });
      await expect(drawer).toBeVisible();
      await drawer.getByRole("button", { name: "Filter by tags", exact: true }).click();
      const filter = drawer.locator(".sidebar-filter-panel");
      await expect(filter).toBeVisible();
      // The existing navigation drawer remains the only modal layer. Its
      // filter is attached to the sidebar, not another centered dialog/sheet.
      await expect(page.locator("dialog[open]")).toHaveCount(1);
      await expect(filter.locator("dialog, .modal, .overlay")).toHaveCount(0);
      const filterBox = await filter.boundingBox();
      const searchBox = await drawer.locator(".ws-search").boundingBox();
      if (!filterBox || !searchBox) throw new Error("Missing attached filter geometry");
      expect(filterBox.y).toBeGreaterThanOrEqual(8);
      expect(filterBox.y + filterBox.height).toBeLessThanOrEqual(height - 8);
      expect(Math.abs(filterBox.x - searchBox.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(filterBox.width - searchBox.width)).toBeLessThanOrEqual(1);
      await expect(filter.getByRole("button", { name: "Done", exact: true })).toBeVisible();
      await shot(page, `mobile-${theme}-${width}-filters`);
      await page.keyboard.press("Escape");
      await expect(filter).toHaveCount(0);
      await expect(drawer).toBeVisible();
      await expect(drawer.getByRole("button", { name: "Filter by tags", exact: true })).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    }
  });
}
