// lib/autosize.ts — Auto-resize a textarea to fit its content.
//
// Attached as a ref callback so it works without re-rendering on every
// keystroke (which would fight htm). The __cortexAutoSized flag prevents
// double-binding on rerenders — the listener stays attached for the
// textarea's whole lifetime. min-height + viewport-capped max-height live
// in CSS (.autosize) so JS only computes the natural height.

interface AutosizedTextArea extends HTMLTextAreaElement {
  __cortexAutoSized?: boolean;
}

export const autosizeRef = (el: HTMLTextAreaElement | null): void => {
  const t = el as AutosizedTextArea | null;
  if (!t || t.__cortexAutoSized) return;
  t.__cortexAutoSized = true;
  const fit = () => {
    t.style.height = "auto";
    t.style.height = t.scrollHeight + "px";
  };
  t.addEventListener("input", fit);
  // Run once now (next paint) so initial content sizes correctly.
  requestAnimationFrame(fit);
};
