// Guarded drafts in real Chromium (plan @400 N8/G2/G3, Task 9): the browser
// racing another writer on the SAME task.
//
// The browser's draft starts from an atomic TaskState and sends every
// autosave as a versioned write guarded by that field's token. The other
// writer is either the TUI's way of writing (a guarded, versioned PATCH
// built from its own atomic read) or the CLI (`cortex edit`, unguarded,
// last-writer-wins by design). To make each race deterministic, the
// browser's save is HELD in flight (page.route) until the other writer has
// committed, then released:
//   - same field  → the daemon answers 412; the browser shows BOTH versions
//     (Apply / Keep my changes), the daemon keeps the other writer's text,
//     and Keep (keyboard) writes conditionally over the version shown;
//   - other field → no conflict: both writes land;
//   - unguarded CLI → the CLI simply wins on the daemon (a clean browser
//     draft follows it); a dirty browser draft is kept beside it, never
//     written over it.
// page.waitForTimeout is BANNED — auto-waiting locators and polls only.

import type { Page, Request, Route } from "@playwright/test";
import type { TaskStateSnapshot, Versions } from "../../src/contracts.ts";
import { test, expect } from "./fixtures/cortex-server.ts";

const MOD = process.platform === "darwin" ? "Meta" : "Control";

async function send(url: string, method: string, path: string, body?: object, headers: object = {}): Promise<Response> {
  return fetch(`${url}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function seedTask(url: string, title: string, body: string): Promise<number> {
  const response = await send(url, "POST", "/api/tasks", { title, body });
  if (!response.ok) throw new Error(`seed task: ${response.status} ${await response.text()}`);
  return ((await response.json()) as { id: number }).id;
}

async function taskState(url: string, id: number): Promise<TaskStateSnapshot> {
  const response = await send(url, "GET", `/api/tasks/${id}/state`);
  if (!response.ok) throw new Error(`task state: ${response.status} ${await response.text()}`);
  return (await response.json()) as TaskStateSnapshot;
}

/** What the TUI's drafts send: the changed field plus its expected token from their own atomic read. */
function guardedEdit(url: string, id: number, fields: object, expected: Versions): Promise<Response> {
  return send(url, "PATCH", `/api/tasks/${id}`, { ...fields, guard: { expected } }, { prefer: "cortex-versioned" });
}

/** Hold the page's saves (PATCH) of task `id` in flight until release(); later saves pass straight through. */
async function holdSaves(page: Page, url: string, id: number) {
  const held: Route[] = [];
  let releasing = false;
  await page.route(`${url}/api/tasks/${id}`, async route => {
    if (route.request().method() !== "PATCH" || releasing) {
      await route.continue();
      return;
    }
    held.push(route);
  });
  return {
    count: (): number => held.length,
    requests: (): Request[] => held.map(route => route.request()),
    release: async (): Promise<void> => {
      releasing = true;
      for (const route of held.splice(0)) await route.continue();
    },
  };
}

/** Open the task in Edit and type at the end of its body. */
async function openEditor(page: Page, url: string, id: number) {
  await page.goto(`${url}/task/${id}`);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = page.locator(".md-editor .cm-content");
  await expect(editor).toBeVisible();
  return editor;
}
async function typeAtEnd(page: Page, editor: ReturnType<Page["locator"]>, text: string): Promise<void> {
  await editor.click();
  await page.keyboard.press(`${MOD}+End`);
  await page.keyboard.type(text);
}

test("the browser and a guarded writer (the TUI's way) change the same body: a visible conflict, never a silent overwrite", async ({
  url,
  page,
}) => {
  const id = await seedTask(url, "Race target", "Base body.");
  const editor = await openEditor(page, url, id);
  const baseline = await taskState(url, id);

  const saves = await holdSaves(page, url, id);
  await typeAtEnd(page, editor, " Browser edit.");
  // The autosave went out as a versioned write guarded by the body token it was edited against.
  await expect.poll(saves.count).toBe(1);
  const sent = saves.requests()[0];
  expect(sent.headers().prefer).toBe("cortex-versioned");
  expect(JSON.parse(sent.postData() ?? "null")).toEqual({
    body: "Base body. Browser edit.",
    guard: { expected: { body: baseline.versions.body } },
  });

  // Meanwhile the TUI saves the same field, guarded by its own atomic read: it lands first.
  const tui = await guardedEdit(url, id, { body: "TUI edit." }, { body: baseline.versions.body });
  expect(tui.status).toBe(200);
  await saves.release();

  // The browser's stale save is refused (412) and BOTH versions stay visible.
  const banner = page.locator(".external-change-banner");
  await expect(banner).toContainText("Body updated externally");
  await expect(banner).toContainText("TUI edit.");
  await expect(editor).toContainText("Base body. Browser edit.");
  expect((await taskState(url, id)).task.body).toBe("TUI edit.");

  // Keyboard path: "Keep my changes" rebases on the version shown and writes conditionally.
  await banner.getByRole("button", { name: "Keep my changes" }).focus();
  await page.keyboard.press("Enter");
  await expect(banner).toHaveCount(0);
  await expect.poll(async () => (await taskState(url, id)).task.body).toBe("Base body. Browser edit.");
  await expect(page.locator(".draft-state")).toHaveCount(0);
});

test("a concurrent change to a different field is not a conflict: both writes land", async ({ url, page }) => {
  const id = await seedTask(url, "Title before", "Base body.");
  const editor = await openEditor(page, url, id);

  const saves = await holdSaves(page, url, id);
  await typeAtEnd(page, editor, " Browser edit.");
  await expect.poll(saves.count).toBe(1);

  // The TUI renames the task (guarded on the TITLE only) and moves its status meanwhile.
  const before = await taskState(url, id);
  expect((await guardedEdit(url, id, { title: "Title from the TUI" }, { title: before.versions.title })).status).toBe(
    200,
  );
  expect((await send(url, "PATCH", `/api/tasks/${id}/status`, { status: "review" })).status).toBe(200);
  await saves.release();

  await expect.poll(async () => (await taskState(url, id)).task.body).toBe("Base body. Browser edit.");
  const after = await taskState(url, id);
  expect(after.task.title).toBe("Title from the TUI");
  expect(after.task.status).toBe("review");
  // The clean title follows the other writer; nothing is shown as a conflict.
  await expect(page.locator(".task-header .task-title-text")).toHaveText("Title from the TUI");
  await expect(page.locator(".draft-state")).toHaveCount(0);
  await expect(page.locator(".external-change-banner")).toHaveCount(0);
  await expect(editor).toContainText("Base body. Browser edit.");
});

test("an unguarded CLI write stays last-writer-wins; a dirty browser draft is kept beside it, never written over it", async ({
  url,
  page,
  cli,
}) => {
  const id = await seedTask(url, "CLI race", "Base body.");
  const editor = await openEditor(page, url, id);
  await typeAtEnd(page, editor, " Browser edit.");
  await page.keyboard.press(`${MOD}+KeyS`);
  await expect.poll(async () => (await taskState(url, id)).task.body).toBe("Base body. Browser edit.");
  await expect(page.locator(".draft-state")).toHaveCount(0);

  // The CLI never read a version: its write is unguarded and simply wins (documented behavior).
  const first = await cli(["edit", String(id), "--body", "CLI body."]);
  expect(first.code, first.stderr).toBe(0);
  expect((await taskState(url, id)).task.body).toBe("CLI body.");
  // The browser had nothing unsaved, so it follows the last writer without a conflict.
  await expect(editor).toHaveText("CLI body.");
  await expect(page.locator(".external-change-banner")).toHaveCount(0);

  // With unsaved browser typing, the CLI still wins on the daemon; the browser keeps both versions.
  const saves = await holdSaves(page, url, id);
  await typeAtEnd(page, editor, " More browser.");
  await expect.poll(saves.count).toBe(1);
  const second = await cli(["edit", String(id), "--body", "CLI again."]);
  expect(second.code, second.stderr).toBe(0);
  await saves.release();
  const banner = page.locator(".external-change-banner");
  await expect(banner).toContainText("CLI again.");
  await expect(editor).toContainText("CLI body. More browser.");
  expect((await taskState(url, id)).task.body).toBe("CLI again.");
});
