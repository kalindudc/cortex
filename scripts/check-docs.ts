#!/usr/bin/env bun
// check-docs.ts — deterministic docs drift linter: docs explain the why and point at code, so the pointers must hold.
//
// Run: `pnpm run docs:check [--base <ref>]`. CI's first gate; also runs inside
// `pnpm run style:check`. Pure Bun stdlib, no dependencies.
// Checked docs: AGENTS.md, README.md and docs/*.md. Exit 0 = no fail finding,
// 1 = at least one. Every finding is collected before exiting.
//
//   rule                     severity  scope
//   size.budget              fail      README.md 120 and AGENTS.md 150 lines (AGENTS.md also 32 KiB, Codex's
//                                      truncation cap); docs/*.md front-matter `budget`; missing or invalid front matter
//   paths.missing            fail      backticked repo paths (./ src/ scripts/ test/ docs/ .agents/ .github/)
//                                      and every front-matter `sources` entry
//   symbols.missing          fail      `path#Symbol`: the file exists but never names Symbol
//   links.broken             fail      relative Markdown links and #anchors (GitHub heading slugs)
//   commands.missing_script  fail      `pnpm run X` / `pnpm test[:Y]` that package.json does not define
//   docs.stale_candidate     warn      with --base: a doc's `sources` changed since <ref>, the doc did not
//   comments.plan_ref        warn      `plan @N`, `N<k>` or `F<k>` refs in src/**/*.ts comments (state the reason)
//   io.git                   fail      git failed while computing --base changes

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };

const ROOT = path.resolve(import.meta.dir, "..");
const FIXED_BUDGETS: Record<string, number> = { "README.md": 120, "AGENTS.md": 150 };
const AGENTS_MAX_BYTES = 32_768; // Codex silently truncates AGENTS.md beyond this.

// `pnpm <verb>` shapes that are never package.json scripts (defensive: the regexes match only run/test).
const IGNORED_PNPM_VERBS = new Set(["install", "exec", "dlx", "add", "store"]);
const RUN_RE = /\bpnpm run ([a-z][a-z0-9:_-]*)\b/g;
const TEST_RE = /\bpnpm (test(?::[a-z][a-z0-9:_-]*)?)\b/g;
const BACKTICK_RE = /`([^`]+)`/g;
const PATH_PREFIX_RE = /^(?:\.\/|src\/|scripts\/|test\/|docs\/|\.agents\/|\.github\/)[^\s`]+$/;
const SYMBOL_RE = /^[A-Za-z_$][\w$]*$/;
const LINK_RE = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const PLAN_REF_RES = [/\bplan @\d+/i, /(?<![-\w])[NF]\d{1,2}(?![-\w])/];

type Severity = "fail" | "warn";
type Finding = { file: string; line: number; rule: string; severity: Severity; message: string };
type Doc = { rel: string; lines: string[]; budget: number | null; sources: string[] };

const findings: Finding[] = [];
const add = (file: string, line: number, rule: string, severity: Severity, message: string): void => {
  findings.push({ file, line, rule, severity, message });
};
const scripts: Record<string, string> = (pkg as { scripts?: Record<string, string> }).scripts ?? {};

/** Lines of a file without the empty string after a trailing newline. */
function fileLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** Each line paired with whether it sits inside a ``` fence (the fence lines count as inside). */
function withFences(lines: string[]): { text: string; fenced: boolean }[] {
  let open = false;
  return lines.map(text => {
    const fence = /^\s*```/.test(text);
    const fenced = open || fence;
    if (fence) open = !open;
    return { text, fenced };
  });
}

function frontMatter(doc: Doc): void {
  if (doc.lines[0] !== "---") {
    add(doc.rel, 1, "size.budget", "fail", "docs/*.md needs YAML front matter with `budget` and `sources`");
    return;
  }
  const end = doc.lines.indexOf("---", 1);
  if (end === -1) {
    add(doc.rel, 1, "size.budget", "fail", "front matter has no closing `---`");
    return;
  }
  let meta: unknown;
  try {
    meta = Bun.YAML.parse(doc.lines.slice(1, end).join("\n"));
  } catch (err) {
    add(doc.rel, 1, "size.budget", "fail", `invalid front matter: ${(err as Error).message}`);
    return;
  }
  const m = (meta ?? {}) as { budget?: unknown; sources?: unknown };
  if (Number.isInteger(m.budget) && (m.budget as number) > 0) doc.budget = m.budget as number;
  else add(doc.rel, 1, "size.budget", "fail", "front matter needs a positive integer `budget` (lines)");
  if (!Array.isArray(m.sources) || !m.sources.every(s => typeof s === "string")) {
    add(doc.rel, 1, "size.budget", "fail", "front matter needs `sources: [...]` (repo paths; a directory ends in /)");
  } else {
    doc.sources = m.sources;
  }
}

