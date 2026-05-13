// tooltip.js — Top-level tooltip primitive for the cortex dashboard.
//
// Singleton fixed-position element rendered once at the App root, driven by a
// signal. Triggers attach via the `tip(text, opts)` helper which returns an
// event-prop spread (mouse + focus). Positioning runs in JS so the tip can
// flip placement when the requested side has no viewport room — escapes any
// `overflow: hidden` ancestor clipping that traps CSS-only tooltips.
//
// Why a singleton:
//   - One DOM node, one set of listeners, no per-trigger state churn.
//   - Hover handlers stay cheap (just signal writes), no Preact re-renders
//     in the parent component tree.
//   - Centralised cleanup: scroll/resize/Esc all collapse one signal.
//
// Public API:
//   tip("text")                         → spread props (default placement="right", delay=200ms)
//   tip("text", { placement: "top" })   → fixed placement, auto-flips when no room
//   tip("text", { delay: 0 })           → instant open (use for keyboard focus surfaces)
//
//   <${Tooltip}/>                        → mount once inside App's render tree.

import { h } from "https://esm.sh/preact@10.24";
import { useEffect, useRef } from "https://esm.sh/preact@10.24/hooks";
import { signal } from "https://esm.sh/@preact/signals@1.3?deps=preact@10.24";
import htm from "https://esm.sh/htm@3.1";

const html = htm.bind(h);

// ---------- state ----------
// `anchor` holds the trigger's last-measured viewport rect so the position
// effect can recompute without re-querying the DOM. `placement` is the
// REQUESTED side; the actual placement (after flip) is written back to the
// element's data-placement attr for CSS hooks.
const tooltipState = signal({
  visible: false,
  text: "",
  anchor: null,
  placement: "right",
});

let openTimer = null;
const clearOpen = () => {
  if (openTimer) { clearTimeout(openTimer); openTimer = null; }
};

function showTip({ text, target, placement, delay }) {
  clearOpen();
  // Snapshot the rect now — by the time the open timer fires the trigger
  // could have moved (scroll, layout shift). Using the snapshot keeps the
  // tip glued to where the user actually pointed.
  const r = target.getBoundingClientRect();
  const anchor = {
    top: r.top, left: r.left, right: r.right, bottom: r.bottom,
    width: r.width, height: r.height,
  };
  const next = { visible: true, text, anchor, placement };
  if (delay <= 0) {
    tooltipState.value = next;
  } else {
    openTimer = setTimeout(() => {
      tooltipState.value = next;
      openTimer = null;
    }, delay);
  }
}

function hideTip() {
  clearOpen();
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
  window.addEventListener("keydown", (e) => { if (e.key === "Escape") hideTip(); });
}

// ---------- public helper ----------
// Returns an event-prop spread to attach to ANY trigger element:
//   <button ...${tip(longName)}>...</button>
//
// Empty / nullish text returns {} so callers don't have to guard.
// Focus opens with delay:0 so keyboard nav reveals labels immediately.
export function tip(text, opts = {}) {
  if (text == null || text === "") return {};
  const { placement = "right", delay = 200 } = opts;
  const open = (e) => showTip({ text, target: e.currentTarget, placement, delay });
  const openNow = (e) => showTip({ text, target: e.currentTarget, placement, delay: 0 });
  return {
    onMouseEnter: open,
    onMouseLeave: hideTip,
    onFocus:      openNow,
    onBlur:       hideTip,
  };
}

// ---------- positioning ----------
// Gap between the trigger edge and the tooltip edge.
const GAP = 8;
// Minimum breathing room from the viewport edge before we consider a side
// "doesn't fit" and try the next one.
const MARGIN = 6;

function computePosition(p, a, w, h) {
  switch (p) {
    case "right":  return { left: a.right + GAP,            top: a.top + (a.height - h) / 2 };
    case "left":   return { left: a.left  - GAP - w,        top: a.top + (a.height - h) / 2 };
    case "top":    return { left: a.left + (a.width - w)/2, top: a.top - GAP - h };
    case "bottom": return { left: a.left + (a.width - w)/2, top: a.bottom + GAP };
    default:       return { left: a.right + GAP,            top: a.top };
  }
}

function fits(pos, w, h, vw, vh) {
  return pos.left >= MARGIN
      && pos.top  >= MARGIN
      && pos.left + w <= vw - MARGIN
      && pos.top  + h <= vh - MARGIN;
}

// Place the tooltip element at the best available position. Tries the
// requested placement first, then falls through right→left→top→bottom. If
// none fit, clamps the requested placement to the viewport so a long tip
// never spills off-screen.
function placeTooltip(el, anchor, requested) {
  const tipW = el.offsetWidth;
  const tipH = el.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;

  const order = [requested, ...["right", "left", "top", "bottom"].filter(p => p !== requested)];
  let chosen = null;
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
      top:  Math.max(MARGIN, Math.min(pos.top,  vh - tipH - MARGIN)),
      placement: requested,
    };
  }

  el.style.left = chosen.left + "px";
  el.style.top  = chosen.top + "px";
  el.dataset.placement = chosen.placement;
}

// ---------- component ----------
// Mount once, anywhere in the App tree. The element is always in the DOM so
// the CSS opacity transition can animate both enter and exit; visibility is
// driven by the .tooltip-visible class. Position recompute runs after every
// render via useEffect because we need the tip's measured size to flip.
export function Tooltip() {
  const ref = useRef(null);
  const s = tooltipState.value;

  useEffect(() => {
    const el = ref.current;
    if (!el || !s.visible || !s.anchor) return;
    placeTooltip(el, s.anchor, s.placement);
  });

  return html`<div
    ref=${ref}
    class=${"tooltip" + (s.visible ? " tooltip-visible" : "")}
    role="tooltip"
    aria-hidden=${s.visible ? "false" : "true"}>${s.text}</div>`;
}
