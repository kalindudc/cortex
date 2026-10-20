// OrphanDrafts — unsaved text whose task was deleted (or belongs to the
// database the app was connected to before). It cannot be saved any more,
// so it stays on screen until the user exports it to a file or discards it.

import type { VNode } from "preact";

import { showError } from "../../api/errors.ts";
import { discardOrphan, orphanedDrafts, type OrphanDraft } from "../../lib/useTaskDraft.ts";

const PREVIEW_CHARS = 80;

async function exportOrphan(o: OrphanDraft): Promise<void> {
  try {
    const { saved } = await window.cortex.drafts.export({ taskId: o.taskId, field: o.field, text: o.text });
    if (saved) discardOrphan(o.taskId, o.field);
  } catch (err) {
    showError(err);
  }
}

export function OrphanDrafts(): VNode | null {
  const orphans = orphanedDrafts.value;
  if (orphans.length === 0) return null;
  return (
    <section class="orphan-drafts" aria-label="Unsaved text from deleted tasks">
      <h2 class="orphan-drafts-title">Unsaved text from deleted tasks</h2>
      <ul class="orphan-drafts-list">
        {orphans.map((o, i) => (
          <li key={`${o.taskId}:${o.field}:${i}`} class="orphan-draft">
            <span class="orphan-draft-label">
              Task {o.taskId} · {o.field}
            </span>
            <span class="orphan-draft-text">{o.text.slice(0, PREVIEW_CHARS)}</span>
            <button type="button" class="btn" onClick={() => void exportOrphan(o)}>
              Export
            </button>
            <button type="button" class="btn" onClick={() => discardOrphan(o.taskId, o.field)}>
              Discard
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
