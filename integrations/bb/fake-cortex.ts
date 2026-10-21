// Test helper: a stand-in `cortex` executable driven by a JSON fixture, so
// plugin tests never touch a real cortex database or daemon. Writes
// (`update`) change the fixture, so a read after a write sees it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type FakeTask = {
  task: {
    id: number;
    title: string;
    status: string;
    lane: string;
    tags: string[];
    body: string | null;
    created: number;
    updated?: number;
    /** Absent for a cortex that predates memory exclusion. */
    memory_excluded?: boolean;
  };
  updates: Array<{ id: number; task_id: number; author: string; summary: string; body: string | null; created: number }>;
  synced?: number;
  staleness?: {
    verdict: "fresh" | "stale" | "unverifiable";
    changed?: string[];
    missing?: string[];
    old?: boolean;
    ageDays?: number;
    behind?: number;
  };
};

export type FakeFixture = {
  commands?: string[];
  streamsProbeFails?: boolean;
  /** `cortex doctor --json`'s `author`; absent for a cortex without `update --as-me`. */
  author?: string;
  doctorFails?: boolean;
  tasks?: Record<string, FakeTask>;
  streams?: Record<string, Array<{ id: number; title: string; lane: string; status: string; activity: number }>>;
  context?: { lane: string; primer: string; primerIds?: number[]; hits?: number[]; hitsText?: string };
  /** `cortex watch --json`: lines (or raw byte chunks) to print, then wait for SIGTERM unless `exitCode` is set. */
  watch?: { lines?: string[]; chunks?: number[][]; exitCode?: number };
  /** Fails every `update` with this message. */
  updateFails?: string;
  /** Updates the fake has posted (it numbers them from 900). */
  posted?: number;
};

export type FakeCall = { argv: string[]; cwd: string };

export type FakeCortex = {
  dir: string;
  binary: string;
  setFixture(fixture: FakeFixture): void;
  fixture(): FakeFixture;
  calls(): FakeCall[];
  cleanup(): void;
};

