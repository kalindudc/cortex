// E2E coverage for the workspace filtering UX (task 330, W2/W3).
//
// Covers:
//   - The ONE status/view selector drives filters.status
//   - Clear-all button: disabled when none active, enabled + clears on click
//   - Selected-tag tokens (FilterChips) render only for tags; the tag-filter
//     trigger is the single persistent tag-filter entry
//   - Attached tag panel: opened via the "Filter by tags" trigger OR palette
//     "Filter by tags…", multi-select toggle, search filter, summary chips
//   - Multi-tag OR semantics: tasks tagged bug OR ui both visible
//   - Untagged sentinel filters tasks with zero tags
//   - StatusBar mounts at the bottom and reflects filter state
//   - Command palette is fuzzy: "filter tag" matches "Filter by tags…"
//   - Tag-filter placeholder renders as a real ellipsis (regression
//     guard for the JSX-attribute-escape bug)
//
// All assertions go through Playwright auto-waiting locators — no
// page.waitForTimeout (banned per test/e2e/README.md).

import { test, expect } from "./fixtures/cortex-server.ts";

let pageErrors: string[] = [];
test.beforeEach(({ page }) => {
  pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
});
test.afterEach(() => {
  expect(pageErrors).toEqual([]);
});

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
  opts: { status?: "draft" | "open" | "review" | "blocked" | "done"; tags?: string[] } = {},
): Promise<{ id: number }> {
  const r = await fetch(`${url}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lane, title, status: opts.status }),
  });
  if (!r.ok) throw new Error(`failed to seed task: ${r.status} ${await r.text()}`);
  const created = (await r.json()) as { id: number };
  if (opts.tags && opts.tags.length > 0) {
    // Ensure each tag exists first (server's PATCH /api/tasks/:id/tags
    // doesn't auto-create tags).
    for (const t of opts.tags) {
      await fetch(`${url}/api/tags`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: t }),
      });
    }
    const tagsResp = await fetch(`${url}/api/tasks/${created.id}/tags`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ set: opts.tags }),
    });
    if (!tagsResp.ok) throw new Error(`failed to set tags on task ${created.id}: ${tagsResp.status}`);
  }
  return created;
}

test("sidebar mounts SidebarPane + StatusBar with ONE workspace filter surface (no duplicate lane/tag lists)", async ({
  url,
  page,
}) => {
  await seedLane(url, "inbox");
  await page.goto(url);
  await expect(page.locator(".sidebar-pane")).toBeVisible();
  await expect(page.locator(".status-bar")).toBeVisible();
  // W2: one search input, one status selector, one lane selector, one tag
  // filter trigger and Clear all — above the task list. No permanent
  // Views/Lanes sections and no second '+ tag' strip.
  const ws = page.locator(".workspace-filters");
  await expect(ws).toBeVisible();
  await expect(ws.locator('input[aria-label="Search tasks"]')).toHaveCount(1);
  await expect(ws.getByRole("button", { name: "Status filter", exact: true })).toHaveCount(1);
  await expect(ws.getByRole("button", { name: "Lane filter", exact: true })).toHaveCount(1);
  await expect(ws.locator("select")).toHaveCount(0);
  await expect(ws.locator('button[aria-label="Filter by tags"]')).toHaveCount(1);
  await expect(page.locator(".view-row")).toHaveCount(0);
  await expect(page.locator(".filter-chip")).toHaveCount(0);
  await expect(page.locator(".filter-chip-add")).toHaveCount(0);
});

test("sidebar filters are attached nonmodal panels with shared geometry and keyboard selection", async ({
  url,
  page,
}) => {
  await seedLane(url, "inbox");
  await seedTask(url, "inbox", "keyboard task", { tags: ["bug"] });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(url);

  const tagsTrigger = page.getByRole("button", { name: "Filter by tags", exact: true });
  await tagsTrigger.click();
  // Filters are NOT modal: no extra top-layer dialog, overlay or backdrop.
  await expect(page.locator("dialog[open], .overlay")).toHaveCount(0);
  const panel = page.locator(".sidebar-filter-panel");
  await expect(panel).toBeVisible();
  await expect(tagsTrigger).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("searchbox", { name: "Search tags", exact: true })).toBeFocused();
  const searchBox = await page.locator(".ws-search").boundingBox();
  const tagBox = await tagsTrigger.boundingBox();
  const panelBox = await panel.boundingBox();
  if (!searchBox || !tagBox || !panelBox) throw new Error("Missing attached filter geometry");
  expect(Math.abs(panelBox.x - searchBox.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(panelBox.width - searchBox.width)).toBeLessThanOrEqual(1);
  expect(panelBox.y - (tagBox.y + tagBox.height)).toBeGreaterThanOrEqual(0);
  expect(panelBox.y - (tagBox.y + tagBox.height)).toBeLessThanOrEqual(8);
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(tagsTrigger).toBeFocused();
  await expect(page.locator(".status-bar .filter-summary")).toHaveText("All tasks");

  const status = page.getByRole("button", { name: "Status filter", exact: true });
  await status.focus();
  await status.press("ArrowDown");
  await expect(page.getByRole("option", { name: "All statuses", exact: true })).toBeFocused();
  await page.keyboard.press("End");
  await expect(page.getByRole("option", { name: "Done", exact: true })).toBeFocused();
  await expect(page.getByRole("option", { name: "All statuses", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(status).toContainText("Draft");
  await expect(status).toBeFocused();
  await expect(panel).toHaveCount(0);
  await status.press("Space");
  await expect(page.getByRole("option", { name: "Draft", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Space");
  await expect(status).toContainText("Open");

  const lane = page.getByRole("button", { name: "Lane filter", exact: true });
  await lane.press("ArrowUp");
  await expect(page.getByRole("searchbox", { name: "Search lanes", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  await page.keyboard.press("Home");
  await expect(page.getByRole("option", { name: "All lanes", exact: true })).toBeFocused();
  const laneBox = await panel.boundingBox();
  if (!laneBox) throw new Error("Missing lane filter geometry");
  expect(laneBox.x).toBe(panelBox.x);
  expect(laneBox.width).toBe(panelBox.width);
  await page.keyboard.press("Escape");
  await expect(lane).toBeFocused();
});

test("the status selector drives filters.status: choosing 'Blocked' narrows the task list", async ({ url, page }) => {
  await seedLane(url, "inbox");
  await seedTask(url, "inbox", "open task");
  await seedTask(url, "inbox", "blocked task", { status: "blocked" });
  await page.goto(url);

  // Both tasks visible by default ("All statuses", status filter null).
  await expect(page.locator(".task-row", { hasText: "open task" })).toBeVisible();
  await expect(page.locator(".task-row", { hasText: "blocked task" })).toBeVisible();

  // Pick "Blocked" in the ONE status/view selector.
  await page.getByRole("button", { name: "Status filter", exact: true }).click();
  await page.getByRole("option", { name: "Blocked", exact: true }).click();
  await expect(page.locator(".task-row", { hasText: "blocked task" })).toBeVisible();
  await expect(page.locator(".task-row", { hasText: "open task" })).toHaveCount(0);

  // The status bar summary reflects the narrowed view; status has its own
  // visible selector so it does NOT render as a removable token.
  await expect(page.locator(".status-bar .filter-summary")).toContainText("blocked");
  await expect(page.locator(".filter-chip")).toHaveCount(0);

  // 'All statuses' clears ONLY the status slot (W3).
  await page.getByRole("button", { name: "Status filter", exact: true }).click();
  await page.getByRole("option", { name: "All statuses", exact: true }).click();
  await expect(page.locator(".task-row", { hasText: "open task" })).toBeVisible();
});

test("Clear all is disabled when no filters are active and clears every slot (query/status/lane/tags) when clicked", async ({
  url,
  page,
}) => {
  await seedLane(url, "inbox");
  await seedTask(url, "inbox", "review me", { status: "review", tags: ["bug"] });
  await page.goto(url);

  const clear = page.locator('button[aria-label="Clear all filters"]');
  await expect(clear).toBeDisabled();

  // Activate every slot: search query, status, lane and a tag.
  await page.locator('input[aria-label="Search tasks"]').fill("review");
  await page.getByRole("button", { name: "Status filter", exact: true }).click();
  await page.getByRole("option", { name: "In review", exact: true }).click();
  await page.getByRole("button", { name: "Lane filter", exact: true }).click();
  await page.getByRole("option", { name: "inbox", exact: true }).click();
  await page.locator('button[aria-label="Filter by tags"]').click();
  await page
    .locator(".tag-filter-row")
    .filter({ has: page.locator(".tag-pill", { hasText: /^bug$/ }) })
    .click();
  await page.locator(".tag-filter-foot button.btn-primary", { hasText: "Done" }).click();
  await expect(clear).toBeEnabled();
  await expect(page.locator(".filter-chip", { hasText: "#bug" })).toBeVisible();
  await expect(page.locator(".task-row", { hasText: "review me" })).toBeVisible();

  // Click Clear all → every slot cleared, tokens gone, button disabled again.
  await clear.click();
  await expect(clear).toBeDisabled();
  await expect(page.locator(".filter-chip")).toHaveCount(0);
  await expect(page.locator('input[aria-label="Search tasks"]')).toHaveValue("");
  await expect(page.getByRole("button", { name: "Status filter", exact: true })).toContainText("All statuses");
  await expect(page.getByRole("button", { name: "Lane filter", exact: true })).toContainText("All lanes");
  await expect(page.locator(".status-bar .filter-summary")).toHaveText("All tasks");
});

test("the 'Filter by tags' trigger opens its attached panel; placeholder text is a real ellipsis (not literal \\u escape)", async ({
  url,
  page,
}) => {
  await seedLane(url, "inbox");
  await page.goto(url);

  await page.locator('button[aria-label="Filter by tags"]').click();
  await expect(page.locator(".sidebar-filter-panel")).toBeVisible();
  // Regression guard for the JSX-attribute escape bug: placeholder is the
  // single ellipsis char, NOT the 6-char string "\u2026".
  const ph = await page.locator(".tag-filter-search input").getAttribute("placeholder");
  expect(ph).toBe("Search tags\u2026");
  expect(ph).not.toContain("\\u");
});

test("tag panel multi-select: pick two tags → both chips appear in the strip; OR-filter shows tasks with EITHER tag", async ({
  url,
  page,
}) => {
  await seedLane(url, "inbox");
  await seedTask(url, "inbox", "task with bug", { tags: ["bug"] });
  await seedTask(url, "inbox", "task with ui", { tags: ["ui"] });
  await seedTask(url, "inbox", "task with neither");
  await page.goto(url);

  await page.locator('button[aria-label="Filter by tags"]').click();
  await expect(page.locator(".sidebar-filter-panel")).toBeVisible();

  // Click the bug + ui rows. Each row contains a TagPill with the tag name.
  await page
    .locator(".tag-filter-row")
    .filter({ has: page.locator(".tag-pill", { hasText: /^bug$/ }) })
    .click();
  await page
    .locator(".tag-filter-row")
    .filter({ has: page.locator(".tag-pill", { hasText: /^ui$/ }) })
    .click();

  // Selected-summary strip inside the panel shows two mini-chips.
  await expect(page.locator(".tag-filter-summary-chip")).toHaveCount(2);

  // Close the panel (Done button).
  await page.locator(".tag-filter-foot button.btn-primary", { hasText: "Done" }).click();
  await expect(page.locator(".sidebar-filter-panel")).toHaveCount(0);

  // FilterChips strip in the sidebar now shows both #bug and #ui.
  await expect(page.locator(".filter-chip", { hasText: "#bug" })).toBeVisible();
  await expect(page.locator(".filter-chip", { hasText: "#ui" })).toBeVisible();

  // OR semantics: bug AND ui tasks visible; the untagged one is filtered out.
  await expect(page.locator(".task-row", { hasText: "task with bug" })).toBeVisible();
  await expect(page.locator(".task-row", { hasText: "task with ui" })).toBeVisible();
  await expect(page.locator(".task-row", { hasText: "task with neither" })).toHaveCount(0);
});

test("removing a tag chip from the strip removes JUST that tag (other tag filter persists)", async ({ url, page }) => {
  await seedLane(url, "inbox");
  await seedTask(url, "inbox", "bug task", { tags: ["bug"] });
  await seedTask(url, "inbox", "ui task", { tags: ["ui"] });
  await page.goto(url);

  // Pre-select both tags via the attached panel.
  await page.locator('button[aria-label="Filter by tags"]').click();
  await page
    .locator(".tag-filter-row")
    .filter({ has: page.locator(".tag-pill", { hasText: /^bug$/ }) })
    .click();
  await page
    .locator(".tag-filter-row")
    .filter({ has: page.locator(".tag-pill", { hasText: /^ui$/ }) })
    .click();
  await page.locator(".tag-filter-foot button.btn-primary", { hasText: "Done" }).click();

  // Remove just #bug via its chip's x-button.
  const bugChip = page.locator(".filter-chip", { hasText: "#bug" });
  await bugChip.locator(".x").click();

  await expect(page.locator(".filter-chip", { hasText: "#bug" })).toHaveCount(0);
  await expect(page.locator(".filter-chip", { hasText: "#ui" })).toBeVisible();
  // Now only ui-tagged task is visible.
  await expect(page.locator(".task-row", { hasText: "ui task" })).toBeVisible();
  await expect(page.locator(".task-row", { hasText: "bug task" })).toHaveCount(0);
});

test("tag panel Untagged sentinel filters to tasks with zero tags", async ({ url, page }) => {
  await seedLane(url, "inbox");
  await seedTask(url, "inbox", "tagged thing", { tags: ["bug"] });
  await seedTask(url, "inbox", "naked thing");
  await page.goto(url);

  await page.locator('button[aria-label="Filter by tags"]').click();
  // First row is the Untagged sentinel.
  await page.locator(".tag-filter-untagged-row").click();
  await page.locator(".tag-filter-foot button.btn-primary", { hasText: "Done" }).click();

  await expect(page.locator(".filter-chip", { hasText: "untagged" })).toBeVisible();
  await expect(page.locator(".task-row", { hasText: "naked thing" })).toBeVisible();
  await expect(page.locator(".task-row", { hasText: "tagged thing" })).toHaveCount(0);
});

test("tag panel search filters the visible tag rows by case-insensitive substring", async ({ url, page }) => {
  await seedLane(url, "inbox");
  // Seed three tags via the API. addTag is sufficient — no task attachment needed.
  for (const name of ["bug", "ui", "infra"]) {
    await fetch(`${url}/api/tags`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
  }
  await page.goto(url);

  await page.locator('button[aria-label="Filter by tags"]').click();
  // All three tag rows + untagged sentinel = 4 rows.
  await expect(page.locator(".tag-filter-row")).toHaveCount(4);

  await page.locator(".tag-filter-search input").fill("ui");
  // Only the "ui" tag row remains; bug/infra/untagged are filtered out.
  await expect(page.locator(".tag-filter-row")).toHaveCount(1);
  await expect(page.locator(".tag-pill", { hasText: /^ui$/ })).toBeVisible();
});

test("command palette uses fuzzy/word-split matching: 'filter tag' matches 'Filter by tags…'", async ({
  url,
  page,
}) => {
  await seedLane(url, "inbox");
  await page.goto(url);

  const mod = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${mod}+KeyP`);
  const input = page.locator(".palette-input");
  await expect(input).toBeVisible();

  // Type a query where strict substring match would FAIL ("filter tag" does
  // not appear contiguously in "Filter by tags…") but word-split match
  // succeeds (both tokens present).
  await input.type("filter tag");
  await expect(page.locator(".palette-row", { hasText: "Filter by tags" })).toBeVisible();
});

