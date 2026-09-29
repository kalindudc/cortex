#!/usr/bin/env bun
// sync-arch-block.ts — rewrites the <!-- arch:src:begin --> / <!-- arch:src:end -->
// region in AGENTS.md from `fs.readdirSync("src")`.
//
// Preserves existing per-dir descriptions; brand-new dirs land as `— TODO`
// so the linter's `arch.dir_drift` rule (which checks list MEMBERSHIP, not
// description content) passes immediately and a human notices the TODO on
// PR review.
//
// Pure Bun stdlib — no deps. Idempotent. Atomic write (tmp + rename) so a
// Ctrl-C mid-run does not leave AGENTS.md half-written.
//
// Run via `pnpm run agents:map` (also the first step of `pnpm run style`).

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const AGENTS = path.join(ROOT, "AGENTS.md");
const SRC = path.join(ROOT, "src");
const BEGIN = "<!-- arch:src:begin -->";
const END = "<!-- arch:src:end -->";

// Captures (dir, description). Description is whatever follows the em-dash,
// trimmed of trailing whitespace. Indentation before the bullet is permitted
// so the block can be nested inside a list if needed; the rewritten block
// reuses whatever indentation the BEGIN marker line used.
const LINE_RE = /^(\s*)- src\/([a-z][a-z0-9_-]*)\/?\s*—\s*(.*)$/;

function fail(message: string): never {
  process.stderr.write(`sync-arch-block: ${message}\n`);
  process.exit(1);
}

if (!fs.existsSync(AGENTS)) {
  fail(`AGENTS.md not found at ${AGENTS}`);
}
if (!fs.existsSync(SRC) || !fs.statSync(SRC).isDirectory()) {
  fail(`src/ not found at ${SRC}`);
}

const original = fs.readFileSync(AGENTS, "utf8");
const lines = original.split("\n");

let beginIdx = -1;
let endIdx = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes(BEGIN)) {
    if (beginIdx !== -1) fail(`duplicate ${BEGIN} marker at line ${i + 1}`);
    beginIdx = i;
  } else if (lines[i].includes(END)) {
    if (endIdx !== -1) fail(`duplicate ${END} marker at line ${i + 1}`);
    endIdx = i;
  }
}

if (beginIdx === -1) fail(`missing ${BEGIN} marker in AGENTS.md`);
if (endIdx === -1) fail(`missing ${END} marker in AGENTS.md`);
if (endIdx <= beginIdx) {
  fail(`${END} (line ${endIdx + 1}) appears before ${BEGIN} (line ${beginIdx + 1})`);
}

// 2) parse existing block lines into Map<dir, description>.
const existingDescriptions = new Map<string, string>();
for (let i = beginIdx + 1; i < endIdx; i++) {
  const m = LINE_RE.exec(lines[i]);
  if (m) existingDescriptions.set(m[2], m[3].trimEnd());
}

// 3) list real src/ subdirs, sorted alphabetically.
const realDirs = fs
  .readdirSync(SRC, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name)
  .sort();

// 4) build the new block. Preserve the indentation used by the BEGIN marker
//    line so the block respects whatever nesting AGENTS.md placed it in.
const beginIndentMatch = /^(\s*)/.exec(lines[beginIdx]);
const indent = beginIndentMatch ? beginIndentMatch[1] : "";

const newBlockLines = realDirs.map(dir => {
  const desc = existingDescriptions.get(dir) ?? "TODO";
  return `${indent}- src/${dir}/   — ${desc}`;
});

// 5) splice between the markers, then write atomically.
const next = [...lines.slice(0, beginIdx + 1), ...newBlockLines, ...lines.slice(endIdx)].join("\n");

if (next === original) {
  process.stdout.write("sync-arch-block: AGENTS.md already in sync\n");
  process.exit(0);
}

const tmp = `${AGENTS}.tmp`;
fs.writeFileSync(tmp, next);
fs.renameSync(tmp, AGENTS);
process.stdout.write(`sync-arch-block: rewrote ${realDirs.length} src/ entries in AGENTS.md arch:src block\n`);
