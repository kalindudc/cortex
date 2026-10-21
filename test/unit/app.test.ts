import { describe, expect, test } from "bun:test";
import path from "node:path";
import { type AppHost, type AppRequest, appLaunch, checkAppArgs, NOT_INSTALLED } from "../../src/commands/app.ts";

function host(o: Partial<AppHost> & { files?: string[]; dirs?: Record<string, string[]> } = {}): AppHost {
  const files = new Set(o.files ?? []);
  return {
    platform: o.platform ?? "darwin",
    env: o.env ?? {},
    home: o.home ?? "/home/me",
    which: o.which ?? (() => null),
    exists: o.exists ?? (file => files.has(file)),
    list: o.list ?? (dir => o.dirs?.[dir] ?? []),
  };
}

const at42: AppRequest = { taskId: 42, heading: "plan" };

describe("checkAppArgs", () => {
  test("accepts an id, an @id and a heading with a leading #", () => {
    expect(checkAppArgs({})).toEqual({ ok: true, request: {} });
    expect(checkAppArgs({ id: "42" })).toEqual({ ok: true, request: { taskId: 42 } });
    expect(checkAppArgs({ id: "@42" })).toEqual({ ok: true, request: { taskId: 42 } });
    expect(checkAppArgs({ id: "42", heading: "#task-42-plan" })).toEqual({
      ok: true,
      request: { taskId: 42, heading: "task-42-plan" },
    });
  });

  test("rejects a bad id, a heading without an id and a heading with a space", () => {
    for (const args of [{ id: "x" }, { id: "0" }, { heading: "plan" }, { id: "42", heading: "a plan" }]) {
      const check = checkAppArgs(args);
      expect(check.ok).toBe(false);
      if (!check.ok) expect(check.message).not.toContain("\n");
    }
  });
});

describe("appLaunch on macOS", () => {
  test("opens /Applications/Cortex.app with -n, the environment and the app arguments", () => {
    const launch = appLaunch(
      at42,
      host({
        env: { CORTEX_DB: "/tmp/x/cortex.db", PATH: "/usr/bin:/bin", BB_CLI: "/opt/bb" },
        files: ["/Applications/Cortex.app"],
      }),
    );
    expect(launch).toEqual({
      argv: [
        "open",
        "-n",
        "-a",
        "/Applications/Cortex.app",
        "--env",
        "PATH=/usr/bin:/bin",
        "--env",
        "BB_CLI=/opt/bb",
        "--args",
        "--cortex-db=/tmp/x/cortex.db",
        "--task=42",
        "--heading=plan",
      ],
      wait: true,
    });
  });

  test("passes BB_CLI only when it is set, and omits --args when there are none", () => {
    const launch = appLaunch({}, host({ env: { PATH: "/bin" }, files: ["/Applications/Cortex.app"] }));
    expect(launch).toEqual({
      argv: ["open", "-n", "-a", "/Applications/Cortex.app", "--env", "PATH=/bin"],
      wait: true,
    });
  });

  test("/Applications wins over ~/Applications, which is the fallback", () => {
    const both = host({ files: ["/Applications/Cortex.app", "/home/me/Applications/Cortex.app"] });
    expect(appLaunch({}, both)).toMatchObject({ argv: ["open", "-n", "-a", "/Applications/Cortex.app"] });
    const userOnly = host({ files: ["/home/me/Applications/Cortex.app"] });
    expect(appLaunch({}, userOnly)).toMatchObject({ argv: ["open", "-n", "-a", "/home/me/Applications/Cortex.app"] });
  });

  test("a relative CORTEX_DB becomes absolute", () => {
    const launch = appLaunch({}, host({ env: { CORTEX_DB: "rel/cortex.db" }, files: ["/Applications/Cortex.app"] }));
    expect(launch).toMatchObject({ argv: expect.arrayContaining([`--cortex-db=${path.resolve("rel/cortex.db")}`]) });
  });

  test("reports the not-installed line when no app exists", () => {
    expect(appLaunch(at42, host())).toEqual({ missing: NOT_INSTALLED });
  });
});

describe("appLaunch on Linux", () => {
  test("prefers cortex-desktop on PATH", () => {
    const launch = appLaunch(
      { taskId: 7 },
      host({
        platform: "linux",
        which: c => (c === "cortex-desktop" ? "/usr/bin/cortex-desktop" : null),
        dirs: { "/home/me/Applications": ["Cortex-0.9.0.AppImage"] },
      }),
    );
    expect(launch).toEqual({ argv: ["/usr/bin/cortex-desktop", "--task=7"], wait: false });
  });

  test("falls back to the highest Cortex AppImage by numeric version, ignoring other names", () => {
    const launch = appLaunch(
      {},
      host({
        platform: "linux",
        dirs: {
          "/home/me/Applications": ["Cortex-0.9.0.AppImage", "Cortex-0.10.0.AppImage", "Other-9.0.0.AppImage", "notes"],
        },
      }),
    );
    expect(launch).toEqual({ argv: ["/home/me/Applications/Cortex-0.10.0.AppImage"], wait: false });
  });

  test("reports the not-installed line when nothing is found", () => {
    expect(appLaunch({}, host({ platform: "linux" }))).toEqual({ missing: NOT_INSTALLED });
  });
});

describe("CORTEX_DESKTOP_APP override", () => {
  test("a .app on macOS is opened", () => {
    const launch = appLaunch(
      { taskId: 3 },
      host({ env: { CORTEX_DESKTOP_APP: "/b/Cortex.app" }, files: ["/b/Cortex.app"] }),
    );
    expect(launch).toEqual({ argv: ["open", "-n", "-a", "/b/Cortex.app", "--args", "--task=3"], wait: true });
  });

  test("anything else is executed, also on Linux", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const launch = appLaunch(
        { taskId: 3 },
        host({ platform, env: { CORTEX_DESKTOP_APP: "/b/fake-app" }, files: ["/b/fake-app"] }),
      );
      expect(launch).toEqual({ argv: ["/b/fake-app", "--task=3"], wait: false });
    }
  });

  test("a missing override is reported even when an installed app exists", () => {
    const launch = appLaunch({}, host({ env: { CORTEX_DESKTOP_APP: "/nope" }, files: ["/Applications/Cortex.app"] }));
    expect(launch).toEqual({ missing: "cortex app: CORTEX_DESKTOP_APP=/nope does not exist" });
  });
});

test("NOT_INSTALLED is one line that names the install instructions and pnpm run desktop:dist", () => {
  expect(NOT_INSTALLED).not.toContain("\n");
  expect(NOT_INSTALLED).toContain("https://github.com/kalindudc/cortex#install");
  expect(NOT_INSTALLED).toContain("pnpm run desktop:dist");
});
