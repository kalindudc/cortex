/**
 * cortex app — the real launch through the compiled binary. Every case sets
 * CORTEX_DESKTOP_APP, so a desktop app installed on the developer's machine
 * is never opened.
 */

import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { mkTmpEnv, runCli } from "../helpers.ts";

const sandbox = mkTmpEnv("app");
afterAll(() => sandbox.cleanup());

async function waitForFile(file: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, "utf8");
      if (text.endsWith("\n")) return text;
    }
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${file}`);
}

function daemonMetadata(dir: string): string[] {
  return fs.readdirSync(dir).filter(name => name.endsWith(".daemon.json"));
}

describe("cortex app", () => {
  test("launches the override with the database, task and heading", async () => {
    const out = path.join(sandbox.tmpDir, "args.txt");
    const fake = path.join(sandbox.tmpDir, "fake-app");
    fs.writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > "${out}.tmp"\nmv "${out}.tmp" "${out}"\n`, {
      mode: 0o755,
    });

    const r = await runCli({
      args: ["app", "7", "--heading", "plan"],
      env: { ...sandbox.env, CORTEX_DESKTOP_APP: fake },
    });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);

    const args = (await waitForFile(out, 5000)).trimEnd().split("\n");
    expect(args).toEqual([`--cortex-db=${sandbox.env.CORTEX_DB}`, "--task=7", "--heading=plan"]);
    expect(daemonMetadata(sandbox.tmpDir)).toEqual([]);
  });

  test("a missing override prints one line, exits 1 and starts no daemon", async () => {
    const missing = path.join(sandbox.tmpDir, "no-such-app");
    const r = await runCli({ args: ["app"], env: { ...sandbox.env, CORTEX_DESKTOP_APP: missing } });
    expect(r.code).toBe(1);
    expect(r.stderr.trimEnd().split("\n")).toEqual([`cortex app: CORTEX_DESKTOP_APP=${missing} does not exist`]);
    expect(daemonMetadata(sandbox.tmpDir)).toEqual([]);
  });
});
