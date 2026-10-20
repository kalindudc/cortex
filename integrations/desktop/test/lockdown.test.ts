import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type DesktopApp, launchDesktop, waitForDashboard } from "./harness.ts";

let desktop: DesktopApp;

beforeAll(async () => {
  desktop = await launchDesktop();
  await waitForDashboard(desktop.page);
});

afterAll(async () => {
  await desktop?.close();
});

describe("lockdown", () => {
  test("the bridge refuses control routes, traversal and non-API paths, and the daemon survives", async () => {
    const errors = await desktop.page.evaluate(async () => {
      const attempts = [
        { method: "POST", path: "/api/control/shutdown" },
        { method: "GET", path: "/api/../etc/hosts" },
        { method: "GET", path: "/events" },
      ];
      const out: string[] = [];
      for (const attempt of attempts) {
        try {
          await window.cortex.request(attempt);
          out.push("accepted");
        } catch (err) {
          out.push((err as Error).message);
        }
      }
      return out;
    });
    expect(errors).toHaveLength(3);
    for (const message of errors) expect(message).toContain("invalid bridge request");
    const doctor = JSON.parse(await desktop.cortex(["doctor", "--json"]));
    expect(doctor.daemon.running).toBe(true);
  });

  test("the scheme answers 404 for unknown files and /api/, and the shell with a CSP for app routes", async () => {
    const result = await desktop.page.evaluate(async () => {
      const [missing, api, route] = await Promise.all([fetch("/missing.js"), fetch("/api/workspace"), fetch("/task/42")]);
      return { missing: missing.status, api: api.status, route: route.status, csp: route.headers.get("content-security-policy") };
    });
    expect(result.missing).toBe(404);
    expect(result.api).toBe(404);
    expect(result.route).toBe(200);
    expect(result.csp).toContain("default-src 'self'");
  });

  test("navigation stays on cortex://app and window.open goes to the system browser", async () => {
    const { app, page } = desktop;
    await app.evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as { opened?: string[] }).opened = opened;
      shell.openExternal = async (url: string) => {
        opened.push(url);
      };
    });
    await page.evaluate(() => {
      location.href = "file:///etc/hosts";
    });
    await page.waitForTimeout(500);
    expect(page.url()).toBe("cortex://app/");
    expect(await page.evaluate(() => window.open("https://example.com/"))).toBeNull();
    await expect
      .poll(() => app.evaluate(() => (globalThis as { opened?: string[] }).opened))
      .toEqual(["https://example.com/"]);
    expect(app.windows()).toHaveLength(1);
  });
});
