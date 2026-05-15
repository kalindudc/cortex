// UpdateDetailModal — read-only viewer for a single inbox update.
//
// Opened when a row in InboxPane is clicked (modal kind "update-detail").
// Renders the update's metadata + the body verbatim through a read-only
// MdEditor so the body keeps the same lezer-markdown highlighting that
// task descriptions already use. No new markdown engine is introduced;
// see the plan for the full rationale.
//
// Empty/null body shows a single muted line — bodies are optional on the
// updates table (CLI `cortex update -b` populates them; the dashboard's
// PostUpdateForm does not post a body today).

import type { VNode } from "preact";

import type { Update } from "../../api/types.ts";
import { fmtTime, initial } from "../../lib/format.ts";
import { MdEditor } from "../active/MdEditor.tsx";

export function UpdateDetailModal({ update, close }: { update: Update; close: () => void }): VNode {
  const overlayClick = (e: MouseEvent) => {
    if ((e.target as HTMLElement).classList.contains("overlay")) close();
  };
  // Severity dot mirrors InboxPane verbatim so the visual stays unified.
  const severityClass = `dot dot-status-${update.severity === "blocked" ? "blocked" : update.severity === "review" ? "review" : "open"}`;
  const hasBody = !!update.body && update.body.trim().length > 0;
  return (
    <div class="overlay overlay--centered" onClick={overlayClick}>
      <div class="modal modal--wide">
        <div class="row" style="gap:10px; align-items:center">
          <span class="avatar">{initial(update.author)}</span>
          <div class="meta" style="display:flex; align-items:center; gap:6px">
            <span class={severityClass} style="width:6px; height:6px"></span>
            <span>{update.author}</span>
            <span>&middot;</span>
            <span>{fmtTime(update.created)}</span>
          </div>
        </div>
        <h2>{update.summary}</h2>
        <div class="update-body">
          {hasBody ? (
            <MdEditor value={update.body as string} onChange={() => {}} readOnly={true} />
          ) : (
            <p class="meta" style="margin:0">
              No body for this update.
            </p>
          )}
        </div>
        <div class="modal-actions">
          <button class="btn" onClick={close}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
