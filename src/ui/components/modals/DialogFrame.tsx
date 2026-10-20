// DialogFrame — the ONE modal frame for the dashboard.
//
// A native <dialog> opened with showModal(): the platform supplies the top
// layer, background inertness, trapped Tab/Shift-Tab and Escape → cancel —
// none of that is claimed through a role attribute or a CSS-only overlay.
// The frame adds what the platform leaves to the app:
//   - an accessible NAME (aria-label) for every dialog;
//   - initial focus INSIDE the dialog (a child that focuses itself wins;
//     otherwise the first focusable element, else the dialog itself);
//   - state-driven closing: Escape (cancel) and backdrop clicks call the
//     owner's onClose and the OWNER unmounts the frame — the frame never
//     closes itself, so signal state and DOM can never disagree;
//   - a real `close` transition on unmount plus logical focus return to the
//     element that was focused when the dialog opened (if still connected).
//
// Used by every modal kind (ModalRoot), the command palette and the mobile
// navigation drawer. Geometry variants are CSS classes (modal.css):
// `dialog-frame--top` (palette-style top anchor), `dialog-frame--sheet`
// (narrow-viewport navigation drawer). Content sits in the caller's own
// `.modal` box so the pre-existing modal styling is untouched.

import type { ComponentChildren, VNode } from "preact";
import { useEffect, useRef } from "preact/hooks";

export interface DialogFrameProps {
  label: string;
  onClose: () => void;
  children: ComponentChildren;
  className?: string;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function DialogFrame(props: DialogFrameProps): VNode {
  const { label, onClose, children, className } = props;
  const ref = useRef<HTMLDialogElement>(null);
  // Latest onClose without re-binding listeners.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    // Opener = whatever had focus when the frame mounted. Focus returns there
    // on unmount (logical focus return) if it is still in the document.
    const opener = document.activeElement as HTMLElement | null;
    if (!dialog.open) {
      try {
        dialog.showModal();
      } catch {
        // Already open / unsupported environment: fall back to the attribute
        // so the content is at least visible; inertness is then not modal.
        dialog.setAttribute("open", "");
      }
    }
    // Initial focus. Children (name inputs, search boxes) may have focused
    // themselves in their own mount effects, which run BEFORE this parent
    // effect — respect that. Re-check on the next tick too, because the
    // trigger button can steal focus back in the same tick (documented race
    // in TagPicker / NewLaneModal).
    const settle = (): void => {
      if (dialog.contains(document.activeElement)) return;
      const target =
        dialog.querySelector<HTMLElement>("[autofocus]") ?? dialog.querySelector<HTMLElement>(FOCUSABLE) ?? dialog;
      target.focus();
    };
    settle();
    const t = setTimeout(settle, 0);
    return () => {
      clearTimeout(t);
      // Real close transition (fires `close`) — the owner already unmounted
      // us through state, so this is DOM-only: no signal writes on the
      // unmount path (writing subscribed signals here crashes preact's
      // render queue).
      if (dialog.open) dialog.close();
      if (opener?.isConnected && typeof opener.focus === "function") opener.focus();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      class={`dialog-frame${className ? ` ${className}` : ""}`}
      aria-label={label}
      tabIndex={-1}
      onCancel={(e: Event) => {
        // Escape: suppress the native self-close and let the owner decide.
        e.preventDefault();
        onCloseRef.current();
      }}
      onClick={(e: MouseEvent) => {
        // The dialog is a transparent full-viewport positioner (modal.css):
        // a click whose target is the dialog itself landed OUTSIDE the
        // content box, i.e. on the backdrop region.
        if (e.target === ref.current) onCloseRef.current();
      }}
    >
      {children}
    </dialog>
  );
}
