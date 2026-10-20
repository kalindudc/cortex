/**
 * Forwards the daemon's live change stream to one renderer. Reconnects,
 * cursors and resyncs are `subscribeChanges`' job; this only reshapes each
 * LiveEvent into the frame the renderer turns back into a MessageEvent.
 */

import type { ConnectionState } from "../contracts.ts";
import { subscribeChanges } from "../subscription.ts";
import type { BridgeFrame } from "./ipc.ts";
import { socketStreamFetch } from "./socketFetch.ts";

export interface BridgeTargets {
  postFrame(frame: BridgeFrame): void;
  postState(state: ConnectionState): void;
}

/** Follow the daemon at `socketPath` until `signal` aborts. */
export function startBridge(o: { socketPath: string; targets: BridgeTargets; signal: AbortSignal }): Promise<void> {
  return subscribeChanges(
    { kind: "unix", socketPath: o.socketPath },
    event => o.targets.postFrame({ event: event.kind, data: JSON.stringify(event.payload), id: event.cursor }),
    state => o.targets.postState(state),
    o.signal,
    { fetch: socketStreamFetch },
  );
}
