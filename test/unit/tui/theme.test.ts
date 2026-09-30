import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BUNDLED_THEMES,
  BUNDLED_THEME_NAMES,
  CONTRAST_PAIRS,
  THEME_TOKENS,
  contrastRatio,
  detectColorMode,
  inactiveTheme,
  isThemeColor,
  listThemes,
  paint,
  requiredContrast,
  resolveTheme,
  seg,
  style,
  to16,
  to256,
  xterm256Hex,
  type ContrastPair,
  type ResolvedTheme,
  type ThemeInput,
  type ThemeToken,
} from "../../../src/tui/theme.ts";
import { DEFAULT_CONFIG } from "../../../src/tui/config.ts";

// Plan @400 N22/N23/G6: semantic tokens, bundled themes derived from the
// web palette, WCAG contrast gates in truecolor AND after 256-color mapping,
// color-mode detection, the theme precedence chain and custom themes.

type BundledName = (typeof BUNDLED_THEME_NAMES)[number];
const HEX_THEMES = BUNDLED_THEME_NAMES.filter(n => n !== "ansi");
const PAIRS = Object.keys(CONTRAST_PAIRS) as ContrastPair[];

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-tui-themes-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function input(overrides: Partial<ThemeInput> = {}): ThemeInput {
  return {
    config: DEFAULT_CONFIG,
    env: { COLORTERM: "truecolor", TERM: "xterm-256color" },
    themesDir: dir,
    ...overrides,
  };
}

