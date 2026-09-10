import { describe, test, expect, mock } from "bun:test";
import { render, fireEvent } from "@testing-library/preact";
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

  test("removable pills use a named button without bubbling into the surrounding control", () => {
    const remove = mock(() => {});
    const parent = mock(() => {});
    const view = render(
      <div onClick={parent}>
        <TagPill name="bug" color={null} onRemove={remove} />
      </div>,
    );
    const button = view.getByRole("button", { name: "Remove tag bug", exact: true });
    expect(view.container.querySelector(".tag-pill-removable")).not.toBeNull();
    fireEvent.click(button);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(parent).not.toHaveBeenCalled();
  });

  test("ordinary pills have no removal control; pending removal can be disabled", () => {
    const plain = render(<TagPill name="plain" color={null} />);
    expect(plain.container.querySelector("button")).toBeNull();
    const pending = render(<TagPill name="pending" color={null} onRemove={() => {}} removeDisabled />);
    expect((pending.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  });

  test("adds tag-pill-interactive when interactive=true", () => {
    render(<TagPill name="x" color={null} interactive />);
    const el = document.querySelector(".tag-pill") as HTMLElement;
    expect(el.classList.contains("tag-pill-interactive")).toBe(true);
  });
});
