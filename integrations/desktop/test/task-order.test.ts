// The task list's sort and grouping in a real window: the default ascending
// id order, every sort field both ways and every grouping chosen from the
// palette's "Sort and group…" and from the list's own order line, folding one
// group or all of them, relevance while searching, and the choices surviving
// a reload and a relaunch on the same Electron profile.

import type { Page } from "playwright-core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { addTask, runCommand } from "./chrome.ts";
import { type DesktopApp, launchDesktop, waitForDashboard } from "./harness.ts";
import { waitForLive, waitForRow } from "./live.ts";

let desktop: DesktopApp;

beforeEach(async () => {
  desktop = await launchDesktop();
  await waitForDashboard(desktop.page);
  await waitForLive(desktop.page);
});

afterEach(async () => {
  await desktop?.close();
});

const POLL = { timeout: 10_000, interval: 50 };

/** The list as shown: "@<id>" for a row, "<label> <count>" for a group header. */
function listed(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll(".section-tasks .task-group-header, .section-tasks .task-row")).map(el =>
      el.classList.contains("task-row")
        ? (el.querySelector(".num")?.textContent ?? "")
        : `${el.querySelector(".task-group-label")?.textContent} ${el.querySelector(".task-group-count")?.textContent}`,
    ),
  );
}
const orderLine = (page: Page) => page.locator(".section-tasks .task-order").textContent();

async function seed(): Promise<Record<string, number>> {
  const ids: Record<string, number> = {};
  // The lane catalog orders the lane sort and groups: "now" first, then
  // "later" (by name alone, "later" would come first).
  await desktop.cortex(["lane", "add", "later"]);
  const moved = await desktop.page.evaluate(() =>
    window.cortex.request({
      method: "PATCH",
      path: "/api/lanes/later",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sort: 1 }),
    }),
  );
  expect(moved.status).toBe(200);
  ids.t12 = await addTask(desktop, "task-12", { lane: "later", status: "review" });
  ids.alpha = await addTask(desktop, "alpha", { lane: "now", status: "blocked" });
  ids.t2 = await addTask(desktop, "task-2", { lane: "later", status: "draft" });
  ids.beta = await addTask(desktop, "beta", { lane: "now", status: "open" });
  await desktop.cortex(["edit", String(ids.t2), "--priority", "0"]);
  await desktop.cortex(["edit", String(ids.beta), "--priority", "1"]);
  await desktop.cortex(["edit", String(ids.t12), "--priority", "2"]);
  for (const title of ["task-12", "alpha", "task-2", "beta"]) await waitForRow(desktop.page, title);
  const lanes = JSON.parse(await desktop.cortex(["lane", "ls", "--json"])) as Array<{ name: string }>;
  expect(lanes.map(l => l.name)).toEqual(["now", "later"]);
  return ids;
}

const at = (...ids: number[]) => ids.map(id => `@${id}`);

/** Chooses `sort` from the palette: its field, then its direction. */
async function sortBy(page: Page, sort: string): Promise<void> {
  const descending = sort.startsWith("-");
  await runCommand(page, "Sort and group", `sort-${descending ? sort.slice(1) : sort}`);
  await runCommand(page, "Sort and group", descending ? "sort-descending" : "sort-ascending");
}
const sortLine = (sort: string) => `Sorted by ${sort.startsWith("-") ? `${sort.slice(1)} descending` : sort}`;

