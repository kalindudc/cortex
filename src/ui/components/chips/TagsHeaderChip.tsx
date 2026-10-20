// TagsHeaderChip — actual named tag pills in the header property row. Up to three removable TagPills, a labeled overflow trigger for
// the rest, and one plus-only Add tags control. Removal uses association
// deltas; canonical task/SSE data drives the pills. No tag-count proxy.
//
// Mount discipline: TagPicker is rendered ONLY when tagsPopover.value is
// true (ternary below, NOT a self-gate inside the child). This guarantees a
// fresh mount per open so:
//   - autoFocus on the search input fires every time
//   - useSignal state (cursor, attached snapshot) is fresh per open
// Same pattern as CommandPalette in App().

import type { VNode } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { useSignal } from "@preact/signals";
import { api } from "../../api/client.ts";
import { tryApi } from "../../api/errors.ts";

import type { Task } from "../../api/types.ts";
import { tagsPopover, addTagFilter } from "../../state/signals.ts";
import { closeAllPopovers, togglePopover } from "../../state/popovers.ts";
import { tip } from "../../state/tooltip.ts";
import { TagPill } from "./TagPill.tsx";
import { TagPicker } from "../pickers/TagPicker.tsx";
import { Icon } from "../Icon.tsx";

const MAX_VISIBLE_TAGS = 3;

export function TagsHeaderChip({ task }: { task: Task }): VNode {
  const pending = useSignal<Set<string>>(new Set());
  const error = useSignal<string | null>(null);
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );
  const removeTag = async (name: string): Promise<void> => {
    if (pending.peek().has(name)) return;
    const taskId = task.id;
    pending.value = new Set([...pending.peek(), name]);
    error.value = null;
    closeAllPopovers();
    try {
      // Remove this association only. Never delete the tag definition or
      // send a stale full set that could reattach another removed tag.
      await tryApi(() => api.versioned.changeTags(taskId, { remove: [name] }));
    } catch {
      if (live.current) error.value = `Could not remove #${name}. Try again.`;
    } finally {
      if (live.current) {
        const next = new Set(pending.peek());
        next.delete(name);
        pending.value = next;
      }
    }
  };
  const attached = task.tags;
  const visible = attached.slice(0, MAX_VISIBLE_TAGS);
  const overflow = attached.length - visible.length;
  const open = (e: MouseEvent): void => {
    e.stopPropagation();
    togglePopover(tagsPopover);
  };
  return (
    <div class="tags-header" style="position:relative" data-pop>
      {visible.map(name => (
        <TagPill
          key={name}
          name={name}
          onActivate={() => addTagFilter(name)}
          onRemove={() => {
            void removeTag(name);
          }}
          removeDisabled={pending.value.has(name)}
        />
      ))}
      {overflow > 0 ? (
        <button
          type="button"
          class="prop-trigger tags-overflow"
          data-pop
          aria-label={`Show all ${attached.length} tags`}
          disabled={pending.value.size > 0}
          onClick={open}
          {...tip(attached.map(n => `#${n}`).join(" "))}
        >
          +{overflow} more
        </button>
      ) : null}
      <button
        type="button"
        class="prop-trigger tags-add"
        data-pop
        aria-label="Add tags"
        aria-expanded={tagsPopover.value}
        disabled={pending.value.size > 0}
        onClick={open}
        {...tip("Add tags to this task")}
      >
        <Icon name="plus" size={13} />
      </button>
      {error.value != null ? (
        <span class="tags-error" role="alert">
          {error.value}
        </span>
      ) : null}
      {tagsPopover.value ? <TagPicker task={task} /> : null}
    </div>
  );
}
