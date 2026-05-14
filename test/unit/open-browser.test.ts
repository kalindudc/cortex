import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { openInBrowser } from "../../src/open-browser.ts";

// Snapshot the platform once so we can monkey-patch process.platform per
// test and restore in afterEach. process.platform is a getter on the
// builtin process object; defineProperty lets us override it per case
// without spawning real subprocesses on the host platform.
const ORIGINAL_PLATFORM = process.platform;
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

describe("openInBrowser", () => {
  let spawnSpy: ReturnType<typeof spyOn>;
  let whichSpy: ReturnType<typeof spyOn>;
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // Stub Bun.spawn so no real browser launches during the test run.
    // Returning a minimal shape is enough — openInBrowser ignores the
    // returned subprocess (it's fire-and-forget by design).
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(() => ({}) as unknown as ReturnType<typeof Bun.spawn>);
    whichSpy = spyOn(Bun, "which").mockImplementation(() => "/usr/bin/xdg-open");
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    spawnSpy.mockRestore();
    whichSpy.mockRestore();
    warnSpy.mockRestore();
    setPlatform(ORIGINAL_PLATFORM);
  });

  test("darwin: spawns `open <url>`", () => {
    setPlatform("darwin");
    openInBrowser("http://cortex.localhost:7777");
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(spawnSpy.mock.calls[0]?.[0]).toEqual(["open", "http://cortex.localhost:7777"]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("linux: spawns `xdg-open <url>` when xdg-open is on PATH", () => {
    setPlatform("linux");
    openInBrowser("http://cortex.localhost:7777");
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(spawnSpy.mock.calls[0]?.[0]).toEqual(["xdg-open", "http://cortex.localhost:7777"]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("linux: prints a warn line when xdg-open is missing and does NOT spawn", () => {
    setPlatform("linux");
    whichSpy.mockImplementation(() => null);
    openInBrowser("http://cortex.localhost:7777");
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("xdg-open not on PATH");
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("http://cortex.localhost:7777");
  });

  test('win32: spawns `cmd /c start "" <url>` (the empty title slot is required)', () => {
    setPlatform("win32");
    openInBrowser("http://cortex.localhost:7777");
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(spawnSpy.mock.calls[0]?.[0]).toEqual(["cmd", "/c", "start", "", "http://cortex.localhost:7777"]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("unknown platform: warns + does NOT spawn (best-effort design)", () => {
    setPlatform("freebsd" as NodeJS.Platform);
    openInBrowser("http://cortex.localhost:7777");
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("don't know how to open");
  });

  test("spawn throwing is swallowed into a warn (never throws)", () => {
    setPlatform("darwin");
    spawnSpy.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(() => openInBrowser("http://cortex.localhost:7777")).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("failed to open browser");
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("ENOENT");
  });
});
