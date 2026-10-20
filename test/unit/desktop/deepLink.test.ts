// desktop/deepLink.ts — launch links from the app's command line.

import { describe, expect, test } from "bun:test";
import { deepLinkPath, parseDeepLink } from "../../../src/desktop/deepLink.ts";

describe("parseDeepLink", () => {
  test("scans a reordered argv with Chromium's own switches", () => {
    const argv = [
      "/Applications/Cortex.app/Contents/MacOS/Cortex",
      "--task=42",
      "--heading=intro-2",
      "--allow-file-access-from-files",
      "--enable-avfoundation",
      "/path/to/app",
    ];
    expect(parseDeepLink(argv)).toEqual({ taskId: 42, heading: "intro-2" });
    expect(parseDeepLink(["--heading=Intro", "exe", "--task=7"])).toEqual({ taskId: 7, heading: "Intro" });
  });

  test("the last of each flag wins", () => {
    expect(parseDeepLink(["--task=1", "--heading=a", "--task=2", "--heading=b"])).toEqual({ taskId: 2, heading: "b" });
    // A bad last task voids the link, even after a good one.
    expect(parseDeepLink(["--task=1", "--task=x"])).toBeNull();
  });

  test("bad ids give no link", () => {
    for (const bad of ["0", "-1", "01", "1.5", "1e3", "", " 1", "abc", "12345678901234567", "9999999999999999"]) {
      expect(parseDeepLink([`--task=${bad}`])).toBeNull();
    }
    expect(parseDeepLink(["--task", "42"])).toBeNull();
    expect(parseDeepLink([])).toBeNull();
  });

  test("a bad slug is dropped, the task kept", () => {
    for (const bad of ["", "a b", "a/b", "é", "a#b", "x".repeat(257), "<script>"]) {
      expect(parseDeepLink(["--task=3", `--heading=${bad}`])).toEqual({ taskId: 3, heading: null });
    }
    expect(parseDeepLink(["--task=3", `--heading=${"x".repeat(256)}`])?.heading).toBe("x".repeat(256));
  });

  test("a heading alone is ignored", () => {
    expect(parseDeepLink(["--heading=intro"])).toBeNull();
  });
});

describe("deepLinkPath", () => {
  test("root, task and task with heading", () => {
    expect(deepLinkPath(null)).toBe("/");
    expect(deepLinkPath({ taskId: 42, heading: null })).toBe("/task/42");
    expect(deepLinkPath({ taskId: 42, heading: "intro-2" })).toBe("/task/42#intro-2");
  });
});
