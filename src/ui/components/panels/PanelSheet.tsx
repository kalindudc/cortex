// PanelSheet — the one sheet a full panel's content lies on, as the document
// lies on the desk: a fixed frame whose PaperLayer paints the dotted paper,
// and .panel-body, the layer's only sibling, which scrolls. Content scrolls
// inside a still sheet and nothing that holds content sits under the
// layer's filter (base.css explains why).

import type { ComponentChildren, VNode } from "preact";

import { PaperLayer } from "../PaperLayer.tsx";

export function PanelSheet({ children }: { children: ComponentChildren }): VNode {
  return (
    <div class="panel-sheet paper-host">
      <PaperLayer dots />
      <div class="panel-body">{children}</div>
    </div>
  );
}
