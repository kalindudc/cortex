// state/theme.ts — the palette applies at module load, before first paint,
// WITHOUT persisting a preference (review @405 F19): the rich draft preview
// imports this module through MarkdownView and must not store the
// system-derived theme as if the user had chosen it. Explicit choices
// (setTheme/toggleTheme) persist, and so does the dashboard's boot
// (src/ui/dashboard.tsx), which keeps its documented first-load behavior.
//
// Each boot scenario loads a FRESH module instance (cache-bust query suffix)
// so its initializer runs against the storage and system preference it sets up.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

type ThemeModule = typeof import("../../../src/ui/state/theme.ts");

const KEY = "cortex-theme";
const root = document.documentElement;
const originalMatchMedia = window.matchMedia;

function systemPrefersDark(dark: boolean): void {
  window.matchMedia = ((query: string) =>
    ({ matches: dark && query.includes("dark"), media: query }) as MediaQueryList) as typeof window.matchMedia;
}

describe("state/theme boot and persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    root.removeAttribute("data-theme");
    systemPrefersDark(true);
  });
  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    localStorage.clear();
    root.removeAttribute("data-theme");
  });

  test("loading applies the system theme before first paint but persists nothing", async () => {
    // @ts-expect-error — cache-bust query suffix has no .d.ts; runtime-only.
    const mod = (await import("../../../src/ui/state/theme.ts?boot=system")) as ThemeModule;
    expect(mod.theme.value).toBe("dark");
    expect(root.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  test("a stored choice wins at load and stays as stored", async () => {
    localStorage.setItem(KEY, "light");
    // @ts-expect-error — cache-bust query suffix has no .d.ts; runtime-only.
    const mod = (await import("../../../src/ui/state/theme.ts?boot=stored")) as ThemeModule;
    expect(mod.theme.value).toBe("light");
    expect(root.getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem(KEY)).toBe("light");
  });

  test("applyTheme only applies; setTheme and toggleTheme apply and persist the choice", async () => {
    const { theme, applyTheme, setTheme, toggleTheme } = await import("../../../src/ui/state/theme.ts");
    applyTheme("dark");
    expect(theme.value).toBe("dark");
    expect(root.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem(KEY)).toBeNull();
    setTheme("light");
    expect(root.getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem(KEY)).toBe("light");
    toggleTheme();
    expect(theme.value).toBe("dark");
    expect(localStorage.getItem(KEY)).toBe("dark");
  });
});
