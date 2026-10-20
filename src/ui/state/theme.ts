// state/theme.ts — The appearance setting, its persistence and boot wiring.
//
// Four appearances: "system" (follows prefers-color-scheme, live), "light",
// "dark" and "high-contrast" (dark surfaces with 7:1 text). The stored
// "cortex-theme" value is the appearance; a missing or unknown value means
// "system". `theme` is always the RESOLVED "light" or "dark": the CSS keys on
// :root[data-theme], and the editor and Mermaid follow this signal. High
// contrast adds :root[data-contrast="high"] on top of the dark palette.
//
// Loading this module only APPLIES the appearance; it persists nothing, so
// importing it (MarkdownView does) never freezes "system" into a stored
// choice. Only an explicit choice (setAppearance, setTheme, toggleTheme)
// is stored.

import { signal } from "@preact/signals";

export type Theme = "light" | "dark";
export type Appearance = "system" | "light" | "dark" | "high-contrast";

export const APPEARANCES: readonly Appearance[] = ["system", "light", "dark", "high-contrast"];

const THEME_KEY = "cortex-theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(DARK_QUERY).matches;
}

function readStoredAppearance(): Appearance {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if ((APPEARANCES as readonly (string | null)[]).includes(v)) return v as Appearance;
  } catch {
    /* private mode — fall through */
  }
  return "system";
}

function resolve(a: Appearance): Theme {
  if (a === "system") return systemPrefersDark() ? "dark" : "light";
  return a === "high-contrast" ? "dark" : a;
}

export const appearance = signal<Appearance>(readStoredAppearance());
export const theme = signal<Theme>(resolve(appearance.value));

function render(mode: Theme, highContrast: boolean): void {
  theme.value = mode;
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.setAttribute("data-theme", mode);
  if (highContrast) root.setAttribute("data-contrast", "high");
  else root.removeAttribute("data-contrast");
}

function applyAppearance(): void {
  render(resolve(appearance.value), appearance.value === "high-contrast");
}

// Apply a resolved light or dark theme to the signal and the DOM without persisting it.
export function applyTheme(mode: Theme): void {
  render(mode === "dark" ? "dark" : "light", false);
}

// Choose an appearance: persist it, then apply it.
export function setAppearance(value: Appearance): void {
  if (!APPEARANCES.includes(value)) value = "system";
  appearance.value = value;
  try {
    localStorage.setItem(THEME_KEY, value);
  } catch {
    /* ignore */
  }
  applyAppearance();
}

// Choose light or dark explicitly.
export function setTheme(mode: Theme): void {
  setAppearance(mode);
}

// The explicit opposite of the resolved theme.
export function toggleTheme(): void {
  setTheme(theme.value === "dark" ? "light" : "dark");
}

// Apply at module load (before first paint), so a hard refresh never
// flashes the wrong palette, and follow the system live while "system".
if (typeof document !== "undefined") {
  applyAppearance();
  const query = typeof window !== "undefined" && window.matchMedia ? window.matchMedia(DARK_QUERY) : null;
  query?.addEventListener?.("change", () => {
    if (appearance.peek() === "system") applyAppearance();
  });
}
