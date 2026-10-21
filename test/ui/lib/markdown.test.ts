// lib/markdown.ts — string-level pipeline tests.
//
// DOMPurify is BROKEN under happy-dom (it passes <script> through and
// strips block tags), so these tests mock it with a recording passthrough:
// they pin the PIPELINE (escaped mermaid fence text, sanitizer invocation
// with the intended profile, fail-closed behavior, the mermaid node-state
// contract), not the scrubbing. Scrubbing is certified in real Chromium by
// integrations/desktop/test/document-safety.test.ts.

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

interface SanitizeCall {
  html: string;
  config: Record<string, unknown> | undefined;
}
const sanitizeCalls: SanitizeCall[] = [];
const purifyCtrl = { supported: true };

mock.module("dompurify", () => ({
  default: {
    get isSupported() {
      return purifyCtrl.supported;
    },
    sanitize: (html: string, config?: Record<string, unknown>) => {
      sanitizeCalls.push({ html, config });
      return html;
    },
    addHook: () => {},
    removeHook: () => {},
  },
}));

import {
  renderMarkdown,
  runMermaid,
  resetMermaidNode,
  MarkdownUnsupportedError,
  resolveHeadingId,
  mermaidConfig,
  mermaidThemeKey,
  readMermaidTokens,
  solidColour,
  waitForFont,
  HAND_DRAWN_SEED,
  type MermaidTokens,
} from "../../../src/ui/lib/markdown.ts";

// Restores <html>'s theme attributes and inline token overrides after a test.
function keepRootState(): void {
  const root = document.documentElement;
  let saved: { theme?: string; contrast?: string; style: string };
  beforeEach(() => {
    saved = { theme: root.dataset.theme, contrast: root.dataset.contrast, style: root.getAttribute("style") ?? "" };
  });
  afterEach(() => {
    for (const [key, value] of [
      ["theme", saved.theme],
      ["contrast", saved.contrast],
    ] as const) {
      if (value === undefined) delete root.dataset[key];
      else root.dataset[key] = value;
    }
    root.setAttribute("style", saved.style);
  });
}

const PAPER: MermaidTokens = {
  sheet: "#fbf8f1",
  text: "#2a251e",
  text3: "#7b7161",
  fontSerif: '"Literata", "Iowan Old Style", Georgia, serif',
};

describe("renderMarkdown", () => {
  beforeEach(() => {
    sanitizeCalls.length = 0;
    purifyCtrl.supported = true;
  });

  test("mermaid fence text is HTML-escaped inside pre.mermaid (M1)", () => {
    const html = renderMarkdown("```mermaid\ngraph TD; A-->B; C<D & E\n```");
    expect(html).toContain('<pre class="mermaid">');
    // Raw arrows/angle brackets/ampersands are entity-escaped…
    expect(html).toContain("A--&gt;B");
    expect(html).toContain("C&lt;D &amp; E");
    // …and the raw forms never appear inside the fence output.
    expect(html).not.toContain("A-->B");
  });

  test("mermaid fence cannot break out of its pre element", () => {
    const html = renderMarkdown("```mermaid\n</pre><img src=x onerror=alert(1)>\n```");
    expect(html).not.toContain("</pre><img");
    expect(html).toContain("&lt;/pre&gt;");
  });

  test("non-mermaid fences fall through to marked's default escaped renderer", () => {
    const html = renderMarkdown('```ts\nconst a = "<b>";\n```');
    expect(html).toContain('<pre><code class="language-ts">');
    expect(html).toContain("&lt;b&gt;");
  });

  test("output is routed through the sanitizer with the HTML profile (M1)", () => {
    renderMarkdown("# Hello");
    expect(sanitizeCalls.length).toBe(1);
    const config = sanitizeCalls[0].config as Record<string, unknown>;
    expect(config.USE_PROFILES).toEqual({ html: true });
    expect(config.SANITIZE_NAMED_PROPS).toBe(true);
    expect(config.ALLOW_DATA_ATTR).toBe(false);
    const forbidden = config.FORBID_TAGS as string[];
    for (const tag of ["style", "script", "iframe", "object", "form", "button", "textarea", "select", "svg", "math"]) {
      expect(forbidden).toContain(tag);
    }
    expect(config.FORBID_ATTR).toContain("style");
    expect(config.ALLOWED_URI_REGEXP).toBeInstanceOf(RegExp);
  });

  test("URI allow-list accepts http(s)/mailto/relative and rejects executable schemes", () => {
    renderMarkdown("x");
    const re = (sanitizeCalls[0].config as Record<string, unknown>).ALLOWED_URI_REGEXP as RegExp;
    for (const ok of [
      "https://example.com",
      "http://localhost:4711/x",
      "mailto:a@b.c",
      "/relative",
      "./rel",
      "#frag",
      "?q=1",
      "task-330",
    ]) {
      expect(re.test(ok)).toBe(true);
    }
    for (const bad of [
      "javascript:alert(1)",
      "JAVASCRIPT:alert(1)",
      "data:text/html;base64,x",
      "vbscript:x",
      "file:///etc/passwd",
      "blob:http://x/y",
    ]) {
      expect(re.test(bad)).toBe(false);
    }
  });

  test("fails closed with MarkdownUnsupportedError when the sanitizer is unsupported (M2)", () => {
    purifyCtrl.supported = false;
    expect(() => renderMarkdown("# x")).toThrow(MarkdownUnsupportedError);
    expect(sanitizeCalls.length).toBe(0); // never reached the sanitizer
  });

  test("GFM structure renders (headings, task lists, tables)", () => {
    const html = renderMarkdown("# H\n\n- [x] done item\n\n| a | b |\n| - | - |\n| 1 | 2 |");
    expect(html).toContain("<h1>");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("<table>");
  });
});

