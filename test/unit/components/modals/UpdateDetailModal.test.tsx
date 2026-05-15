// UpdateDetailModal — smoke tests in isolation. MdEditor is stubbed (per the
// EditableTaskBody.test.tsx precedent) so we don't drag CodeMirror into
// happy-dom and can assert on the props we forward to it.

import { describe, test, expect, mock } from "bun:test";
import { render, fireEvent } from "@testing-library/preact";

mock.module("../../../../src/ui/components/active/MdEditor.tsx", () => ({
  MdEditor: ({ value, readOnly }: { value: string; readOnly?: boolean }) => (
    <div class="md-editor" data-value={value} data-readonly={String(!!readOnly)} />
  ),
}));

import { UpdateDetailModal } from "../../../../src/ui/components/modals/UpdateDetailModal.tsx";
import type { Update } from "../../../../src/ui/api/types.ts";

function update(over: Partial<Update> = {}): Update {
  return {
    id: 1,
    task_id: 1,
    author: "alice",
    summary: "did stuff",
    body: null,
    severity: "progress",
    created: 1700000000,
    ...over,
  };
}

describe("UpdateDetailModal", () => {
  test("renders summary, author, and the body via a read-only MdEditor", () => {
    const { container } = render(
      <UpdateDetailModal update={update({ summary: "did stuff", body: "## hello" })} close={() => {}} />,
    );
    const ed = container.querySelector(".md-editor");
    expect(ed).toBeTruthy();
    expect(ed?.getAttribute("data-readonly")).toBe("true");
    expect(ed?.getAttribute("data-value")).toBe("## hello");
    expect(container.textContent).toContain("did stuff");
    expect(container.textContent).toContain("alice");
  });

  test("shows the empty hint when body is null", () => {
    const { container } = render(<UpdateDetailModal update={update({ body: null })} close={() => {}} />);
    expect(container.querySelector(".md-editor")).toBeNull();
    expect(container.textContent).toContain("No body");
  });

  test("calls close when the Close button is clicked", () => {
    const close = mock(() => {});
    const { getByText } = render(<UpdateDetailModal update={update()} close={close} />);
    fireEvent.click(getByText("Close"));
    expect(close).toHaveBeenCalledTimes(1);
  });
});
