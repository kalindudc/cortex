import { describe, test, expect } from "bun:test";
import { render } from "@testing-library/preact";
import { TagPill } from "../../../../src/ui/components/chips/TagPill.tsx";

describe("TagPill", () => {
  test("renders the tag name in a .tag-pill span", () => {
    render(<TagPill name="bug" color={null} />);
    const el = document.querySelector(".tag-pill") as HTMLElement;
    expect(el).toBeTruthy();
    expect(el.textContent).toBe("bug");
    // No color → neutral; no -colored class.
    expect(el.classList.contains("tag-pill-colored")).toBe(false);
  });

  test("adds tag-pill-colored when a hex is supplied", () => {
    render(<TagPill name="urgent" color="#ff8800" />);
    const el = document.querySelector(".tag-pill") as HTMLElement;
    expect(el.classList.contains("tag-pill-colored")).toBe(true);
  });

  test("adds tag-pill-interactive when interactive=true", () => {
    render(<TagPill name="x" color={null} interactive />);
    const el = document.querySelector(".tag-pill") as HTMLElement;
    expect(el.classList.contains("tag-pill-interactive")).toBe(true);
  });
});
