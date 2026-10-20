// state/theme.ts — the appearance applies at module load, before first paint,
// WITHOUT persisting a preference: a missing value means "system", which
// must keep following the operating system. Explicit choices (setAppearance,
// setTheme, toggleTheme) persist.
//
// Each boot scenario loads a FRESH module instance (cache-bust query suffix)
// so its initializer runs against the storage and system preference it sets up.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

type ThemeModule = typeof import("../../../src/ui/state/theme.ts");

const KEY = "cortex-theme";
const root = document.documentElement;
const originalMatchMedia = window.matchMedia;

let changeListeners: (() => void)[] = [];
let systemDark = true;

function systemPrefersDark(dark: boolean): void {
  systemDark = dark;
  window.matchMedia = ((query: string) =>
    ({
      get matches() {
        return systemDark && query.includes("dark");
      },
      media: query,
      addEventListener: (_type: string, listener: () => void) => changeListeners.push(listener),
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
}

function flipSystem(dark: boolean): void {
  systemDark = dark;
  for (const listener of changeListeners) listener();
}

describe("state/theme boot and persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    root.removeAttribute("data-theme");
    root.removeAttribute("data-contrast");
    changeListeners = [];
    systemPrefersDark(true);
  });
  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    localStorage.clear();
    root.removeAttribute("data-theme");
    root.removeAttribute("data-contrast");
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

  test("a missing or unknown stored value means system, which follows the OS live", async () => {
    localStorage.setItem(KEY, "sepia");
    // @ts-expect-error — cache-bust query suffix has no .d.ts; runtime-only.
    const mod = (await import("../../../src/ui/state/theme.ts?boot=live")) as ThemeModule;
    expect(mod.appearance.value).toBe("system");
    expect(mod.theme.value).toBe("dark");
    flipSystem(false);
    expect(mod.theme.value).toBe("light");
    expect(root.getAttribute("data-theme")).toBe("light");
    mod.setAppearance("dark");
    flipSystem(true);
    flipSystem(false);
    expect(root.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem(KEY)).toBe("dark");
  });

  test("high contrast resolves to dark and adds data-contrast; other appearances remove it", async () => {
    systemPrefersDark(false);
    // @ts-expect-error — cache-bust query suffix has no .d.ts; runtime-only.
    const mod = (await import("../../../src/ui/state/theme.ts?boot=contrast")) as ThemeModule;
    expect(mod.APPEARANCES).toEqual(["system", "light", "dark", "high-contrast"]);
    mod.setAppearance("high-contrast");
    expect(mod.theme.value).toBe("dark");
    expect(root.getAttribute("data-theme")).toBe("dark");
    expect(root.getAttribute("data-contrast")).toBe("high");
    expect(localStorage.getItem(KEY)).toBe("high-contrast");
    mod.toggleTheme();
    expect(mod.appearance.value).toBe("light");
    expect(root.hasAttribute("data-contrast")).toBe(false);
    mod.setAppearance("system");
    expect(mod.theme.value).toBe("light");
    expect(localStorage.getItem(KEY)).toBe("system");
  });

  test("a stored high-contrast choice applies at load", async () => {
    localStorage.setItem(KEY, "high-contrast");
    // @ts-expect-error — cache-bust query suffix has no .d.ts; runtime-only.
    const mod = (await import("../../../src/ui/state/theme.ts?boot=stored-contrast")) as ThemeModule;
    expect(mod.appearance.value).toBe("high-contrast");
    expect(root.getAttribute("data-contrast")).toBe("high");
  });
});
