// Markdown rendering helper for the RenderMarkdownModal.
//
// Owns the `marked` configuration, the lazy mermaid-load promise, and the
// post-mount `mermaid.run` call. No DOM imports at the module top level so
// the file is safe to import from anywhere — DOM access lives only inside
// `runMermaid`.
//
// Mermaid is loaded as a SEPARATE bundle (out/mermaid.js, served at
// /mermaid.js by src/server.ts) on first call to `runMermaid`. This keeps
// mermaid out of the main bundle.js cost.

import { marked } from "marked";

// Module-level state.
//
// `configured` guards a one-time `marked.use({...})` call so each render
// doesn't re-register the renderer overrides.
//
// `mermaidPromise` is shared across opens so concurrent first-opens share
// one network fetch + one parse cost. `null` means "not yet started".
let configured = false;
let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;

function configureOnce(): void {
  if (configured) return;
  configured = true;
  marked.use({
    gfm: true,
    breaks: false,
    renderer: {
      // v15 renderer signature: token object, NOT positional (code, lang).
      // Returning `false` falls through to marked's default renderer.
      // For mermaid fences we emit `<pre class="mermaid">${text}</pre>` —
      // text is emitted VERBATIM (no HTML-escape pass) because mermaid's
      // parser needs raw `-->`, `<`, `&`. The threat model accepts this:
      // cortex is single-user, localhost-only, no auth (AGENTS.md §1).
      code({ text, lang }) {
        if (lang === "mermaid") {
          return `<pre class="mermaid">${text}</pre>`;
        }
        return false;
      },
    },
  });
}

function detectTheme(): "dark" | "default" {
  // Reads the document-level theme attribute that state/theme.ts toggles.
  // Mermaid's `theme` option accepts "default" | "dark" | "forest" | etc.;
  // we only differentiate dark vs default here — KISS.
  if (typeof document === "undefined") return "default";
  return document.documentElement.dataset.theme === "dark" ? "dark" : "default";
}

/**
 * Render a markdown string to HTML.
 *
 * Synchronous (marked.parse with `async: false` defaults). Mermaid code
 * fences are passed through verbatim inside `<pre class="mermaid">` —
 * `runMermaid` then converts them to SVG after the HTML is in the DOM.
 *
 * No DOMPurify; raw inline HTML in the body renders verbatim. See header.
 */
export function renderMarkdown(md: string): string {
  configureOnce();
  return marked.parse(md) as string;
}

/**
 * Convert any `<pre class="mermaid">` blocks inside `root` to SVG.
 *
 * On first call, fetches /mermaid.js (the lazy chunk emitted by the
 * `pnpm run ui:build` second `bun build` invocation). Subsequent calls
 * reuse the cached module. Mermaid's `initialize` is called every
 * invocation — it's idempotent and accepts re-config, so reopening the
 * modal after a theme toggle picks up the new theme without any
 * theme-change observer wiring.
 *
 * Wrapped in try/catch so any failure (network, parse, runtime) does not
 * propagate — `suppressErrors: true` already replaces bad diagrams with
 * mermaid's own error SVG, which is desirable feedback in the modal.
 */
export async function runMermaid(root: HTMLElement): Promise<void> {
  try {
    if (!mermaidPromise) {
      // Dynamic-import target is the BROWSER URL `/mermaid.js`, NOT the
      // npm specifier `"mermaid"` — the latter would inline the module
      // back into bundle.js and defeat the lazy split. We build the URL
      // via `new URL(...)` so Bun's bundler cannot statically resolve
      // the import target at build time (a bare literal triggers
      // "Could not resolve: /mermaid.js"). At runtime the URL is just
      // the browser-served `/mermaid.js` route registered in src/server.ts.
      const url = new URL("/mermaid.js", document.baseURI).href;
      mermaidPromise = import(url).then((mod: { default: typeof import("mermaid").default }) => mod.default);
    }
    const mermaid = await mermaidPromise;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: detectTheme(),
    });
    const nodes = root.querySelectorAll<HTMLElement>(".mermaid");
    if (nodes.length === 0) return;
    await mermaid.run({ nodes: Array.from(nodes), suppressErrors: true });
  } catch {
    // Mermaid failed to load or run; leave the verbatim `.mermaid` text in
    // place — the user still sees the diagram source rather than nothing.
  }
}
