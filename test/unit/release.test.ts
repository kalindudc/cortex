import { describe, expect, test } from "bun:test";
import { changelogSection, homebrewFormula, releaseProblems } from "../../scripts/release.ts";

const CHANGELOG = `# Changelog

Intro.

## 1.1.0 - 2026-11-02

- the newer one

## 1.0.0 - 2026-11-01

- signed apps
- a cask

## 0.99.0

## 0.9.0

- old
`;

const SUMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]
  .map((platform, i) => `${String(i).repeat(64)}  cortex-1.0.0-${platform}.tar.gz`)
  .join("\n");

describe("changelogSection", () => {
  test("returns the text under its heading, up to the next section", () => {
    expect(changelogSection(CHANGELOG, "1.0.0")).toBe("- signed apps\n- a cask");
    expect(changelogSection(CHANGELOG, "0.9.0")).toBe("- old");
  });

  test("a release candidate uses its base version's section", () => {
    expect(changelogSection(CHANGELOG, "1.0.0-rc.2")).toBe("- signed apps\n- a cask");
  });

  test("a missing or empty section is null, and a heading must match the whole version", () => {
    expect(changelogSection(CHANGELOG, "2.0.0")).toBeNull();
    expect(changelogSection(CHANGELOG, "0.99.0")).toBeNull();
    expect(changelogSection(CHANGELOG, "1.0")).toBeNull();
  });
});

describe("releaseProblems", () => {
  test("a version with a section and matching package versions has no problem", () => {
    expect(releaseProblems({ version: "1.0.0", changelog: CHANGELOG })).toEqual([]);
    expect(
      releaseProblems({
        version: "1.0.0-rc.1",
        changelog: CHANGELOG,
        rootVersion: "1.0.0-rc.1",
        desktopVersion: "1.0.0-rc.1",
      }),
    ).toEqual([]);
  });

  test("reports a version that is not x.y.z or x.y.z-rc.n", () => {
    for (const version of ["1.0", "v1.0.0", "1.0.0-beta.1", "1.0.0-rc"]) {
      expect(releaseProblems({ version, changelog: CHANGELOG })).toEqual([
        `${version} is not a release version: use x.y.z, or x.y.z-rc.n to rehearse one`,
      ]);
    }
  });

  test("reports a missing or empty changelog section", () => {
    expect(releaseProblems({ version: "2.0.0", changelog: CHANGELOG })[0]).toContain('no "## 2.0.0" section');
    expect(releaseProblems({ version: "0.99.0", changelog: CHANGELOG })[0]).toContain('no "## 0.99.0" section');
  });

  test("reports each package whose version differs", () => {
    expect(
      releaseProblems({ version: "1.0.0", changelog: CHANGELOG, rootVersion: "0.99.0", desktopVersion: "0.2.0" }),
    ).toEqual([
      "package.json has version 0.99.0, not 1.0.0",
      "integrations/desktop/package.json has version 0.2.0, not 1.0.0",
    ]);
  });
});

describe("homebrewFormula", () => {
  test("installs the CLI archive of each platform, with its checksum", () => {
    const formula = homebrewFormula("1.0.0", SUMS);
    ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"].forEach((platform, i) => {
      const url = `https://github.com/kalindudc/cortex/releases/download/v1.0.0/cortex-1.0.0-${platform}.tar.gz`;
      expect(formula).toContain(`url "${url}"\n      sha256 "${String(i).repeat(64)}"`);
    });
    expect(formula).toStartWith("class Cortex < Formula\n");
    expect(formula).toContain('version "1.0.0"');
    expect(formula).toContain('license "MIT"');
    expect(formula).toContain('bin.install "cortex"');
    expect(formula).toContain('assert_match version.to_s, shell_output("#{bin}/cortex --version")');
  });

  test("throws, naming the archive, when SHA256SUMS lacks one", () => {
    const partial = SUMS.split("\n").slice(0, 3).join("\n");
    expect(() => homebrewFormula("1.0.0", partial)).toThrow(
      "SHA256SUMS has no entry for cortex-1.0.0-linux-x64.tar.gz",
    );
  });
});
