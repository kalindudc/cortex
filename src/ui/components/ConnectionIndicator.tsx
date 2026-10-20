// ConnectionIndicator — the status bar's view of liveState: whether the
// window is connecting to the daemon, receiving its changes, or showing
// data that may be out of date until the stream reconnects.

import type { VNode } from "preact";
import type { ConnectionState } from "../../contracts.ts";
import { liveState } from "../state/signals.ts";
import { tip } from "../state/tooltip.ts";

const LABELS: Record<ConnectionState, { text: string; tooltip: string }> = {
  connecting: { text: "connecting", tooltip: "Connecting to the cortex daemon" },
  live: { text: "live", tooltip: "Receiving changes from the cortex daemon" },
  stale: {
    text: "stale \u00b7 reconnecting",
    tooltip: "Connection lost; shown data may be out of date until it reconnects",
  },
};

export function ConnectionIndicator(): VNode {
  const state = liveState.value;
  const label = LABELS[state];
  return (
    <span class="conn" data-state={state} role="status" {...tip(label.tooltip)}>
      {label.text}
    </span>
  );
}
