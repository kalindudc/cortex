import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { type Diagram, drawMermaid } from "../../../src/tui/diagram.ts";

// The contract cortex relies on from its one Mermaid seam, not the exact art:
// a drawable block becomes escaped rows of themed runs measured by cortex,
// anything undrawable is null (the reader then shows the source), and a
// hostile label can never reach the terminal as a control sequence.

const CONTROLS = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/;

function rowText(diagram: Diagram): string[] {
  return diagram.rows.map(row => row.map(run => run.text).join(""));
}

function widest(diagram: Diagram): number {
  return Math.max(...rowText(diagram).map(row => visibleWidth(row)));
}

function draw(source: string): Diagram {
  const diagram = drawMermaid(source);
  if (diagram === null) throw new Error(`expected a diagram for ${JSON.stringify(source)}`);
  return diagram;
}

describe("drawMermaid", () => {
  test("a flowchart draws as rows whose width cortex measures", () => {
    const diagram = draw("graph TD; A[Alpha]-->B[Beta];");
    expect(rowText(diagram).some(row => row.includes("│ Alpha │"))).toBe(true);
    expect(diagram.width).toBe(widest(diagram));
    expect(diagram.partial).toBe(false);
  });

  test("blank input, an unsupported type and source that parses to nothing are null", () => {
    expect(drawMermaid("")).toBeNull();
    expect(drawMermaid("gantt\n  title Plan\n  section A\n  t1 :a1, 2024-01-01, 3d")).toBeNull();
    expect(drawMermaid("graph TD\n  !!! ??? ###")).toBeNull();
  });

  test("a partly parsed diagram is drawn and marked partial", () => {
    expect(draw("graph TD\n  A[Start --> B").partial).toBe(true);
  });

  test("renderer roles map to existing raised theme pairs", () => {
    const runs = draw("graph TD\n  A[Alpha] -->|yes| B[Beta]").rows.flat();
    const pairOf = (needle: string) => runs.find(run => run.text.includes(needle))?.pair;
    expect(pairOf("Alpha")).toBe("text@raised");
    expect(pairOf("▼")).toBe("accent@raised");
    expect(pairOf("┌")).toBe("border@raised");
    expect(pairOf("yes")).toBe("muted@raised");
  });

  test("hostile labels stay visible text; links and author classes never reach a run", () => {
    const diagram = draw(
      [
        "graph TD",
        '  A["x \x1b]52;c;SGVsbG8=\x07 \x9b31m"] --> B',
        '  click A "https://evil.example"',
        "  classDef hot fill:#f00",
        "  class A hot",
      ].join("\n"),
    );
    const rows = rowText(diagram);
    for (const row of rows) expect(row).not.toMatch(CONTROLS);
    expect(rows.some(row => row.includes("^["))).toBe(true);
    for (const run of diagram.rows.flat()) expect(Object.keys(run).sort()).toEqual(["pair", "text"]);
  });

  test("width holds for ZWJ emoji, flags and CJK labels", () => {
    const diagram = draw('graph LR\n  A["👨‍👩‍👧 family"] --> B["🇨🇦 flag"] --> C["中文"]');
    expect(diagram.width).toBe(widest(diagram));
  });
});
