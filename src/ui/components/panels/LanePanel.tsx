// LanePanel — the Lanes view's main area: the lane the list shows
// (shownLane), its tasks by status, its name, colour and position with one
// Save, and its delete section. Creating a lane stays in NewLaneModal (the
// list's "+"), and deleting still goes through the confirm-lane-delete
// dialog.
//
// Edits use the same non-versioned write as the old edit dialog
// (api.editLane with only the changed fields); a rename follows the lane
// filter and the panel's selection.

import type { JSX, VNode } from "preact";
import { useSignal } from "@preact/signals";

import type { Lane, TaskStatus } from "../../api/types.ts";
import { api, type EditLaneBody } from "../../api/client.ts";
import { tryApi } from "../../api/errors.ts";
import { filters, modal, selectedLane, setFilter, tasks, view } from "../../state/signals.ts";
import { shownLane } from "../../state/computed.ts";
import { LANE_COLORS, STATUS, STATUS_LABEL } from "../../../lib/constants.ts";
import { plural } from "../../../lib/format.ts";
import { onSubmitKeys } from "../../lib/keys.ts";
import { Icon } from "../Icon.tsx";
import { PanelSheet } from "./PanelSheet.tsx";

function LaneForm({ lane }: { lane: Lane }): VNode {
  const renameTo = useSignal(lane.name);
  const color = useSignal<string | null>(lane.color || null);
  const sort = useSignal(String(lane.sort));
  const isDefault = lane.name === "now";

  const fields = (): EditLaneBody => {
    const out: EditLaneBody = {};
    if (color.value !== (lane.color || null)) out.color = color.value;
    const s = Number.parseInt(sort.value, 10);
    if (Number.isFinite(s) && s !== lane.sort) out.sort = s;
    const name = renameTo.value.trim();
    if (name && name !== lane.name) out.rename = name;
    return out;
  };
  const changed = Object.keys(fields()).length > 0;

  const discard = (): void => {
    renameTo.value = lane.name;
    color.value = lane.color || null;
    sort.value = String(lane.sort);
  };
  const save = async (): Promise<void> => {
    const patch = fields();
    if (Object.keys(patch).length === 0) return;
    try {
      await tryApi(() => api.editLane(lane.name, patch));
    } catch {
      return; // tryApi has shown the error; the form keeps the user's edits
    }
    if (patch.rename) {
      if (filters.value.lane === lane.name) setFilter("lane", patch.rename);
      selectedLane.value = patch.rename;
    }
  };

  return (
    <div class="panel-card" onKeyDown={onSubmitKeys(() => void save())}>
      <div class="panel-row">
        <label class="panel-row-label" for="lane-panel-name">
          <b>Name</b>
          <span>Renaming moves every task with it.</span>
        </label>
        <input
          id="lane-panel-name"
          class="panel-input"
          aria-label="Lane name"
          value={renameTo.value}
          onInput={(e: JSX.TargetedInputEvent<HTMLInputElement>) => (renameTo.value = e.currentTarget.value)}
          disabled={isDefault}
          title={isDefault ? "the 'now' lane cannot be renamed" : ""}
        />
      </div>
      <div class="panel-row panel-row-top">
        <div class="panel-row-label">
          <b>Colour</b>
          <span>Shown in the task list, headers and filters.</span>
        </div>
        <div class="color-grid">
          {LANE_COLORS.map(c => (
            <button
              type="button"
              key={c ?? "none"}
              class={`color-swatch${color.value === c ? " selected" : ""}${c === null ? " clear" : ""}`}
              style={c ? `background: ${c}` : ""}
              title={c || "no color"}
              aria-label={c ? `Colour ${c}` : "No colour"}
              aria-pressed={color.value === c}
              onClick={() => (color.value = c)}
            />
          ))}
        </div>
      </div>
      <div class="panel-row">
        <label class="panel-row-label" for="lane-panel-position">
          <b>Position</b>
          <span>Lower numbers come first in lists and groups.</span>
        </label>
        <input
          id="lane-panel-position"
          class="panel-input panel-input-number num"
          type="number"
          aria-label="Position"
          value={sort.value}
          onInput={(e: JSX.TargetedInputEvent<HTMLInputElement>) => (sort.value = e.currentTarget.value)}
        />
      </div>
      <div class="panel-row panel-row-foot">
        <button type="button" class="btn btn-ghost" disabled={!changed} onClick={discard}>
          Discard changes
        </button>
        <button type="button" class="btn btn-primary" disabled={!changed} onClick={() => void save()}>
          Save changes
        </button>
      </div>
    </div>
  );
}