describe("tokens and bundled themes", () => {
  test("the N22 token list", () => {
    expect(THEME_TOKENS).toEqual([
      "bg",
      "panel",
      "raised",
      "border",
      "text",
      "muted",
      "dim",
      "inactive",
      "accent",
      "info",
      "warn",
      "danger",
      "selection",
      "search",
      "status.draft",
      "status.open",
      "status.review",
      "status.blocked",
      "status.done",
      "mode.normal",
      "mode.insert",
      "mode.command",
      "mode.search",
      "md.heading",
      "md.link",
      "md.code",
      "md.quote",
      "md.bullet",
    ]);
  });

  test("bundled names and completeness; hex themes use only #rrggbb", () => {
    expect(BUNDLED_THEME_NAMES).toEqual([
      "cortex-dark",
      "cortex-light",
      "high-contrast-dark",
      "high-contrast-light",
      "ansi",
    ]);
    for (const name of BUNDLED_THEME_NAMES) {
      const theme = BUNDLED_THEMES[name];
      expect(theme.name).toBe(name);
      expect(Object.keys(theme.colors).sort()).toEqual([...THEME_TOKENS].sort());
      for (const token of THEME_TOKENS) expect(isThemeColor(theme.colors[token]), `${name} ${token}`).toBe(true);
    }
    for (const name of HEX_THEMES) {
      for (const token of THEME_TOKENS) expect(BUNDLED_THEMES[name].colors[token]).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(BUNDLED_THEMES["high-contrast-dark"].highContrast).toBe(true);
    expect(BUNDLED_THEMES["high-contrast-light"].highContrast).toBe(true);
    expect(BUNDLED_THEMES["cortex-dark"].appearance).toBe("dark");
    expect(BUNDLED_THEMES["cortex-light"].appearance).toBe("light");
  });

  test("ansi uses the terminal's own surfaces and body text, and palette colors only for roles and status", () => {
    const c = BUNDLED_THEMES.ansi.colors;
    for (const token of ["bg", "panel", "raised", "border", "text", "muted", "dim"] as ThemeToken[]) {
      expect(c[token], token).toBe("default");
    }
    for (const token of THEME_TOKENS) expect(c[token]).toMatch(/^(default|ansi:(\d|1[0-5]))$/);
    for (const token of ["status.draft", "status.review", "status.blocked", "status.done", "danger", "warn"] as const) {
      expect(c[token]).toMatch(/^ansi:/);
    }
  });

  test("isThemeColor accepts only #rrggbb, ansi:0-15 and default", () => {
    for (const ok of ["#000000", "#a1b2c3", "#FFFFFF", "ansi:0", "ansi:15", "default"])
      expect(isThemeColor(ok), ok).toBe(true);
    for (const bad of ["#fff", "#12345g", "ansi:16", "ansi:-1", "ansi:", "red", "", "Default", 3, null]) {
      expect(isThemeColor(bad), String(bad)).toBe(false);
    }
  });
});

describe("CONTRAST_PAIRS", () => {
  test("every pair names real tokens and a kind with its WCAG minimum", () => {
    for (const pair of PAIRS) {
      const spec = CONTRAST_PAIRS[pair];
      expect(THEME_TOKENS).toContain(spec.fg);
      expect(THEME_TOKENS).toContain(spec.surface);
      expect(pair as string).toBe(`${spec.fg}@${spec.surface}`);
      expect(spec.min).toBe({ text: 4.5, indicator: 3, decorative: 1 }[spec.kind]);
    }
    expect(requiredContrast(BUNDLED_THEMES["cortex-dark"], "text@bg")).toBe(4.5);
    expect(requiredContrast(BUNDLED_THEMES["high-contrast-dark"], "text@bg")).toBe(7);
    expect(requiredContrast(BUNDLED_THEMES["high-contrast-dark"], "accent@selection")).toBe(3);
  });

  test("colored text is declared on every surface it appears on", () => {
    const surfaces = ["bg", "panel", "raised", "selection"] as const;
    for (const fg of [
      "text",
      "muted",
      "accent",
      "info",
      "warn",
      "danger",
      ...THEME_TOKENS.filter(t => t.startsWith("status.")),
    ]) {
      for (const surface of surfaces) {
        if (fg === "accent" && surface === "selection") continue; // the selected-row marker: an indicator
        expect(CONTRAST_PAIRS[`${fg}@${surface}` as ContrastPair]?.kind, `${fg}@${surface}`).toBe("text");
      }
    }
    expect(CONTRAST_PAIRS["text@search"].kind).toBe("text");
    for (const mode of ["normal", "insert", "command", "search"]) {
      expect(CONTRAST_PAIRS[`mode.${mode}@panel` as ContrastPair].kind).toBe("text");
    }
    for (const md of ["heading", "link", "code", "quote", "bullet"]) {
      expect(CONTRAST_PAIRS[`md.${md}@bg` as ContrastPair].kind).toBe("text");
    }
    expect(CONTRAST_PAIRS["accent@selection"].kind).toBe("indicator");
    expect(CONTRAST_PAIRS["border@bg"].kind).toBe("decorative");
  });

  // G6: every CONTRAST_PAIRS entry passes for every bundled hex theme in
  // truecolor AND after 256-color mapping (text 4.5:1, high-contrast 7:1,
  // indicators 3:1). Decorative borders are exempt.
  for (const name of HEX_THEMES) {
    test(`${name} passes every pair in truecolor and after 256-color mapping`, () => {
      const theme = BUNDLED_THEMES[name];
      const failures: string[] = [];
      for (const pair of PAIRS) {
        const { fg, surface } = CONTRAST_PAIRS[pair];
        const min = requiredContrast(theme, pair);
        const a = theme.colors[fg];
        const b = theme.colors[surface];
        const tc = contrastRatio(a, b);
        const mapped = contrastRatio(xterm256Hex(to256(a)), xterm256Hex(to256(b)));
        if (tc < min) failures.push(`${pair} truecolor ${tc.toFixed(2)} < ${min}`);
        if (mapped < min) failures.push(`${pair} 256-color ${mapped.toFixed(2)} < ${min}`);
      }
      expect(failures).toEqual([]);
    });
  }
});

// cortex-dark / cortex-light start from cortex's base palette (statuses:
// draft=info, open=text-3, review=warn, blocked=err, done=ok). Tokens that
// pass keep the base value; every base value that fails a gate is adjusted to
// the nearest passing color (CIELAB), and each adjustment is recorded here
// beside its test.
describe("base palette derivation", () => {
  test("surfaces, body text and passing roles keep the base values", () => {
    const d = BUNDLED_THEMES["cortex-dark"].colors;
    expect([d.bg, d.panel, d.raised, d.border, d.text]).toEqual([
      "#1d1f24",
      "#24262b",
      "#2c2e34",
      "#43454c",
      "#dadbe0",
    ]);
    // --text-2, --accent, --warn, --err, --ok, --code-accent
    expect([d.muted, d.accent, d.warn, d.danger, d["status.done"], d["md.link"]]).toEqual([
      "#989aa0",
      "#f5a47e",
      "#d8a558",
      "#e08580",
      "#7eaa6c",
      "#f5a47e",
    ]);
    const l = BUNDLED_THEMES["cortex-light"].colors;
    expect([l.bg, l.panel, l.raised, l.border, l.text]).toEqual([
      "#f6f2ec",
      "#efe9dd",
      "#e7e0d0",
      "#bdb19a",
      "#2c2820",
    ]);
    expect([l.muted, l.selection]).toEqual(["#56503f", "#cfd9e8"]);
    for (const name of ["cortex-dark", "cortex-light"] as const) {
      const c = BUNDLED_THEMES[name].colors;
      expect([c["status.draft"], c["status.review"], c["status.blocked"]]).toEqual([c.info, c.warn, c.danger]);
    }
  });

  // [theme, token, web value, the pair it fails, the mode it fails in]; the
  // comment records web -> adjusted ratios as truecolor / after 256 mapping.
  const ADJUSTMENTS: [BundledName, ThemeToken, string, ContrastPair, "truecolor" | "256"][] = [
    // --selection: danger 4.55 / 4.17 (muted 4.33 / 4.25) -> #242f4a: danger 4.96 / 4.84, muted 4.72 / 4.93
    ["cortex-dark", "selection", "#2a3550", "danger@selection", "256"],
    // --text-3: 2.62 / 2.51 on raised -> #98949f: 4.57 / 4.93
    ["cortex-dark", "dim", "#6b6d72", "dim@raised", "truecolor"],
    // --text-3 (open): 2.62 / 2.51 on raised -> #95979f: 4.66 / 4.93 (it also sits on selection)
    ["cortex-dark", "status.open", "#6b6d72", "status.open@raised", "truecolor"],
    // --info: 4.39 / 3.84 on raised -> #7e9cb6: 4.73 / 5.52 (also status.draft, mode.command)
    ["cortex-dark", "info", "#7896b0", "info@raised", "truecolor"],
    // --text-3: 2.93 / 2.65 on raised -> #696352: 4.55 / 4.57
    ["cortex-light", "dim", "#8a8170", "dim@raised", "truecolor"],
    // --text-3 (open): 2.93 / 2.65 on raised -> #665d4c: 4.94 / 5.09
    ["cortex-light", "status.open", "#8a8170", "status.open@raised", "truecolor"],
    // --accent: 1.85 / 1.69 on raised -> #a82e1b: 5.20 / 5.32 (also mode.normal)
    ["cortex-light", "accent", "#ed8e60", "accent@raised", "truecolor"],
    // --info: 3.61 / 4.32 on selection -> #2f637e: 4.60 / 5.03 (also status.draft, mode.command)
    ["cortex-light", "info", "#4a728d", "info@selection", "truecolor"],
    // --warn: 2.13 / 2.33 on selection -> #725a01: 4.64 / 4.81 (also status.review, mode.search)
    ["cortex-light", "warn", "#c08a3a", "warn@selection", "truecolor"],
    // --err: 4.05 / 3.25 on raised -> #992f2d: 5.71 / 7.40 (also status.blocked)
    ["cortex-light", "danger", "#b14a48", "danger@raised", "truecolor"],
    // --ok: 2.83 / 2.94 on selection -> #2e691e: 4.67 / 5.70 (also mode.insert; stays green in 256)
    ["cortex-light", "status.done", "#5e8a4b", "status.done@selection", "truecolor"],
    // --code-accent: 5.35 / 4.10 on selection -> #7e2e06: 6.46 / 7.40 (also md.code, md.bullet)
    ["cortex-light", "md.link", "#8a3d12", "md.link@selection", "256"],
  ];
  const ratio = (a: string, b: string, mode: "truecolor" | "256") =>
    mode === "truecolor" ? contrastRatio(a, b) : contrastRatio(xterm256Hex(to256(a)), xterm256Hex(to256(b)));

  for (const [name, token, web, pair, mode] of ADJUSTMENTS) {
    test(`${name} ${token}: web ${web} fails ${pair} (${mode}), so it is adjusted`, () => {
      const theme = BUNDLED_THEMES[name];
      const { fg, surface } = CONTRAST_PAIRS[pair];
      const withWeb = { ...theme.colors, [token]: web };
      const min = requiredContrast(theme, pair);
      expect(ratio(withWeb[fg], withWeb[surface], mode)).toBeLessThan(min);
      expect(theme.colors[token]).not.toBe(web);
      for (const m of ["truecolor", "256"] as const) {
        expect(ratio(theme.colors[fg], theme.colors[surface], m)).toBeGreaterThanOrEqual(min);
      }
    });
  }
});

describe("color math", () => {
  test("contrastRatio implements the WCAG 2 formula", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#777777")).toBe(1);
    expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
    expect(contrastRatio("#595959", "#ffffff")).toBeCloseTo(7.0, 1);
    expect(() => contrastRatio("ansi:1", "#ffffff")).toThrow();
    expect(() => contrastRatio("default", "#ffffff")).toThrow();
  });

  test("256-color downsampling uses the cube levels 0,95,135,175,215,255 and grays 8+10n", () => {
    expect(to256("#000000")).toBe(16);
    expect(to256("#ffffff")).toBe(231);
    expect(to256("#5f87af")).toBe(16 + 36 * 1 + 6 * 2 + 3);
    expect(to256("#080808")).toBe(232);
    expect(to256("#eeeeee")).toBe(255);
    expect(to256("#767676")).toBe(243);
    expect(to256("#ff0101")).toBe(196);
    expect(xterm256Hex(16)).toBe("#000000");
    expect(xterm256Hex(67)).toBe("#5f87af");
    expect(xterm256Hex(232)).toBe("#080808");
    expect(xterm256Hex(255)).toBe("#eeeeee");
    for (let i = 16; i < 256; i++) expect(to256(xterm256Hex(i))).toBe(i);
  });

  test("16-color mapping picks the nearest standard color", () => {
    expect(to16("#000000")).toBe(0);
    expect(to16("#ffffff")).toBe(15);
    expect(to16("#ff0000")).toBe(9);
    expect(to16("#c00000")).toBe(1);
    expect(to16("#00d000")).toBe(2);
    expect(to16("#808080")).toBe(8);
    expect(to16("#e0e0e0")).toBe(7);
  });
});

