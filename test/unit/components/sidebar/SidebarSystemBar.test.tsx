import { describe, expect, test, beforeEach } from "bun:test";
import { render, fireEvent } from "@testing-library/preact";

import { SidebarSystemBar } from "../../../../src/ui/components/sidebar/SidebarSystemBar.tsx";
import { sidebarView, selectedTag } from "../../../../src/ui/state/signals.ts";

describe("SidebarSystemBar", () => {
  beforeEach(() => {
    sidebarView.value = "lanes";
    selectedTag.value = null;
  });

  test("in lanes mode renders the 'Manage tags' (hash) button, not Home", () => {
    const { container } = render(<SidebarSystemBar />);
    expect(container.querySelector('button[aria-label="Manage tags"]')).toBeTruthy();
    expect(container.querySelector('button[aria-label="Home"]')).toBeNull();
  });

  test("clicking the hash button switches sidebarView to 'tags'", () => {
    const { container } = render(<SidebarSystemBar />);
    const hashBtn = container.querySelector('button[aria-label="Manage tags"]');
    if (!hashBtn) throw new Error("expected the Manage tags button to render");
    fireEvent.click(hashBtn);
    expect(sidebarView.value).toBe("tags");
  });

  test("in tags mode renders the Home button, not the hash button", () => {
    sidebarView.value = "tags";
    const { container } = render(<SidebarSystemBar />);
    expect(container.querySelector('button[aria-label="Home"]')).toBeTruthy();
    expect(container.querySelector('button[aria-label="Manage tags"]')).toBeNull();
  });

  test("clicking Home switches sidebarView to 'lanes' and clears selectedTag", () => {
    sidebarView.value = "tags";
    selectedTag.value = "bug";
    const { container } = render(<SidebarSystemBar />);
    const homeBtn = container.querySelector('button[aria-label="Home"]');
    if (!homeBtn) throw new Error("expected the Home button to render");
    fireEvent.click(homeBtn);
    // Cast widens the narrowed type after the explicit assignment above so
    // bun's `expect<T>(value).toBe(T)` accepts the literal "lanes" arg.
    expect(sidebarView.value as "lanes" | "tags").toBe("lanes");
    expect(selectedTag.value).toBeNull();
  });

  test("always renders the ThemeToggle alongside the mode button", () => {
    const { container } = render(<SidebarSystemBar />);
    // Two btn-icon buttons: hash + theme toggle.
    expect(container.querySelectorAll("button.btn-icon").length).toBe(2);
  });
});
