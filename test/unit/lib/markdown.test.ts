// lib/markdown.ts — string-level pipeline tests.
//
// DOMPurify is BROKEN under happy-dom (it passes <script> through and
// strips block tags — the "happy-dom limitation" in the plan's verification
// notes), so these tests mock it with a recording passthrough: they assert
// the PIPELINE (escaped mermaid fence text, sanitizer invocation with the
// intended profile, fail-closed behavior) — actual scrubbing is verified
// in real Chromium by test/e2e/document-safety.spec.ts (task 330 gate).

import { describe, test, expect, mock, beforeEach } from "bun:test";

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

import { renderMarkdown, runMermaid, MarkdownUnsupportedError } from "../../../src/ui/lib/markdown.ts";

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
    node.dataset.mermaidTheme = document.documentElement.dataset.theme === "dark" ? "dark" : "default";
    await runMermaid(root); // no pending work → resolves without module load
    expect(node.dataset.mermaidState).toBe("done");
  });

  test("error-state diagrams wait for explicit retry (not re-attempted automatically)", async () => {
    const root = document.createElement("div");
    root.innerHTML = '<pre class="mermaid" data-mermaid-state="error" data-mermaid-error="boom">graph TD;</pre>';
    await runMermaid(root); // error nodes are not pending → no module load
    const node = root.querySelector<HTMLElement>("pre.mermaid");
    expect(node?.dataset.mermaidState).toBe("error");
  });
});