describe("detectColorMode (N23)", () => {
  const cases: [string, Parameters<typeof detectColorMode>[1], string][] = [
    ["NO_COLOR non-empty", { NO_COLOR: "1", COLORTERM: "truecolor" }, "none"],
    ["empty NO_COLOR is ignored", { NO_COLOR: "", COLORTERM: "truecolor" }, "truecolor"],
    ["COLORTERM=truecolor", { COLORTERM: "truecolor", TERM: "xterm" }, "truecolor"],
    ["COLORTERM=24bit", { COLORTERM: "24bit" }, "truecolor"],
    ["TERM=xterm-kitty (SSH without COLORTERM)", { TERM: "xterm-kitty" }, "truecolor"],
    ["TERM=xterm-ghostty", { TERM: "xterm-ghostty" }, "truecolor"],
    ["TERM=*-direct", { TERM: "xterm-direct" }, "truecolor"],
    ["TERM=*256color", { TERM: "screen-256color" }, "256"],
    ["TERM=xterm", { TERM: "xterm" }, "16"],
    ["TERM unset", {}, "16"],
  ];
  for (const [label, env, mode] of cases) {
    test(label, () => expect(detectColorMode("auto", env).mode).toBe(mode as "none"));
  }

  test("an explicit colors setting overrides NO_COLOR and detection", () => {
    expect(detectColorMode("truecolor", { NO_COLOR: "1" }).mode).toBe("truecolor");
    expect(detectColorMode("256", { COLORTERM: "truecolor" }).mode).toBe("256");
    expect(detectColorMode("none", { COLORTERM: "truecolor" }).mode).toBe("none");
  });

  test("TERM=dumb is reported so the command can refuse", () => {
    expect(detectColorMode("auto", { TERM: "dumb" }).dumb).toBe(true);
    expect(detectColorMode("truecolor", { TERM: "dumb" }).dumb).toBe(true);
    expect(detectColorMode("auto", { TERM: "xterm" }).dumb).toBe(false);
  });
});

