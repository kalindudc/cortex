// DialogFrame — the ONE modal frame (task 330, V3): a native <dialog>
// opened with showModal (inert background + trapped Tab come from the
// platform, not from a role attribute), an accessible name, initial focus
// inside the dialog, Escape/cancel and backdrop-click close through the
// caller's onClose (state-driven unmount), a real `close` transition on
// unmount and logical focus return to the opener.
//
// happy-dom implements HTMLDialogElement.showModal/close and the `close`
// event but does NOT emulate top-layer inertness or Escape → cancel; the
// cancel path is exercised by dispatching the event, and geometry/inert
// behaviour is certified by the Chromium e2e specs (Task 10).

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { render, fireEvent } from "@testing-library/preact";
import { DialogFrame } from "../../../../src/ui/components/modals/DialogFrame.tsx";

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0));

function dialogOf(root: ParentNode): HTMLDialogElement {
  const d = root.querySelector("dialog");
  if (!d) throw new Error("expected a <dialog> element");
  return d as HTMLDialogElement;
}

describe("DialogFrame", () => {
  let opener: HTMLButtonElement;
  beforeEach(() => {
    opener = document.createElement("button");
    opener.textContent = "opener";
    document.body.appendChild(opener);
    opener.focus();
  });
  afterEach(() => {
    opener.remove();
  });

  test("renders a NAMED native dialog opened as modal", () => {
    const { container } = render(
      <DialogFrame label="Edit lane" onClose={() => {}}>
        <p>content</p>
      </DialogFrame>,
    );
    const d = dialogOf(container);
    expect(d.getAttribute("aria-label")).toBe("Edit lane");
    expect(d.open).toBe(true); // showModal() ran on mount
    expect(d.classList.contains("dialog-frame")).toBe(true);
  });

  test("initial focus lands INSIDE the dialog (first focusable) when no child claims it", async () => {
    const { container } = render(
      <DialogFrame label="Confirm" onClose={() => {}}>
        <p>Are you sure?</p>
        <button type="button" class="first">
          Cancel
        </button>
        <button type="button">OK</button>
      </DialogFrame>,
    );
    await tick();
    expect(document.activeElement).toBe(container.querySelector(".first"));
  });

  test("a child that focuses itself on mount is NOT overridden", async () => {
    const { container } = render(
      <DialogFrame label="New lane" onClose={() => {}}>
        <button type="button">decoy</button>
        <input class="name" ref={el => el?.focus()} />
      </DialogFrame>,
    );
    await tick();
    expect(document.activeElement).toBe(container.querySelector(".name"));
  });

  test("Escape (native cancel) routes through onClose exactly once and never self-closes", () => {
    const onClose = mock(() => {});
    const { container } = render(
      <DialogFrame label="Confirm" onClose={onClose}>
        <button type="button">OK</button>
      </DialogFrame>,
    );
    const d = dialogOf(container);
    const cancel = new Event("cancel", { cancelable: true });
    d.dispatchEvent(cancel);
    expect(onClose).toHaveBeenCalledTimes(1);
    // The frame is state-driven: the OWNER unmounts it. Until then it stays
    // open (the native default close is suppressed).
    expect(cancel.defaultPrevented).toBe(true);
    expect(d.open).toBe(true);
  });

  test("backdrop click closes; clicks inside the content do not", () => {
    const onClose = mock(() => {});
    const { container } = render(
      <DialogFrame label="Confirm" onClose={onClose}>
        <div class="modal">
          <button type="button" class="inner">
            inner
          </button>
        </div>
      </DialogFrame>,
    );
    fireEvent.click(container.querySelector(".inner") as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(0);
    fireEvent.click(dialogOf(container)); // target === dialog ⇒ ::backdrop
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("unmount fires the native close transition and returns focus to the opener", async () => {
    const closed: string[] = [];
    const view = render(
      <DialogFrame label="Confirm" onClose={() => {}}>
        <button type="button" class="ok">
          OK
        </button>
      </DialogFrame>,
    );
    const d = dialogOf(view.container);
    d.addEventListener("close", () => closed.push("close"));
    await tick();
    expect(document.activeElement).toBe(view.container.querySelector(".ok"));
    view.unmount();
    expect(closed).toEqual(["close"]);
    expect(document.activeElement).toBe(opener); // logical focus return
  });

  test("className is appended for per-dialog geometry variants", () => {
    const { container } = render(
      <DialogFrame label="Palette" onClose={() => {}} className="dialog-frame--top">
        <p>x</p>
      </DialogFrame>,
    );
    expect(dialogOf(container).classList.contains("dialog-frame--top")).toBe(true);
  });
});