const SCRIPT = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const dir = __DIR__;
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ argv, cwd: process.cwd() }) + "\n");
const fixtureFile = path.join(dir, "fixture.json");
const fixture = JSON.parse(fs.readFileSync(fixtureFile, "utf8"));
const out = value => process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));
const fail = message => { process.stderr.write(message + "\n"); process.exit(1); };
const flag = name => { const a = argv.find(x => x.startsWith("--" + name + "=")); return a === undefined ? undefined : a.slice(name.length + 3); };
const json = argv.includes("--json");
const [a, b, c] = argv;
const taskOf = id => (fixture.tasks || {})[id] || fail("task " + id + " not found");
const taskJson = t => ({ ...t.task, priority: null, updated: t.task.updated ?? t.task.created });
if (a === "schema") {
  out({ version: "0.0.0", commands: (fixture.commands || ["watch", "memory"]).map(name => ({ name, summary: "" })) });
} else if (a === "doctor") {
  if (fixture.doctorFails) fail("doctor broke");
  out({ version: "0.0.0", ...(fixture.author === undefined ? {} : { author: fixture.author }) });
} else if (a === "memory" && b === "streams") {
  if (flag("limit") === "1" && fixture.streamsProbeFails) fail("Unknown command streams");
  out((fixture.streams || {})[flag("author")] || []);
} else if (a === "show") {
  const t = taskOf(b);
  out({ task: taskJson(t), updates: t.updates.map(u => ({ ...u, severity: "progress" })) });
} else if (a === "memory" && b === "show") {
  const t = taskOf(c);
  const s = t.staleness || { verdict: "fresh" };
  if (!json) {
    // The staleness line in the format of src/memory.ts renderStream.
    const changed = (s.changed || []).length > 0 ? " \u00b7 changed: " + s.changed.join(", ") : "";
    out("TEXT memory show " + c + (flag("section") ? " #" + flag("section") : "") + " cwd=" + process.cwd() + "\n" +
      "staleness: " + s.verdict + " \u00b7 synced 2026-01-01 (1d)" + changed + "\n");
    process.exit(0);
  }
  out({
    task: taskJson(t),
    synced: t.synced ?? t.task.created,
    latest: null,
    trail: [],
    staleness: {
      verdict: s.verdict, synced: t.synced ?? t.task.created, ageDays: s.ageDays ?? 1, old: s.old ?? false,
      repo: s.verdict === "unverifiable" ? "none" : "this", changed: s.changed || [], missing: s.missing || [],
      checked: 0, behind: s.behind ?? 0,
    },
  });
} else if (a === "memory" && (b === "exclude" || b === "include")) {
  const t = taskOf(c);
  t.task.memory_excluded = b === "exclude";
  fs.writeFileSync(fixtureFile, JSON.stringify(fixture));
  out(taskJson(t));
} else if (a === "memory" && b === "search") {
  out("TEXT memory search " + c + (flag("boost") ? " boost=" + flag("boost") : "") + "\n");
} else if (a === "memory" && b === "context") {
  out({ lane: fixture.context?.lane ?? "lane", primer: fixture.context?.primer ?? "", primerIds: fixture.context?.primerIds ?? [], terms: [], recent: false, hits: (fixture.context?.hits ?? []).map(id => ({ id })), hitsText: fixture.context?.hitsText ?? "" });
} else if (a === "search") {
  const q = (b || "").toLowerCase();
  out(Object.values(fixture.tasks || {}).map(taskJson).filter(t => t.title.toLowerCase().includes(q)));
} else if (a === "ls") {
  const lane = flag("lane");
  out(Object.values(fixture.tasks || {}).map(taskJson).filter(t => lane === undefined || t.lane === lane).map(({ body, ...row }) => row));
} else if (a === "update") {
  if (fixture.updateFails) fail(fixture.updateFails);
  const t = taskOf(b);
  const asMe = argv.includes("--as-me");
  const author = asMe ? fixture.author : flag("as");
  const status = flag("status");
  const message = flag("message");
  const now = 2000000000000 + (fixture.posted || 0);
  const next = () => { const id = 900 + (fixture.posted || 0); fixture.posted = (fixture.posted || 0) + 1; return id; };
  let update = null;
  if (message !== undefined) {
    update = { id: next(), task_id: t.task.id, author, summary: message, body: flag("body") ?? null, created: now };
    t.updates.push(update);
  }
  if (status) {
    const audit = { id: next(), task_id: t.task.id, author, summary: "status \u2192 " + status, body: null, created: now };
    t.updates.push(audit);
    t.task.status = status;
    t.task.updated = now;
    update = update ?? audit;
  }
  fs.writeFileSync(fixtureFile, JSON.stringify(fixture));
  out({ update: { ...update, severity: "progress" }, ...(status ? { status } : {}) });
} else if (a === "watch") {
  const w = fixture.watch || {};
  process.on("SIGTERM", () => { fs.writeFileSync(path.join(dir, "watch-terminated"), "yes"); process.exit(0); });
  for (const line of w.lines || []) process.stdout.write(line + "\n");
  const chunks = (w.chunks || []).map(bytes => Buffer.from(bytes));
  const next = () => {
    const chunk = chunks.shift();
    if (chunk) { process.stdout.write(chunk); setTimeout(next, 20); return; }
    if (w.exitCode !== undefined) { process.stderr.write("watch gave up\n"); process.exit(w.exitCode); }
    setInterval(() => {}, 1000);
  };
  next();
} else {
  fail("fake cortex: unhandled " + argv.join(" "));
}
`;

export function createFakeCortex(fixture: FakeFixture = {}): FakeCortex {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-bb-fake-"));
  const binary = path.join(dir, "cortex");
  fs.writeFileSync(binary, `#!${process.execPath}\n${SCRIPT.replace("__DIR__", JSON.stringify(dir))}`, { mode: 0o755 });
  const fixtureFile = path.join(dir, "fixture.json");
  const fake: FakeCortex = {
    dir,
    binary,
    setFixture(next) {
      fs.writeFileSync(fixtureFile, JSON.stringify(next));
    },
    fixture() {
      return JSON.parse(fs.readFileSync(fixtureFile, "utf8")) as FakeFixture;
    },
    calls() {
      const file = path.join(dir, "calls.jsonl");
      if (!fs.existsSync(file)) return [];
      return fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map(line => JSON.parse(line) as FakeCall);
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  fake.setFixture(fixture);
  return fake;
}
