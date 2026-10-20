// OutlineTab — the side panel's Outline tab: the headings TaskDocument
// publishes to `docOutline` for the task it shows in Read or Split mode. An
// entry left by another task never shows. A click hands the heading to
// `pendingHeadingFragment`, whose consumer in TaskDocument scrolls to it, so
// there is one way to scroll the document to a heading.

import type { VNode } from "preact";

import { activeTask } from "../../state/computed.ts";
import { docOutline } from "../../state/context.ts";
import { pendingHeadingFragment } from "../../state/signals.ts";
import { Icon } from "../Icon.tsx";

export function OutlineTab(): VNode {
  const at = activeTask.value;
  const outline = docOutline.value;
  if (!at || outline?.taskId !== at.id || outline.headings.length === 0) {
    return (
      <div class="empty">
        <Icon name="list" size={32} />
        <div class="empty-title">No outline</div>
        <div class="empty-sub">
          {at ? "The document's headings show here in Read and Split modes." : "Select a task to see its outline."}
        </div>
      </div>
    );
  }
  return (
    <nav class="doc-outline" aria-label="Document outline">
      {outline.headings.map(h => (
        <button
          key={h.id}
          type="button"
          class={`doc-outline-link level-${h.level}`}
          aria-current={outline.active === h.id ? "location" : undefined}
          onClick={() => {
            pendingHeadingFragment.value = { taskId: at.id, id: h.id };
          }}
        >
          {h.text}
        </button>
      ))}
    </nav>
  );
}
