import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { resolveDashboardUrl, resolveOpenUrl } from "../../src/commands/open.ts";
import type { DaemonIdentity } from "../../src/contracts.ts";
import { publishDaemonMetadata, removeDaemonMetadata } from "../../src/daemon.ts";
import { canonicalDatabasePath, tryAcquireOwnership } from "../../src/ownership.ts";
import { browserUrlPath, urlPath, ensureConfigDir, dbPath, daemonSocketPath } from "../../src/paths.ts";
import { buildApp, createRuntime, type DaemonControl } from "../../src/server.ts";
import { Store } from "../../src/store.ts";

// Snapshot env keys we mutate so we can restore after each test — same
// pattern as paths.test.ts.
const ORIGINAL_XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;

describe("resolveOpenUrl (cortex open URL resolution)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-open-test-"));
    process.env.XDG_CONFIG_HOME = tmpDir;
    ensureConfigDir();
  });

  afterEach(() => {
    if (ORIGINAL_XDG_CONFIG_HOME === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = ORIGINAL_XDG_CONFIG_HOME;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("falls back to default cortex.localhost:7777 when neither file exists", () => {
    expect(fs.existsSync(browserUrlPath())).toBe(false);
    expect(fs.existsSync(urlPath())).toBe(false);
    expect(resolveOpenUrl()).toBe("http://cortex.localhost:7777");
  });

  test("returns the trimmed contents of cortex.browser-url when present", () => {
    fs.writeFileSync(browserUrlPath(), "  http://cortex.localhost:7778\n");
    expect(resolveOpenUrl()).toBe("http://cortex.localhost:7778");
  });

  test("prefers cortex.browser-url over cortex.url when both exist", () => {
    fs.writeFileSync(browserUrlPath(), "http://cortex.example:9000");
    fs.writeFileSync(urlPath(), "http://127.0.0.1:9000");
    expect(resolveOpenUrl()).toBe("http://cortex.example:9000");
  });

  test("legacy upgrade: only cortex.url with 127.0.0.1 → swaps host to cortex.localhost", () => {
    fs.writeFileSync(urlPath(), "http://127.0.0.1:7777");
    expect(resolveOpenUrl()).toBe("http://cortex.localhost:7777");
  });

  test("legacy upgrade preserves a non-default port and trailing path", () => {
    fs.writeFileSync(urlPath(), "http://127.0.0.1:8080/dash");
    expect(resolveOpenUrl()).toBe("http://cortex.localhost:8080/dash");
  });

  test("legacy upgrade: cortex.url without 127.0.0.1 → falls back to default (no unsafe rewrite)", () => {
    // Defensive: if a future binary writes a non-loopback URL into cortex.url
    // we should NOT silently rewrite a host segment we don't recognise.
    fs.writeFileSync(urlPath(), "http://example.invalid:7777");
    expect(resolveOpenUrl()).toBe("http://cortex.localhost:7777");
  });

  test("empty cortex.browser-url file falls through to cortex.url upgrade path", () => {
    fs.writeFileSync(browserUrlPath(), "   \n");
    fs.writeFileSync(urlPath(), "http://127.0.0.1:7777");
    expect(resolveOpenUrl()).toBe("http://cortex.localhost:7777");
  });
});

describe("resolveDashboardUrl (cortex open on the verified daemon for this database)", () => {
  const KEYS = ["XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "CORTEX_DB"] as const;
  let saved: Record<string, string | undefined> = {};
  let tmpDir: string;
  let runtimeDir: string;
  const cleanups: (() => unknown)[] = [];

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cortex-open-daemon-")));
    runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxo-"));
    fs.chmodSync(runtimeDir, 0o700);
    process.env.XDG_CONFIG_HOME = tmpDir;
    process.env.XDG_RUNTIME_DIR = runtimeDir;
    process.env.CORTEX_DB = path.join(tmpDir, "cortex.db");
    ensureConfigDir();
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });

  /** A published daemon for CORTEX_DB in this process, headless until enable-web is called. */
  function startDaemon(): { identity: DaemonIdentity; calls: string[] } {
    const lease = tryAcquireOwnership(dbPath());
    if (lease === null) throw new Error("expected to own the database");
    const store = Store.open(dbPath(), { owner: lease, warnMigrations: false });
    const canonical = canonicalDatabasePath(dbPath());
    const socketPath = daemonSocketPath(canonical);
    const identity: DaemonIdentity = {
      protocol: 1,
      instanceId: crypto.randomUUID(),
      databaseId: store.databaseId(),
      databasePath: canonical,
      endpoint: { kind: "unix", socketPath },
      pid: 999_999_999,
      capabilities: ["control.shutdown", "control.web"],
    };
    const calls: string[] = [];
    const control: DaemonControl = {
      shutdown: () => {},
      enableWeb: async request => {
        calls.push(`web ${JSON.stringify(request)}`);
        identity.webUrl = "http://cortex.localhost:4321";
        publishDaemonMetadata(identity);
        return identity;
      },
    };
    const app = buildApp(store, createRuntime({ identity, listener: "ipc", control }));
    const server = Bun.serve({ unix: socketPath, fetch: app.fetch });
    publishDaemonMetadata(identity);
    cleanups.push(async () => {
      await server.stop(true);
      removeDaemonMetadata(identity);
      store.close();
      lease.release();
    });
    return { identity, calls };
  }

  test("without a verified daemon it keeps the legacy resolution", async () => {
    expect(await resolveDashboardUrl()).toBe("http://cortex.localhost:7777");
    fs.writeFileSync(browserUrlPath(), "http://cortex.localhost:7778");
    expect(await resolveDashboardUrl()).toBe("http://cortex.localhost:7778");
  });

  test("the verified daemon's dashboard wins over legacy files, enabled on that same daemon when missing", async () => {
    const { calls } = startDaemon();
    fs.writeFileSync(browserUrlPath(), "http://cortex.localhost:7778");
    expect(await resolveDashboardUrl()).toBe("http://cortex.localhost:4321");
    expect(calls).toEqual(["web {}"]);
    expect(await resolveDashboardUrl()).toBe("http://cortex.localhost:4321");
    expect(calls.length).toBe(1);
  });
});
