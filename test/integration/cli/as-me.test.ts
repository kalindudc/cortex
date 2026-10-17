import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Store } from "../../../src/store.ts";
import { reap, startForeground } from "../fixtures/daemon.ts";
import { mkTmpEnv, runCli } from "../helpers.ts";

// `cortex update --as-me` records a change as the user's own, the way the TUI
// does: credited to the user's author name (also `cortex doctor`'s `author`)
// and never notifying. HOME is a sandbox whose gh hosts file names the user,
// so the author cascade is deterministic and never reads the real home.

const USER = "cortex-test-user";
const AGENT = "agent-1a2b3c4d";

let env: Record<string, string>;
let cleanup: () => void;

beforeAll(async () => {
  const e = mkTmpEnv("as-me");
  cleanup = e.cleanup;
  const home = path.join(e.tmpDir, "home");
  fs.mkdirSync(path.join(home, ".config", "gh"), { recursive: true });
  fs.writeFileSync(path.join(home, ".config", "gh", "hosts.yml"), `github.com:\n    user: ${USER}\n`);
  env = { ...e.env, HOME: home };
  expect((await runCli({ args: ["init"], env })).code).toBe(0);
});

afterEach(async () => {
  await reap();
});

afterAll(() => cleanup());

async function run(args: string[], extra: Record<string, string> = {}) {
  return runCli({ args, env: { ...env, ...extra } });
}

async function addTask(title: string): Promise<number> {
  const r = await run(["add", title, "--as", AGENT, "--json"]);
  expect(r.code).toBe(0);
  return (JSON.parse(r.stdout) as { id: number }).id;
}

async function updatesOf(id: number) {
  const r = await run(["show", String(id), "--json"]);
  expect(r.code).toBe(0);
  const shown = JSON.parse(r.stdout) as {
    task: { status: string };
    updates: Array<{ id: number; author: string; summary: string; body: string | null }>;
  };
  return shown;
}

const notificationsFor = (id: number): number =>
  Store.readSnapshot(env.CORTEX_DB ?? "", store => store.listNotifications()).filter(n => n.task_id === id).length;

describe("cortex update --as-me", () => {
  test("a status-only change is credited to the user and records no notification; an agent's does", async () => {
    const id = await addTask("status only");
    const before = notificationsFor(id);
    const r = await run(["update", String(id), "--as-me", "-s", "blocked", "--json"]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as { update: { author: string; summary: string }; status: string };
    expect(out.status).toBe("blocked");
    expect(out.update).toMatchObject({ author: USER, summary: "status \u2192 blocked" });
    expect((await updatesOf(id)).task.status).toBe("blocked");
    expect(notificationsFor(id)).toBe(before);

    // The control: the same kind of change by an agent does notify.
    expect((await run(["update", String(id), "-m", "back", "-s", "open", "--as", AGENT])).code).toBe(0);
    expect(notificationsFor(id)).toBe(before + 1);
  });

  test("through a running daemon the status change is still the user's and silent", async () => {
    const id = await addTask("via daemon");
    await startForeground(env);
    const before = notificationsFor(id);
    const r = await run(["update", String(id), "--as-me", "-s", "review"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^\u2713 status \u2192 review \(update \[\d+\]\)\n$/);
    const last = (await updatesOf(id)).updates.at(-1);
    expect(last).toMatchObject({ author: USER, summary: "status \u2192 review" });
    expect(notificationsFor(id)).toBe(before);
  });

  test("a note is posted as the user, with and without a status change", async () => {
    const id = await addTask("notes");
    const before = notificationsFor(id);
    const plain = await run(["update", String(id), "--as-me", "-m", "just a note", "--json"]);
    expect(plain.code).toBe(0);
    expect(JSON.parse(plain.stdout)).toMatchObject({ update: { author: USER, summary: "just a note" } });
    expect(JSON.parse(plain.stdout).status).toBeUndefined();

    const withStatus = await run([
      "update",
      String(id),
      "--as-me",
      "-m",
      "shipping it",
      "-b",
      "- detail",
      "-s",
      "done",
      "--json",
    ]);
    expect(withStatus.code).toBe(0);
    expect(JSON.parse(withStatus.stdout)).toMatchObject({
      update: { author: USER, summary: "shipping it", body: "- detail" },
      status: "done",
    });
    const shown = await updatesOf(id);
    expect(shown.task.status).toBe("done");
    expect(shown.updates.slice(-3).map(u => [u.author, u.summary])).toEqual([
      [USER, "just a note"],
      [USER, "shipping it"],
      [USER, "status \u2192 done"],
    ]);
    expect(notificationsFor(id)).toBe(before);
  });

  test("--as-me ignores BB_THREAD_ID", async () => {
    const id = await addTask("bb thread");
    const r = await run(["update", String(id), "--as-me", "-m", "from a tool", "--json"], {
      BB_THREAD_ID: "thr_2qj8qzdqqr",
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).update.author).toBe(USER);
  });

  test("--as-me with --as fails before any write", async () => {
    const id = await addTask("conflict");
    const r = await run(["update", String(id), "--as-me", "--as", AGENT, "-s", "done", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error.message).toBe("--as-me cannot be combined with --as");
    expect((await updatesOf(id)).task.status).toBe("open");
  });

  test("-m stays required unless --as-me changes only the status", async () => {
    const id = await addTask("message rules");
    for (const args of [["-s", "done", "--as", AGENT], ["--as", AGENT], ["--as-me"], ["-s", "done"]]) {
      const r = await run(["update", String(id), ...args, "--json"], { BB_THREAD_ID: "thr_2qj8qzdqqr" });
      expect(r.code, args.join(" ")).toBe(1);
      expect(JSON.parse(r.stdout).error.message).toBe("--message is required (only --as-me -s <status> may omit it)");
    }
    const bodyOnly = await run(["update", String(id), "--as-me", "-s", "done", "-b", "detail", "--json"]);
    expect(bodyOnly.code).toBe(1);
    expect(JSON.parse(bodyOnly.stdout).error.message).toBe("--body needs --message");
    expect((await updatesOf(id)).task.status).toBe("open");
  });
});

describe("cortex doctor: author", () => {
  test("--json reports the user's author name, and the human report names it", async () => {
    const json = await run(["doctor", "--json"]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout).author).toBe(USER);
    const human = await run(["doctor"]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain(`author:     ${USER}`);
  });
});
