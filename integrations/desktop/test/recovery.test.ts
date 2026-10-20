import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type DesktopApp, launchDesktop, readWorkspace, UUID, waitForDashboard } from "./harness.ts";

let desktop: DesktopApp;

beforeAll(async () => {
  desktop = await launchDesktop();
  await waitForDashboard(desktop.page);
});

afterAll(async () => {
  await desktop?.close();
});

describe("recovery", () => {
  test("a stopped daemon is restarted by the next request and the bridge reaches the new instance", async () => {
    const { page } = desktop;
    const before = (await readWorkspace(page)).instanceId;
    expect(before).toMatch(UUID);
    await desktop.cortex(["stop"]);
    const status = await page.evaluate(async () => (await window.cortex.request({ method: "GET", path: "/api/health" })).status);
    expect(status).toBe(200);
    await expect
      .poll(async () => (await readWorkspace(page)).instanceId, { timeout: 15_000 })
      .not.toBe(before);
    expect((await readWorkspace(page)).instanceId).toMatch(UUID);
  });
});
