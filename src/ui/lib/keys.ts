// lib/keys.ts — Platform-aware keyboard helpers.
//
// `IS_MAC` / `MOD` / `kbd` produce the cross-platform glyph for keyboard
// hints in the UI. Mode helpers share the Read/Edit/Split bindings and
// protect platform/AltGr semantics. `onSubmitKeys` is the "save this form" matcher
// shared by every form (new task, edit task, lane edit modal, post update).

import type { ReaderMode } from "../state/signals.ts";

// macOS gets the ⌘ glyph; everyone else gets the literal word "Ctrl". Used by
// every keyboard hint in the UI so we never make a Linux user squint at a
// Mac key icon. Always include "+" between modifier and key for visual
// parity across platforms.
export const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");
export const MOD = IS_MAC ? "\u2318" : "Ctrl";
export const kbd = (key: string): string => `${MOD} + ${key}`;

// Ordered like the UI. Avoid plain Mod+digits (browser tabs), Mod+R/S and
// Mod+Shift+R/E (reload/save/reader/devtools). Reference checks:
// support.google.com/chrome/answer/157179
// support.apple.com/guide/safari/keyboard-and-other-shortcuts-cpsh003/mac
// support.microsoft.com/microsoft-edge/keyboard-shortcuts-in-microsoft-edge-50d3edab-30d9-c7e4-21ce-37fe2713cfad
const MODE_DIGITS: Record<ReaderMode, string> = { read: "1", edit: "2", split: "3" };
const NO_ALT_KEYS: ReadonlySet<string> = new Set();
export function modeShortcutHint(mode: ReaderMode, mac = IS_MAC): string {
  return `${mac ? "⌘ + ⌥" : "Ctrl + Alt"} + ${MODE_DIGITS[mode]}`;
}
export function modeShortcutDigit(mode: ReaderMode): string {
  return MODE_DIGITS[mode];
}
export function modeShortcutAria(mode: ReaderMode, mac = IS_MAC): string {
  return `${mac ? "Meta" : "Control"}+Alt+${MODE_DIGITS[mode]}`;
}
export function matchModeShortcut(
  event: KeyboardEvent,
  mac = IS_MAC,
  heldAlt: ReadonlySet<string> = NO_ALT_KEYS,
): ReaderMode | null {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.shiftKey || !event.altKey)
    return null;
  if (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return null;
  // Firefox reports AltGraph for Option on Mac and genuine Ctrl+Alt on
  // Windows. Track physical Alt keys so right-Alt character entry is never
  // hijacked, without rejecting an intentional left-Ctrl+left-Alt chord.
  // developer.mozilla.org/docs/Web/API/KeyboardEvent/getModifierState
  if (!mac && (heldAlt.has("AltRight") || (event.getModifierState("AltGraph") && !heldAlt.has("AltLeft")))) return null;
  for (const mode of ["read", "edit", "split"] as const) {
    if (event.code === `Digit${MODE_DIGITS[mode]}` || (!event.code && event.key === MODE_DIGITS[mode])) return mode;
  }
  return null;
}

// Universal "save this form" keydown matcher. Used by every form (new task,
// new lane, edit task, lane edit modal, post update). Fires on Cmd/Ctrl+S
// and Cmd/Ctrl+Enter so muscle memory from any editor (⌘S in macOS, Ctrl+S
// in Win/Linux, ⌘⏎ / Ctrl+⏎ as the universal "submit" gesture) works.
// Returns a keydown handler you attach to the form (or to the focused input,
// for textareas where Enter alone has its own meaning).
export const onSubmitKeys = (submit: () => void) => (e: KeyboardEvent) => {
  if (e.isComposing) return; // skip mid-IME
  const meta = e.metaKey || e.ctrlKey;
  if (!meta) return;
  if (e.key === "Enter" || e.key === "s" || e.key === "S") {
    e.preventDefault();
    e.stopPropagation();
    submit();
  }
};