describe("resolveTheme precedence (N22)", () => {
  const cfg = (c: Partial<typeof DEFAULT_CONFIG>) => ({ ...DEFAULT_CONFIG, ...c });

  test("auto: the bundled pair by appearance; an unanswered query means dark", () => {
    expect(resolveTheme(input())).toMatchObject({ name: "cortex-dark", source: "default", explicit: false });
    expect(resolveTheme(input({ detected: null }))).toMatchObject({ name: "cortex-dark" });
    expect(resolveTheme(input({ detected: "light" }))).toMatchObject({ name: "cortex-light", source: "default" });
    expect(resolveTheme(input({ detected: "dark", config: cfg({ appearance: "light" }) })).name).toBe("cortex-light");
    expect(resolveTheme(input({ detected: "light", config: cfg({ appearance: "dark" }) })).name).toBe("cortex-dark");
  });

  test("theme_dark / theme_light by appearance", () => {
    const config = cfg({ themeDark: "high-contrast-dark", themeLight: "high-contrast-light" });
    expect(resolveTheme(input({ config }))).toMatchObject({
      name: "high-contrast-dark",
      source: "appearance",
      explicit: false,
    });
    expect(resolveTheme(input({ config, detected: "light" }))).toMatchObject({ name: "high-contrast-light" });
  });

  test("session > cli > saved > tui.toml theme > theme_dark/theme_light > bundled pair", () => {
    const config = cfg({ theme: "cortex-light", themeDark: "high-contrast-dark" });
    const all = { session: "ansi", cli: "high-contrast-light", saved: "cortex-dark", config };
    expect(resolveTheme(input(all))).toMatchObject({ name: "ansi", source: "session", explicit: true });
    expect(resolveTheme(input({ ...all, session: null }))).toMatchObject({
      name: "high-contrast-light",
      source: "cli",
    });
    expect(resolveTheme(input({ ...all, session: null, cli: null }))).toMatchObject({
      name: "cortex-dark",
      source: "saved",
    });
    expect(resolveTheme(input({ config }))).toMatchObject({ name: "cortex-light", source: "config", explicit: true });
  });

  test("an unknown or invalid explicit theme falls through with a problem", () => {
    const r = resolveTheme(input({ saved: "gone", cli: "../x", config: cfg({ theme: "cortex-light" }) }));
    expect(r).toMatchObject({ name: "cortex-light", source: "config" });
    expect(r.problems.map(p => p.reason).join("\n")).toMatch(/gone/);
    expect(r.problems.map(p => p.reason).join("\n")).toMatch(/\.\.\/x/);
  });

  test("16-color terminals get ansi unless a theme is explicit, which is mapped with a notice", () => {
    const env = { TERM: "xterm" };
    expect(resolveTheme(input({ env }))).toMatchObject({ name: "ansi", source: "colors", explicit: false, mode: "16" });
    const config = cfg({ themeDark: "cortex-light" });
    expect(resolveTheme(input({ env, config })).name).toBe("ansi");
    const explicit = resolveTheme(input({ env, cli: "cortex-dark" }));
    expect(explicit).toMatchObject({ name: "cortex-dark", mode: "16" });
    expect(explicit.problems).toContainEqual(expect.objectContaining({ severity: "notice" }));
  });

  test("NO_COLOR resolves a theme but renders no color", () => {
    const r = resolveTheme(input({ env: { NO_COLOR: "1", COLORTERM: "truecolor" } }));
    expect(r).toMatchObject({ name: "cortex-dark", mode: "none" });
    const forced = resolveTheme(input({ env: { NO_COLOR: "1" }, config: cfg({ colors: "256" }) }));
    expect(forced.mode).toBe("256");
  });

  test("transparent_background leaves bg to the terminal and says contrast is unverifiable", () => {
    const r = resolveTheme(input({ config: cfg({ transparentBackground: true }) }));
    expect(r.colors.bg).toBe("default");
    expect(r.colors.panel).toBe(BUNDLED_THEMES["cortex-dark"].colors.panel);
    expect(r.problems).toContainEqual(
      expect.objectContaining({ severity: "notice", reason: expect.stringMatching(/contrast/) }),
    );
  });
});

