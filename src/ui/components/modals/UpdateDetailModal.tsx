// UpdateDetailModal — read-only viewer for a single inbox update.
//
// A COMPATIBILITY consumer of the shared MarkdownView surface (task 330):
// the normal update-reading path is the expandable Activity card inside
// TaskDocument; this modal remains for legacy entry points (modal kind
// "update-detail"). The body renders through MarkdownView — same
// sanitization, refs and copy controls as every other rendered surface.
//
// Empty/null body shows a single muted line — bodies are optional on the
// updates table (CLI `cortex update -b` populates them; the dashboard's
// PostUpdateForm does not post a body today).

import type { VNode } from "preact";

import type { Update } from "../../api/types.ts";
import { fmtTime, initial } from "../../lib/format.ts";
import { MarkdownView } from "../active/MarkdownView.tsx";
import { DialogFrame } from "./DialogFrame.tsx";

export function UpdateDetailModal({ update, close }: { update: Update; close: () => void }): VNode {
  // Severity dot mirrors InboxPane verbatim so the visual stays unified.
  const severityClass = `dot dot-status-${update.severity === "blocked" ? "blocked" : update.severity === "review" ? "review" : "open"}`;
  const hasBody = !!update.body && update.body.trim().length > 0;
  return (
    <DialogFrame label="Update" onClose={close}>
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
            <MarkdownView source={update.body as string} idPrefix={`update-${update.id}`} />
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
    </DialogFrame>
  );
}
