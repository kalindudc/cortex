// E2E for the new-lane flow.
//
// The inline new-lane popover form was replaced by a NewLaneModal
// (modal.value = { kind: "new-lane" }) so creation matches the edit/delete
// surface and the name input is reliably autofocused (the inline form's
// autoFocus race was the original motivation).
//
// Covered:
//   - Clicking the "+" button in the Lanes section header opens the modal
//   - The Name input is autofocused on open
//   - Create is disabled until a non-blank name is entered
//   - Submitting creates the lane and closes the modal
//   - Cancel closes the modal without creating

import { test, expect } from "./fixtures/cortex-server.ts";

async function listLanes(url: string): Promise<Array<{ name: string }>> {
  const r = await fetch(`${url}/api/lanes`);
  return r.json();
}

test("clicking the Lanes section '+' button opens NewLaneModal with the Name input autofocused", async ({
  url,
  page,
}) => {
  // Seed an initial lane so the Lanes section is non-empty (the "+" button
  // is the trailing slot of the Lanes SectionHeader, present regardless).
  await fetch(`${url}/api/lanes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "now" }),
  });
  await page.goto(url);

  await page.locator('button[aria-label="New lane"]').click();
  await expect(page.locator(".modal")).toBeVisible();
  // Heading confirms NewLaneModal (vs LaneEditModal which says "Edit lane").
  await expect(page.locator(".modal h2")).toHaveText("New lane");

  // Name input is autofocused via the ref+useEffect pattern.
  const nameInput = page.locator(".modal input").first();
  await expect(nameInput).toBeFocused();
});

test("Create button is disabled until a non-blank name is entered", async ({ url, page }) => {
  await fetch(`${url}/api/lanes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "now" }),
  });
  await page.goto(url);
  await page.locator('button[aria-label="New lane"]').click();

  const create = page.locator(".modal button.btn-primary", { hasText: "Create" });
  await expect(create).toBeDisabled();

  await page.locator(".modal input").first().fill("next");
  await expect(create).toBeEnabled();
});

test("submitting the modal creates the lane and closes the modal; the lane appears in the sidebar", async ({
  url,
  page,
}) => {
  await fetch(`${url}/api/lanes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "now" }),
  });
  await page.goto(url);

  await page.locator('button[aria-label="New lane"]').click();
  await page.locator(".modal input").first().fill("soon");
  await page.locator(".modal button.btn-primary", { hasText: "Create" }).click();

  // Modal closes.
  await expect(page.locator(".modal")).toHaveCount(0);
  // Lane appears in the sidebar.
  await expect(page.locator(".lane-row .lane-name", { hasText: /^soon$/ })).toBeVisible();
  // Belt + suspenders: persisted via the API.
  const lanes = await listLanes(url);
  expect(lanes.find(l => l.name === "soon")).toBeTruthy();
});

test("Cancel closes the modal without creating a lane", async ({ url, page }) => {
  await fetch(`${url}/api/lanes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "now" }),
  });
  await page.goto(url);

  await page.locator('button[aria-label="New lane"]').click();
  await page.locator(".modal input").first().fill("ghost");
  await page.locator(".modal button.btn", { hasText: "Cancel" }).click();

  await expect(page.locator(".modal")).toHaveCount(0);
  const lanes = await listLanes(url);
  expect(lanes.find(l => l.name === "ghost")).toBeUndefined();
});

test("palette 'New lane…' command also opens NewLaneModal (consistent path)", async ({ url, page }) => {
  await page.goto(url);
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${mod}+KeyP`);
  await page.locator(".palette-input").fill("new lane");
  await page.locator(".palette-row", { hasText: "New lane" }).first().click();
  await expect(page.locator(".modal h2")).toHaveText("New lane");
});
