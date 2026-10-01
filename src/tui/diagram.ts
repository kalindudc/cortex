// The one seam to the Mermaid renderer (lovely-mermaid): no other module
// imports it, so swapping the renderer touches only this file.
//
// - Escape in: the source passes through escapeTerminalLines BEFORE layout,
//   so controls are already visible text (ESC → `^[`) and tabs are expanded
//   when the renderer measures labels; boxes are sized to what is shown.
// - Escape out: every span passes through escapeTerminalText again. For
//   printable text that is a no-op (alignment holds); it is defense in depth
//   should the renderer ever emit something we did not give it.
// - Roles map to existing raised theme pairs (the code panel's surface), so
//   custom themes keep working with no new tokens.
// - Diagram links (`click`/`link`) and author colors (`classDef`, classes)
//   are dropped: links reach the terminal only through the reader's safeUrl
//   path, and author colors could break the theme's contrast.
// - Width is measured here with displayWidth, never taken from the renderer:
//   cortex decides what fits its pane.

import { type Role, render } from "lovely-mermaid";
import { displayWidth, escapeTerminalLines, escapeTerminalText } from "./safety.ts";
import type { ContrastPair } from "./theme.ts";

/** One themed run of a diagram row; `text` is escaped. */
export interface DiagramRun {
  readonly text: string;
  readonly pair: ContrastPair;
}

/** A Mermaid diagram drawn as text art. */
export interface Diagram {
  /** Right-trimmed rows, blank filler included. */
  readonly rows: readonly (readonly DiagramRun[])[];
  /** The widest row in terminal cells, by displayWidth. */
  readonly width: number;
  /** Some source could not be read (or a size cap cut it): the art is real but incomplete. */
  readonly partial: boolean;
}

const PAIRS: Readonly<Record<Role, ContrastPair>> = {
  border: "border@raised",
  text: "text@raised",
  edge: "accent@raised",
  edgeLabel: "muted@raised",
  title: "muted@raised",
  none: "text@raised",
};

/** Draw a Mermaid block, or null when it cannot be drawn (the reader then shows its source). */
export function drawMermaid(source: string): Diagram | null {
  let art: ReturnType<typeof render>;
  try {
    art = render(escapeTerminalLines(source).join("\n"));
  } catch {
    // A renderer bug on untrusted text must never take the workspace down;
    // the fallback is visible, since the reader then captions the source panel.
    return null;
  }
  if (art === null || art.styled.length === 0) return null;
  const rows = art.styled.map(spans =>
    spans
      .filter(span => span.text !== "")
      .map(span => ({ text: escapeTerminalText(span.text), pair: PAIRS[span.role] })),
  );
  const width = Math.max(0, ...rows.map(row => displayWidth(row.map(run => run.text).join(""))));
  return { rows, width, partial: art.warnings.length > 0 };
}
