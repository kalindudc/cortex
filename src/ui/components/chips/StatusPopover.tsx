// StatusPopover — anchored popover listing the four task statuses.
//
// Anchor to the right edge of the status pill so the menu extends LEFT.
// The pill sits on the right side of the header (after the .grow spacer),
// so left-anchoring would overflow into the inbox pane and trigger a
// horizontal scroll on the main grid.

import type { VNode } from "preact";

import type { Task } from "../../api/types.ts";
import { statusPopover } from "../../state/signals.ts";
import { api } from "../../api/client.ts";
import { tryApi } from "../../api/errors.ts";
import { STATUS, STATUS_LABEL } from "../../lib/constants.ts";
import { Icon } from "../Icon.tsx";

export function StatusPopover({ task }: { task: Task }): VNode | null {
  if (!statusPopover.value) return null;
  // Anchor to the right edge of the status pill so the menu extends LEFT.
  // The pill sits on the right side of the header (after the .grow spacer),
  // so left-anchoring would overflow into the inbox pane and trigger a
  // horizontal scroll on the main grid.
  return (
    <div class="popover" data-pop style="top: 32px; right: 0">
      {STATUS.map(s => (
        <button
          class="popover-row"
          onClick={async () => {
            statusPopover.value = false;
            await tryApi(() => api.setStat(task.id, s));
          }}
        >
          <span class={`dot dot-status-${s}`}></span>
          <span>{STATUS_LABEL[s]}</span>
          {task.status === s ? <Icon name="checkCircle" size={12} /> : <span></span>}
        </button>
      ))}
    </div>
  );
}