function loadDocs(): Doc[] {
  const rels = ["AGENTS.md", "README.md"];
  const docsDir = path.join(ROOT, "docs");
  if (fs.existsSync(docsDir)) {
    for (const name of fs.readdirSync(docsDir).sort()) if (name.endsWith(".md")) rels.push(`docs/${name}`);
  }
  const docs: Doc[] = [];
  for (const rel of rels) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) {
      add(rel, 0, "paths.missing", "fail", `${rel} not found`);
      continue;
    }
    const doc: Doc = {
      rel,
      lines: fileLines(fs.readFileSync(abs, "utf8")),
      budget: null,
      sources: [],
    };
    if (rel.startsWith("docs/")) frontMatter(doc);
    else doc.budget = FIXED_BUDGETS[rel] ?? null;
    docs.push(doc);
  }
  return docs;
}

function checkBudget(doc: Doc): void {
  if (doc.budget !== null && doc.lines.length > doc.budget) {
    add(
      doc.rel,
      doc.lines.length,
      "size.budget",
      "fail",
      `${doc.lines.length} lines (budget ${doc.budget}): cut, never split`,
    );
  }
  if (doc.rel === "AGENTS.md") {
    const bytes = Buffer.byteLength(fs.readFileSync(path.join(ROOT, doc.rel), "utf8"), "utf8");
    if (bytes > AGENTS_MAX_BYTES) add(doc.rel, 1, "size.budget", "fail", `${bytes} bytes (> ${AGENTS_MAX_BYTES})`);
  }
}

