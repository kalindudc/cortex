// Launches the built desktop app in real Chromium on a throwaway database.
// Every launch gets its own database, config, 0700 runtime, HOME and Electron
// profile directories and an environment built from scratch, so nothing
// reaches the user's real cortex data. close() stops the daemon it started.

import { execFile } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron, type ElectronApplication, type Page } from "playwright-core";

export const ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const CORTEX_BIN = path.join(ROOT, "bin/cortex");

export interface DesktopApp {
  electronPath: string;
  launchArgs: string[];
  app: ElectronApplication;
  page: Page;
  env: Record<string, string>;
  cortex(args: string[]): Promise<string>;
  /**
   * Close only the Electron app (the daemon keeps running and no directory
   * is removed), then launch again on the same database and Electron
   * profile; `options.args` replaces the original extra arguments.
   */
  relaunch(options?: { args?: string[] }): Promise<DesktopApp>;
  close(): Promise<void>;
}

export interface LaunchOptions {
  /** Extra environment variables for the app (and for cortex()). */
  env?: Record<string, string>;
  /** Extra app arguments, after the harness's own. */
  args?: string[];
}

interface Sandbox {
  electronPath: string;
  baseArgs: string[];
  env: Record<string, string>;
  cortex(args: string[]): Promise<string>;
  cleanup(): Promise<void>;
}

function runCortex(args: string[], env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(CORTEX_BIN, args, { env, timeout: 20_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`cortex ${args.join(" ")} failed: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}

export async function launchDesktop(options: LaunchOptions = {}): Promise<DesktopApp> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-desktop-"));
  // Sockets live in the runtime dir; a short path stays under the AF_UNIX limit.
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "cxd-"));
  fs.chmodSync(runtime, 0o700);
  const dir = (name: string): string => {
    const p = path.join(base, name);
    fs.mkdirSync(p);
    return p;
  };
  const db = path.join(dir("db"), "cortex.db");
  const config = dir("config");
  const home = dir("home");
  const profile = dir("profile");
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    TMPDIR: os.tmpdir(),
    LANG: process.env.LANG ?? "en_US.UTF-8",
    XDG_CONFIG_HOME: config,
    XDG_RUNTIME_DIR: runtime,
    CORTEX_DB: db,
    CORTEX_SKILL_DIR: path.join(base, "skills"),
    CORTEX_PI_EXTENSION_DIR: path.join(base, "extensions"),
    CORTEX_BB_CLI: "",
    CORTEX_DESKTOP_CORTEX_BIN: CORTEX_BIN,
    CORTEX_UI_DIR: path.join(ROOT, "out/ui"),
    CORTEX_DESKTOP_HIDDEN: "1",
    ...options.env,
  };
  // xvfb-run names its auth cookie in XAUTHORITY; without it X11 looks in the temporary HOME and refuses the display.
  for (const name of ["DISPLAY", "XAUTHORITY"]) {
    const value = process.env[name];
    if (value) env[name] = value;
  }

  const cortex = (args: string[]): Promise<string> => runCortex(args, env);
  const sandbox: Sandbox = {
    electronPath: createRequire(import.meta.url)("electron") as string,
    baseArgs: [path.join(ROOT, "integrations/desktop"), `--cortex-db=${db}`, `--user-data-dir=${profile}`],
    env,
    cortex,
    cleanup: async () => {
      await cortex(["stop"]).catch(() => {});
      fs.rmSync(base, { recursive: true, force: true });
      fs.rmSync(runtime, { recursive: true, force: true });
    },
  };
  return start(sandbox, options.args ?? []);
}

// Teardown answers a close-guard dialog with Discard, so a test that left a
// draft unsaved cannot hang it, and it tolerates an app that a test already
// closed or quit.
async function quit(app: ElectronApplication): Promise<void> {
  await app
    .evaluate(({ dialog }) => {
      dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox;
    })
    .catch(() => {});
  await app.close().catch(() => {});
}

async function start(sandbox: Sandbox, extraArgs: string[]): Promise<DesktopApp> {
  const { electronPath, env, cortex } = sandbox;
  const launchArgs = [...sandbox.baseArgs, ...extraArgs];
  let app: ElectronApplication | undefined;
  try {
    app = await _electron.launch({ executablePath: electronPath, args: launchArgs, env });
    const page = await app.firstWindow();
    const launched = app;
    return {
      electronPath,
      launchArgs,
      app: launched,
      page,
      env,
      cortex,
      relaunch: async options => {
        await quit(launched);
        return start(sandbox, options?.args ?? extraArgs);
      },
      close: async () => {
        await quit(launched);
        await sandbox.cleanup();
      },
    };
  } catch (err) {
    await app?.close().catch(() => {});
    await sandbox.cleanup();
    throw err;
  }
}

/** Wait until `selector`'s text satisfies `predicate` (a string means equality). */
export async function waitForText(page: Page, selector: string, expected: string | RegExp, timeout = 5_000) {
  await page.waitForFunction(
    ([sel, source, flags]) => {
      const text = document.querySelector(sel)?.textContent ?? "";
      return flags === null ? text === source : new RegExp(source, flags).test(text);
    },
    typeof expected === "string"
      ? ([selector, expected, null] as const)
      : ([selector, expected.source, expected.flags] as const),
    { timeout },
  );
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** An element the restored dashboard's App renders on every viewport: the status bar. */
export const DASHBOARD_READY = "main#app .status-bar";

/** Wait until the dashboard has mounted in the window. */
export async function waitForDashboard(page: Page, timeout = 10_000): Promise<void> {
  await page.waitForSelector(DASHBOARD_READY, { state: "attached", timeout });
}

/** The daemon's instance id and task count, read through the page's bridge. */
export async function readWorkspace(page: Page): Promise<{ instanceId: string; taskCount: number }> {
  return page.evaluate(async () => {
    const reply = await window.cortex.request({ method: "GET", path: "/api/workspace" });
    if (reply.status !== 200) throw new Error(`GET /api/workspace answered ${reply.status}`);
    const workspace = JSON.parse(reply.body) as { identity?: { instanceId?: string }; tasks: unknown[] };
    return { instanceId: workspace.identity?.instanceId ?? "", taskCount: workspace.tasks.length };
  });
}

/**
 * Record every bridge frame the page receives in `window.__frames`, then
 * (re)attach the window's subscription and wait for its `ready` frame.
 */
export async function recordFrames(page: Page, timeout = 5_000): Promise<void> {
  await page.evaluate(async () => {
    const frames: Array<{ event: string; data: string; id: string }> = [];
    (globalThis as { __frames?: typeof frames }).__frames = frames;
    window.cortex.onFrame(frame => {
      frames.push(frame);
    });
    await window.cortex.attach();
  });
  await waitForFrame(page, "ready", null, timeout);
}

/** Wait until the page has recorded a frame of `event` whose payload's title is `title` (null: any payload). */
export async function waitForFrame(page: Page, event: string, title: string | null, timeout = 5_000): Promise<void> {
  await page.waitForFunction(
    ([kind, expected]) =>
      ((globalThis as { __frames?: Array<{ event: string; data: string }> }).__frames ?? []).some(
        frame =>
          frame.event === kind && (expected === null || (JSON.parse(frame.data) as { title?: string }).title === expected),
      ),
    [event, title] as const,
    { timeout },
  );
}
