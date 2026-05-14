// state/tooltip.ts — Singleton tooltip data + global listeners.
//
// Owns the `tooltipState` signal, the `tip()` event-prop helper used by every
// trigger, the file-local positioning math (showTip/hideTip/computePosition/
// fits/placeTooltip), and the module-load global window listeners (scroll/
// resize/Esc) that hide the tip when the anchor coordinates would go stale.
//
// The `<Tooltip/>` Preact component itself lives in src/ui/components/Tooltip.tsx and
// reads `tooltipState` from this module. (Plan 02 will extract it into TSX.)
//
// Why a singleton:
//   - One DOM node, one set of listeners, no per-trigger state churn.
//   - Hover handlers stay cheap (just signal writes), no Preact re-renders
//     in the parent component tree.
//   - Centralised cleanup: scroll/resize/Esc all collapse one signal.

import { signal, type Signal } from "@preact/signals";

export type Placement = "top" | "bottom" | "left" | "right";

export interface TipOpts {
  placement?: Placement;
  delay?: number;
}

// Snapshot of the trigger's bounding client rect at the moment of show.
// Stored as a plain object (not a live DOMRect) so mutations to the trigger
// element after show don't move the tip.
interface AnchorRect {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface TooltipState {
  visible: boolean;
  text: string;
  anchor: AnchorRect | null;
  placement: Placement;
}

// `anchor` holds the trigger's last-measured viewport rect so the position
// effect can recompute without re-querying the DOM. `placement` is the
// REQUESTED side; the actual placement (after flip) is written back to the
// element's data-placement attr for CSS hooks.
export const tooltipState: Signal<TooltipState> = signal<TooltipState>({
  visible: false,
  text: "",
  anchor: null,
  placement: "right",
});

let openTimer: ReturnType<typeof setTimeout> | null = null;
const clearOpen = (): void => {
  if (openTimer) {
    clearTimeout(openTimer);
    openTimer = null;
  }
};

interface ShowTipArgs {
  text: string;
  target: Element;
  placement: Placement;
  delay: number;
}

// Module-local handle on the currently-shown anchor DOM element. NOT in
// the signal because (a) signals are for renderable state and (b) holding
// element refs across renders that re-mount nodes would leak. Cleared on
// hideTip and on every show.
let activeAnchorEl: Element | null = null;

function showTip({ text, target, placement, delay }: ShowTipArgs): void {
  clearOpen();
  activeAnchorEl = target;
  // Snapshot the rect now — by the time the open timer fires the trigger
  // could have moved (scroll, layout shift). Using the snapshot keeps the
  // tip glued to where the user actually pointed.
  const r = target.getBoundingClientRect();
  const anchor: AnchorRect = {
    top: r.top,
    left: r.left,
    right: r.right,
    bottom: r.bottom,
    width: r.width,
    height: r.height,
  };
  const next: TooltipState = { visible: true, text, anchor, placement };
  if (delay <= 0) {
    tooltipState.value = next;
  } else {
    openTimer = setTimeout(() => {
      tooltipState.value = next;
      openTimer = null;
    }, delay);
  }
}

function hideTip(): void {
  clearOpen();
  activeAnchorEl = null;
  if (tooltipState.value.visible) {
    // Preserve text/anchor so the fade-out has something to position against
    // for the duration of the CSS transition.
    tooltipState.value = { ...tooltipState.value, visible: false };
  }
}

// Global dismissal: anything that invalidates the anchor coordinates should
// hide the tip immediately rather than letting it float over stale content.
// `true` on scroll uses capture phase so inner scroll containers (sidebar
// section bodies) also trigger dismissal.
if (typeof window !== "undefined") {
  window.addEventListener("scroll", hideTip, true);
  window.addEventListener("resize", hideTip);
  window.addEventListener("keydown", e => {
    if (e.key === "Escape") hideTip();
  });
  // Click-refresh: when the user clicks an element whose tooltip is the
  // currently-shown one, the click usually triggers a state change that
  // re-renders the trigger with NEW tip text (e.g. show/hide toggle). The
  // existing tooltip is still showing the OLD text because the mouse
  // hasn't left the trigger. Dispatch a synthetic mouseenter AFTER the
  // re-render so the freshly-attached tip handler closes over the new
  // text and re-issues showTip with it.
  window.addEventListener(
    "click",
    e => {
      const target = e.target;
      if (!(target instanceof Element) || !activeAnchorEl) return;
      if (!activeAnchorEl.contains(target)) return;
      const el = activeAnchorEl;
      // requestAnimationFrame waits for Preact to flush the re-render
      // queued by the click's handler before we re-fire mouseenter.
      requestAnimationFrame(() => {
        el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
      });
    },
    true,
  );
}

// ---------- public helper ----------
// Returns an event-prop spread to attach to ANY trigger element:
//   <button {...tip(longName)}>...</button>
//
// Empty / nullish text returns {} so callers don't have to guard.
// Focus opens with delay:0 so keyboard nav reveals labels immediately.
//
// Return type narrowed to ONLY the event handlers tip actually sets. The
// previous `JSX.HTMLAttributes` return shape carried a generic `ref?:
// Ref<EventTarget>` field that conflicted with element-specific ref types
// (e.g. `Ref<HTMLButtonElement>`) at every spread site, causing every
// `<button {...tip(...)}>` to fail tsc strict-mode checks.
export interface TipSpread {
  onMouseEnter?: (e: Event) => void;
  onMouseLeave?: (e: Event) => void;
  onFocus?: (e: Event) => void;
  onBlur?: (e: Event) => void;
}
export function tip(text: string | null | undefined, opts: TipOpts = {}): TipSpread {
  if (text == null || text === "") return {};
  const { placement = "right", delay = 200 } = opts;
  const open = (e: Event) => showTip({ text, target: e.currentTarget as Element, placement, delay });
  const openNow = (e: Event) => showTip({ text, target: e.currentTarget as Element, placement, delay: 0 });
  return {
    onMouseEnter: open,
    onMouseLeave: hideTip,
    onFocus: openNow,
    onBlur: hideTip,
  };
}

// ---------- positioning ----------
// Gap between the trigger edge and the tooltip edge.
const GAP = 8;
// Minimum breathing room from the viewport edge before we consider a side
// "doesn't fit" and try the next one.
const MARGIN = 6;

interface Position {
  left: number;
  top: number;
}

function computePosition(p: Placement, a: AnchorRect, w: number, h: number): Position {
  switch (p) {
    case "right":
      return { left: a.right + GAP, top: a.top + (a.height - h) / 2 };
    case "left":
      return { left: a.left - GAP - w, top: a.top + (a.height - h) / 2 };
    case "top":
      return { left: a.left + (a.width - w) / 2, top: a.top - GAP - h };
    case "bottom":
      return { left: a.left + (a.width - w) / 2, top: a.bottom + GAP };
    default:
      return { left: a.right + GAP, top: a.top };
  }
}

function fits(pos: Position, w: number, h: number, vw: number, vh: number): boolean {
  return pos.left >= MARGIN && pos.top >= MARGIN && pos.left + w <= vw - MARGIN && pos.top + h <= vh - MARGIN;
}

// Place the tooltip element at the best available position. Tries the
// requested placement first, then falls through right→left→top→bottom. If
// none fit, clamps the requested placement to the viewport so a long tip
// never spills off-screen.
export function placeTooltip(el: HTMLElement, anchor: AnchorRect, requested: Placement): void {
  const tipW = el.offsetWidth;
  const tipH = el.offsetHeight;
  const vw = window.innerWidth,
    vh = window.innerHeight;

  const order: Placement[] = [
    requested,
    ...(["right", "left", "top", "bottom"] as Placement[]).filter(p => p !== requested),
  ];
  let chosen: { left: number; top: number; placement: Placement } | null = null;
  for (const p of order) {
    const pos = computePosition(p, anchor, tipW, tipH);
    if (fits(pos, tipW, tipH, vw, vh)) {
      chosen = { ...pos, placement: p };
      break;
    }
  }
  if (!chosen) {
    const pos = computePosition(requested, anchor, tipW, tipH);
    chosen = {
      left: Math.max(MARGIN, Math.min(pos.left, vw - tipW - MARGIN)),
      top: Math.max(MARGIN, Math.min(pos.top, vh - tipH - MARGIN)),
      placement: requested,
    };
  }

  el.style.left = `${chosen.left}px`;
  el.style.top = `${chosen.top}px`;
  el.dataset.placement = chosen.placement;
}
