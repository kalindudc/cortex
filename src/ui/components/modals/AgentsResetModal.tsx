// AgentsResetModal — asks before the Agent tools panel's Reset: the folders
// it deletes (from the last check) and, when bb runs, that the bb plugin's
// settings are cleared. Confirming closes the dialog and starts the reset;
// the panel shows its progress and outcome.

import type { VNode } from "preact";

import { agentsStatus, resetAgents } from "../../state/agents.ts";
import { DialogFrame } from "./DialogFrame.tsx";

export function AgentsResetModal({ close }: { close: () => void }): VNode {
  const status = agentsStatus.value;
  const bb = status !== null && status.bb.state !== "skipped";
  const dirs = status
    ? [
        ...status.skills.map(s => s.dir),
        ...status.extensions.map(e => e.dir),
        ...(bb && status.bb.dir ? [status.bb.dir] : []),
      ]
    : [];
  return (
    <DialogFrame label="Reset agent tools" onClose={close}>
      <div class="modal">
        <h2>Reset the agent tools?</h2>
        <p class="meta" style="margin:0">
          Cortex deletes these folders, then installs them again. Hand-edits in them are lost.
        </p>
        <ul class="agents-reset-dirs">
          {dirs.map(dir => (
            <li class="mono" key={dir}>
              {dir}
            </li>
          ))}
        </ul>
        {bb ? (
          <p class="meta" style="margin:0">
            The bb plugin is removed from bb and installed again, which resets its settings, such as{" "}
            <code>cortexPath</code>.
          </p>
        ) : null}
        <div class="modal-actions">
          <button type="button" class="btn" onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            class="btn btn-primary"
            style="background:var(--err)"
            onClick={() => {
              close();
              void resetAgents();
            }}
          >
            Reset
          </button>
        </div>
      </div>
    </DialogFrame>
  );
}
