// Smoke test of a packaged app (`pnpm run desktop:dist`), run only when
// CORTEX_DESKTOP_APP names it: a macOS `.app` bundle or a Linux executable
// such as dist/linux-unpacked/cortex-desktop. It does not use the dev harness,
// because a packaged app must find its own resources and start its bundled
// daemon. Everything lives in a temporary root and the environment is built
// from scratch, so the user's real cortex data is never reached.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron, type ElectronApplication } from "playwright-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const target = process.env.CORTEX_DESKTOP_APP;

function executableOf(app: string): string {
  if (!app.endsWith(".app")) return app;
  const macos = path.join(app, "Contents/MacOS");
  const [only, ...rest] = fs.readdirSync(macos);
  if (only === undefined || rest.length > 0) throw new Error(`expected one executable in ${macos}`);
  return path.join(macos, only);
}

// Where the bundled cortex sits, for cleanup when the test failed before asking the app.
function bundledCortex(app: string): string {
  return app.endsWith(".app") ? path.join(app, "Contents/Resources/cortex") : path.join(path.dirname(app), "resources/cortex");
}

function run(bin: string, args: string[], env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { env, timeout: 20_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${path.basename(bin)} ${args.join(" ")} failed: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}

describe.skipIf(!target)("packaged app", () => {
  let root = "";
  let db = "";
  let env: Record<string, string> = {};
  let app: ElectronApplication | undefined;
  let cortexBin: string | undefined;

  beforeAll(() => {
    // Short names: the daemon's socket lives under run/ and AF_UNIX paths are limited.
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cxp-"));
    const dir = (name: string): string => {
      const p = path.join(root, name);
      fs.mkdirSync(p, { mode: 0o700 });
      return p;
    };
    db = path.join(dir("db"), "cortex.db");
    dir("ud");
    env = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: dir("home"),
      TERM: process.env.TERM ?? "xterm-256color",
      LANG: process.env.LANG ?? "en_US.UTF-8",
      TMPDIR: os.tmpdir(),
      CORTEX_DB: db,
      XDG_CONFIG_HOME: dir("cfg"),
      XDG_RUNTIME_DIR: dir("run"),
      CORTEX_BB_CLI: "",
      CORTEX_DESKTOP_HIDDEN: "1",
    };
    // xvfb-run names its auth cookie in XAUTHORITY; without it X11 looks in the temporary HOME and refuses the display.
    for (const name of ["DISPLAY", "XAUTHORITY"]) {
      const value = process.env[name];
      if (value) env[name] = value;
    }
  });

  afterAll(async () => {
    await app?.close().catch(() => {});
    if (root) await run(cortexBin ?? bundledCortex(target as string), ["stop"], env).catch(() => {});
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  test("finds its resources, starts its bundled daemon and shows tasks", async () => {
    app = await _electron.launch({
      executablePath: executableOf(target as string),
      args: [`--cortex-db=${db}`, `--user-data-dir=${path.join(root, "ud")}`],
      env,
    });
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);

    const resources = await app.evaluate(() => process.resourcesPath);
    for (const entry of ["cortex", "ui/index.html", "app.asar"]) {
      expect(fs.existsSync(path.join(resources, entry)), `${entry} in ${resources}`).toBe(true);
    }
    cortexBin = path.join(resources, "cortex");

    const page = await app.firstWindow();
    await page.waitForURL(url => url.href.startsWith("cortex://app/"), { timeout: 15_000 });
    await expect.poll(() => fs.existsSync(`${db}.daemon.json`), { timeout: 20_000 }).toBe(true);

    await run(cortexBin, ["add", "Packaged smoke task", "--as", "smoke-00000001"], env);
    await page.getByText("Packaged smoke task").first().waitFor({ timeout: 15_000 });

    await app.close();
    app = undefined;
    const doctor = JSON.parse(await run(cortexBin, ["doctor", "--json"], env)) as { daemon?: { running?: boolean } };
    expect(doctor.daemon?.running).toBe(true);

    await run(cortexBin, ["stop"], env);
    expect(fs.existsSync(`${db}.daemon.json`)).toBe(false);
  });
});