describe("runMermaid", () => {
  test("resolves immediately for a root without diagrams (source-only: no module load)", async () => {
    const root = document.createElement("div");
    root.innerHTML = "<p>plain</p><pre><code>code</code></pre>";
    // A module-load attempt would reject under bun/happy-dom — resolving
    // proves the early return fired before any import happened.
    await runMermaid(root);
    expect(root.querySelector("pre.mermaid")).toBeNull();
  });

  test("skips diagrams already rendered for the active theme", async () => {
    const root = document.createElement("div");
    root.innerHTML = '<pre class="mermaid" data-mermaid-state="done">svg here</pre>';
    const node = root.querySelector<HTMLElement>("pre.mermaid");
    if (!node) throw new Error("expected node");
    node.dataset.mermaidTheme = mermaidThemeKey();
    await runMermaid(root); // no pending work → resolves without module load
    expect(node.dataset.mermaidState).toBe("done");
  });

  describe("palette changes", () => {
    keepRootState();

    test("a diagram rendered for another palette is rendered again", async () => {
      document.documentElement.dataset.theme = "dark";
      document.documentElement.dataset.contrast = "high";
      const root = document.createElement("div");
      root.innerHTML = '<pre class="mermaid" data-mermaid-state="done" data-mermaid-theme="dark">svg here</pre>';
      // Stale for high contrast: the run tries to load the module, which cannot load here.
      await expect(runMermaid(root)).rejects.toBeDefined();
      root.querySelector<HTMLElement>("pre.mermaid")?.setAttribute("data-mermaid-theme", "high-contrast");
      await runMermaid(root); // current again: no module load
    });
  });

  test("error-state diagrams wait for explicit retry (not re-attempted automatically)", async () => {
    const root = document.createElement("div");
    root.innerHTML = '<pre class="mermaid" data-mermaid-state="error" data-mermaid-error="boom">graph TD;</pre>';
    await runMermaid(root); // error nodes are not pending → no module load
    const node = root.querySelector<HTMLElement>("pre.mermaid");
    expect(node?.dataset.mermaidState).toBe("error");
  });

  test("selects only pre.mermaid and resolves void", async () => {
    const root = document.createElement("div");
    root.innerHTML = '<div class="mermaid">graph TD;</div><code class="mermaid">graph TD;</code>';
    expect(await runMermaid(root)).toBeUndefined();
  });

  test("resetMermaidNode returns a failed node to its source and makes it pending again", async () => {
    const root = document.createElement("div");
    root.innerHTML = '<pre class="mermaid" data-mermaid-state="error" data-mermaid-error="boom">shown</pre>';
    const node = root.querySelector<HTMLElement>("pre.mermaid");
    if (!node) throw new Error("expected node");
    node.dataset.mermaidSource = "graph TD; A-->B";
    resetMermaidNode(node);
    expect(node.textContent).toBe("graph TD; A-->B");
    expect(node.dataset.mermaidState).toBeUndefined();
    expect(node.dataset.mermaidError).toBeUndefined();
    // Pending again: the run now tries to load the module, which cannot load here.
    await expect(runMermaid(root)).rejects.toBeDefined();
  });
});

