// Stand-ins for the bb CLI and npm, so `cortex agents install|reset` can be
// tested without ever running the real bb (which would move the user's
// installed plugin) or the real npm. Both are scripts run by this test's own
// Bun; they log every call and keep bb's state in a JSON file.

import fs from "node:fs";
import path from "node:path";

export type FakePlugin = {
  id: string;
  source: string;
  rootDir: string | null;
  status: string;
  statusDetail: string | null;
};

export type FakeBbState = {
  /** false: `plugin list` fails, as when the bb app is not running. */
  reachable: boolean;
  plugin: FakePlugin | null;
  settings: Record<string, string>;
  /** The status bb reports after an install or reload. */
  installStatus?: string;
  installDetail?: string;
  /** Makes `npm ci` fail with this output. */
  npmFails?: string;
};

export type FakeCall = { cmd: "bb" | "npm"; argv: string[]; cwd: string };

const COMMON = `
const fs = require("node:fs");
const path = require("node:path");
const dir = __DIR__;
const stateFile = path.join(dir, "state.json");
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
const argv = process.argv.slice(2);
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
`;

const BB = String.raw`
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ cmd: "bb", argv, cwd: process.cwd() }) + "\n");
const fail = message => { process.stderr.write(message + "\n"); process.exit(1); };
const [area, verb, arg] = argv;
if (area !== "plugin") fail("fake bb: unhandled " + argv.join(" "));
if (!state.reachable) fail("error: could not reach the bb server (is bb running?)");
const other = { id: "github", source: "builtin:github", rootDir: null, status: "running", statusDetail: null };
if (verb === "list") {
  process.stdout.write(JSON.stringify({ plugins: [other, ...(state.plugin ? [state.plugin] : [])] }));
} else if (verb === "install") {
  if (!arg.startsWith("path:") || !argv.includes("--yes")) fail("fake bb: expected path:<dir> --yes");
  const root = arg.slice(5);
  if (!fs.existsSync(path.join(root, "package.json"))) fail("no package.json in " + root);
  if (!fs.existsSync(path.join(root, "node_modules"))) fail("dependencies are not installed in " + root);
  state.plugin = { id: "cortex", source: arg, rootDir: root, status: state.installStatus || "running", statusDetail: state.installDetail || null };
  save();
  process.stdout.write("Installed:\ncortex@0.1.0  " + state.plugin.status + "\n");
} else if (verb === "reload") {
  if (arg !== "cortex" || !state.plugin) fail("fake bb: nothing to reload");
  state.plugin.status = state.installStatus || "running";
  state.plugin.statusDetail = state.installDetail || null;
  save();
  process.stdout.write("cortex@0.1.0  " + state.plugin.status + "\n");
} else if (verb === "remove") {
  if (arg !== "cortex" || !state.plugin) fail("fake bb: nothing to remove");
  state.plugin = null;
  state.settings = {};
  save();
  process.stdout.write("Removed cortex\n");
} else if (verb === "config") {
  process.stdout.write(JSON.stringify({ ok: true, schema: { cortexPath: { type: "string" } }, values: state.settings }));
} else {
  fail("fake bb: unhandled " + argv.join(" "));
}
`;

const NPM = String.raw`
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ cmd: "npm", argv, cwd: process.cwd() }) + "\n");
if (state.npmFails) { process.stderr.write(state.npmFails + "\n"); process.exit(1); }
fs.mkdirSync(path.join(process.cwd(), "node_modules", "zod"), { recursive: true });
process.stdout.write("added 12 packages\n");
`;

export type FakeBb = {
  /** The fake bb CLI: point CORTEX_BB_CLI at it. */
  bb: string;
  /** A directory holding only the fake `npm`: put it on PATH. */
  binDir: string;
  state(): FakeBbState;
  setState(patch: Partial<FakeBbState>): void;
  calls(): FakeCall[];
  clearCalls(): void;
};

export function createFakeBb(root: string, initial: Partial<FakeBbState> = {}): FakeBb {
  const dir = path.join(root, "fake-bb");
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const header = `#!${process.execPath}\n${COMMON.replace("__DIR__", JSON.stringify(dir))}`;
  const bb = path.join(dir, "bb");
  fs.writeFileSync(bb, header + BB, { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, "npm"), header + NPM, { mode: 0o755 });
  const stateFile = path.join(dir, "state.json");
  const callsFile = path.join(dir, "calls.jsonl");
  const read = (): FakeBbState => JSON.parse(fs.readFileSync(stateFile, "utf8")) as FakeBbState;
  fs.writeFileSync(stateFile, JSON.stringify({ reachable: true, plugin: null, settings: {}, ...initial }));
  return {
    bb,
    binDir,
    state: read,
    setState(patch) {
      fs.writeFileSync(stateFile, JSON.stringify({ ...read(), ...patch }));
    },
    calls() {
      if (!fs.existsSync(callsFile)) return [];
      return fs
        .readFileSync(callsFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map(line => JSON.parse(line) as FakeCall);
    },
    clearCalls() {
      fs.rmSync(callsFile, { force: true });
    },
  };
}
