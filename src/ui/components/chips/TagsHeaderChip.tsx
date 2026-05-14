// TagsHeaderChip — always-rendered chip in the active-task header showing
// 'tags: N'. Click opens the TagPicker (replaces the prior read-only
// popover — the picker is now the single source of truth for editing a
// task's tags, including in edit mode). Even at zero tags the chip stays
// visible so users have a discoverable affordance to add the first tag.
//
// Mount discipline: TagPicker is rendered ONLY when tagsPopover.value is
// true (ternary below, NOT a self-gate inside the child). This guarantees a
// fresh mount per open so:
//   - autoFocus on the search input fires every time
//   - useSignal state (cursor, attached snapshot) is fresh per open
// Same pattern as CommandPalette in App() — see the comment block above
// CommandPalette for the full failure mode of the self-gate alternative.

import type { VNode } from "preact";

import type { Task } from "../../api/types.ts";
import { tagsPopover } from "../../state/signals.ts";
import { togglePopover } from "../../state/popovers.ts";
import { TagPicker } from "../pickers/TagPicker.tsx";

export function TagsHeaderChip({ task }: { task: Task }): VNode {
  const count = (task.tags || []).length;
  // Tooltip preview of attached tags (if any) so quick hover-inspection works
  // without opening the picker.
  const titleAttr = count > 0 ? `${task.tags.map(n => `#${n}`).join(" ")} \u2014 click to manage` : "Click to add tags";
  return (
    <div style="position:relative" data-pop>
      <button
        class="tags-chip"
        data-pop
        title={titleAttr}
        onClick={(e: MouseEvent) => {
          e.stopPropagation();
          togglePopover(tagsPopover);
        }}
      >
        <span class="tags-chip-label">tags:</span>
        <span class="tags-chip-count">{count}</span>
      </button>
      {tagsPopover.value ? <TagPicker task={task} /> : null}
    </div>
  );
}
