// desktop/deepLink.ts — launch links from the app's command line.

import { describe, expect, test } from "bun:test";
import { deepLinkPath, parseDeepLink, parseDeepLinkUrl } from "../../../src/desktop/deepLink.ts";

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

describe("parseDeepLinkUrl", () => {
  test("a task link, with or without a heading", () => {
    expect(parseDeepLinkUrl("cortex://app/task/42")).toEqual({ taskId: 42, heading: null });
    expect(parseDeepLinkUrl("cortex://app/task/42/")).toEqual({ taskId: 42, heading: null });
    expect(parseDeepLinkUrl("cortex://app/task/42#intro-2")).toEqual({ taskId: 42, heading: "intro-2" });
    expect(parseDeepLinkUrl("CORTEX://app/task/7?from=journal")).toEqual({ taskId: 7, heading: null });
  });

  test("other hosts, paths and schemes give no link", () => {
    for (const bad of [
      "cortex://app/",
      "cortex://app/task/0",
      "cortex://app/task/01",
      "cortex://app/task/42/extra",
      "cortex://other/task/42",
      "cortex://user:pw@app/task/42",
      "cortex://app:8080/task/42",
      "https://app/task/42",
      "not a url",
    ]) {
      expect(parseDeepLinkUrl(bad)).toBeNull();
    }
  });

  test("a bad heading is dropped, the task kept", () => {
    expect(parseDeepLinkUrl("cortex://app/task/3#a%20b")).toEqual({ taskId: 3, heading: null });
  });
});

describe("parseDeepLink with a URL in argv", () => {
  test("Linux and Windows pass an opened link as an argument", () => {
    expect(parseDeepLink(["/opt/Cortex/cortex-desktop", "--no-sandbox", "cortex://app/task/9#plan"])).toEqual({
      taskId: 9,
      heading: "plan",
    });
  });

  test("the last link wins, whether a flag or a URL", () => {
    expect(parseDeepLink(["--task=1", "cortex://app/task/2"])).toEqual({ taskId: 2, heading: null });
    expect(parseDeepLink(["cortex://app/task/2", "--task=3"])).toEqual({ taskId: 3, heading: null });
  });
});

describe("deepLinkPath", () => {
  test("root, task and task with heading", () => {
    expect(deepLinkPath(null)).toBe("/");
    expect(deepLinkPath({ taskId: 42, heading: null })).toBe("/task/42");
    expect(deepLinkPath({ taskId: 42, heading: "intro-2" })).toBe("/task/42#intro-2");
  });
});
