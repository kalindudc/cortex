// MarkdownView — THE shared rendered-Markdown surface.
//
// Consumed by task reading (TaskDocument), expanded update bodies in the
// Activity view (ActivityPane) and the legacy modal viewers. Owns a generation-scoped DOM
// lifecycle over lib/markdown.ts:
//
//   1. renderMarkdown(source) → sanitized HTML string (fails closed: a
//      MarkdownUnsupportedError renders an explicit error + raw-source
//      view, never unsanitized HTML).
//   2. Post-processing via DOM APIs (validated attributes + text nodes —
//      never string-concatenated HTML after sanitizing):
//        - stable namespaced unique heading ids (`${idPrefix}-<slug>`),
//          reported through onHeadings for outline consumers;
//        - per-code-block copy controls (clipboard failures are visible);
//        - defensive input tightening (only disabled checkboxes survive);
//        - table overflow wrappers (local scroll, not page scroll);
//        - @id / #tag reference decoration through parseRefs/navigateRef,
//          applied ONLY to prose text nodes (never inside code, links,
//          pre, or SVG). A surface outside the workspace (the rich draft
//          preview) injects `onRef` instead, so following a reference there
//          never touches the workspace's selection/filter singletons.
//   3. runMermaid(host, isCurrent) — sanitized SVG commits gated by the
//      render generation; failures keep the source visible with an
//      explicit error + retry affordance. Source-only documents never
//      trigger a mermaid load.
//
// Re-renders happen ONLY when `source`/`idPrefix` change — unrelated
// signal churn (SSE metadata, theme, panel switches) must not rebuild the
// Markdown DOM. Theme changes only re-run mermaid (stale-theme nodes).

import type { VNode } from "preact";
import { useEffect, useMemo, useRef } from "preact/hooks";
import { renderMarkdown, runMermaid, resetMermaidNode } from "../../lib/markdown.ts";
import { parseRefs } from "../../lib/refs.ts";
import { navigateRef } from "../../lib/refs.ts";
import { slugify } from "../../../lib/slug.ts";
import { appearance, theme } from "../../state/theme.ts";

export interface MarkdownHeading {
  id: string;
  text: string;
  level: number;
}

export interface MarkdownViewProps {
  source: string;
  idPrefix: string;
  onHeadings?: (headings: MarkdownHeading[]) => void;
  /** Follow an @id / #tag reference; default navigateRef (the workspace's selection and filters). */
  onRef?: (kind: "task" | "tag", value: string) => void;
}

// Elements whose text must NEVER be ref-decorated: code spans/blocks,
// existing links, SVG output and our own decorations.
const NON_PROSE = new Set(["CODE", "PRE", "A", "BUTTON", "SVG", "SCRIPT", "STYLE", "TEXTAREA"]);

function insideNonProse(node: Node, stopAt: HTMLElement): boolean {
  for (let el = node.parentElement; el != null && el !== stopAt; el = el.parentElement) {
    if (NON_PROSE.has(el.tagName)) return true;
  }
  return false;
}

// Decorate @id / #tag references in prose text nodes with focusable ref
// buttons. Text-node splitting via DOM APIs only.
function decorateRefs(host: HTMLElement): void {
  const doc = host.ownerDocument;
  const walker = doc.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  for (let n = walker.nextNode(); n != null; n = walker.nextNode()) {
    textNodes.push(n as Text);
  }
  for (const textNode of textNodes) {
    const value = textNode.nodeValue ?? "";
    if (!value.includes("@") && !value.includes("#")) continue;
    if (insideNonProse(textNode, host)) continue;
    const segments = parseRefs(value);
    if (!segments.some(s => s.kind !== "text")) continue;
    const frag = doc.createDocumentFragment();
    for (const seg of segments) {
      if (seg.kind === "text") {
        frag.appendChild(doc.createTextNode(seg.text));
      } else {
        const btn = doc.createElement("button");
        btn.type = "button";
        btn.className = "md-ref";
        btn.dataset.refKind = seg.kind;
        btn.dataset.refValue = seg.kind === "task" ? String(seg.id) : seg.name;
        btn.textContent = seg.kind === "task" ? `@${seg.id}` : `#${seg.name}`;
        frag.appendChild(btn);
      }
    }
    textNode.parentNode?.replaceChild(frag, textNode);
  }
}

