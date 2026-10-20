import { spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type DesktopApp, DASHBOARD_READY, launchDesktop, readWorkspace, waitForDashboard } from "./harness.ts";

let desktop: DesktopApp;

beforeAll(async () => {
  desktop = await launchDesktop();
  await waitForDashboard(desktop.page);
});

afterAll(async () => {
  await desktop?.close();
});

describe("single instance", () => {
  test("a second launch on the same profile exits and the first window stays", async () => {
    const second = spawn(desktop.electronPath, desktop.launchArgs, { env: desktop.env, stdio: "ignore" });
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        second.kill("SIGKILL");
        reject(new Error("the second instance did not exit"));
      }, 20_000);
      second.on("exit", exitCode => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });
    expect(code).toBe(0);
    expect(desktop.app.windows()).toHaveLength(1);
    expect(await desktop.page.locator(DASHBOARD_READY).count()).toBe(1);
    expect((await readWorkspace(desktop.page)).taskCount).toBe(0);
  });
});
