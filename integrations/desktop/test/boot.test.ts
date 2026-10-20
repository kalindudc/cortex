import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type DesktopApp, launchDesktop, readWorkspace, UUID, waitForDashboard } from "./harness.ts";
import { rowCount, waitForLive, waitForRow } from "./live.ts";

let desktop: DesktopApp;

beforeAll(async () => {
  desktop = await launchDesktop();
});

afterAll(async () => {
  await desktop?.close();
});

describe("boot", () => {
  test("loads the dashboard on cortex://app with only the bridge exposed", async () => {
    const { page } = desktop;
    await waitForDashboard(page);
    const workspace = await readWorkspace(page);
    expect(workspace.instanceId).toMatch(UUID);
    expect(workspace.taskCount).toBe(0);
    expect(page.url()).toBe("cortex://app/");
    const probe = await page.evaluate(() => ({
      origin: location.origin,
      bridge: Object.keys(window.cortex).sort(),
      drafts: Object.keys(window.cortex.drafts).sort(),
      require: typeof (globalThis as { require?: unknown }).require,
      process: typeof (globalThis as { process?: unknown }).process,
    }));
    expect(probe).toEqual({
      origin: "cortex://app",
      bridge: ["attach", "drafts", "onFrame", "onOpen", "onState", "request", "resume"],
      drafts: ["export", "onRelease", "onSaveAll", "report"],
      require: "undefined",
      process: "undefined",
    });
  });

  test("shows CLI writes in the task list live, and again after a reload", async () => {
    const { page } = desktop;
    await waitForLive(page);
    await desktop.cortex(["add", "probe"]);
    await waitForRow(page, "probe");
    await page.reload();
    await waitForDashboard(page);
    await waitForLive(page);
    await desktop.cortex(["add", "second probe"]);
    await waitForRow(page, "second probe");
    expect(await rowCount(page, "probe")).toBe(2);
    expect((await readWorkspace(page)).taskCount).toBe(2);
  });
});
