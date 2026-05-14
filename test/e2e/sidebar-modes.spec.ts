// E2E for the latest sidebar UX additions:
//   - Tasks section is collapsible + has a "+" affordance that creates an
//     untitled-<id> task and selects it for inline rename
//   - Lane row's edit "..." icon is invisible (and takes no space) until
//     hover, then fades in
//   - Tag-management mode: SidebarSystemBar's hash button swaps the pane
//     to a single TAGS section with its own "+" → NewTagModal
//   - StatusBar's palette hint is a clickable button that opens ⌘P
//
// All assertions go through Playwright auto-waiting locators.

import { test, expect } from "./fixtures/cortex-server.ts";

async function seedLane(url: string, name: string): Promise<void> {
  const r = await fetch(`${url}/api/lanes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) throw new Error(`failed to seed lane ${name}: ${r.status} ${await r.text()}`);
}

async function listTags(url: string): Promise<Array<{ name: string }>> {
  const r = await fetch(`${url}/api/tags`);
  return r.json();
}

test("Tasks section toggle collapses + reopens the task list", async ({ url, page }) => {
  await seedLane(url, "inbox");
  await page.goto(url);
  // Click "+" to seed a task so the list is non-empty.
  await page.locator('button[aria-label="New task"]').click();
  await expect(page.locator(".task-row").first()).toBeVisible();

  // Toggle the Tasks section header — section body unmounts.
  const tasksToggle = page.locator(".section-toggle", { hasText: "Tasks" });
  await tasksToggle.click();
  await expect(page.locator(".section-tasks .section-body")).toHaveCount(0);

  // Toggle back open.
  await tasksToggle.click();
  await expect(page.locator(".task-row").first()).toBeVisible();
});

test("Tasks section '+' creates an untitled-<id> task; the active pane title input is focused for inline rename", async ({
  url,
  page,
}) => {
  await seedLane(url, "inbox");
  await page.goto(url);

  await page.locator('button[aria-label="New task"]').click();

  // The created task lands in the lane with title "untitled-<id>".
  const newRow = page.locator(".task-row .task-title", { hasText: /^untitled-\d+$/ }).first();
  await expect(newRow).toBeVisible();

  // The active-pane title input is focused so the user can rename in place.
  // The createUntitledTask helper schedules .focus() + .select() in a
  // setTimeout(0); Playwright's auto-wait gives the microtask + macrotask
  // chain time to settle.
  const titleInput = page.locator(".pane-active .title-input");
  await expect(titleInput).toBeFocused();
});

test("lane-edit '...' icon is hidden by default and fades in only when the row is hovered", async ({ url, page }) => {
  await seedLane(url, "inbox");
  await page.goto(url);

  // Resolve the lane-row + edit btn handles up front.
  const laneRow = page.locator(".lane-row", { hasText: "inbox" }).first();
  const editBtn = laneRow.locator(".lane-edit-btn");

  // CSS hides the btn via opacity:0 (still in DOM, but visually invisible).
  // We check computed opacity rather than DOM presence.
  const initialOpacity = await editBtn.evaluate(el => getComputedStyle(el).opacity);
  expect(Number(initialOpacity)).toBe(0);

  // Hover the row → opacity transitions to 1 (transition is ~150ms; rely on
  // poll + timeout from expect.poll for stability).
  await laneRow.hover();
  await expect
    .poll(async () => Number(await editBtn.evaluate(el => getComputedStyle(el).opacity)), {
      timeout: 2000,
    })
    .toBe(1);
});

test("manage-tags toggle: pane swaps to the TAGS-only section and back", async ({ url, page }) => {
  await seedLane(url, "inbox");
  await page.goto(url);

  // Main mode: Views/Lanes/Tasks section toggles all visible.
  const labelsBefore = await page.locator(".section-toggle .section-label").allTextContents();
  expect(labelsBefore).toContain("Views");
  expect(labelsBefore).toContain("Lanes");
  expect(labelsBefore).toContain("Tasks");

  // Click the manage-tags button in the system bar.
  await page.locator('button[aria-label="Manage tags"]').click();

  // Tags-mode: ONLY the Tags section eyebrow renders; main-mode collapsibles are gone.
  await expect(page.locator(".section-head .eyebrow")).toHaveText("Tags");
  await expect(page.locator(".section-toggle")).toHaveCount(0);

  // The "Manage tags" button is now "Back to main sidebar".
  await page.locator('button[aria-label="Back to main sidebar"]').click();
  await expect(page.locator(".section-toggle .section-label", { hasText: "Tasks" })).toBeVisible();
});

test("tag-management '+' opens NewTagModal; saving creates a tag that appears in the list", async ({ url, page }) => {
  await seedLane(url, "inbox");
  await page.goto(url);
  await page.locator('button[aria-label="Manage tags"]').click();

  // Click the section's "+" button to open NewTagModal.
  await page.locator('button[aria-label="New tag"]').click();
  await expect(page.locator(".modal h2")).toHaveText("New tag");
  // Name input is autofocused.
  const nameInput = page.locator(".modal input").first();
  await expect(nameInput).toBeFocused();
  // Create is disabled until a TAG_NAME_RE-valid name is typed.
  const create = page.locator(".modal button.btn-primary", { hasText: "Create" });
  await expect(create).toBeDisabled();
  await nameInput.fill("release-train");
  await expect(create).toBeEnabled();
  await create.click();

  // Modal closes; tag appears in the TAGS section list.
  await expect(page.locator(".modal")).toHaveCount(0);
  await expect(page.locator(".lane-row .tag-pill", { hasText: "release-train" })).toBeVisible();
  // Persisted server-side too.
  const tags = await listTags(url);
  expect(tags.find(t => t.name === "release-train")).toBeTruthy();
});

test("tag-management row click opens TagEditModal", async ({ url, page }) => {
  await seedLane(url, "inbox");
  // Seed a tag so the list is non-empty.
  await fetch(`${url}/api/tags`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "bug" }),
  });
  await page.goto(url);
  await page.locator('button[aria-label="Manage tags"]').click();

  // Click the row whose pill says 'bug'.
  await page
    .locator(".lane-row")
    .filter({ has: page.locator(".tag-pill", { hasText: /^bug$/ }) })
    .click();
  await expect(page.locator(".modal h2")).toHaveText("Edit tag");
});

test("StatusBar palette hint is clickable and opens the command palette", async ({ url, page }) => {
  await seedLane(url, "inbox");
  await page.goto(url);
  await page.locator(".status-bar .hint-button").click();
  await expect(page.locator(".palette-input")).toBeVisible();
});