test("palette 'Filter by tags…' opens the attached sidebar panel", async ({ url, page }) => {
  await seedLane(url, "inbox");
  await page.goto(url);
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${mod}+KeyP`);
  await page.locator(".palette-input").type("filter tag");
  await page.locator(".palette-row", { hasText: "Filter by tags" }).click();
  await expect(page.locator(".sidebar-filter-panel")).toBeVisible();
  await expect(page.locator("dialog[open], .overlay")).toHaveCount(0);
  await expect(page.getByRole("searchbox", { name: "Search tags" })).toBeFocused();
});

test("mobile live tag filtering preserves its drawer through fallback changes; outside clicks keep target focus", async ({
  url,
  page,
}) => {
  await seedLane(url, "inbox");
  await seedTask(url, "inbox", "bug task", { tags: ["bug"] });
  await seedTask(url, "inbox", "ui task", { tags: ["ui"] });
  for (let i = 0; i < 8; i++) await seedTask(url, "inbox", `untagged task ${i}`);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(url); // no explicit selectedId: filters can replace the fallback
  const title = page.locator(".task-title-display");
  await expect(title).toBeVisible();
  const nextTag = (await title.textContent()) === "bug task" ? "ui" : "bug";
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "Navigation", exact: true });
  const trigger = drawer.getByRole("button", { name: "Filter by tags", exact: true });
  await trigger.click();
  const panel = drawer.locator(".sidebar-filter-panel");
  await panel.evaluate(element => {
    (element as HTMLElement).dataset.identity = "live-filter";
  });
  const search = panel.getByRole("searchbox", { name: "Search tags" });
  await search.fill(nextTag);
  await search.press("ArrowDown");
  const choice = panel.getByRole("button", { name: `Include #${nextTag}`, exact: true });
  await expect(choice).toBeFocused();
  await choice.press("Space");
  await expect(title).toHaveText(`${nextTag} task`);
  await expect(choice).toHaveAttribute("aria-pressed", "true");
  await expect(panel).toHaveAttribute("data-identity", "live-filter");
  await expect(drawer).toBeVisible();
  await expect(search).toHaveValue(nextTag);
  await search.fill("");
  await panel.getByRole("button", { name: `Include #${nextTag === "bug" ? "ui" : "bug"}`, exact: true }).click();
  await expect(panel.locator(".tag-filter-summary-chip")).toHaveCount(2);
  await expect(drawer.locator(".task-row")).toHaveCount(2);
  await panel.getByRole("button", { name: "Clear all", exact: true }).click();
  await expect(drawer.locator(".task-row")).toHaveCount(10);
  await expect(panel).toHaveAttribute("data-identity", "live-filter");
  await panel.getByRole("button", { name: "Done", exact: true }).click();
  await expect(trigger).toBeFocused();
  await expect(drawer).toBeVisible();
  await trigger.click();
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("");
  const taskSearch = drawer.getByRole("searchbox", { name: "Search tasks" });
  await taskSearch.click();
  await expect(panel).toHaveCount(0);
  await expect(taskSearch).toBeFocused(); // closing must not steal this click's focus

  // Explicit task navigation, including a current/fallback row, dismisses
  // the filtering surface AND navigation rather than leaving a stale panel.
  await trigger.click();
  const row = drawer.locator(".task-row").last();
  const destination = await row.locator(".task-title").textContent();
  await row.scrollIntoViewIfNeeded();
  await row.click();
  await expect(drawer).toHaveCount(0);
  await expect(page.locator(".sidebar-filter-panel")).toHaveCount(0);
  await expect(title).toHaveText(destination ?? "");

  // Landscape navigation scrolls as one column. If its trigger scrolls
  // out of view, dismiss rather than detach the panel from an absent anchor.
  await page.setViewportSize({ width: 844, height: 320 });
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await trigger.click();
  await expect(panel).toBeVisible();
  await drawer.locator(".sidebar-body").evaluate(element => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(panel).toHaveCount(0);
  await expect(drawer).toBeVisible();
  await expect(page.locator(".status-bar .filter-summary")).toHaveText("All tasks");
});

test("palette tag filtering reveals the sidebar from focus reading, management, and narrow layouts", async ({
  url,
  page,
}) => {
  await seedLane(url, "inbox");
  await seedTask(url, "inbox", "palette filter task", { tags: ["bug"] });
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(url);
    if (width > 900) {
      await page.getByRole("button", { name: "Manage lanes", exact: true }).click();
      await page.getByRole("button", { name: "Focus reading", exact: true }).click();
      await expect(page.locator(".sidebar-pane")).toHaveCount(0);
    }
    await page.keyboard.press(`${mod}+KeyP`);
    await page.locator(".palette-input").fill("/filter tag");
    await page.locator(".palette-input").press("Enter");
    await expect(page.locator(".palette")).toHaveCount(0);
    const panel = page.locator(".sidebar-filter-panel");
    await expect(panel).toBeVisible();
    await expect(page.getByRole("searchbox", { name: "Search tags" })).toBeFocused();
    await expect(page.locator(".workspace-filters")).toBeVisible();
    await expect(page.locator("dialog[open]")).toHaveCount(width > 900 ? 0 : 1);
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Filter by tags", exact: true })).toBeFocused();
  }
});

