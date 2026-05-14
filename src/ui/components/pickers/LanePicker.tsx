// LanePicker — built on the generic Picker primitive: search input + arrow
// nav + Enter to select. Single-select (replace, not toggle); clicking or
// Entering a row moves the task to that lane and closes the picker. No
// create-row affordance — new lanes are managed via the sidebar's New Lane
// flow; auto-creating from inside the picker would conflate "move to
// existing" and "create new" intents on the same surface.

import type { VNode } from "preact";

import type { Task, Lane } from "../../api/types.ts";
import { lanes, lanePopover } from "../../state/signals.ts";
import { api } from "../../api/client.ts";
import { tryApi } from "../../api/errors.ts";
import { Picker } from "./Picker.tsx";
import { Icon } from "../Icon.tsx";

export function LanePicker({ task }: { task: Task }): VNode {
  // Sort by name for predictable ordering. lanes.value is API-order
  // (insertion); the picker uses alphabetical so search hits feel stable.
  const sorted = [...lanes.value].sort((a, b) => a.name.localeCompare(b.name));
  const select = (l: Lane) => {
    lanePopover.value = false;
    if (l.name === task.lane) return;
    tryApi(() => api.moveLane(task.id, l.name));
  };
  return (
    <Picker<Lane>
      items={sorted}
      filterText={l => l.name}
      isSelected={l => l.name === task.lane}
      onSelect={select}
      placeholder="Search lanes…"
      emptyText="no lanes match"
      className="lane-picker"
      renderRow={({ item: l, isSelected, isCursor, onClick, onMouseMove }) => (
        <button
          class={`picker-row${isSelected ? " selected" : ""}${isCursor ? " cursor" : ""}`}
          onClick={onClick}
          onMouseMove={onMouseMove}
          title={isSelected ? "Current lane" : `Move to ${l.name}`}
        >
          <span class="picker-check">{isSelected ? <Icon name="check" size={12} /> : null}</span>
          <span class="lane-color" style={l.color ? `background: ${l.color}` : "background: var(--border)"}></span>
          <span>{l.name}</span>
        </button>
      )}
    />
  );
}