interface ProcessResult {
  headings: MarkdownHeading[];
}

// Post-process sanitized DOM: heading ids, copy controls, table wrappers,
// input tightening, ref decoration. All mutations are DOM-API writes with
// validated values.
function processHost(host: HTMLElement, idPrefix: string): ProcessResult {
  const doc = host.ownerDocument;

  // Defensive input tightening (the DOMPurify hook already enforces this
  // in production; enforce here too so the invariant survives any
  // sanitizer seam).
  for (const input of Array.from(host.querySelectorAll("input"))) {
    if ((input.getAttribute("type") ?? "").toLowerCase() !== "checkbox") input.remove();
    else input.setAttribute("disabled", "");
  }

  // Stable namespaced unique heading ids + outline collection.
  const headings: MarkdownHeading[] = [];
  const seen = new Map<string, number>();
  for (const h of Array.from(host.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"))) {
    const text = h.textContent ?? "";
    const base = `${idPrefix}-${slugify(text)}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    const id = count === 1 ? base : `${base}-${count}`;
    h.id = id;
    headings.push({ id, text, level: Number(h.tagName.slice(1)) });
  }

  // Copy control per non-mermaid code block. Wrapper div owns positioning;
  // the button lives OUTSIDE the code element so selection/copy of the
  // code text stays clean.
  for (const pre of Array.from(host.querySelectorAll<HTMLElement>("pre"))) {
    if (pre.classList.contains("mermaid")) continue;
    const wrap = doc.createElement("div");
    wrap.className = "md-codeblock";
    pre.parentNode?.replaceChild(wrap, pre);
    const bar = doc.createElement("div");
    bar.className = "md-codebar";
    const language = Array.from(pre.querySelector("code")?.classList ?? [])
      .find(name => name.startsWith("language-"))
      ?.slice(9);
    const caption = doc.createElement("span");
    caption.className = "md-code-language";
    // Captions use textContent, never HTML; unknown/long fence info is just
    // a generic Code label rather than untrusted UI markup.
    caption.textContent = language && /^[a-z0-9_+#.-]{1,24}$/i.test(language) ? language : "Code";
    bar.appendChild(caption);
    wrap.appendChild(bar);
    wrap.appendChild(pre);
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "md-copy";
    btn.textContent = "Copy";
    btn.setAttribute("aria-label", "Copy code to clipboard");
    bar.appendChild(btn);
  }

  // Local table overflow: wrap tables so wide content scrolls in place
  // instead of forcing page-level horizontal scroll.
  for (const table of Array.from(host.querySelectorAll<HTMLElement>("table"))) {
    const wrap = doc.createElement("div");
    wrap.className = "md-table-wrap";
    table.parentNode?.replaceChild(wrap, table);
    wrap.appendChild(table);
  }

  decorateRefs(host);
  return { headings };
}

// Append explicit error + retry affordances to failed mermaid nodes.
function decorateMermaidErrors(host: HTMLElement): void {
  for (const node of Array.from(host.querySelectorAll<HTMLElement>("pre.mermaid[data-mermaid-state='error']"))) {
    const wrap = node.parentElement;
    if (wrap?.classList.contains("md-mermaid-error")) continue; // already decorated
    const doc = host.ownerDocument;
    const box = doc.createElement("div");
    box.className = "md-mermaid-error";
    node.parentNode?.replaceChild(box, node);
    const notice = doc.createElement("div");
    notice.className = "md-mermaid-error-msg";
    notice.textContent = `Diagram failed to render: ${node.dataset.mermaidError ?? "unknown error"}`;
    const retry = doc.createElement("button");
    retry.type = "button";
    retry.className = "md-mermaid-retry";
    retry.textContent = "Retry diagram";
    box.appendChild(notice);
    box.appendChild(retry);
    box.appendChild(node);
  }
}

export function MarkdownView(props: MarkdownViewProps): VNode {
  const { source, idPrefix } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const genRef = useRef(0);
  // Latest callback without retriggering the DOM build (parents re-render
  // freely; the Markdown DOM must not rebuild unless source changes).
  const onHeadingsRef = useRef(props.onHeadings);
  onHeadingsRef.current = props.onHeadings;
  const onRefRef = useRef(props.onRef);
  onRefRef.current = props.onRef;

  // Sanitize on the RENDER path so the failure view and the host div swap
  // declaratively (fail closed on sanitizer errors). Memoized: unrelated
  // parent re-renders reuse the sanitized string untouched.
  const rendered = useMemo<{ html: string; error: null } | { html: null; error: string }>(() => {
    try {
      return { html: renderMarkdown(source), error: null };
    } catch (err) {
      return { html: null, error: err instanceof Error ? err.message : String(err) };
    }
  }, [source]);

  const runDiagrams = (host: HTMLElement, gen: number): void => {
    if (!host.querySelector("pre.mermaid")) return; // source-only: no mermaid load
    void runMermaid(host, () => gen === genRef.current)
      .catch((err: unknown) => {
        if (gen !== genRef.current) return;
        // Module-level failure: mark every untouched diagram so each gets
        // a visible error + retry.
        for (const node of Array.from(host.querySelectorAll<HTMLElement>("pre.mermaid:not([data-mermaid-state])"))) {
          node.dataset.mermaidState = "error";
          node.dataset.mermaidError = err instanceof Error ? err.message : String(err);
        }
      })
      .finally(() => {
        if (gen !== genRef.current) return;
        decorateMermaidErrors(host);
      });
  };

  // Build the DOM when the sanitized output or namespace changes — and
  // ONLY then.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || rendered.html == null) return;
    const gen = ++genRef.current;
    host.innerHTML = rendered.html; // sanitized — the ONLY HTML-string insertion
    const { headings } = processHost(host, idPrefix);
    onHeadingsRef.current?.(headings);
    runDiagrams(host, gen);
    return () => {
      // Invalidate pending async commits for this generation.
      genRef.current++;
    };
  }, [rendered, idPrefix]);

  // Palette flips re-run mermaid only; runMermaid itself skips diagrams
  // already rendered for the active palette. The appearance is a dependency
  // too: dark and high contrast share the resolved theme "dark".
  useEffect(() => {
    void theme.value; // subscribe
    void appearance.value;
    const host = hostRef.current;
    if (!host) return;
    runDiagrams(host, genRef.current);
  }, [theme.value, appearance.value]);

  // Event delegation for post-processed controls: ref navigation, code
  // copy (with VISIBLE failure), mermaid retry.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onClick = (e: MouseEvent): void => {
      const target = (e.target as HTMLElement).closest?.("button");
      if (!target || !host.contains(target)) return;
      if (target.classList.contains("md-ref")) {
        e.preventDefault();
        const kind = target.dataset.refKind === "task" ? "task" : "tag";
        (onRefRef.current ?? navigateRef)(kind, target.dataset.refValue ?? "");
        return;
      }
      if (target.classList.contains("md-copy")) {
        const code = target.closest(".md-codeblock")?.querySelector("code, pre");
        if (!code) {
          target.textContent = "Copy failed";
          return;
        }
        const text = code.textContent ?? "";
        const clip = navigator.clipboard;
        if (!clip || typeof clip.writeText !== "function") {
          target.textContent = "Copy failed"; // visible failure
          return;
        }
        clip
          .writeText(text)
          .then(() => {
            target.textContent = "Copied";
            setTimeout(() => {
              target.textContent = "Copy";
            }, 1500);
          })
          .catch(() => {
            target.textContent = "Copy failed"; // visible failure
          });
        return;
      }
      if (target.classList.contains("md-mermaid-retry")) {
        const box = target.closest<HTMLElement>(".md-mermaid-error");
        const node = box?.querySelector<HTMLElement>("pre.mermaid");
        if (box && node) {
          resetMermaidNode(node);
          box.parentNode?.replaceChild(node, box);
          runDiagrams(host, genRef.current);
        }
      }
    };
    host.addEventListener("click", onClick);
    return () => host.removeEventListener("click", onClick);
  }, []);

  if (rendered.error != null) {
    // Fail closed: explicit error + raw source, never unsanitized HTML.
    return (
      <div class="markdown-view markdown-view-failed">
        <p class="md-render-error" role="alert">
          Markdown could not be rendered safely: {rendered.error}
        </p>
        <pre class="md-source-fallback">{source}</pre>
      </div>
    );
  }
  return <div class="markdown-view" ref={hostRef}></div>;
}
