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
import { lanePopover } from "../../state/signals.ts";
import { togglePopover } from "../../state/popovers.ts";
import { laneColor } from "../../lib/color.ts";
import { LanePicker } from "../pickers/LanePicker.tsx";

export function LaneChipButton({ task }: { task: Task }): VNode {
  return (
    <div style="position:relative" data-pop>
      <button
        class="lane-chip lane-chip-button"
        data-pop
        draggable={true}
        title={`Lane: ${task.lane} — click to move, drag to reorder`}
        onDragStart={(e: DragEvent) => e.dataTransfer!.setData("application/x-cortex-task-id", String(task.id))}
        onClick={(e: MouseEvent) => {
          e.stopPropagation();
          togglePopover(lanePopover);
        }}
      >
        {laneColor(task.lane) ? <span class="lane-color" style={`background: ${laneColor(task.lane)}`}></span> : null}
        <span>{task.lane}</span>
      </button>
      {lanePopover.value ? <LanePicker task={task} /> : null}
    </div>
  );
}
