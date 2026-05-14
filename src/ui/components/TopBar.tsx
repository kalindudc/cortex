// TopBar — sticky red banner that surfaces blocked tasks at app level.
// Renders only when there is at least one blocked task; clicking jumps the
// active selection to the first blocked task so the user can review it.

import type { VNode } from "preact";

import { blockedTasks } from "../state/computed.ts";
import { selectedId } from "../state/signals.ts";

export function TopBar(): VNode | null {
  const blocked = blockedTasks.value;
  if (blocked.length === 0) return null;
  const n = blocked.length;
  return (
    <div
      class="topbar blocked"
      onClick={() => {
        selectedId.value = blocked[0].id;
      }}
      title="Jump to the first blocked task"
    >
      <span>
        &#9888; {n} task{n === 1 ? "" : "s"} blocked &mdash; click to review
      </span>
    </div>
  );
}
