import { describe, expect, test } from "bun:test";
import {
  type AgentsResult,
  type BbStatus,
  type FilesStatus,
  installSummary,
  suggestion,
} from "../../../src/lib/agentTools.ts";

const files = (state: FilesStatus["state"]): FilesStatus => ({ name: "cortex", dir: "/s/cortex", state, differs: [] });
const bb = (state: BbStatus["state"]): BbStatus => ({ state });

describe("suggestion", () => {
  test("install when any skill, extension or the bb plugin is missing or outdated", () => {
    expect(suggestion({ skills: [files("installed"), files("missing")], extensions: [], bb: bb("skipped") })).toBe(
      "install",
    );
    expect(suggestion({ skills: [files("installed")], extensions: [files("outdated")], bb: bb("installed") })).toBe(
      "install",
    );
    expect(suggestion({ skills: [files("installed")], extensions: [], bb: bb("missing") })).toBe("install");
    expect(suggestion({ skills: [files("installed")], extensions: [], bb: bb("outdated") })).toBe("install");
  });

  test("reset only for a plugin bb installed another way; install wins when files need writing too", () => {
    expect(suggestion({ skills: [files("installed")], extensions: [], bb: bb("foreign") })).toBe("reset");
    expect(suggestion({ skills: [files("missing")], extensions: [], bb: bb("foreign") })).toBe("install");
  });

  test("none when everything is installed and bb is installed or skipped", () => {
    expect(suggestion({ skills: [files("installed")], extensions: [files("installed")], bb: bb("installed") })).toBe(
      "none",
    );
    expect(suggestion({ skills: [files("installed")], extensions: [], bb: bb("skipped") })).toBe("none");
  });
});

describe("installSummary", () => {
  const result = (over: Partial<AgentsResult>): AgentsResult => ({
    skills: [
      { name: "cortex", dir: "/s/cortex" },
      { name: "cortex-planner", dir: "/s/cortex-planner" },
    ],
    extensions: [{ name: "pi", dir: "/e/cortex" }],
    skipped: [],
    bb: { status: "unchanged", dir: "/b", plugin: { status: "running" } },
    ...over,
  });

  test("one line per bb outcome; only a failed plugin is an error", () => {
    expect(installSummary(result({}))).toEqual({
      level: "info",
      text: "Installed 2 skills and the pi extension; bb plugin up to date",
    });
    expect(installSummary(result({ bb: { status: "installed", dir: "/b", plugin: { status: "error" } } }))).toEqual({
      level: "info",
      text: "Installed 2 skills and the pi extension; bb plugin installed but it is error",
    });
    expect(installSummary(result({ bb: { status: "skipped", reason: "bb not found" } }))).toEqual({
      level: "info",
      text: "Installed 2 skills and the pi extension; skipped the bb plugin: bb not found",
    });
    expect(installSummary(result({ bb: { status: "failed", reason: "npm ci failed (exit 1)" } }))).toEqual({
      level: "error",
      text: "Installed 2 skills and the pi extension; the bb plugin failed: npm ci failed (exit 1)",
    });
  });

  test("a skipped pi says why", () => {
    const skipped = result({ extensions: [], skipped: [{ name: "pi", reason: "pi not found" }] });
    expect(installSummary({ ...skipped, skills: [{ name: "cortex", dir: "/s/cortex" }] }).text).toBe(
      "Installed 1 skill; skipped pi: pi not found; bb plugin up to date",
    );
  });
});
