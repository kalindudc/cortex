import { beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, render } from "@testing-library/preact";

// Capture the editTask mock so we can assert on autosave commits.
const editTask = mock((_id: number, _body: Record<string, unknown>) => Promise.resolve({}));
mock.module("../../../../src/ui/api/client.ts", () => ({
  api: {
    editTask,
    postUpd: mock(() => Promise.resolve({})),
    setStat: mock(() => Promise.resolve({})),
  },
}));

// MdEditor wraps CodeMirror which does heavy DOM-measurement on mount. We
// don't exercise the editor in this file (covered by MdEditor.test.tsx +
// e2e), so stub it with a trivial textarea so EditableTaskBody can mount
// cleanly under happy-dom and the title-autosave assertion stays focused.
mock.module("../../../../src/ui/components/active/MdEditor.tsx", () => ({
  MdEditor: ({ value }: { value: string }) => <div class="md-editor-stub" data-value={value} />,
}));

import { EditableTaskBody } from "../../../../src/ui/components/active/EditableTaskBody.tsx";

const makeTask = (over: Record<string, unknown> = {}) => ({
  id: 11,
  lane: "inbox",
  title: "original",
  body: "body text",
  status: "open" as const,
  priority: 50,
  created: 1,
  updated: 1,
  tags: [],
  ...over,
});

const findButton = (root: ParentNode, text: string): HTMLButtonElement | null => {
  for (const btn of Array.from(root.querySelectorAll<HTMLButtonElement>("button"))) {
    if (btn.textContent?.trim() === text) return btn;
  }
  return null;
};

describe("EditableTaskBody", () => {
  beforeEach(() => {
    editTask.mockClear();
  });

  test("renders title input + body editor with the task's current values", () => {
    const { container } = render(<EditableTaskBody task={makeTask()} />);
    const titleInput = container.querySelector(".title-input") as HTMLInputElement;
    expect(titleInput).toBeTruthy();
    expect(titleInput.value).toBe("original");
    const editor = container.querySelector(".md-editor-stub") as HTMLElement;
    expect(editor).toBeTruthy();
    expect(editor.getAttribute("data-value")).toBe("body text");
  });

  test("blur flushes the pending title autosave synchronously", () => {
    const { container } = render(<EditableTaskBody task={makeTask({ id: 11, title: "original" })} />);
    const titleInput = container.querySelector(".title-input") as HTMLInputElement;
    fireEvent.input(titleInput, { target: { value: "renamed" } });
    fireEvent.blur(titleInput);
    expect(editTask).toHaveBeenCalledTimes(1);
    expect(editTask.mock.calls[0][0]).toBe(11);
    expect(editTask.mock.calls[0][1]).toEqual({ title: "renamed" });
  });

  test("the 600ms idle timer eventually fires an autosave PATCH", async () => {
    const { container } = render(<EditableTaskBody task={makeTask({ id: 99, title: "alpha" })} />);
    const titleInput = container.querySelector(".title-input") as HTMLInputElement;
    fireEvent.input(titleInput, { target: { value: "beta" } });
    // Default idleMs in useAutosave is 600 — wait a bit longer.
    await new Promise(r => setTimeout(r, 700));
    expect(editTask).toHaveBeenCalledTimes(1);
    expect(editTask.mock.calls[0][0]).toBe(99);
    expect(editTask.mock.calls[0][1]).toEqual({ title: "beta" });
  });

  test("renders the title ExternalChangeBanner when an SSE-conflict is staged", () => {
    // We render with an existing task, dirty the local title, then re-render
    // the same component instance with a NEW task.title to drive case 5
    // (local !== server, incoming !== local) — that pushes the external
    // value into titleExternal and shows the banner.
    const task1 = makeTask({ id: 50, title: "v1" });
    const { container, rerender } = render(<EditableTaskBody task={task1} />);
    const titleInput = container.querySelector(".title-input") as HTMLInputElement;
    fireEvent.input(titleInput, { target: { value: "local edits" } });
    // External update arrives while local is dirty.
    const task2 = makeTask({ id: 50, title: "external v2", body: task1.body });
    rerender(<EditableTaskBody task={task2} />);
    const banner = container.querySelector(".external-change-banner");
    expect(banner).toBeTruthy();
    expect(banner?.textContent).toContain("Title updated externally");
    expect(banner?.textContent).toContain("external v2");

    // Clicking Apply adopts the external value and dismisses the banner.
    const applyBtn = findButton(container, "Apply");
    if (!applyBtn) throw new Error("expected Apply button to render");
    fireEvent.click(applyBtn);
    expect(container.querySelector(".external-change-banner")).toBeFalsy();
    expect((container.querySelector(".title-input") as HTMLInputElement).value).toBe("external v2");
  });
});