test("all filter panels remain sidebar-width and viewport-bounded with long lists and selected tokens", async ({
  url,
  page,
}) => {
  for (let index = 0; index < 16; index++) await seedLane(url, `queue-${index}-long-lane-name`);
  for (let index = 0; index < 20; index++) {
    const response = await fetch(`${url}/api/tags`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: `filter-${index.toString().padStart(2, "0")}-long-tag-name` }),
    });
    if (!response.ok) throw new Error(`Tag fixture: ${response.status}`);
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const [width, height] of [
    [320, 740],
    [390, 844],
    [768, 900],
    [844, 320],
    [1280, 390],
  ]) {
    await page.setViewportSize({ width, height });
    await page.goto(url);
    if (width <= 900) await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    for (const name of ["Status filter", "Lane filter", "Filter by tags"]) {
      const trigger = page.getByRole("button", { name, exact: true });
      await trigger.click();
      const panel = page.locator(".sidebar-filter-panel");
      await expect(panel).toBeVisible();
      if (name === "Filter by tags") {
        for (let index = 0; index < 10; index++) {
          await panel
            .getByRole("button", {
              name: `Include #filter-${index.toString().padStart(2, "0")}-long-tag-name`,
              exact: true,
            })
            .click();
        }
        await expect(panel.locator(".tag-filter-summary-chip")).toHaveCount(10);
        await expect(panel.getByRole("button", { name: "Done", exact: true })).toBeInViewport();
      } else {
        if (name === "Lane filter") await page.keyboard.press("ArrowDown");
        await page.keyboard.press("End");
        await expect(page.getByRole("option").last()).toBeFocused();
        await expect(page.getByRole("option").last()).toBeInViewport();
      }
      const geometry = await panel.evaluate(element => {
        const sidebar = element.closest(".sidebar-pane");
        const field = sidebar?.querySelector(".ws-search");
        if (!sidebar || !field) throw new Error("Missing sidebar anchor");
        return {
          panel: element.getBoundingClientRect().toJSON(),
          field: field.getBoundingClientRect().toJSON(),
          sidebar: sidebar.getBoundingClientRect().toJSON(),
        };
      });
      expect(Math.abs(geometry.panel.left - geometry.field.left)).toBeLessThanOrEqual(1);
      expect(Math.abs(geometry.panel.width - geometry.field.width)).toBeLessThanOrEqual(1);
      expect(geometry.panel.left).toBeGreaterThanOrEqual(geometry.sidebar.left);
      expect(geometry.panel.right).toBeLessThanOrEqual(geometry.sidebar.right);
      expect(geometry.panel.top).toBeGreaterThanOrEqual(8);
      expect(geometry.panel.bottom).toBeLessThanOrEqual(height - 8);
      await expect(page.locator("dialog[open]")).toHaveCount(width <= 900 ? 1 : 0);
      if (name === "Filter by tags") await panel.getByRole("button", { name: "Clear all", exact: true }).click();
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  }
});

