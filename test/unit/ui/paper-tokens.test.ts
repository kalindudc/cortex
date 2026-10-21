import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

// Reads tokens.css as text and resolves each theme the way the cascade does:
// dark is layered on light, and high contrast on dark.
const ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const read = (file: string) => stripComments(fs.readFileSync(path.join(ROOT, file), "utf8"));

type Rule = { prelude: string; body: string };
type Theme = Map<string, string>;

/** Walks `css` from `start`, skipping quoted strings, and calls `at` on every other character. */
function scan(css: string, start: number, at: (i: number) => boolean | undefined): number {
  let quote = "";
  for (let i = start; i < css.length; i++) {
    const c = css[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (at(i)) {
      return i;
    }
  }
  return css.length;
}

function stripComments(css: string): string {
  let out = "";
  let pos = 0;
  for (;;) {
    const start = scan(css, pos, i => css.startsWith("/*", i));
    out += css.slice(pos, start);
    if (start === css.length) return out;
    pos = css.indexOf("*/", start + 2) + 2;
  }
}

function rules(css: string): Rule[] {
  const out: Rule[] = [];
  let pos = 0;
  while (css.slice(pos).trim()) {
    const open = scan(css, pos, i => css[i] === "{");
    let depth = 0;
    const close = scan(css, open, i => {
      if (css[i] === "{") depth++;
      if (css[i] === "}") depth--;
      return depth === 0;
    });
    out.push({ prelude: css.slice(pos, open).trim(), body: css.slice(open + 1, close) });
    pos = close + 1;
  }
  return out;
}

function declarations(body: string): [string, string][] {
  const out: [string, string][] = [];
  let depth = 0;
  let from = 0;
  const take = (to: number) => {
    const decl = body.slice(from, to).trim();
    from = to + 1;
    if (!decl) return;
    const colon = decl.indexOf(":");
    out.push([
      decl.slice(0, colon).trim(),
      decl
        .slice(colon + 1)
        .trim()
        .replace(/\s+/g, " "),
    ]);
  };
  scan(body, 0, i => {
    if (body[i] === "(") depth++;
    if (body[i] === ")") depth--;
    if (body[i] === ";" && depth === 0) take(i);
    return undefined;
  });
  take(body.length);
  return out;
}

function block(list: Rule[], prelude: string): [string, string][] {
  const rule = list.find(r => r.prelude === prelude);
  if (!rule) throw new Error(`tokens.css has no ${prelude} block`);
  const decls = declarations(rule.body);
  const names = decls.map(([name]) => name);
  expect(new Set(names).size, `${prelude} declares a token twice`).toBe(names.length);
  return decls;
}

const TOP = rules(read("src/ui/styles/tokens.css"));
const MEDIA_DARK = "@media (prefers-color-scheme: dark)";
const LIGHT_BLOCK = block(TOP, ":root");
const SYSTEM_DARK_BLOCK = block(
  rules(TOP.find(r => r.prelude === MEDIA_DARK)?.body ?? ""),
  ':root:not([data-theme="light"])',
);
const DARK_BLOCK = block(TOP, ':root[data-theme="dark"]');
const HIGH_BLOCK = block(TOP, ':root[data-contrast="high"]');

const light: Theme = new Map(LIGHT_BLOCK);
const dark: Theme = new Map([...light, ...DARK_BLOCK]);
const high: Theme = new Map([...dark, ...HIGH_BLOCK]);
const THEMES = { light, dark, "high contrast": high };

function resolve(theme: Theme, name: string, seen: string[] = []): string {
  const value = theme.get(name);
  if (value === undefined) throw new Error(`${name} is not defined`);
  if (seen.includes(name)) throw new Error(`${[...seen, name].join(" -> ")} is a cycle`);
  return value.replace(/var\((--[\w-]+)\)/g, (_, ref: string) => resolve(theme, ref, [...seen, name]));
}

function luminance(theme: Theme, name: string): number {
  const value = resolve(theme, name);
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (!match) throw new Error(`${name} is ${value}, not a #rrggbb colour`);
  const [r, g, b] = [0, 2, 4].map(i => {
    const c = Number.parseInt(match[1].slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(theme: Theme, text: string, surface: string): number {
  const [hi, lo] = [luminance(theme, text), luminance(theme, surface)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

function expectContrast(theme: Theme, texts: string[], surfaces: string[], min: number): void {
  for (const text of texts) {
    for (const surface of surfaces) {
      expect(contrast(theme, text, surface), `${text} on ${surface}`).toBeGreaterThanOrEqual(min);
    }
  }
}

const PALETTE = {
  light: {
    "--desk": "#ebe4d6",
    "--desk-deep": "#e4dccb",
    "--sheet": "#fbf8f1",
    "--bg": "#fbf8f1",
    "--panel": "#ebe4d6",
    "--text": "#2a251e",
    "--text-content": "#3a342b",
    "--text-2": "#4f483c",
    "--text-3": "#7b7161",
    "--text-4": "#a99e89",
    "--rule": "rgba(70, 55, 35, 0.13)",
    "--rule-strong": "rgba(70, 55, 35, 0.24)",
    "--accent": "#ea8a5b",
    "--accent-on": "#2a251e",
    "--code-accent": "#9a4a1f",
  },
  dark: {
    "--desk": "#1a1815",
    "--desk-deep": "#161411",
    "--sheet": "#24211c",
    "--bg": "#24211c",
    "--panel": "#1a1815",
    "--text": "#ece5d8",
    "--text-content": "#ddd5c6",
    "--text-2": "#cdc5b6",
    "--text-3": "#8e8575",
    "--text-4": "#5f584c",
    "--rule": "rgba(236, 229, 216, 0.09)",
    "--rule-strong": "rgba(236, 229, 216, 0.18)",
    "--accent": "#f0a27c",
    "--accent-on": "#1a1815",
    "--code-accent": "#f0a27c",
  },
};

const PAPER = [
  "--desk",
  "--desk-deep",
  "--sheet",
  "--rule",
  "--paper-grain",
  "--dot-grid",
  "--paper-edge",
  "--paper-lift",
  "--card-lift",
  "--shadow-card",
];

describe("paper tokens", () => {
  test("the blocks are light, the two dark copies, then high contrast last", () => {
    expect(TOP.map(r => r.prelude)).toEqual([
      ":root",
      MEDIA_DARK,
      ':root[data-theme="dark"]',
      ':root[data-contrast="high"]',
    ]);
  });

  test("the two dark copies declare identical values", () => {
    expect(SYSTEM_DARK_BLOCK).toEqual(DARK_BLOCK);
  });

  test("light and dark resolve to the paper and night-paper palettes", () => {
    for (const [name, palette] of Object.entries(PALETTE)) {
      const theme = THEMES[name as keyof typeof PALETTE];
      for (const [token, value] of Object.entries(palette))
        expect(resolve(theme, token), `${name} ${token}`).toBe(value);
    }
  });

  test("the page background is the desk", () => {
    const body = block(rules(read("src/ui/styles/base.css")), "body");
    expect(body.find(([name]) => name === "background")?.[1]).toBe("var(--desk)");
  });

  test("in light and dark, text reaches 4.5:1 and --text-3 reaches 3:1 on the sheet and the desk", () => {
    for (const theme of [light, dark]) {
      const surfaces = ["--sheet", "--desk", "--desk-deep"];
      expectContrast(theme, ["--text", "--text-content", "--text-2"], surfaces, 4.5);
      expectContrast(theme, ["--text-3"], surfaces, 3);
    }
  });

  test("in high contrast, every text token reaches 7:1 on every surface", () => {
    expectContrast(
      high,
      ["--text", "--text-content", "--text-2", "--text-3", "--text-4"],
      ["--bg", "--panel", "--tint", "--sheet", "--desk", "--desk-deep"],
      7,
    );
  });

  test("every theme defines the paper primitives", () => {
    for (const [name, theme] of Object.entries(THEMES)) {
      for (const token of PAPER) expect(resolve(theme, token), `${name} ${token}`).not.toBe("");
    }
    for (const theme of [light, dark]) {
      expect(resolve(theme, "--paper-grain")).toStartWith('url("data:image/svg+xml;utf8,');
      expect(resolve(theme, "--paper-grain")).toContain("feTurbulence");
      expect(resolve(theme, "--dot-grid")).toStartWith("radial-gradient(circle,");
      expect(resolve(theme, "--paper-lift").match(/drop-shadow\(/g)).toHaveLength(2);
      expect(resolve(theme, "--card-lift").match(/drop-shadow\(/g)).toHaveLength(2);
    }
    const edge = resolve(light, "--paper-edge");
    expect(edge).toStartWith("polygon(");
    // 22 points on each of the four edges.
    expect(edge.slice("polygon(".length, -1).split(",")).toHaveLength(88);
  });

  test("high contrast draws no grain and no dots", () => {
    expect(resolve(high, "--paper-grain")).toBe("none");
    expect(resolve(high, "--dot-grid")).toBe("none");
  });
});
