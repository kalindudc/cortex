// scripts/install.sh end to end, with no network: CORTEX_INSTALL_FROM points it at a folder holding the
// built bin/cortex packed like a release archive, and HOME and every cortex path are temporary.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pkg from "../../package.json" with { type: "json" };
import { BIN, mkTmpEnv } from "./helpers.ts";

const SCRIPT = path.resolve(import.meta.dir, "../../scripts/install.sh");
const OS = process.platform === "darwin" ? "darwin" : "linux";
const ARCH = process.arch === "arm64" ? "arm64" : "x64";
const ARCHIVE = `cortex-${pkg.version}-${OS}-${ARCH}.tar.gz`;

const sandbox = mkTmpEnv("install");
const release = path.join(sandbox.tmpDir, "release");

function sha256(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function writeSums(folder: string, hash: string): void {
  fs.writeFileSync(path.join(folder, "SHA256SUMS"), `${hash}  ${ARCHIVE}\n`);
}

/** A release folder holding only the CLI archive; `hash` replaces its real checksum when given. */
function releaseFolder(name: string, hash?: string): string {
  const folder = path.join(sandbox.tmpDir, name);
  fs.mkdirSync(folder);
  fs.copyFileSync(path.join(release, ARCHIVE), path.join(folder, ARCHIVE));
  writeSums(folder, hash ?? sha256(path.join(folder, ARCHIVE)));
  return folder;
}

async function install(extra: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: Record<string, string> = { ...sandbox.env, HOME: sandbox.tmpDir, ...extra };
  const proc = Bun.spawn(["sh", SCRIPT], { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

beforeAll(async () => {
  const stage = path.join(sandbox.tmpDir, "stage");
  fs.mkdirSync(stage);
  fs.mkdirSync(release);
  fs.copyFileSync(BIN, path.join(stage, "cortex"));
  fs.chmodSync(path.join(stage, "cortex"), 0o755);
  const tar = Bun.spawn(["tar", "-czf", path.join(release, ARCHIVE), "-C", stage, "cortex"], { env: sandbox.env });
  expect(await tar.exited).toBe(0);
  writeSums(release, sha256(path.join(release, ARCHIVE)));
});

afterAll(() => sandbox.cleanup());

describe("scripts/install.sh", () => {
  test("installs the CLI from a folder after checking it, and stops this database's daemon", async () => {
    const binDir = path.join(sandbox.tmpDir, "bin-ok");
    const res = await install({
      CORTEX_INSTALL_FROM: release,
      CORTEX_VERSION: pkg.version,
      CORTEX_BIN_DIR: binDir,
      CORTEX_NO_APP: "1",
    });
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toContain(`✓ Installed cortex ${pkg.version} to ${binDir}/cortex`);
    expect(res.stdout).toContain(`${binDir} is not on your PATH`);
    expect(res.stdout).toContain("not running");
    const version = Bun.spawnSync([path.join(binDir, "cortex"), "--version"], { env: sandbox.env });
    expect(version.stdout.toString().trim()).toBe(pkg.version);
  });

  test("a checksum mismatch fails, names the archive and installs nothing", async () => {
    const binDir = path.join(sandbox.tmpDir, "bin-bad");
    const res = await install({
      CORTEX_INSTALL_FROM: releaseFolder("release-bad", "0".repeat(64)),
      CORTEX_VERSION: pkg.version,
      CORTEX_BIN_DIR: binDir,
      CORTEX_NO_APP: "1",
    });
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain(`checksum mismatch for ${ARCHIVE}`);
    expect(fs.existsSync(path.join(binDir, "cortex"))).toBe(false);
  });

  test("a local folder needs CORTEX_VERSION", async () => {
    const res = await install({ CORTEX_INSTALL_FROM: release, CORTEX_BIN_DIR: path.join(sandbox.tmpDir, "bin-nover") });
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain("CORTEX_INSTALL_FROM needs CORTEX_VERSION");
  });

  test("CORTEX_NO_CLI=1 skips the CLI archive and stops the daemon with the cortex on PATH", async () => {
    const folder = path.join(sandbox.tmpDir, "release-app-only");
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, "SHA256SUMS"), "");
    // Stands in for Homebrew's cortex; PATH is pinned so no other cortex can answer.
    const pathBin = path.join(sandbox.tmpDir, "path-bin");
    fs.mkdirSync(pathBin);
    fs.symlinkSync(BIN, path.join(pathBin, "cortex"));
    const binDir = path.join(sandbox.tmpDir, "bin-app-only");
    const res = await install({
      CORTEX_INSTALL_FROM: folder,
      CORTEX_VERSION: pkg.version,
      CORTEX_BIN_DIR: binDir,
      CORTEX_NO_CLI: "1",
      PATH: `${pathBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    });
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toContain(`note: no desktop package for cortex ${pkg.version}`);
    expect(res.stdout).not.toContain("Installed cortex");
    expect(res.stdout).toContain("not running");
    expect(fs.existsSync(binDir)).toBe(false);
  });

  test("CORTEX_NO_CLI=1 and CORTEX_NO_APP=1 together fail", async () => {
    const res = await install({
      CORTEX_INSTALL_FROM: release,
      CORTEX_VERSION: pkg.version,
      CORTEX_NO_CLI: "1",
      CORTEX_NO_APP: "1",
    });
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain("leave nothing to install");
  });

  test("a folder without a desktop package installs the CLI and says how to build the app", async () => {
    const binDir = path.join(sandbox.tmpDir, "bin-noapp");
    const res = await install({
      CORTEX_INSTALL_FROM: releaseFolder("release-cli-only"),
      CORTEX_VERSION: pkg.version,
      CORTEX_BIN_DIR: binDir,
    });
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toContain(`note: no desktop package for cortex ${pkg.version}`);
    expect(fs.existsSync(path.join(binDir, "cortex"))).toBe(true);
  });
});
