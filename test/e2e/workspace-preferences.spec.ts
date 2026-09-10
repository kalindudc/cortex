// Browser-owned view preference. Only the enum is cached, never task data.
import { test, expect } from "./fixtures/cortex-server.ts";

const MODE_KEY = "cortex-reader-mode-v1";
const MOD = process.platform === "darwin" ? "Meta" : "Control";
async function seed(url: string): Promise<{ a: number; b: number }> {
  const create = async (path: string, body: object): Promise<Response> => {
    const response = await fetch(`${url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Preference fixture ${path}: ${response.status}`);
    return response;
  };
  await create("/api/lanes", { name: "cortex" });
  const body = "## Intro\n\nKeep the selected mode.\n\n## Details\n\nA second heading.";
  const a = (await create("/api/tasks", { lane: "cortex", title: "Mode task A", body }).then(response =>
    response.json(),
  )) as { id: number };
  const b = (await create("/api/tasks", { lane: "cortex", title: "Mode task B", body }).then(response =>
    response.json(),
  )) as { id: number };
  return { a: a.id, b: b.id };
}

test("Read/Edit/Split choices survive task navigation, reloads and a new browser tab", async ({
  url,
  page,
  context,
}) => {
  const { a, b } = await seed(url);
  const writes: string[] = [];
  page.on("request", request => {
    if (["PATCH", "POST", "DELETE"].includes(request.method()) && request.url().includes("/api/tasks"))
      writes.push(request.url());
  });
  await page.goto(`${url}/task/${a}`);
  let destination = "Mode task B";
  for (const mode of ["Edit", "Split", "Read"]) {
    await page.getByRole("button", { name: mode, exact: true }).click();
    expect(await page.evaluate(key => localStorage.getItem(key), MODE_KEY)).toBe(mode.toLowerCase());
    await page.getByRole("tab", { name: "Activity", exact: true }).click();
    await page.locator(".task-row", { hasText: destination }).click();
    await expect(page.getByRole("tab", { name: "Document", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("button", { name: mode, exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.reload();
    await expect(page.locator(".task-title-display")).toHaveText(destination);
    await expect(page.getByRole("button", { name: mode, exact: true })).toHaveAttribute("aria-pressed", "true");
    if (mode === "Read") await expect(page.locator(".md-editor")).toHaveCount(0);
    else await expect(page.locator(".cm-editor")).toBeVisible();
    const second = await context.newPage();
    await second.goto(`${url}/task/${b}`);
    await expect(second.getByRole("button", { name: mode, exact: true })).toHaveAttribute("aria-pressed", "true");
    await second.close();
    destination = destination === "Mode task B" ? "Mode task A" : "Mode task B";
  }
  expect(writes).toEqual([]);
});

test("heading links and title editing do not overwrite the preferred body mode", async ({ url, page }) => {
  const { a, b } = await seed(url);
  await page.goto(`${url}/task/${a}`);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.goto(`${url}/task/${b}#task-${b}-details`);
  await expect(page.getByRole("button", { name: "Read", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(`#task-${b}-details`)).toBeVisible();
  expect(await page.evaluate(key => localStorage.getItem(key), MODE_KEY)).toBe("edit");
  await page.keyboard.press(`${MOD}+KeyP`);
  await page.locator(".palette-input").fill("/Edit title");
  await page.locator(".palette-input").press("Enter");
  await expect(page.locator(".title-input")).toBeFocused();
  await page.locator(".title-input").press("Escape");
  expect(await page.evaluate(key => localStorage.getItem(key), MODE_KEY)).toBe("edit");
  await page.locator(".task-row", { hasText: "Mode task A" }).click();
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("invalid stored modes are rejected and a fresh browser defaults to Read", async ({ url, page }) => {
  const { a } = await seed(url);
  await page.addInitScript(key => localStorage.setItem(key, "not-a-mode"), MODE_KEY);
  await page.goto(`${url}/task/${a}`);
  await expect(page.getByRole("button", { name: "Read", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".md-editor")).toHaveCount(0);
  expect(await page.evaluate(key => localStorage.getItem(key), MODE_KEY)).toBe("read");
});

test("unavailable storage does not block choosing a mode or retaining it during navigation", async ({ url, page }) => {
  const { a } = await seed(url);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(String(error)));
  await page.addInitScript(key => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name: string, value: string): void {
      if (name === key) throw new DOMException("Storage unavailable", "SecurityError");
      set.call(this, name, value);
    };
  }, MODE_KEY);
  await page.goto(`${url}/task/${a}`);
  await page.getByRole("button", { name: "Split", exact: true }).click();
  await page.locator(".task-row", { hasText: "Mode task B" }).click();
  await expect(page.getByRole("button", { name: "Split", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".cm-editor")).toBeVisible();
  expect(errors).toEqual([]);
});
