#!/usr/bin/env bun
// check-agents.ts — deterministic AGENTS.md drift linter.
//
// Run via `pnpm run agents:check`. Wired into `.github/workflows/test.yml`
// before `pnpm test` so PR feedback on drift is < 30 s.
//
// Pure Bun stdlib — no deps (no chalk / picocolors). Reads AGENTS.md,
// `package.json` scripts, and the `src/` tree.
// Exit 0 = clean. Exit 1 = at least one fail-severity finding.
//
// Five rules — each implemented as one discrete function. ALL findings are
// collected before exiting (not short-circuited) for better PR feedback.
//
//   1. size.too_large         — > 32 768 bytes      (fail)  Codex truncate cap.
//   2. size.too_long          — > 350 lines         (warn)  Soft signal.
//   3. commands.missing_script — pnpm run X / pnpm test[:Y] in AGENTS.md
//                                 must exist in package.json scripts (fail).
//   4. paths.missing          — backtick-quoted repo-prefixed paths must
//                                 exist on disk (fail).
//   5. arch.dir_drift         — `arch:src` marker block must list every
//                                 immediate child of src/ exactly once (fail).

import fs from "node:fs";
import path from "node:path";
import pkg from "../package.json" with { type: "json" };

const ROOT = path.resolve(import.meta.dir, "..");
const AGENTS = path.join(ROOT, "AGENTS.md");

// Single canonical exception list for `pnpm <verb>` shapes that are NEVER
// expected to resolve to a script. The current regexes already restrict
// matches to `pnpm run X` and `pnpm test[:Y]`, so this list is a defensive
// guard rather than load-bearing — if either regex broadens later, these
// stay ignored.
const IGNORED_PNPM_VERBS = new Set(["install", "exec", "dlx", "add", "store"]);

// Caps from Implementation Notes.
const SIZE_FAIL_BYTES = 32_768;
const SIZE_WARN_LINES = 350;

// Marker block sentinels (kept in sync with `scripts/sync-arch-block.ts`).
const ARCH_BEGIN = "<!-- arch:src:begin -->";
const ARCH_END = "<!-- arch:src:end -->";

// Path tokens we recognize as repo-relative inside backticks.
const PATH_PREFIX_RE = /^(?:\.\/|src\/|scripts\/|test\/|out\/|bin\/|\.github\/)[^\s`]+$/;

type Severity = "fail" | "warn";
type Finding = {
  line: number;
  rule: string;
  severity: Severity;
  message: string;
};

const findings: Finding[] = [];
const add = (line: number, rule: string, severity: Severity, message: string): void => {
  findings.push({ line, rule, severity, message });
};

// --- I/O ----------------------------------------------------------------------

if (!fs.existsSync(AGENTS)) {
  process.stderr.write(`AGENTS.md:0: fail: io.missing: AGENTS.md not found at ${AGENTS}\n`);
  process.exit(1);
}

const raw = fs.readFileSync(AGENTS, "utf8");
const bytes = Buffer.byteLength(raw, "utf8");
const lines = raw.split("\n");

const scripts: Record<string, string> = (pkg as { scripts?: Record<string, string> }).scripts ?? {};

// --- Rules --------------------------------------------------------------------

// 1. size.too_large
function checkSizeTooLarge(): void {
  if (bytes > SIZE_FAIL_BYTES) {
    add(
      1,
      "size.too_large",
      "fail",
      `AGENTS.md is ${bytes} bytes (> ${SIZE_FAIL_BYTES}); Codex silently truncates beyond this cap`,
    );
  }
}

// 2. size.too_long
function checkSizeTooLong(): void {
  if (lines.length > SIZE_WARN_LINES) {
    add(
      lines.length,
      "size.too_long",
      "warn",
      `AGENTS.md is ${lines.length} lines (> ${SIZE_WARN_LINES}); soft cap exceeded`,
    );
  }
}

// 3. commands.missing_script
const RUN_RE = /\bpnpm run ([a-z][a-z0-9:_-]*)\b/g;
const TEST_RE = /\bpnpm (test(?::[a-z][a-z0-9:_-]*)?)\b/g;

function checkMissingScripts(): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    for (const m of line.matchAll(RUN_RE)) {
      const name = m[1];
      if (IGNORED_PNPM_VERBS.has(name)) continue;
      if (!(name in scripts)) {
        add(
          lineNo,
          "commands.missing_script",
          "fail",
          `pnpm run ${name} is referenced but not defined in package.json scripts`,
        );
      }
    }

    for (const m of line.matchAll(TEST_RE)) {
      const name = m[1];
      if (!(name in scripts)) {
        add(
          lineNo,
          "commands.missing_script",
          "fail",
          `pnpm ${name} is referenced but not defined in package.json scripts`,
        );
      }
    }
  }
}

// 4. paths.missing
const BACKTICK_RE = /`([^`]+)`/g;

function checkPathsMissing(): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    for (const m of line.matchAll(BACKTICK_RE)) {
      const token = m[1];
      if (!PATH_PREFIX_RE.test(token)) continue;
      // Strip a trailing colon (common in prose like `src/store.ts:`)
      const cleaned = token.replace(/[:,)]$/, "");
      const abs = path.join(ROOT, cleaned);
      if (!fs.existsSync(abs)) {
        add(lineNo, "paths.missing", "fail", `\`${token}\` does not exist on disk`);
      }
    }
  }
}

