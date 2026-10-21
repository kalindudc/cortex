// PaperLayer — the paper behind a sheet or a card, drawn by base.css. Put it
// first inside an element with the paper-host class. `card` gives the
// smaller lift of a card; `dots` adds the dot grid of the document and the
// full panels.

import type { VNode } from "preact";

export function PaperLayer({ card = false, dots = false }: { card?: boolean; dots?: boolean }): VNode {
  const cls = `paper-layer${card ? " is-card" : ""}${dots ? " is-dotted" : ""}`;
  return <div class={cls} aria-hidden="true" />;
}
