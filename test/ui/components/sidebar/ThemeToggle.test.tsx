import { describe, expect, test, beforeEach } from "bun:test";
import { render, fireEvent } from "@testing-library/preact";

import { ThemeToggle } from "../../../../src/ui/components/sidebar/ThemeToggle.tsx";
import { theme, setTheme } from "../../../../src/ui/state/theme.ts";

describe("ThemeToggle", () => {
  beforeEach(() => {
    setTheme("light");
  });

  test("renders a button with destination-mode label when in light mode", () => {
    const { container } = render(<ThemeToggle />);
    const btn = container.querySelector("button");
    expect(btn).toBeTruthy();
    expect(btn?.getAttribute("aria-label")).toBe("Switch to dark mode");
    // Moon icon → destination is dark.
    expect(container.querySelector("svg")).toBeTruthy();
  });

  test("click flips light → dark and updates document data-theme", () => {
    const { container } = render(<ThemeToggle />);
    const btn = container.querySelector("button");
    if (!btn) throw new Error("ThemeToggle did not render a button");
    fireEvent.click(btn);
    expect(theme.value).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  test("click toggles dark → light back", () => {
    setTheme("dark");
    const { container } = render(<ThemeToggle />);
    const btn = container.querySelector("button");
    if (!btn) throw new Error("ThemeToggle did not render a button");
    expect(btn.getAttribute("aria-label")).toBe("Switch to light mode");
    fireEvent.click(btn);
    expect(theme.value).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  test("two clicks cycle light → dark → light", () => {
    const { container } = render(<ThemeToggle />);
    const btn = container.querySelector("button");
    if (!btn) throw new Error("ThemeToggle did not render a button");
    fireEvent.click(btn);
    expect(theme.value).toBe("dark");
    fireEvent.click(btn);
    expect(theme.value).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });
});