test("filter menu motion runs once per open and is disabled by reduced motion", async ({ url, page }) => {
  await seedLane(url, "inbox");
  await seedTask(url, "inbox", "motion task", { tags: ["bug", "ui"] });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(url);
  const trigger = page.getByRole("button", { name: "Filter by tags", exact: true });
  await trigger.click();
  const surface = page.locator(".sidebar-filter-surface");
  const motion = await surface.evaluate(element => {
    const style = getComputedStyle(element);
    return { name: style.animationName, duration: style.animationDuration, delay: style.animationDelay };
  });
  expect(motion).toEqual({ name: "ui-menu-in", duration: "0.14s", delay: "0s" });
  await surface.evaluate(async element => {
    await Promise.all(element.getAnimations().map(animation => animation.finished));
    const node = element as HTMLElement;
    node.dataset.identity = "same-filter";
    node.dataset.starts = "0";
    node.addEventListener("animationstart", () => {
      node.dataset.starts = String(Number(node.dataset.starts) + 1);
    });
  });
  await surface.getByRole("button", { name: "Include #bug", exact: true }).click();
  await surface.getByRole("button", { name: "Include #ui", exact: true }).click();
  await expect(surface).toHaveAttribute("data-identity", "same-filter");
  await expect(surface).toHaveAttribute("data-starts", "0");
  expect(await surface.evaluate(element => element.getAnimations().length)).toBe(0);
  await page.keyboard.press("Escape");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await trigger.click();
  expect(await surface.evaluate(element => getComputedStyle(element).animationName)).toBe("none");
  await expect(page.getByRole("searchbox", { name: "Search tags" })).toBeFocused();
});

