// LaneEditModal — edit a lane's name, color, and sort order. Includes the
// "Delete lane" button (gated on the lane being non-default and empty).

import type { JSX, VNode } from "preact";
import { useSignal } from "@preact/signals";

import { lanes, tasks, filters, setFilter, modal } from "../../state/signals.ts";
import { api, type EditLaneBody } from "../../api/client.ts";
import { tryApi } from "../../api/errors.ts";
import { LANE_COLORS } from "../../../lib/constants.ts";
import { onSubmitKeys } from "../../lib/keys.ts";
import { Icon } from "../Icon.tsx";
import { DialogFrame } from "./DialogFrame.tsx";

export function LaneEditModal({ name, close }: { name: string; close: () => void }): VNode | null {
  const lane = lanes.value.find(l => l.name === name);
  if (!lane) {
    close();
    return null;
  }
  const renameTo = useSignal(lane.name);
  const color = useSignal<string | null>(lane.color || null);
  const sort = useSignal(String(lane.sort));
  const isDefault = lane.name === "now";
  const inUse = tasks.value.some(t => t.lane === lane.name);
  const save = async () => {
    const fields: EditLaneBody = {};
    if (color.value !== (lane.color || null)) fields.color = color.value;
    const s = parseInt(sort.value, 10);
    if (Number.isFinite(s) && s !== lane.sort) fields.sort = s;
    if (renameTo.value && renameTo.value !== lane.name) fields.rename = renameTo.value.trim();
    if (Object.keys(fields).length === 0) {
      close();
      return;
    }
    await tryApi(() => api.editLane(lane.name, fields));
    // If we renamed and this lane was the active filter, follow the rename.
    if (fields.rename && filters.value.lane === lane.name) setFilter("lane", fields.rename);
    close();
  };
  return (
    <DialogFrame label="Edit lane" onClose={close}>
      <div class="modal" style="max-width: 420px" onKeyDown={onSubmitKeys(save)}>
        <div class="row">
          <h2 class="grow">Edit lane</h2>
          <button class="btn-icon" onClick={close}>
            <Icon name="x" />
          </button>
        </div>
        <label class="col" style="gap:4px">
          <span class="meta">Name</span>
          <input
            value={renameTo.value}
            onInput={(e: JSX.TargetedInputEvent<HTMLInputElement>) => (renameTo.value = e.currentTarget.value)}
            disabled={isDefault}
            title={isDefault ? "the 'now' lane cannot be renamed" : ""}
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
        <div class="row" style="justify-content:space-between">
          <button
            class="btn btn-danger"
            disabled={isDefault || inUse}
            title={
              isDefault
                ? "cannot delete 'now'"
                : inUse
                  ? `${tasks.value.filter(t => t.lane === lane.name).length} task(s) in this lane`
                  : "delete lane"
            }
            onClick={() => (modal.value = { kind: "confirm-lane-delete", name: lane.name })}
          >
            <Icon name="trash" size={12} />
            <span>Delete lane</span>
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
    </DialogFrame>
  );
}