describe("task-list order", () => {
  test("defaults to ascending id; each sort and grouping from the palette reorders the list", async () => {
    const { page } = desktop;
    const { t12, alpha, t2, beta } = await seed();
    expect(await orderLine(page)).toBe("Sorted by id");
    await expect.poll(() => listed(page), POLL).toEqual(at(t12, alpha, t2, beta));

    // Updated order, newest last: the edits above touched t2, beta, t12 in that order.
    const tasks = JSON.parse(await desktop.cortex(["ls", "--json"])) as Array<{ id: number; updated: number }>;
    const byUpdated = [...tasks].sort((a, b) => a.updated - b.updated || a.id - b.id).map(t => t.id);
    const byUpdatedDesc = [...tasks].sort((a, b) => b.updated - a.updated || a.id - b.id).map(t => t.id);

    const sorts: Array<[string, number[]]> = [
      ["-id", [beta, t2, alpha, t12]],
      ["title", [alpha, beta, t2, t12]],
      ["-title", [t12, t2, beta, alpha]],
      ["lane", [alpha, beta, t12, t2]],
      ["-lane", [t12, t2, alpha, beta]],
      ["status", [t2, beta, t12, alpha]],
      ["-status", [alpha, t12, beta, t2]],
      ["priority", [t2, beta, t12, alpha]],
      // Reversed, a task without a priority still comes last.
      ["-priority", [t12, beta, t2, alpha]],
      ["updated", byUpdated],
      ["-updated", byUpdatedDesc],
      ["id", [t12, alpha, t2, beta]],
    ];
    for (const [sort, expected] of sorts) {
      await sortBy(page, sort);
      await expect.poll(() => orderLine(page), POLL).toBe(sortLine(sort));
      expect(await listed(page)).toEqual(at(...expected));
    }

    await runCommand(page, "Sort and group", "group-lane");
    await expect.poll(() => orderLine(page), POLL).toBe("Sorted by id, grouped by lane");
    expect(await listed(page)).toEqual(["now 2", ...at(alpha, beta), "later 2", ...at(t12, t2)]);

    await runCommand(page, "Sort and group", "group-status");
    await expect.poll(() => orderLine(page), POLL).toBe("Sorted by id, grouped by status");
    expect(await listed(page)).toEqual([
      "Draft 1",
      ...at(t2),
      "Open 1",
      ...at(beta),
      "In review 1",
      ...at(t12),
      "Blocked 1",
      ...at(alpha),
    ]);

    // Headers are not rows: next task steps from the last row of one group to the first of the next.
    await page.locator("button.task-row", { hasText: "task-2" }).click();
    await runCommand(page, "next");
    await expect.poll(() => page.locator(".task-row.active .num").textContent(), POLL).toBe(`@${beta}`);

    // A search ranks by relevance in one flat list, whatever the sort and grouping.
    await page.locator('input[aria-label="Search tasks"]').fill("task");
    await expect.poll(() => orderLine(page), POLL).toBe("Sorted by relevance");
    expect(await page.locator(".section-tasks .task-group-header").count()).toBe(0);
    expect(new Set(await listed(page))).toEqual(new Set(at(t12, t2)));
    await page.locator('input[aria-label="Search tasks"]').fill("");
    await expect.poll(() => orderLine(page), POLL).toBe("Sorted by id, grouped by status");
  });

  test("the choice survives a reload and a relaunch on the same profile", async () => {
    await seed();
    await sortBy(desktop.page, "-title");
    await runCommand(desktop.page, "Sort and group", "group-lane");
    await expect.poll(() => orderLine(desktop.page), POLL).toBe("Sorted by title descending, grouped by lane");

    await desktop.page.reload();
    await waitForDashboard(desktop.page);
    await expect.poll(() => orderLine(desktop.page), POLL).toBe("Sorted by title descending, grouped by lane");

    desktop = await desktop.relaunch();
    await waitForDashboard(desktop.page);
    await waitForLive(desktop.page);
    await expect.poll(() => orderLine(desktop.page), POLL).toBe("Sorted by title descending, grouped by lane");
    await expect.poll(() => listed(desktop.page), POLL).toEqual([
      "now 2",
      "@4",
      "@2",
      "later 2",
      "@1",
      "@3",
    ]);
  });

  test("the list's order line sets sort and grouping, and a folded lane stays folded after a relaunch", async () => {
    const { page } = desktop;
    const { t12, alpha, t2, beta } = await seed();
    await page.locator("#sidebar-filter-order-trigger").click();
    const panel = page.locator("#sidebar-filter-order-panel");
    await panel.locator("#setting-group").selectOption("lane");
    // Each field once; the direction is its own control.
    expect(await panel.locator("#setting-sort option").allTextContents()).toEqual([
      "id",
      "title",
      "lane",
      "status",
      "priority",
      "updated",
    ]);
    await panel.locator('#setting-direction input[value="desc"]').check();
    await expect.poll(() => orderLine(page), POLL).toBe("Sorted by id descending, grouped by lane");
    // The panel stays open across the choices; Escape closes it.
    expect(await panel.count()).toBe(1);
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "detached" });
    expect(await listed(page)).toEqual(["now 2", ...at(beta, alpha), "later 2", ...at(t2, t12)]);

    // Collapse all, then Expand all, then fold one lane.
    await page.locator('button[aria-label="Collapse all lanes"]').click();
    await expect.poll(() => listed(page), POLL).toEqual(["now 2", "later 2"]);
    expect(await page.locator('button[aria-label="Collapse all lanes"]').isDisabled()).toBe(true);
    await page.locator('button[aria-label="Expand all lanes"]').click();
    await expect.poll(() => listed(page), POLL).toEqual(["now 2", ...at(beta, alpha), "later 2", ...at(t2, t12)]);
    await page.locator("button.task-group-header", { hasText: "later" }).click();
    await expect.poll(() => listed(page), POLL).toEqual(["now 2", ...at(beta, alpha), "later 2"]);
    expect(await page.locator("button.task-group-header", { hasText: "later" }).getAttribute("aria-expanded")).toBe(
      "false",
    );

    desktop = await desktop.relaunch();
    await waitForDashboard(desktop.page);
    await waitForLive(desktop.page);
    await expect.poll(() => listed(desktop.page), POLL).toEqual(["now 2", ...at(beta, alpha), "later 2"]);
    await desktop.page.locator("button.task-group-header", { hasText: "later" }).click();
    await expect.poll(() => listed(desktop.page), POLL).toEqual([
      "now 2",
      ...at(beta, alpha),
      "later 2",
      ...at(t2, t12),
    ]);
  });
});
