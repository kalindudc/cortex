import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render } from "@testing-library/preact";

import { ExternalChangeBanner } from "../../../../src/ui/components/active/ExternalChangeBanner.tsx";

// findByText helper that scopes to a container — `screen` from
// @testing-library/dom is captured at import time before happy-dom installs
// `document`, so we read elements via querySelector/textContent instead.
const findByText = (root: ParentNode, text: string): HTMLElement | null => {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
    if (el.textContent === text || (el.childNodes.length === 1 && el.textContent?.trim() === text)) return el;
  }
  return null;
};

const findButton = (root: ParentNode, text: string): HTMLButtonElement | null => {
  for (const btn of Array.from(root.querySelectorAll<HTMLButtonElement>("button"))) {
    if (btn.textContent?.trim() === text) return btn;
  }
  return null;
};

describe("ExternalChangeBanner", () => {
  test("renders label + incoming preview", () => {
    const { container } = render(
      <ExternalChangeBanner label="Title" incoming="new external title" onApply={() => {}} onDismiss={() => {}} />,
    );
    expect(findByText(container, "Title updated externally")).toBeTruthy();
    const preview = container.querySelector(".external-change-preview");
    expect(preview?.textContent).toBe("new external title");
  });

  test("truncates long previews with an ellipsis", () => {
    const long = "x".repeat(200);
    const { container } = render(
      <ExternalChangeBanner label="Body" incoming={long} onApply={() => {}} onDismiss={() => {}} />,
    );
    const preview = container.querySelector(".external-change-preview");
    expect(preview?.textContent?.length).toBe(118); // 117 chars + ellipsis
    expect(preview?.textContent?.endsWith("\u2026")).toBe(true);
  });

  test("renders the empty placeholder when incoming is empty", () => {
    const { container } = render(
      <ExternalChangeBanner label="Body" incoming="" onApply={() => {}} onDismiss={() => {}} />,
    );
    const preview = container.querySelector(".external-change-preview");
    expect(preview?.textContent).toBe("(empty)");
  });

  test("Apply button invokes onApply once", () => {
    const onApply = mock(() => {});
    const onDismiss = mock(() => {});
    const { container } = render(
      <ExternalChangeBanner label="Title" incoming="x" onApply={onApply} onDismiss={onDismiss} />,
    );
    const applyBtn = findButton(container, "Apply");
    if (!applyBtn) throw new Error("expected Apply button to render");
    fireEvent.click(applyBtn);
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  test("the keep action is labeled 'Keep my changes' and invokes onDismiss once (task 330 H-series)", () => {
    const onApply = mock(() => {});
    const onDismiss = mock(() => {});
    const { container } = render(
      <ExternalChangeBanner label="Title" incoming="x" onApply={onApply} onDismiss={onDismiss} />,
    );
    // The old ambiguous 'Dismiss' label is gone — the action states its
    // domain meaning: keep MY text (and overwrite the external write on
    // the next explicit save).
    expect(findButton(container, "Dismiss")).toBeNull();
    const keepBtn = findButton(container, "Keep my changes");
    if (!keepBtn) throw new Error("expected 'Keep my changes' button to render");
    fireEvent.click(keepBtn);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
  });
});
