#!/usr/bin/env bun
// release.ts — the checks and generated text a release needs; pure Bun stdlib.
//
//   check <version>                 the version is x.y.z (or x.y.z-rc.n) and CHANGELOG.md has its section;
//                                   the `preversion` hook runs it before `pnpm version` changes anything
//   check --tag v<version>          the same, and both package.json files carry that version (release.yml)
//   notes <version>                 the CHANGELOG.md section, used as the release notes
//   formula <version> <SHA256SUMS>  the Homebrew formula for kalindudc/homebrew-tap

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const ROOT = path.resolve(import.meta.dir, "..");
const REPO = "https://github.com/kalindudc/cortex";
// A release candidate rehearses its base version, so it uses that version's changelog section.
const VERSION_RE = /^(\d+\.\d+\.\d+)(?:-rc\.\d+)?$/;

function baseVersion(version: string): string {
  return VERSION_RE.exec(version)?.[1] ?? version;
}

/** The text under `## <version>` (or its base version for x.y.z-rc.n) up to the next `## `; null when absent or empty. */
export function changelogSection(changelog: string, version: string): string | null {
  const heading = `## ${baseVersion(version)}`;
  const lines = changelog.split("\n");
  const start = lines.findIndex(line => line === heading || line.startsWith(`${heading} - `));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(line => line.startsWith("## "));
  const body = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
  return body === "" ? null : body;
}

/** Everything that stops `version` from being released; empty when it can be. */
export function releaseProblems(o: {
  version: string;
  changelog: string;
  rootVersion?: string;
  desktopVersion?: string;
}): string[] {
  const problems: string[] = [];
  if (!VERSION_RE.test(o.version)) {
    problems.push(`${o.version} is not a release version: use x.y.z, or x.y.z-rc.n to rehearse one`);
  } else if (changelogSection(o.changelog, o.version) === null) {
    problems.push(`CHANGELOG.md has no "## ${baseVersion(o.version)}" section with text; add one before releasing`);
  }
  const packages: Array<[string, string | undefined]> = [
    ["package.json", o.rootVersion],
    ["integrations/desktop/package.json", o.desktopVersion],
  ];
  for (const [file, version] of packages) {
    if (version !== undefined && version !== o.version)
      problems.push(`${file} has version ${version}, not ${o.version}`);
  }
  return problems;
}

/** `<hash>  <file>` lines (sha256sum and shasum output) as a map from file name to hash. */
function parseSums(sha256sums: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of sha256sums.split("\n")) {
    const [hash, file] = line.trim().split(/\s+/);
    if (hash && file) sums.set(file.replace(/^\*/, ""), hash);
  }
  return sums;
}

/** The Homebrew formula installing the CLI archives of `version`; throws when SHA256SUMS lacks one of them. */
export function homebrewFormula(version: string, sha256sums: string): string {
  const sums = parseSums(sha256sums);
  const archive = (os: string, arch: string): string => {
    const file = `cortex-${version}-${os}-${arch}.tar.gz`;
    const hash = sums.get(file);
    if (hash === undefined) throw new Error(`SHA256SUMS has no entry for ${file}`);
    return [`      url "${REPO}/releases/download/v${version}/${file}"`, `      sha256 "${hash}"`].join("\n");
  };
  return `class Cortex < Formula
  desc "Local task tracker for supervising several AI coding agents at once"
  homepage "${REPO}"
  version "${version}"
  license "MIT"

  on_macos do
    on_arm do
${archive("darwin", "arm64")}
    end
    on_intel do
${archive("darwin", "x64")}
    end
  end

  on_linux do
    on_arm do
${archive("linux", "arm64")}
    end
    on_intel do
${archive("linux", "x64")}
    end
  end

  def install
    bin.install "cortex"
  end

  def caveats
    <<~EOS
      Create your database with \`cortex init\`, then set up your agents with \`cortex agents install\`.
      The desktop app is on the release page, or comes with the install script:
        ${REPO}#install
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/cortex --version")
  end
end
`;
}

function readVersion(file: string): string {
  return (JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8")) as { version: string }).version;
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function main(argv: string[]): void {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { tag: { type: "string" } },
  });
  const [command, ...rest] = positionals;
  const changelog = (): string => fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8");

  switch (command) {
    case "check": {
      let problems: string[];
      if (values.tag !== undefined) {
        if (!values.tag.startsWith("v")) fail(`tag ${values.tag} must start with "v"`);
        problems = releaseProblems({
          version: values.tag.slice(1),
          changelog: changelog(),
          rootVersion: readVersion("package.json"),
          desktopVersion: readVersion("integrations/desktop/package.json"),
        });
      } else {
        const [version] = rest;
        if (version === undefined) fail("usage: release.ts check <version> | check --tag v<version>");
        problems = releaseProblems({ version, changelog: changelog() });
      }
      for (const problem of problems) console.error(`error: ${problem}`);
      if (problems.length > 0) process.exit(1);
      return;
    }
    case "notes": {
      const [version] = rest;
      if (version === undefined) fail("usage: release.ts notes <version>");
      const section = changelogSection(changelog(), version);
      if (section === null) fail(`CHANGELOG.md has no section for ${version}`);
      console.log(section);
      return;
    }
    case "formula": {
      const [version, sums] = rest;
      if (version === undefined || sums === undefined) fail("usage: release.ts formula <version> <SHA256SUMS>");
      try {
        console.log(homebrewFormula(version, fs.readFileSync(sums, "utf8")).trimEnd());
      } catch (err) {
        fail((err as Error).message);
      }
      return;
    }
    default:
      fail("usage: release.ts check|notes|formula ...");
  }
}

if (import.meta.main) main(Bun.argv.slice(2));
