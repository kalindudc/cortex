// ExternalChangeBanner — banner shown above a field when an external write
// (another agent, the CLI) changed the value while the user has unsaved
// local edits to that same field. Apply adopts the external value; Dismiss
// keeps the user's version (next autosave will overwrite the agent's write
// — explicitly, not silently).

import type { VNode } from "preact";

export interface ExternalChangeBannerProps {
  label: string;
  incoming: string;
  onApply: () => void;
  onDismiss: () => void;
}

export function ExternalChangeBanner({ label, incoming, onApply, onDismiss }: ExternalChangeBannerProps): VNode {
  // Truncate long bodies in the preview — user clicks Apply to see the
  // full text in the editor. Single-line preview keeps the banner compact.
  const preview = (incoming || "(empty)").replace(/\s+/g, " ").trim();
  const display = preview.length > 120 ? preview.slice(0, 117) + "\u2026" : preview;
  return (
    <div class="external-change-banner" role="status">
      <span class="external-change-icon" aria-hidden="true">
        ↻
      </span>
      <div class="external-change-text">
        <strong>{label} updated externally</strong>
        <p class="external-change-preview">{display}</p>
      </div>
      <div class="external-change-actions">
        <button type="button" class="btn btn-primary" onClick={onApply}>
          Apply
        </button>
        <button type="button" class="btn" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
