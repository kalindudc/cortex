// lib/keys.ts — Platform-aware keyboard helpers.
//
// `IS_MAC` / `MOD` / `kbd` produce the cross-platform glyph for keyboard
// hints in the UI. `onSubmitKeys` is the universal "save this form" matcher
// shared by every form (new task, edit task, lane edit modal, post update).

// macOS gets the ⌘ glyph; everyone else gets the literal word "Ctrl". Used by
// every keyboard hint in the UI so we never make a Linux user squint at a
// Mac key icon. Always include "+" between modifier and key for visual
// parity across platforms.
export const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");
export const MOD = IS_MAC ? "\u2318" : "Ctrl";
export const kbd = (key: string): string => `${MOD} + ${key}`;

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