describe("custom themes", () => {
  const writeTheme = (name: string, text: string) => fs.writeFileSync(path.join(dir, `${name}.toml`), text);
  const full = (overrides = "") =>
    THEME_TOKENS.map(t => {
      const [table, key] = t.includes(".") ? t.split(".") : [null, t];
      return table
        ? `${table}.${key} = "${BUNDLED_THEMES["cortex-dark"].colors[t]}"`
        : `${key} = "${BUNDLED_THEMES["cortex-dark"].colors[t]}"`;
    }).join("\n") + overrides;

  test("a complete theme file is used", () => {
    writeTheme("mine", full());
    const r = resolveTheme(input({ cli: "mine" }));
    expect(r).toMatchObject({ name: "mine", source: "cli" });
    expect(r.colors).toEqual(BUNDLED_THEMES["cortex-dark"].colors);
    expect(r.problems.filter(p => p.severity === "error")).toEqual([]);
  });

  test("extends ONE bundled theme; tables and dotted keys both work", () => {
    writeTheme("warm", `extends = "cortex-light"\naccent = "#7a2e00"\n[status]\ndone = "#2f5a1f"\n`);
    const r = resolveTheme(input({ saved: "warm" }));
    expect(r.name).toBe("warm");
    expect(r.appearance).toBe("light");
    expect(r.colors.accent).toBe("#7a2e00");
    expect(r.colors["status.done"]).toBe("#2f5a1f");
    expect(r.colors.bg).toBe(BUNDLED_THEMES["cortex-light"].colors.bg);
  });

  test("syntax and completeness errors reject the theme with a problem", () => {
    writeTheme("broken", `bg = [\n`);
    writeTheme("partial", `bg = "#000000"\ntext = "#ffffff"\n`);
    writeTheme("badvalue", `extends = "cortex-dark"\ntext = "white"\n`);
    writeTheme("chained", `extends = "warm"\n`);
    writeTheme("warm", `extends = "cortex-light"\n`);
    writeTheme("nobase", `extends = "solarized"\n`);
    for (const [name, pattern, keyPath] of [
      ["broken", /invalid TOML/, ""],
      ["partial", /missing/, ""],
      ["badvalue", /#rrggbb/, "text"],
      ["chained", /bundled/, "extends"],
      ["nobase", /bundled/, "extends"],
    ] as const) {
      const r = resolveTheme(input({ cli: name }));
      expect(r.name, name).toBe("cortex-dark");
      const problem = r.problems.find(p => p.severity === "error" && p.theme === name);
      expect(problem, name).toMatchObject({ file: path.join(dir, `${name}.toml`), keyPath });
      expect(problem?.reason).toMatch(pattern);
      expect(problem?.reason).not.toMatch(/\bline\b|\d+:\d+/);
    }
  });

  test("bundled names win over custom files", () => {
    writeTheme("cortex-dark", full().replace(/^bg = .*$/m, 'bg = "#ff0000"'));
    const r = resolveTheme(input({ cli: "cortex-dark" }));
    expect(r.colors.bg).toBe(BUNDLED_THEMES["cortex-dark"].colors.bg);
    const listed = listThemes(dir);
    expect(listed.themes.filter(t => t.name === "cortex-dark")).toEqual([{ name: "cortex-dark", source: "bundled" }]);
    expect(listed.problems).toContainEqual(expect.objectContaining({ severity: "warning", theme: "cortex-dark" }));
  });

  test("low contrast is a per-pair warning, not a rejection; ansi/default pairs are exempt", () => {
    writeTheme("faint", `extends = "cortex-dark"\ndim = "#303238"\ninfo = "ansi:4"\n`);
    const r = resolveTheme(input({ cli: "faint" }));
    expect(r.name).toBe("faint");
    const warnings = r.problems.filter(p => p.severity === "warning").map(p => p.reason);
    expect(warnings.some(w => w.includes("dim@bg"))).toBe(true);
    expect(warnings.some(w => w.includes("info@"))).toBe(false);
  });

  test("unknown keys are warnings", () => {
    writeTheme("typo", `extends = "cortex-dark"\nacent = "#ffffff"\n[status]\nwip = "#ffffff"\n`);
    const r = resolveTheme(input({ cli: "typo" }));
    expect(r.name).toBe("typo");
    const warned = r.problems.filter(p => p.severity === "warning").map(p => p.keyPath);
    expect(warned).toEqual(expect.arrayContaining(["acent", "status.wip"]));
  });

  test("listThemes lists bundled then custom themes and skips invalid file names", () => {
    writeTheme("zeta", full());
    writeTheme("alpha", full());
    fs.writeFileSync(path.join(dir, "Bad Name.toml"), full());
    fs.writeFileSync(path.join(dir, "notes.txt"), "");
    const { themes, problems } = listThemes(dir);
    expect(themes).toEqual([
      ...BUNDLED_THEME_NAMES.map(name => ({ name, source: "bundled" as const })),
      { name: "alpha", source: "custom" as const },
      { name: "zeta", source: "custom" as const },
    ]);
    expect(problems).toContainEqual(
      expect.objectContaining({ severity: "warning", file: path.join(dir, "Bad Name.toml") }),
    );
    expect(listThemes(path.join(dir, "missing")).themes).toHaveLength(BUNDLED_THEME_NAMES.length);
  });
});

describe("style()", () => {
  const theme = (name: string, mode: ResolvedTheme["mode"]): ResolvedTheme => {
    const env =
      mode === "none"
        ? { NO_COLOR: "1" }
        : mode === "truecolor"
          ? { COLORTERM: "truecolor" }
          : mode === "256"
            ? { TERM: "xterm-256color" }
            : { TERM: "xterm" };
    return resolveTheme(input({ cli: name, env }));
  };
  const rgb = (hex: string) => [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16)).join(";");

  test("truecolor, 256 and 16-color encodings of a declared pair", () => {
    const dark = BUNDLED_THEMES["cortex-dark"].colors;
    expect(style(theme("cortex-dark", "truecolor"), "text@bg", "hi")).toBe(
      `\x1b[38;2;${rgb(dark.text)};48;2;${rgb(dark.bg)}mhi\x1b[0m`,
    );
    expect(style(theme("cortex-dark", "256"), "text@bg", "hi")).toBe(
      `\x1b[38;5;${to256(dark.text)};48;5;${to256(dark.bg)}mhi\x1b[0m`,
    );
    const sixteen = style(theme("cortex-dark", "16"), "text@bg", "hi");
    expect(sixteen).toMatch(/^\x1b\[(3[0-7]|9[0-7]);(4[0-7]|10[0-7])mhi\x1b\[0m$/);
  });

  test("attributes are kept in every mode, including none", () => {
    expect(style(theme("cortex-dark", "none"), "text@bg", "x", { bold: true, underline: true })).toBe(
      "\x1b[1;4mx\x1b[0m",
    );
    expect(style(theme("cortex-dark", "none"), "text@bg", "x")).toBe("x");
    expect(style(theme("cortex-dark", "truecolor"), "text@bg", "x", { inverse: true, dim: true })).toMatch(/;2;7mx/);
  });

  test("none keeps every state distinguishable without color", () => {
    const none = theme("cortex-dark", "none");
    expect(style(none, "text@selection", "row")).toBe("\x1b[7mrow\x1b[0m");
    expect(style(none, "text@search", "hit")).toBe("\x1b[4;7mhit\x1b[0m");
    expect(style(none, "accent@panel", "Tasks")).toBe("\x1b[1mTasks\x1b[0m");
    expect(style(none, "muted@bg", "meta")).toBe("\x1b[2mmeta\x1b[0m");
    expect(style(none, "md.link@bg", "link")).toBe("\x1b[4mlink\x1b[0m");
  });

  test("ansi: default surfaces use SGR 39/49, muted/dim are dim, roles use the palette, selection is inverse", () => {
    const ansi = theme("ansi", "truecolor");
    expect(style(ansi, "text@bg", "x")).toBe("\x1b[39;49mx\x1b[0m");
    expect(style(ansi, "muted@bg", "x")).toBe("\x1b[39;49;2mx\x1b[0m");
    expect(style(ansi, "status.blocked@bg", "x")).toMatch(/^\x1b\[(3[0-7]|9[0-7]);49mx/);
    expect(style(ansi, "text@selection", "x")).toBe("\x1b[39;49;7mx\x1b[0m");
  });

  test("only declared pairs and only already-escaped text", () => {
    const t = theme("cortex-dark", "truecolor");
    expect(() => style(t, "warn@search" as ContrastPair, "x")).toThrow(/pair/);
    for (const raw of ["\x1b[31m", "a\x07b", "\x9b2J", "tab\there", "line\nbreak", "\x7f"]) {
      expect(() => style(t, "text@bg", raw), JSON.stringify(raw)).toThrow(/escape/);
    }
    expect(style(t, "text@bg", "")).toBe("");
    expect(style(t, "text@bg", "日本語 ✓ 👍🏽")).toContain("日本語 ✓ 👍🏽");
  });
});

describe("paint() (one row of declared-pair segments)", () => {
  test("cuts to the width, pads with the fill surface and keeps every segment's pair", () => {
    const none = resolveTheme(input({ env: { NO_COLOR: "1" } }));
    const row = paint(
      none,
      [seg("accent@panel", "TASKS", { bold: true }), seg("dim@panel", "  3 shown")],
      20,
      "text@panel",
    );
    expect(row.replace(/\x1b\[[0-9;]*m/g, "")).toBe("TASKS  3 shown      ");
    expect(row.startsWith("\x1b[1mTASKS\x1b[0m")).toBe(true);
    const cut = paint(none, [seg("text@panel", "a very long title that will not fit")], 10, "text@panel");
    expect(cut.replace(/\x1b\[[0-9;]*m/g, "")).toBe("a very lo…");
    expect(paint(none, [seg("text@panel", "x"), seg("text@panel", "never")], 1, "text@panel")).toBe("x");
    const dark = resolveTheme(input());
    expect(paint(dark, [], 3, "text@panel")).toBe(style(dark, "text@panel", "   "));
  });
});

// The unfocused pane (plan @400 follow-up, N23): painted through a variant
// of the session theme whose every foreground is the `inactive` grey (an
// indicator-class token: readable, >= 3:1), never bold, and SGR dim where
// there is no color to grey (`none`, `default` values). Surfaces stay, so
// the selected row keeps its highlight; search matches show on `raised`.
describe("the inactive (unfocused) pane", () => {
  const SURFACES = ["bg", "panel", "raised", "selection"] as const;

  test("inactive is an indicator token on every pane surface; high-contrast themes keep it at 4.5:1", () => {
    for (const surface of SURFACES) {
      expect(CONTRAST_PAIRS[`inactive@${surface}` as ContrastPair]?.kind, surface).toBe("indicator");
    }
    for (const name of ["high-contrast-dark", "high-contrast-light"] as const) {
      const c = BUNDLED_THEMES[name].colors;
      for (const surface of SURFACES) {
        expect(contrastRatio(c.inactive, c[surface]), `${name} inactive@${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(BUNDLED_THEMES.ansi.colors.inactive).toBe("default");
  });

  test("inactiveTheme greys every foreground, keeps the surfaces (search shows as raised) and is memoized", () => {
    const dark = resolveTheme(input());
    const dim = inactiveTheme(dark);
    expect(dim.inactive).toBe(true);
    expect(inactiveTheme(dark)).toBe(dim);
    expect(inactiveTheme(dim)).toBe(dim);
    for (const token of THEME_TOKENS) {
      const kept = ["bg", "panel", "raised", "selection", "border"].includes(token);
      const expected = token === "search" ? dark.colors.raised : kept ? dark.colors[token] : dark.colors.inactive;
      expect(dim.colors[token], token).toBe(expected);
    }
    expect(dim.name).toBe(dark.name);
    expect(dim.mode).toBe(dark.mode);
  });

  // Everything painted in an unfocused pane stays readable: every declared
  // pair, through the variant, reaches 3:1 in truecolor and 256 colors.
  for (const name of HEX_THEMES) {
    test(`${name}: every pair painted through the inactive variant is at least 3:1`, () => {
      const dim = inactiveTheme(resolveTheme(input({ cli: name })));
      const failures: string[] = [];
      for (const pair of PAIRS) {
        const { fg, surface, kind } = CONTRAST_PAIRS[pair];
        if (kind === "decorative") continue;
        const a = dim.colors[fg];
        const b = dim.colors[surface];
        const tc = contrastRatio(a, b);
        const mapped = contrastRatio(xterm256Hex(to256(a)), xterm256Hex(to256(b)));
        if (tc < 3) failures.push(`${pair} truecolor ${tc.toFixed(2)}`);
        if (mapped < 3) failures.push(`${pair} 256-color ${mapped.toFixed(2)}`);
      }
      expect(failures).toEqual([]);
    });
  }

  test("style() through the variant: the grey in color, never bold, and SGR dim without color", () => {
    const dark = resolveTheme(input({ cli: "cortex-dark" }));
    const grey = [1, 3, 5].map(i => Number.parseInt(dark.colors.inactive.slice(i, i + 2), 16)).join(";");
    expect(style(inactiveTheme(dark), "accent@panel", "TASKS", { bold: true })).toBe(
      `\x1b[38;2;${grey};48;2;${[1, 3, 5].map(i => Number.parseInt(dark.colors.panel.slice(i, i + 2), 16)).join(";")}mTASKS\x1b[0m`,
    );
    const none = inactiveTheme(resolveTheme(input({ env: { NO_COLOR: "1" } })));
    expect(style(none, "text@panel", "row")).toBe("\x1b[2mrow\x1b[0m");
    expect(style(none, "accent@panel", "TASKS", { bold: true })).toBe("\x1b[2mTASKS\x1b[0m");
    expect(style(none, "text@selection", "sel")).toBe("\x1b[2;7msel\x1b[0m");
    const ansi = inactiveTheme(resolveTheme(input({ cli: "ansi" })));
    expect(style(ansi, "status.blocked@bg", "x")).toBe("\x1b[39;49;2mx\x1b[0m");
  });

  test("a custom theme without `inactive` derives it from `dim` (older complete themes keep loading)", () => {
    const complete = THEME_TOKENS.filter(t => t !== "inactive")
      .map(t => {
        const [table, key] = t.includes(".") ? t.split(".") : [null, t];
        const value = BUNDLED_THEMES["cortex-dark"].colors[t];
        return table ? `${table}.${key} = "${value}"` : `${key} = "${value}"`;
      })
      .join("\n");
    fs.writeFileSync(path.join(dir, "older.toml"), complete);
    const r = resolveTheme(input({ cli: "older" }));
    expect(r.name).toBe("older");
    expect(r.colors.inactive).toBe(BUNDLED_THEMES["cortex-dark"].colors.dim);
    expect(r.problems.filter(p => p.severity === "error")).toEqual([]);
  });
});
