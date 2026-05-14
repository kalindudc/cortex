// E2E coverage for the unified sidebar's filtering UX.
//
// Covers:
//   - Smart-view rows (All / In review / Blocked / Done) drive filters.status
//   - Reset-filters button: disabled when none active, enabled + clears on click
//   - FilterChips strip ALWAYS renders (so the "+ tag" affordance is always
//     reachable); empty state has only the + tag chip
//   - TagFilterModal: opened via "+ tag" chip OR palette "Filter by tags…",
//     multi-select toggle, search filter, selected-summary chips
//   - Multi-tag OR semantics: tasks tagged bug OR ui both visible
//   - Untagged sentinel filters tasks with zero tags
//   - StatusBar mounts at the bottom and reflects filter state
//   - Command palette is fuzzy: "filter tag" matches "Filter by tags…"
//   - TagFilterModal placeholder renders as a real ellipsis (regression
//     guard for the JSX-attribute-escape bug)
//
// All assertions go through Playwright auto-waiting locators — no
// page.waitForTimeout (banned per test/e2e/README.md).

import { test, expect } from "./fixtures/cortex-server.ts";

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
  opts: { status?: "open" | "review" | "blocked" | "done"; tags?: string[] } = {},
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

test("sidebar mounts SidebarPane + StatusBar and the FilterChips strip is always visible", async ({ url, page }) => {
  await seedLane(url, "inbox");
  await page.goto(url);
  await expect(page.locator(".sidebar-pane")).toBeVisible();
  await expect(page.locator(".status-bar")).toBeVisible();
  // The chip strip is always present so the + tag affordance stays
  // discoverable; with zero filters active the only thing inside is
  // the + tag chip.
  await expect(page.locator(".filter-chips")).toBeVisible();
  await expect(page.locator(".filter-chip")).toHaveCount(0);
  await expect(page.locator(".filter-chip-add")).toBeVisible();
});

test("smart-view rows drive filters.status: clicking 'Blocked' narrows the task list", async ({ url, page }) => {
  await seedLane(url, "inbox");
  await seedTask(url, "inbox", "open task");
  await seedTask(url, "inbox", "blocked task", { status: "blocked" });
  await page.goto(url);

  // Both tasks visible by default ("All tasks" view, status filter null).
  await expect(page.locator(".task-row", { hasText: "open task" })).toBeVisible();
  await expect(page.locator(".task-row", { hasText: "blocked task" })).toBeVisible();

  // Click the "Blocked" view-row inside the Views section body.
  await page.locator(".view-row", { hasText: "Blocked" }).click();
  await expect(page.locator(".task-row", { hasText: "blocked task" })).toBeVisible();
  await expect(page.locator(".task-row", { hasText: "open task" })).toHaveCount(0);

  // Status chip appears in the FilterChips strip.
  await expect(page.locator(".filter-chip", { hasText: "blocked" })).toBeVisible();
});

test("reset-filters button is disabled when no filters active and clears every slot when clicked", async ({
  url,
  page,
}) => {
  await seedLane(url, "inbox");
  await seedTask(url, "inbox", "review me", { status: "review" });
  await page.goto(url);

  const reset = page.locator('button[aria-label="Reset filters"]');
  await expect(reset).toBeDisabled();

  // Activate a filter via the "In review" smart-view row.
  await page.locator(".view-row", { hasText: "In review" }).click();
  await expect(reset).toBeEnabled();
  await expect(page.locator(".filter-chip", { hasText: "review" })).toBeVisible();

  // Click reset → all filters cleared, chips gone, button disabled again.
  await reset.click();
  await expect(reset).toBeDisabled();
  await expect(page.locator(".filter-chip")).toHaveCount(0);
});

test("'+ tag' chip opens TagFilterModal; placeholder text is a real ellipsis (not literal \\u escape)", async ({
  url,
  page,
}) => {
  await seedLane(url, "inbox");
  await page.goto(url);

  await page.locator(".filter-chip-add").click();
  await expect(page.locator(".tag-filter-modal")).toBeVisible();
  // Regression guard for the JSX-attribute escape bug: placeholder is the
  // single ellipsis char, NOT the 6-char string "\u2026".
  const ph = await page.locator(".tag-filter-search input").getAttribute("placeholder");
  expect(ph).toBe("Search tags\u2026");
  expect(ph).not.toContain("\\u");
});

