import { describe, test, expect } from "bun:test";
import { render } from "@testing-library/preact";
import { PriorityChip } from "../../../../src/ui/components/chips/PriorityChip.tsx";

describe("PriorityChip (static)", () => {
  test("renders P{n} text and urgent class for priority 0", () => {
    render(<PriorityChip priority={0} />);
    const el = document.querySelector(".priority-chip") as HTMLElement;
    expect(el).toBeTruthy();
    expect(el.textContent).toBe("P0");
    expect(el.classList.contains("urgent")).toBe(true);
  });

  test("renders P{n} text with no priority class for priority 2", () => {
    render(<PriorityChip priority={2} />);
    const el = document.querySelector(".priority-chip") as HTMLElement;
    expect(el.textContent).toBe("P2");
    expect(el.classList.contains("urgent")).toBe(false);
    expect(el.classList.contains("high")).toBe(false);
  });

  test("renders the high class for priority 1", () => {
    render(<PriorityChip priority={1} />);
    const el = document.querySelector(".priority-chip") as HTMLElement;
    expect(el.classList.contains("high")).toBe(true);
  });
});
