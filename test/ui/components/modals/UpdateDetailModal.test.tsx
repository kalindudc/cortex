// UpdateDetailModal — compatibility consumer of the shared MarkdownView
//: the body renders through the same sanitized pipeline as task
// reading. DOMPurify is mocked passthrough (broken under happy-dom; real
// scrubbing is Chromium-verified in task 10's e2e).

import { describe, test, expect, mock } from "bun:test";
import { render, fireEvent } from "@testing-library/preact";

mock.module("dompurify", () => ({
  default: {
    isSupported: true,
    sanitize: (html: string) => html,
    addHook: () => {},
    removeHook: () => {},
  },
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

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0));

describe("UpdateDetailModal", () => {
  test("renders summary, author, and the body through MarkdownView", async () => {
    const { container } = render(
      <UpdateDetailModal update={update({ summary: "did stuff", body: "## hello" })} close={() => {}} />,
    );
    await tick();
    const view = container.querySelector(".markdown-view");
    expect(view).toBeTruthy();
    // Rendered (not raw) markdown, with the update-namespaced heading id.
    const h2 = view?.querySelector("h2");
    expect(h2?.textContent).toBe("hello");
    expect(h2?.id).toBe("update-1-hello");
    expect(container.textContent).toContain("did stuff");
    expect(container.textContent).toContain("alice");
  });

  test("shows the empty hint when body is null", () => {
    const { container } = render(<UpdateDetailModal update={update({ body: null })} close={() => {}} />);
    expect(container.querySelector(".markdown-view")).toBeNull();
    expect(container.textContent).toContain("No body");
  });

  test("calls close when the Close button is clicked", () => {
    const close = mock(() => {});
    const { getByText } = render(<UpdateDetailModal update={update()} close={close} />);
    fireEvent.click(getByText("Close"));
    expect(close).toHaveBeenCalledTimes(1);
  });
});
