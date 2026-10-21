// NewLaneModal — create a new lane (name + optional color + sort).
//
// Uses the lane panel's fields (name, colour, position) in a short dialog.
// Differences from the panel:
//   - Name input starts empty and is required (Save disabled when blank).
//   - No "Delete lane" affordance.
//   - Save calls api.addLane (returns the created Lane).
//
// Sort defaults to (max(existing lane.sort) + 1) so new lanes sort to the
// bottom of the list \u2014 matches the implicit ordering users would expect
// when they create the next bucket.

import type { JSX, VNode } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { useSignal } from "@preact/signals";

import { lanes } from "../../state/signals.ts";
import { api, type AddLaneBody } from "../../api/client.ts";
import { tryApi } from "../../api/errors.ts";
import { LANE_COLORS } from "../../../lib/constants.ts";
import { onSubmitKeys } from "../../lib/keys.ts";
import { Icon } from "../Icon.tsx";
import { DialogFrame } from "./DialogFrame.tsx";

export function NewLaneModal({ close }: { close: () => void }): VNode {
  const name = useSignal("");
  const color = useSignal<string | null>(null);
  // Default sort: next slot after the current max so new lanes append.
  const defaultSort = lanes.value.reduce((m, l) => Math.max(m, l.sort + 1), 0);
  const sort = useSignal(String(defaultSort));

  // Autofocus the name input on mount. Same race TagPicker documents \u2014
  // the trigger button can steal focus back the same tick the modal mounts,
  // so belt-and-suspenders ref + setTimeout.
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    nameRef.current?.focus();
    const t = setTimeout(() => nameRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, []);

  const trimmed = name.value.trim();
  const canSave = trimmed.length > 0;

  const save = async () => {
    if (!canSave) return;
    const body: AddLaneBody = { name: trimmed };
    if (color.value) body.color = color.value;
    const s = parseInt(sort.value, 10);
    if (Number.isFinite(s)) body.sort = s;
    await tryApi(() => api.addLane(body));
    close();
  };

  return (
    <DialogFrame label="New lane" onClose={close}>
      <div class="modal modal--narrow" onKeyDown={onSubmitKeys(save)}>
        <div class="row">
          <h2 class="grow">New lane</h2>
          <button class="btn-icon" onClick={close} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>
        <label class="col" style="gap:4px">
          <span class="meta">Name</span>
          <input
            ref={nameRef}
            value={name.value}
            placeholder="lane name"
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
                title={c || "no color"}
                onClick={(e: MouseEvent) => {
                  e.preventDefault();
                  color.value = c;
                }}
              />
            ))}
          </div>
        </div>
        <label class="col" style="gap:4px">
          <span class="meta">
            Sort order{" "}
            <span class="meta" style="opacity:0.7">
              (lower = higher in the list)
            </span>
          </span>
          <input
            type="number"
            value={sort.value}
            onInput={(e: JSX.TargetedInputEvent<HTMLInputElement>) => (sort.value = e.currentTarget.value)}
          />
        </label>
        <div class="row" style="justify-content:flex-end">
          <button class="btn" onClick={close}>
            Cancel
          </button>
          <button
            class="btn btn-primary"
            onClick={save}
            disabled={!canSave}
            title={canSave ? "Create lane" : "Enter a name first"}
          >
            Create
          </button>
        </div>
      </div>
    </DialogFrame>
  );
}
