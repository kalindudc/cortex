import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const FONTS = path.join(ROOT, "src/ui/fonts");
const STYLES = path.join(ROOT, "src/ui/styles");
const LICENCES = ["OFL-Literata.txt", "LICENSE-iA-Writer-Mono.md"];
const WOFF2_SIGNATURE = "wOF2";

const css = fs.readFileSync(path.join(STYLES, "fonts.css"), "utf8");
const cssWithoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
const fontFiles = fs.readdirSync(FONTS).filter(name => !LICENCES.includes(name));

function urls(source: string): string[] {
  return [...source.matchAll(/url\(\s*(["']?)([^"')]*)\1\s*\)/g)].map(m => m[2] ?? "");
}

function rootToken(name: string): string | undefined {
  const root = cssWithoutComments.match(/:root\s*\{([^}]*)\}/)?.[1] ?? "";
  return root.match(new RegExp(`${name}\\s*:\\s*([^;]+);`))?.[1]?.trim();
}

function listFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(ent => {
    const abs = path.join(dir, ent.name);
    return ent.isDirectory() ? listFiles(abs) : [abs];
  });
}

describe("bundled fonts", () => {
  test("every url() in fonts.css names a file in src/ui/fonts, relative to the bundled stylesheet", () => {
    const referenced = urls(cssWithoutComments);
    expect(referenced.length).toBeGreaterThan(0);
    for (const url of referenced) {
      expect(url, url).toMatch(/^fonts\/[a-z0-9-]+\.woff2$/);
      expect(fs.existsSync(path.join(FONTS, url.slice("fonts/".length))), url).toBe(true);
    }
  });

  test("every font file in src/ui/fonts is referenced by fonts.css", () => {
    const referenced = new Set(urls(cssWithoutComments));
    expect(fontFiles.length).toBeGreaterThan(0);
    for (const name of fontFiles) expect(referenced.has(`fonts/${name}`), name).toBe(true);
  });

  test("every font file is a woff2 file with a lower-case kebab-case name", () => {
    for (const name of fontFiles) {
      expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*\.woff2$/);
      const head = Buffer.alloc(WOFF2_SIGNATURE.length);
      const fd = fs.openSync(path.join(FONTS, name), "r");
      try {
        fs.readSync(fd, head, 0, head.length, 0);
      } finally {
        fs.closeSync(fd);
      }
      expect(head.toString("latin1"), name).toBe(WOFF2_SIGNATURE);
    }
  });

  test("both licences ship beside the fonts", () => {
    for (const name of LICENCES) {
      const file = path.join(FONTS, name);
      expect(fs.existsSync(file), name).toBe(true);
      expect(fs.statSync(file).size, name).toBeGreaterThan(0);
    }
  });

  test("fonts.css defines --font-serif starting with Literata and --font-write starting with iA Writer Mono", () => {
    expect(rootToken("--font-serif")).toStartWith('"Literata",');
    expect(rootToken("--font-write")).toStartWith('"iA Writer Mono",');
  });

  test("no stylesheet under src/ui/styles references an http or https URL", () => {
    for (const file of listFiles(STYLES)) {
      expect(fs.readFileSync(file, "utf8"), path.relative(ROOT, file)).not.toMatch(
        /https?:(?!\/\/www\.w3\.org\/2000\/svg)/i,
      );
    }
  });

  test("build-css.sh puts the fonts slice first, before tokens", () => {
    const script = fs.readFileSync(path.join(ROOT, "scripts/build-css.sh"), "utf8");
    const slices = script
      .match(/^SLICES=\(\n([\s\S]*?)^\)/m)?.[1]
      ?.split(/\s+/)
      .filter(Boolean);
    expect(slices?.slice(0, 2)).toEqual(["fonts", "tokens"]);
  });
});