// 5. arch.dir_drift
const ARCH_LINE_RE = /^\s*- src\/([a-z][a-z0-9_-]*)\/?\s*—/;

function checkArchDirDrift(): void {
  let beginIdx = -1;
  let endIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(ARCH_BEGIN)) beginIdx = i;
    if (lines[i].includes(ARCH_END)) endIdx = i;
  }
  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) {
    add(1, "arch.dir_drift", "fail", `missing or out-of-order ${ARCH_BEGIN} / ${ARCH_END} marker block`);
    return;
  }

  const listed = new Map<string, number>(); // dir → first line where it appears
  for (let i = beginIdx + 1; i < endIdx; i++) {
    const m = ARCH_LINE_RE.exec(lines[i]);
    if (!m) continue;
    const dir = m[1];
    if (listed.has(dir)) {
      add(i + 1, "arch.dir_drift", "fail", `\`src/${dir}/\` listed twice in arch:src marker block`);
    } else {
      listed.set(dir, i + 1);
    }
  }

  const srcDir = path.join(ROOT, "src");
  const real = new Set<string>(
    fs
      .readdirSync(srcDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name),
  );

  for (const dir of real) {
    if (!listed.has(dir)) {
      add(
        beginIdx + 1,
        "arch.dir_drift",
        "fail",
        `\`src/${dir}/\` exists on disk but is missing from the arch:src marker block`,
      );
    }
  }
  for (const dir of listed.keys()) {
    if (!real.has(dir)) {
      add(
        listed.get(dir) ?? beginIdx + 1,
        "arch.dir_drift",
        "fail",
        `\`src/${dir}/\` listed in arch:src marker block but does not exist on disk`,
      );
    }
  }
}

// --- Run + report -------------------------------------------------------------

checkSizeTooLarge();
checkSizeTooLong();
checkMissingScripts();
checkPathsMissing();
checkArchDirDrift();

// Sort findings by line number then rule for stable output.
findings.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));

for (const f of findings) {
  process.stderr.write(`AGENTS.md:${f.line}: ${f.severity}: ${f.rule}: ${f.message}\n`);
}

const failed = findings.some(f => f.severity === "fail");
if (failed) {
  process.stderr.write(
    `\ncheck-agents: ${findings.filter(f => f.severity === "fail").length} fail, ${findings.filter(f => f.severity === "warn").length} warn\n`,
  );
  process.exit(1);
}
process.stdout.write(`check-agents: clean (${findings.length} warn)\n`);
process.exit(0);
