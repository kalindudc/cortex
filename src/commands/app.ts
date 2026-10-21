import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineCommand } from "citty";

// `cortex app [id] [--heading slug]` opens the installed desktop app, which
// starts its own daemon; this command never touches the database or a daemon.
// This module stays light on purpose: src/cli.ts imports entryArgs for every
// command, so the launcher's heavier imports live inside `run`.

/** The argv citty runs: ["app"] for plain `cortex` on an interactive terminal, otherwise `argv` unchanged. `interactive` is consulted only when argv is empty. */
export function entryArgs(argv: readonly string[], interactive: () => boolean): string[] {
  return argv.length === 0 && interactive() ? ["app"] : [...argv];
}

export interface AppRequest {
  taskId?: number;
  heading?: string;
}

export type AppArgCheck = { ok: true; request: AppRequest } | { ok: false; message: string };

/** Everything appLaunch reads from the machine, injected so the decision stays pure. */
export interface AppHost {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  which(command: string): string | null;
  exists(file: string): boolean;
  list(dir: string): string[];
}

export type AppLaunch = { argv: string[]; wait: boolean } | { missing: string };

export const NOT_INSTALLED =
  "cortex app: the desktop app is not installed; see https://github.com/kalindudc/cortex#install (from a checkout: `pnpm run desktop:dist`)";

// The app accepts the same heading anchors (src/desktop/deepLink.ts).
const HEADING_SLUG = /^[a-z0-9-]{1,256}$/i;
const APPIMAGE = /^Cortex-(\d+(?:\.\d+)*)(?:-[^/]*)?\.AppImage$/;

export function checkAppArgs(args: { id?: unknown; heading?: unknown }): AppArgCheck {
  const fail = (message: string): AppArgCheck => ({ ok: false, message });
  const request: AppRequest = {};

  if (args.id !== undefined) {
    const raw = String(args.id);
    const id = /^@?\d+$/.test(raw) ? Number(raw.replace(/^@/, "")) : Number.NaN;
    if (!Number.isSafeInteger(id) || id <= 0) {
      return fail(`invalid task id ${JSON.stringify(raw)}: expected a positive integer such as 42`);
    }
    request.taskId = id;
  }

  if (args.heading !== undefined) {
    if (request.taskId === undefined) return fail("--heading needs a task id: cortex app <id> --heading <slug>");
    const heading = typeof args.heading === "string" ? args.heading.replace(/^#/, "") : null;
    if (heading === null || !HEADING_SLUG.test(heading)) {
      return fail("--heading must be a heading anchor: letters, digits and '-', for example plan or task-42-plan");
    }
    request.heading = heading;
  }

  return { ok: true, request };
}

function appArgs(request: AppRequest, env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  if (env.CORTEX_DB) out.push(`--cortex-db=${path.resolve(env.CORTEX_DB)}`);
  if (request.taskId !== undefined) out.push(`--task=${request.taskId}`);
  if (request.heading !== undefined) out.push(`--heading=${request.heading}`);
  return out;
}

function versionParts(name: string): number[] | null {
  const m = APPIMAGE.exec(name);
  return m?.[1] ? m[1].split(".").map(Number) : null;
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function newestAppImage(host: AppHost): string | null {
  const dir = path.join(host.home, "Applications");
  let best: { file: string; version: number[] } | null = null;
  for (const name of host.list(dir)) {
    const version = versionParts(name);
    if (version && (best === null || compareVersions(version, best.version) > 0)) {
      best = { file: path.join(dir, name), version };
    }
  }
  return best?.file ?? null;
}

/** Where the app is and how to start it, or why it cannot be. Spawns nothing. */
export function appLaunch(request: AppRequest, host: AppHost): AppLaunch {
  const args = appArgs(request, host.env);
  // `open` hands the app a fresh environment, so resume would not find bb without these.
  const envArgs: string[] = [];
  for (const name of ["PATH", "BB_CLI"]) {
    const value = host.env[name];
    if (value) envArgs.push("--env", `${name}=${value}`);
  }
  // -n makes a second launch deliver its arguments while the app already runs.
  const openApp = (app: string): AppLaunch => ({
    argv: ["open", "-n", "-a", app, ...envArgs, ...(args.length > 0 ? ["--args", ...args] : [])],
    wait: true,
  });

  const override = host.env.CORTEX_DESKTOP_APP;
  if (override) {
    if (!host.exists(override)) return { missing: `cortex app: CORTEX_DESKTOP_APP=${override} does not exist` };
    if (host.platform === "darwin" && override.replace(/\/+$/, "").endsWith(".app")) return openApp(override);
    return { argv: [override, ...args], wait: false };
  }

  if (host.platform === "darwin") {
    for (const app of ["/Applications/Cortex.app", path.join(host.home, "Applications", "Cortex.app")]) {
      if (host.exists(app)) return openApp(app);
    }
    return { missing: NOT_INSTALLED };
  }

  if (host.platform === "linux") {
    const file = host.which("cortex-desktop") ?? newestAppImage(host);
    return file === null ? { missing: NOT_INSTALLED } : { argv: [file, ...args], wait: false };
  }

  return { missing: NOT_INSTALLED };
}

function realHost(): AppHost {
  return {
    platform: process.platform,
    env: process.env,
    home: os.homedir(),
    which: command => Bun.which(command),
    exists: file => fs.existsSync(file),
    list: dir => {
      try {
        return fs.readdirSync(dir);
      } catch {
        return [];
      }
    },
  };
}

function launch(argv: string[], wait: boolean): void {
  const [program, ...rest] = argv as [string, ...string[]];
  const failed = (err: NodeJS.ErrnoException): never => {
    console.error(`cortex app: cannot start ${program}: ${err.message ?? String(err)}`);
    process.exit(1);
  };
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(program, rest, { stdio: "ignore", detached: !wait });
  } catch (err) {
    failed(err as NodeJS.ErrnoException);
    return;
  }
  child.on("error", failed);
  if (wait) {
    child.on("exit", code => process.exit(code ?? 1));
    return;
  }
  child.unref();
  // Long enough for a missing or non-executable file to report its error first.
  setTimeout(() => process.exit(0), 200);
}

export default defineCommand({
  meta: {
    name: "app",
    description: "open the installed desktop app, optionally at a task (it starts its own daemon)",
  },
  args: {
    id: {
      type: "positional",
      required: false,
      description: "task id to open",
    },
    heading: {
      type: "string",
      valueHint: "slug",
      description: "open at this heading of that task: its slug or web anchor, e.g. plan or task-42-plan (needs an id)",
    },
  },
  run({ args }) {
    const check = checkAppArgs(args);
    if (!check.ok) {
      console.error(`error: ${check.message}`);
      process.exit(1);
    }
    const found = appLaunch(check.request, realHost());
    if ("missing" in found) {
      console.error(found.missing);
      process.exit(1);
    }
    launch(found.argv, found.wait);
  },
});