export function LanePanel(): VNode {
  const lane = shownLane.value;
  if (!lane) {
    return (
      <section class="pane panel-view lane-panel" aria-label="Lanes">
        <header class="panel-head">
          <div class="panel-crumb">
            <b>Lanes</b>
          </div>
        </header>
        <PanelSheet>
          <div class="empty">
            <Icon name="layers" size={32} />
            <div class="empty-title">No lanes yet</div>
            <div class="empty-sub">Create one with the + button beside "Lanes".</div>
          </div>
        </PanelSheet>
      </section>
    );
  }

  const inLane = tasks.value.filter(t => t.lane === lane.name);
  const counts = Object.fromEntries(STATUS.map(s => [s, inLane.filter(t => t.status === s).length])) as Record<
    TaskStatus,
    number
  >;
  const notDone = inLane.length - counts.done;
  const isDefault = lane.name === "now";
  const reason = isDefault
    ? "The default lane, now, cannot be deleted."
    : inLane.length > 0
      ? `Move its ${plural(inLane.length, "task")} to another lane first; only an empty lane can be deleted.`
      : "It has no tasks, so it can be deleted.";

  return (
    <section class="pane panel-view lane-panel" aria-label={`Lane ${lane.name}`}>
      <header class="panel-head">
        <div class="panel-crumb">
          <span>Lanes</span>
          <Icon name="chevronRight" size={12} />
          <b>{lane.name}</b>
        </div>
        <span class="grow"></span>
        <button
          type="button"
          class="btn"
          aria-label={`Show tasks in ${lane.name}`}
          onClick={() => {
            setFilter("lane", lane.name);
            view.value = "tasks";
          }}
        >
          Show its tasks
        </button>
      </header>
      <PanelSheet>
        <div class="panel-inner">
          <h1 class="panel-title">
            <span class="lane-color panel-title-swatch" style={lane.color ? `background: ${lane.color}` : ""}></span>
            {lane.name}
          </h1>
          <p class="panel-lede">
            {plural(inLane.length, "task")}, {notDone} not done.
          </p>

          <h2 class="panel-card-title">Breakdown</h2>
          <div class="panel-card panel-card-pad">
            <div class="breakdown-bar" aria-hidden="true">
              {STATUS.filter(s => counts[s] > 0).map(s => (
                <i key={s} class={`breakdown-seg breakdown-${s}`} style={`flex-grow: ${counts[s]}`}></i>
              ))}
            </div>
            <ul class="breakdown-legend" aria-label="Tasks by status">
              {STATUS.map(s => (
                <li key={s} data-status={s}>
                  <span class={`dot dot-status-${s}`} aria-hidden="true"></span>
                  <span>
                    {counts[s]} {STATUS_LABEL[s].toLowerCase()}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <h2 class="panel-card-title">Lane</h2>
          <LaneForm key={lane.name} lane={lane} />

          <h2 class="panel-card-title">Delete</h2>
          <div class="panel-card">
            <div class="panel-row">
              <div class="panel-row-label">
                <b>Delete this lane</b>
                <span class="lane-delete-reason">{reason}</span>
              </div>
              <button
                type="button"
                class="btn btn-danger"
                disabled={isDefault || inLane.length > 0}
                onClick={() => (modal.value = { kind: "confirm-lane-delete", name: lane.name })}
              >
                <Icon name="trash" size={12} />
                <span>Delete lane</span>
              </button>
            </div>
          </div>
        </div>
      </PanelSheet>
    </section>
  );
}