/** GitHub's heading anchors for a Markdown file (a repeat gets `-1`, `-2`, ...). */
function headingSlugs(lines: string[]): Set<string> {
  const seen = new Map<string, number>();
  const slugs = new Set<string>();
  for (const { text, fenced } of withFences(lines)) {
    const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(text);
    if (fenced || !m) continue;
    const base = (m[1] ?? "")
      .replace(/`/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
      .replace(/ /g, "-");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    slugs.add(n === 0 ? base : `${base}-${n}`);
  }
  return slugs;
}

const slugCache = new Map<string, Set<string>>();
function anchorsOf(abs: string): Set<string> {
  let slugs = slugCache.get(abs);
  if (!slugs) {
    slugs = headingSlugs(fileLines(fs.readFileSync(abs, "utf8")));
    slugCache.set(abs, slugs);
  }
  return slugs;
}

/** Repo-relative `path` (and optional `#fragment`) of a backticked token, or null when it is not a path. */
function pathToken(token: string): { rel: string; frag: string | null } | null {
  if (!PATH_PREFIX_RE.test(token) || /[*<{]/.test(token)) return null;
  const hash = token.indexOf("#");
  const frag = hash === -1 ? null : token.slice(hash + 1);
  const rel = (hash === -1 ? token : token.slice(0, hash)).replace(/:\d+(?:-\d+)?$/, "").replace(/[:,)]$/, "");
  return { rel, frag };
}

function checkPaths(doc: Doc): void {
  withFences(doc.lines).forEach(({ text, fenced }, i) => {
    if (fenced) return;
    for (const m of text.matchAll(BACKTICK_RE)) {
      const token = pathToken(m[1] ?? "");
      if (!token) continue;
      const abs = path.join(ROOT, token.rel);
      if (!fs.existsSync(abs)) {
        add(doc.rel, i + 1, "paths.missing", "fail", `\`${token.rel}\` does not exist`);
        continue;
      }
      if (token.frag === null) continue;
      if (token.rel.endsWith(".md")) {
        if (!anchorsOf(abs).has(token.frag)) {
          add(doc.rel, i + 1, "links.broken", "fail", `\`${m[1]}\`: no heading with the anchor #${token.frag}`);
        }
      } else if (!SYMBOL_RE.test(token.frag)) {
        add(doc.rel, i + 1, "symbols.missing", "fail", `\`${m[1]}\`: #${token.frag} is not an identifier`);
      } else if (fs.statSync(abs).isFile()) {
        const escaped = token.frag.replace(/\$/g, "\\$");
        if (!new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`).test(fs.readFileSync(abs, "utf8"))) {
          add(doc.rel, i + 1, "symbols.missing", "fail", `\`${m[1]}\`: ${token.rel} never names ${token.frag}`);
        }
      }
    }
  });
  for (const source of doc.sources) {
    if (!fs.existsSync(path.join(ROOT, source))) {
      add(doc.rel, 1, "paths.missing", "fail", `front-matter source \`${source}\` does not exist`);
    }
  }
}

function checkLinks(doc: Doc): void {
  const dir = path.dirname(path.join(ROOT, doc.rel));
  withFences(doc.lines).forEach(({ text, fenced }, i) => {
    if (fenced) return;
    for (const m of text.replace(BACKTICK_RE, "").matchAll(LINK_RE)) {
      const target = m[1] ?? "";
      if (SCHEME_RE.test(target) || target.startsWith("<")) continue;
      const hash = target.indexOf("#");
      const file = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? null : target.slice(hash + 1);
      const abs = file === "" ? path.join(ROOT, doc.rel) : path.resolve(dir, decodeURI(file));
      if (!fs.existsSync(abs)) {
        add(doc.rel, i + 1, "links.broken", "fail", `[...](${target}): ${path.relative(ROOT, abs)} does not exist`);
      } else if (frag !== null && abs.endsWith(".md") && !anchorsOf(abs).has(frag)) {
        add(doc.rel, i + 1, "links.broken", "fail", `[...](${target}): no heading with the anchor #${frag}`);
      }
    }
  });
}

function checkScripts(doc: Doc): void {
  doc.lines.forEach((line, i) => {
    for (const m of line.matchAll(RUN_RE)) {
      const name = m[1] ?? "";
      if (!IGNORED_PNPM_VERBS.has(name) && !(name in scripts)) {
        add(doc.rel, i + 1, "commands.missing_script", "fail", `pnpm run ${name} is not a package.json script`);
      }
    }
    for (const m of line.matchAll(TEST_RE)) {
      const name = m[1] ?? "";
      if (!(name in scripts))
        add(doc.rel, i + 1, "commands.missing_script", "fail", `pnpm ${name} is not a package.json script`);
    }
  });
}

function git(args: string[]): string[] | null {
  const run = Bun.spawnSync(["git", ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) {
    add(".", 0, "io.git", "fail", `git ${args.join(" ")}: ${run.stderr.toString().trim()}`);
    return null;
  }
  return run.stdout.toString().split("\n").filter(Boolean);
}

function checkStale(docs: Doc[], base: string): void {
  const diff = git(["diff", "--name-only", base]);
  const untracked = git(["ls-files", "--others", "--exclude-standard"]); // new docs are untracked
  if (diff === null || untracked === null) return;
  const changed = new Set([...diff, ...untracked]);
  for (const doc of docs) {
    if (doc.sources.length === 0 || changed.has(doc.rel)) continue;
    const hits = doc.sources.filter(s => [...changed].some(c => c === s || (s.endsWith("/") && c.startsWith(s))));
    if (hits.length === 0) continue;
    const named = hits.slice(0, 3).join(", ") + (hits.length > 3 ? `, +${hits.length - 3} more` : "");
    add(
      doc.rel,
      1,
      "docs.stale_candidate",
      "warn",
      `${named} changed since ${base}; this doc did not (run the docs skill: sync)`,
    );
  }
}

/** The comment text of a TypeScript line, or null. */
function commentOf(line: string): string | null {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) return trimmed;
  const at = line.indexOf(" // ");
  return at === -1 ? null : line.slice(at + 4);
}

function checkPlanRefs(): void {
  const files = fs
    .readdirSync(path.join(ROOT, "src"), { recursive: true })
    .map(String)
    .filter(f => f.endsWith(".ts"))
    .sort();
  for (const file of files) {
    const rel = `src/${file}`;
    let count = 0;
    let first = 0;
    fileLines(fs.readFileSync(path.join(ROOT, rel), "utf8")).forEach((line, i) => {
      const comment = commentOf(line);
      if (comment === null || !PLAN_REF_RES.some(re => re.test(comment))) return;
      count++;
      if (first === 0) first = i + 1;
    });
    if (count > 0) {
      add(
        rel,
        first,
        "comments.plan_ref",
        "warn",
        `${count} plan-id ref(s) in comments: state the reason instead (plan ids resolve only in one person's cortex)`,
      );
    }
  }
}

// --- Run + report -------------------------------------------------------------

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { base: { type: "string" } }, strict: true });
const docs = loadDocs();
for (const doc of docs) {
  checkBudget(doc);
  checkPaths(doc);
  checkLinks(doc);
  checkScripts(doc);
}
if (values.base !== undefined) checkStale(docs, values.base);
checkPlanRefs();

findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));
for (const f of findings) process.stderr.write(`${f.file}:${f.line}: ${f.severity}: ${f.rule}: ${f.message}\n`);
const fails = findings.filter(f => f.severity === "fail").length;
const warns = findings.length - fails;
if (fails > 0) {
  process.stderr.write(`\ncheck-docs: ${fails} fail, ${warns} warn\n`);
  process.exit(1);
}
process.stdout.write(`check-docs: clean (${warns} warn)\n`);
