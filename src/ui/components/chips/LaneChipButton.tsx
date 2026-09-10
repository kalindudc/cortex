// LaneChipButton — active-task lane chip.
//
// Renders the lane color dot + name as a button that (a) opens a popover
// listing all lanes for one-click moves, and (b) is the drag source for
// moving the active task into another lane via the sidebar. The drag
// handler used to live on the title <h2>, but the title is now an editable
// <input> — dragging text would interfere with selection — so the gesture
// moved here onto a surface that already visually represents lane
// membership.
//
// HTML5 DnD + onClick coexist: the browser does NOT fire `click` after a
// successful drag, so the popover does not pop after a drag. Do NOT call
// e.preventDefault() in either handler — that would break the coexistence.

import type { VNode } from "preact";

import type { Task } from "../../api/types.ts";
import { lanePopover, draggedTaskId } from "../../state/signals.ts";
import { togglePopover } from "../../state/popovers.ts";
import { laneColor } from "../../lib/color.ts";
import { LanePicker } from "../pickers/LanePicker.tsx";
import { Icon } from "../Icon.tsx";

export function LaneChipButton({ task }: { task: Task }): VNode {
  return (
    <div style="position:relative" data-pop>
      <button
        class="prop-trigger lane-chip-button"
        data-pop
        draggable={true}
        title={`Lane: ${task.lane} — click to move, or drag onto a lane`}
        onDragStart={(e: DragEvent) => {
          e.dataTransfer?.setData("application/x-cortex-task-id", String(task.id));
          // Reveal the sidebar's transient Move-to-lane tray (W5).
          draggedTaskId.value = task.id;
        }}
        onDragEnd={() => {
          draggedTaskId.value = null;
        }}
        onClick={(e: MouseEvent) => {
          e.stopPropagation();
          togglePopover(lanePopover);
        }}
      >
        <span class="prop-label">Lane:</span>
        {laneColor(task.lane) ? <span class="lane-color" style={`background: ${laneColor(task.lane)}`}></span> : null}
        <span class="prop-value">{task.lane}</span>
        <Icon name="chevronDown" size={10} />
      </button>
      {lanePopover.value ? <LanePicker task={task} /> : null}
    </div>
  );
}
