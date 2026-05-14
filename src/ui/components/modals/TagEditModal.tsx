// TagEditModal — mirrors LaneEditModal: rename, color picker (reuses
// LANE_COLORS palette and .color-grid CSS), delete (cascades join rows when
// in-use; the confirm step gives the user the impact count). Tag names are
// validated server-side against TAG_NAME_RE; we display the resulting error
// via the existing toast.

import type { VNode } from "preact";
import { useSignal } from "@preact/signals";

import { tags, selectedTag, modal } from "../../state/signals.ts";
import { api, type EditTagBody } from "../../api/client.ts";
import { tryApi } from "../../api/errors.ts";
import { LANE_COLORS } from "../../lib/constants.ts";
import { onSubmitKeys } from "../../lib/keys.ts";
import { Icon } from "../Icon.tsx";

export function TagEditModal({ name, close }: { name: string; close: () => void }): VNode | null {
  const tg = tags.value.find(t => t.name === name);
  if (!tg) {
    close();
    return null;
  }
  const renameTo = useSignal(tg.name);
  const color = useSignal<string | null>(tg.color || null);
  const taskCount = tg.task_count ?? 0;
  const save = async () => {
    const fields: EditTagBody = {};
    if (color.value !== (tg.color || null)) fields.color = color.value;
    if (renameTo.value && renameTo.value !== tg.name) fields.rename = renameTo.value.trim();
    if (Object.keys(fields).length === 0) {
      close();
      return;
    }
    await tryApi(() => api.editTag(tg.name, fields));
    // Follow the rename if this tag was the active filter.
    if (fields.rename && selectedTag.value === tg.name) selectedTag.value = fields.rename;
    close();
  };
  return (
    <div
      class="overlay"
      onClick={(e: MouseEvent) => {
        if ((e.target as HTMLElement).classList.contains("overlay")) close();
      }}
    >
      <div class="modal" style="max-width: 420px" onKeyDown={onSubmitKeys(save)}>
        <div class="row">
          <h2 class="grow">Edit tag</h2>
          <button class="btn-icon" onClick={close}>
            <Icon name="x" />
          </button>
        </div>
        <label class="col" style="gap:4px">
          <span class="meta">Name</span>
          <input
            value={renameTo.value}
            onInput={(e: any) => (renameTo.value = e.currentTarget.value)}
            placeholder="a-z, 0-9, _ @ - (1-32 chars)"
          />
        </label>
        <div class="col" style="gap:4px">
          <span class="meta">Color</span>
          <div class="color-grid">
            {LANE_COLORS.map(c => (
              <button
                class={"color-swatch" + (color.value === c ? " selected" : "") + (c === null ? " clear" : "")}
                style={c ? `background: ${c}` : ""}
                title={c || "no color"}
                onClick={(e: MouseEvent) => {
                  e.preventDefault();
                  color.value = c;
                }}
              />
            ))}
          </div>
        </div>
        <div class="row" style="justify-content:space-between">
          <button
            class="btn btn-danger"
            title={
              taskCount > 0
                ? `${taskCount} task${taskCount === 1 ? " carries" : "s carry"} this tag (delete cascades)`
                : "delete tag"
            }
            onClick={() => (modal.value = { kind: "confirm-tag-delete", name: tg.name, taskCount })}
          >
            <Icon name="trash" size={12} />
            <span>Delete tag</span>
          </button>
          <div class="row">
            <button class="btn" onClick={close}>
              Cancel
            </button>
            <button class="btn btn-primary" onClick={save}>
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