describe("mermaid config", () => {
  test("draws hand-drawn with a fixed seed on the base theme", () => {
    const config = mermaidConfig("light", PAPER);
    expect(config.look).toBe("handDrawn");
    expect(config.handDrawnSeed).toBe(HAND_DRAWN_SEED);
    expect(typeof HAND_DRAWN_SEED).toBe("number");
    expect(mermaidConfig("dark", PAPER).handDrawnSeed).toBe(HAND_DRAWN_SEED);
    expect(config.theme).toBe("base");
  });

  test("keeps the strict security settings", () => {
    const config = mermaidConfig("light", PAPER);
    expect(config.startOnLoad).toBe(false);
    expect(config.securityLevel).toBe("strict");
    expect(config.htmlLabels).toBe(false);
    expect(config.flowchart?.htmlLabels).toBe(false);
  });

  test("takes its colours and fonts from the tokens", () => {
    const config = mermaidConfig("light", PAPER);
    expect(config.themeVariables).toEqual({
      darkMode: false,
      background: "#fbf8f1",
      primaryColor: "#fbf8f1",
      secondaryColor: "#fbf8f1",
      tertiaryColor: "#fbf8f1",
      edgeLabelBackground: "#fbf8f1",
      primaryBorderColor: "#7b7161",
      secondaryBorderColor: "#7b7161",
      lineColor: "#7b7161",
      primaryTextColor: "#2a251e",
      textColor: "#2a251e",
      titleColor: "#2a251e",
      fontFamily: PAPER.fontSerif,
      fontSize: "15px",
    });
    expect(config.fontFamily).toBe(PAPER.fontSerif);
    expect(mermaidConfig("dark", PAPER).themeVariables.darkMode).toBe(true);
    expect(mermaidConfig("high-contrast", PAPER).themeVariables.darkMode).toBe(true);
  });

  test("converts rgba tokens to solid colours on the sheet", () => {
    const config = mermaidConfig("light", {
      ...PAPER,
      sheet: "rgb(255, 255, 255)",
      text: "rgba(0, 0, 0, 0.5)",
      text3: "rgb(0 0 0 / 25%)",
    });
    expect(config.themeVariables.primaryColor).toBe("#ffffff");
    expect(config.themeVariables.textColor).toBe("#808080");
    expect(config.themeVariables.lineColor).toBe("#bfbfbf");
    expect(JSON.stringify(config.themeVariables)).not.toMatch(/rgba?\(|var\(/);
  });

  test("solidColour leaves hex alone and drops alpha without a backdrop", () => {
    expect(solidColour(" #2a251e ")).toBe("#2a251e");
    expect(solidColour("rgba(70, 55, 35, 0.13)")).toBe("#463723");
    expect(solidColour("rgba(70, 55, 35, 0.13)", "#fbf8f1")).toBe("#e3dfd6");
  });

  test("protects the look, seed, theme, colours and fonts from in-diagram directives", () => {
    const secure = mermaidConfig("light", PAPER).secure ?? [];
    for (const key of [
      "secure",
      "securityLevel",
      "startOnLoad",
      "maxTextSize",
      "htmlLabels",
      "look",
      "handDrawnSeed",
      "theme",
      "themeCSS",
      "themeVariables",
      "fontFamily",
    ]) {
      expect(secure).toContain(key);
    }
  });

  test("real Mermaid ignores init directives and front matter that set them", async () => {
    const { default: mermaid } = await import("mermaid");
    mermaid.initialize(mermaidConfig("light", PAPER));
    await mermaid.parse(
      [
        "---",
        "config:",
        "  look: classic",
        "  handDrawnSeed: 99",
        "  theme: dark",
        "  fontFamily: Papyrus",
        "  themeVariables:",
        "    primaryColor: '#ff0000'",
        "---",
        "%%{init: {'look': 'neo', 'handDrawnSeed': 7, 'theme': 'forest', 'fontFamily': 'Papyrus', 'themeVariables': {'lineColor': '#00ff00', 'fontFamily': 'Papyrus'}}}%%",
        "graph LR; A-->B",
      ].join("\n"),
    );
    const config = mermaid.mermaidAPI.getConfig();
    expect(config.look).toBe("handDrawn");
    expect(config.handDrawnSeed).toBe(HAND_DRAWN_SEED);
    expect(config.theme).toBe("base");
    expect(config.fontFamily).toBe(PAPER.fontSerif);
    expect(config.themeVariables.fontFamily).toBe(PAPER.fontSerif);
    expect(config.themeVariables.primaryColor).toBe(PAPER.sheet);
    expect(config.themeVariables.lineColor).toBe(PAPER.text3);
  });
});

describe("mermaid palette", () => {
  keepRootState();

  test("the theme key differs between light, dark and high contrast", () => {
    const root = document.documentElement;
    delete root.dataset.contrast;
    root.dataset.theme = "light";
    const light = mermaidThemeKey();
    root.dataset.theme = "dark";
    const dark = mermaidThemeKey();
    root.dataset.contrast = "high";
    const high = mermaidThemeKey();
    expect(new Set([light, dark, high]).size).toBe(3);
    expect([light, dark, high]).toEqual(["light", "dark", "high-contrast"]);
  });

  test("tokens are read resolved from the root element", () => {
    const root = document.documentElement;
    root.style.setProperty("--sheet", "#000000");
    root.style.setProperty("--text", " #ffffff");
    root.style.setProperty("--text-3", "#c8c8c8");
    root.style.setProperty("--font-serif", '"Literata", Georgia, serif');
    expect(readMermaidTokens()).toEqual({
      sheet: "#000000",
      text: "#ffffff",
      text3: "#c8c8c8",
      fontSerif: '"Literata", Georgia, serif',
    });
  });
});

describe("waitForFont", () => {
  test("waits for the font to load", async () => {
    const loads: string[] = [];
    let loaded = false;
    const fonts = {
      load: async (font: string) => {
        loads.push(font);
        await new Promise(r => setTimeout(r, 5));
        loaded = true;
        return [];
      },
    };
    await waitForFont(fonts, "15px Literata", 1000);
    expect(loads).toEqual(["15px Literata"]);
    expect(loaded).toBe(true);
  });

  test("gives up after the timeout when the font never loads", async () => {
    const start = performance.now();
    await waitForFont({ load: () => new Promise<FontFace[]>(() => {}) }, "15px Literata", 30);
    expect(performance.now() - start).toBeGreaterThanOrEqual(25);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  test("resolves when the load fails or there is no font set", async () => {
    await waitForFont({ load: () => Promise.reject(new Error("no font")) }, "15px Literata", 1000);
    await waitForFont(
      {
        load: () => {
          throw new Error("bad font string");
        },
      },
      "15px Literata",
      1000,
    );
    await waitForFont(undefined, "15px Literata", 1000);
  });
});

describe("resolveHeadingId", () => {
  const ids = ["task-5-intro", "task-5-beta", "task-5-beta-2"];
  test("accepts the bare slug, including a repeat suffix", () => {
    expect(resolveHeadingId(ids, 5, "beta-2")).toBe("task-5-beta-2");
    expect(resolveHeadingId(ids, 5, "beta")).toBe("task-5-beta");
  });
  test("accepts the full anchor, case-insensitively and with a leading #", () => {
    expect(resolveHeadingId(ids, 5, "#TASK-5-BETA")).toBe("task-5-beta");
    expect(resolveHeadingId(ids, 5, " task-5-intro ")).toBe("task-5-intro");
  });
  test("returns null for an unknown or empty fragment", () => {
    expect(resolveHeadingId(ids, 5, "nope")).toBeNull();
    expect(resolveHeadingId(ids, 5, "#")).toBeNull();
    expect(resolveHeadingId(ids, 6, "beta")).toBeNull();
  });
});
