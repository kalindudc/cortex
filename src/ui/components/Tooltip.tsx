// Tooltip — top-level Preact component for the cortex dashboard.
//
// The data + listener half (signal, tip() helper, positioning math, global
// window listeners) lives in src/ui/state/tooltip.ts. This file is just the
// singleton DOM node.
//
// Mount once, anywhere in the App tree. The element is always in the DOM so
// the CSS opacity transition can animate both enter and exit; visibility is
// driven by the .tooltip-visible class. Position recompute runs after every
// render via useEffect because we need the tip's measured size to flip.

import type { VNode } from "preact";
import { useEffect, useRef } from "preact/hooks";

import { tooltipState, placeTooltip } from "../state/tooltip.ts";

export function Tooltip(): VNode {
  const ref = useRef<HTMLDivElement>(null);
  const s = tooltipState.value;

  useEffect(() => {
    const el = ref.current;
    if (!el || !s.visible || !s.anchor) return;
    placeTooltip(el, s.anchor, s.placement);
  });

  return (
    <div
      ref={ref}
      class={"tooltip" + (s.visible ? " tooltip-visible" : "")}
      role="tooltip"
      aria-hidden={s.visible ? "false" : "true"}
    >
      {s.text}
    </div>
  );
}
