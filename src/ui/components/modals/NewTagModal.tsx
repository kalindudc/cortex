// NewTagModal — create a new tag (name + optional color).
//
// Mirrors NewLaneModal's visual shape so creation/editing feel like the
// same surface. Differences from the edit modal:
//   - Name input starts empty + must match TAG_NAME_RE before Save enables.
//   - No "Delete tag" affordance.
//   - Save calls api.addTag.
//
// Reuses LANE_COLORS and the .color-grid CSS so the palette is consistent
// with lanes (same tactile choice set).

import type { JSX, VNode } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { useSignal } from "@preact/signals";

import { api, type AddTagBody } from "../../api/client.ts";
import { tryApi } from "../../api/errors.ts";
import { LANE_COLORS, isValidTagName } from "../../../lib/constants.ts";
import { onSubmitKeys } from "../../lib/keys.ts";
import { Icon } from "../Icon.tsx";
import { DialogFrame } from "./DialogFrame.tsx";

export function NewTagModal({ close }: { close: () => void }): VNode {
  const name = useSignal("");
  const color = useSignal<string | null>(null);

  // Belt-and-suspenders autoFocus — same race TagPicker / NewLaneModal
  // document. The trigger button can steal focus back the same tick the
  // modal mounts, so we ref-focus and re-focus on the next microtask.
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    nameRef.current?.focus();
    const t = setTimeout(() => nameRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, []);

  const trimmed = name.value.trim();
  const canSave = isValidTagName(trimmed);

  const save = async () => {
    if (!canSave) return;
    const body: AddTagBody = { name: trimmed };
    if (color.value) body.color = color.value;
    await tryApi(() => api.addTag(body));
    close();
  };

  return (
    <DialogFrame label="New tag" onClose={close}>
      <div class="modal modal--narrow" onKeyDown={onSubmitKeys(save)}>
        <div class="row">
          <h2 class="grow">New tag</h2>
          <button class="btn-icon" onClick={close} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>
        <label class="col" style="gap:4px">
          <span class="meta">Name</span>
          <input
            ref={nameRef}
            value={name.value}
            placeholder="a-z, 0-9, _ @ - (1-32 chars)"
            onInput={(e: JSX.TargetedInputEvent<HTMLInputElement>) => (name.value = e.currentTarget.value)}
          />
        </label>
        <div class="col" style="gap:4px">
          <span class="meta">Color</span>
          <div class="color-grid">
            {LANE_COLORS.map(c => (
              <button
                class={`color-swatch${color.value === c ? " selected" : ""}${c === null ? " clear" : ""}`}
                style={c ? `background: ${c}` : ""}
                title={c || "auto-derived from name"}
                onClick={(e: MouseEvent) => {
                  e.preventDefault();
                  color.value = c;
                }}
              />
            ))}
          </div>
        </div>
        <div class="row" style="justify-content:flex-end">
          <button class="btn" onClick={close}>
            Cancel
          </button>
          <button
            class="btn btn-primary"
            onClick={save}
            disabled={!canSave}
            title={
              canSave
                ? "Create tag"
                : trimmed.length === 0
                  ? "Enter a name first"
                  : "Tag name must match a-z, 0-9, _ @ - (1-32 chars)"
            }
          >
            Create
          </button>
        </div>
      </div>
    </DialogFrame>
  );
}