test("TagFilterModal multi-select: pick two tags → both chips appear in the strip; OR-filter shows tasks with EITHER tag", async ({
  url,
  page,
}) => {
  await seedLane(url, "inbox");
  await seedTask(url, "inbox", "task with bug", { tags: ["bug"] });
  await seedTask(url, "inbox", "task with ui", { tags: ["ui"] });
  await seedTask(url, "inbox", "task with neither");
  await page.goto(url);

  await page.locator(".filter-chip-add").click();
  await expect(page.locator(".tag-filter-modal")).toBeVisible();

  // Click the bug + ui rows. Each row contains a TagPill with the tag name.
  await page
    .locator(".tag-filter-row")
    .filter({ has: page.locator(".tag-pill", { hasText: /^bug$/ }) })
    .click();
  await page
    .locator(".tag-filter-row")
    .filter({ has: page.locator(".tag-pill", { hasText: /^ui$/ }) })
    .click();

  // Selected-summary strip inside the modal shows two mini-chips.
  await expect(page.locator(".tag-filter-summary-chip")).toHaveCount(2);

  // Close the modal (Done button).
  await page.locator(".tag-filter-foot button.btn-primary", { hasText: "Done" }).click();
  await expect(page.locator(".tag-filter-modal")).toHaveCount(0);

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

  // Pre-select both tags via the modal.
  await page.locator(".filter-chip-add").click();
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

test("TagFilterModal Untagged sentinel filters to tasks with zero tags", async ({ url, page }) => {
  await seedLane(url, "inbox");
  await seedTask(url, "inbox", "tagged thing", { tags: ["bug"] });
  await seedTask(url, "inbox", "naked thing");
  await page.goto(url);

  await page.locator(".filter-chip-add").click();
  // First row is the Untagged sentinel.
  await page.locator(".tag-filter-untagged-row").click();
  await page.locator(".tag-filter-foot button.btn-primary", { hasText: "Done" }).click();

  await expect(page.locator(".filter-chip", { hasText: "untagged" })).toBeVisible();
  await expect(page.locator(".task-row", { hasText: "naked thing" })).toBeVisible();
  await expect(page.locator(".task-row", { hasText: "tagged thing" })).toHaveCount(0);
});

test("TagFilterModal search filters the visible tag rows by case-insensitive substring", async ({ url, page }) => {
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

  await page.locator(".filter-chip-add").click();
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
  await input.fill("filter tag");
  await expect(page.locator(".palette-row", { hasText: "Filter by tags" })).toBeVisible();
});

test("palette 'Filter by tags…' opens the modal", async ({ url, page }) => {
  await seedLane(url, "inbox");
  await page.goto(url);
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${mod}+KeyP`);
  await page.locator(".palette-input").fill("filter tag");
  await page.locator(".palette-row", { hasText: "Filter by tags" }).click();
  await expect(page.locator(".tag-filter-modal")).toBeVisible();
});

test("StatusBar reflects filter summary and shown count", async ({ url, page }) => {
  await seedLane(url, "inbox");
  await seedTask(url, "inbox", "alpha");
  await seedTask(url, "inbox", "beta", { status: "blocked" });
  await page.goto(url);

  // Default state: summary reads "All tasks", shown count is 2.
  await expect(page.locator(".status-bar .filter-summary")).toHaveText("All tasks");
  await expect(page.locator(".status-bar .status-counts")).toContainText("2 shown");

  // After narrowing via the Blocked smart view, summary updates and count drops to 1.
  await page.locator(".view-row", { hasText: "Blocked" }).click();
  await expect(page.locator(".status-bar .filter-summary")).toContainText("blocked");
  await expect(page.locator(".status-bar .status-counts")).toContainText("1 shown");
});
