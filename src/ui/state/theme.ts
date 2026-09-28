// state/theme.ts — Light/dark theme signal + persistence + boot wiring.
//
// Two-state theme model: "light" or "dark". CSS handles both via
// :root[data-theme="light"|"dark"] selectors. JS is responsible for reading
// the persisted choice on boot, writing the dataset attribute, and
// persisting on toggle.
//
// First-load default: matchMedia(prefers-color-scheme: dark). After that,
// the user's choice always wins and is persisted forever — no "system"
// option that changes under them.
//
// Loading this module only APPLIES the resolved theme (applyTheme): the
// dashboard's boot (dashboard.tsx) persists its first-load theme, while the
// rich draft preview, which imports this module through MarkdownView,
// persists no preference at all (review @405 F19).

import { signal } from "@preact/signals";

export type Theme = "light" | "dark";

const THEME_KEY = "cortex-theme";
const THEME_VALUES: readonly Theme[] = ["light", "dark"];

function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function readStoredTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "light" || v === "dark") return v;
  } catch {
    /* private mode — fall through */
  }
  return systemPrefersDark() ? "dark" : "light";
}

export const theme = signal<Theme>(readStoredTheme());

// Apply a theme to the signal and the DOM without persisting it.
export function applyTheme(mode: Theme): void {
  if (!THEME_VALUES.includes(mode)) mode = "light";
  theme.value = mode;
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-theme", mode);
  }
}

// Apply a theme to the DOM and persist it.
export function setTheme(mode: Theme): void {
  applyTheme(mode);
  try {
    localStorage.setItem(THEME_KEY, theme.value);
  } catch {
    /* ignore */
  }
}

// Flip light ↔ dark.
export function toggleTheme(): void {
  setTheme(theme.value === "dark" ? "light" : "dark");
}

// Apply the resolved theme to the DOM at module load (before first paint),
// so a hard refresh never flashes the wrong palette. Persisting is the
// dashboard boot's job, never an import's.
if (typeof document !== "undefined") applyTheme(theme.value);
