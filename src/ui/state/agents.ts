// state/agents.ts — the Agent tools panel's state: the last check, the action
// running and the last install or reset's outcome. Main runs the CLI
// (src/desktop/agents.ts); this module only asks it and remembers the
// answer. In memory only: the panel checks again each time it opens, and
// after every install or reset.

import { signal } from "@preact/signals";

import { type AgentsAction, type AgentsStatus, installSummary } from "../../lib/agentTools.ts";
import { showError } from "../api/errors.ts";

export const agentsStatus = signal<AgentsStatus | null>(null);
/** Why the last check failed; cleared by the next one that succeeds. */
export const agentsCheckError = signal<string | null>(null);
export const agentsBusy = signal<AgentsAction | null>(null);
export const agentsOutcome = signal<{ level: "info" | "error"; text: string } | null>(null);

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function checkAgents(): Promise<void> {
  if (agentsBusy.value !== null) return;
  agentsBusy.value = "status";
  try {
    const reply = await window.cortex.agents({ action: "status" });
    if (!reply.ok) agentsCheckError.value = reply.error;
    else if (reply.action === "status") {
      agentsStatus.value = reply.status;
      agentsCheckError.value = null;
    }
  } catch (e) {
    agentsCheckError.value = message(e);
  } finally {
    agentsBusy.value = null;
  }
}

async function write(action: "install" | "reset"): Promise<void> {
  if (agentsBusy.value !== null) return;
  agentsBusy.value = action;
  agentsOutcome.value = null;
  try {
    const reply = await window.cortex.agents({ action });
    if (!reply.ok) agentsOutcome.value = { level: "error", text: reply.error };
    else if (reply.action !== "status") agentsOutcome.value = installSummary(reply.result);
  } catch (e) {
    agentsOutcome.value = { level: "error", text: message(e) };
  } finally {
    agentsBusy.value = null;
  }
  const outcome = agentsOutcome.value;
  if (outcome?.level === "error") showError(new Error(outcome.text));
  await checkAgents();
}

/** Write every agent tool for this cortex (`cortex agents install`). */
export const installAgents = (): Promise<void> => write("install");
/** Wipe the agent tools' folders, then install (`cortex agents reset`); the caller asked the user first. */
export const resetAgents = (): Promise<void> => write("reset");
