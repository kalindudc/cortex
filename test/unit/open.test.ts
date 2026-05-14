import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { resolveOpenUrl } from "../../src/commands/open.ts";
import { browserUrlPath, urlPath, ensureConfigDir } from "../../src/paths.ts";

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