test("lane and tag search is optional: all catalog entries remain available and typing only filters", async ({
  url,
  page,
}) => {
  test.setTimeout(60_000);
  // Seed a real catalog in bounded REQUEST batches, not a UI result limit.
  for (let start = 0; start < 1000; start += 40) {
    await Promise.all(
      Array.from({ length: Math.min(40, 1000 - start) }, async (_, offset) => {
        const index = String(start + offset).padStart(4, "0");
        await seedLane(url, `queue-${index}-platform`);
        const response = await fetch(`${url}/api/tags`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: `team-${index}-ui` }),
        });
        if (!response.ok) throw new Error(`Catalog fixture: ${response.status}`);
      }),
    );
  }
  const target = await seedTask(url, "queue-0999-platform", "Catalog task", { tags: ["team-0999-ui"] });
  const allLanes = (await fetch(`${url}/api/lanes`).then(response => response.json())) as Array<{ name: string }>;
  expect(allLanes.filter(lane => lane.name.startsWith("queue-")).length).toBe(1000);
  await page.goto(`${url}/task/${target.id}`);
  const laneTrigger = page.getByRole("button", { name: "Lane filter", exact: true });
  await laneTrigger.click();
  const laneSearch = page.getByRole("searchbox", { name: "Search lanes", exact: true });
  await expect(laneSearch).toBeFocused();
  await expect(page.getByRole("option")).toHaveCount(allLanes.length + 1); // includes built-in lanes and All lanes
  await page.getByRole("option", { name: "queue-0999-platform", exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("option", { name: "queue-0999-platform", exact: true })).toBeInViewport();
  await laneSearch.fill("PLAT 0999 QuE");
  await expect(page.getByRole("option")).toHaveCount(2);
  await expect(laneTrigger).toContainText("All lanes"); // typing has not changed the filter
  await page.screenshot({ path: "tmp/screenshots/polish/lane-keyword-search.png", animations: "disabled" });
  await laneSearch.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(laneTrigger).toContainText("queue-0999-platform");

  await page.getByRole("button", { name: "Filter by tags", exact: true }).click();
  const panel = page.locator(".sidebar-filter-panel");
  const tagSearch = panel.getByRole("searchbox", { name: "Search tags", exact: true });
  await expect(panel.locator(".tag-filter-row")).toHaveCount(1001); // ALL tags plus Untagged
  await tagSearch.fill("UI 0999 TeAM");
  await expect(panel.locator(".tag-filter-row")).toHaveCount(1);
  const tag = panel.getByRole("button", { name: "Include #team-0999-ui", exact: true });
  await expect(tag).toHaveAttribute("aria-pressed", "false");
  await tagSearch.press("Enter");
  await expect(tag).toHaveAttribute("aria-pressed", "true");
  await tagSearch.fill("");
  await expect(panel.locator(".tag-filter-row")).toHaveCount(1001);
  await expect(tag).toHaveAttribute("aria-pressed", "true");
  await panel.getByRole("button", { name: "Done", exact: true }).click();

  // Task metadata uses the same optional keyword matcher, with no cap.
  await page.locator(".lane-chip-button").click();
  await expect(page.locator(".picker-row")).toHaveCount(allLanes.length);
  await page.getByRole("searchbox", { name: "Search lanes", exact: true }).fill("0999 PLATFORM");
  await expect(page.locator(".picker-row")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Add tags", exact: true }).click();
  await expect(page.locator(".tag-picker-row")).toHaveCount(1000);
  await page.getByRole("searchbox", { name: "Search or create tags", exact: true }).fill("TEAM 0999 UI");
  await expect(page.locator(".tag-picker-row")).toHaveCount(1);
  await expect(page.locator(".tag-picker-row")).toContainText("team-0999-ui");
  await expect(page.locator(".tag-picker-foot")).toHaveCount(0); // keywords are valid search, not an invalid new tag
});

test("StatusBar reflects filter summary and shown count", async ({ url, page }) => {
  await seedLane(url, "inbox");
  await seedTask(url, "inbox", "alpha");
  await seedTask(url, "inbox", "beta", { status: "blocked" });
  await page.goto(url);

  // Default state: summary reads "All tasks", shown count is 2.
  await expect(page.locator(".status-bar .filter-summary")).toHaveText("All tasks");
  await expect(page.locator(".status-bar .status-counts")).toContainText("2 shown");

  // After narrowing via the status selector, summary updates and count drops to 1.
  await page.getByRole("button", { name: "Status filter", exact: true }).click();
  await page.getByRole("option", { name: "Blocked", exact: true }).click();
  await expect(page.locator(".status-bar .filter-summary")).toContainText("blocked");
  await expect(page.locator(".status-bar .status-counts")).toContainText("1 shown");
});
