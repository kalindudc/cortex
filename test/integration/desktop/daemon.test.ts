import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { connectDaemon, DaemonConnectError } from "../../../src/desktop/daemon.ts";
import { BIN, mkTmpEnv, runCli } from "../helpers.ts";

const sandbox = mkTmpEnv("desktop-daemon");

afterAll(async () => {
  await runCli({ args: ["stop"], env: sandbox.env });
  sandbox.cleanup();
});

describe("connectDaemon", () => {
  test("starts the database's daemon and returns its published socket and instance id", async () => {
    const db = sandbox.env.CORTEX_DB as string;
    const first = await connectDaemon({ cortexBin: BIN, databasePath: db, env: sandbox.env });
    const metadata = JSON.parse(fs.readFileSync(`${fs.realpathSync(db)}.daemon.json`, "utf8"));
    expect(first).toEqual({ socketPath: metadata.endpoint.socketPath, instanceId: metadata.instanceId });
    const second = await connectDaemon({ cortexBin: BIN, databasePath: db, env: sandbox.env });
    expect(second).toEqual(first);
  });

  test("a database inside a missing directory fails with the CLI's own error", async () => {
    const db = path.join(sandbox.tmpDir, "missing", "cortex.db");
    const attempt = connectDaemon({ cortexBin: BIN, databasePath: db, env: sandbox.env });
    await expect(attempt).rejects.toBeInstanceOf(DaemonConnectError);
    await expect(attempt).rejects.toThrow("ENOENT");
  });
});
