import { useSyncExternalStore } from "react";
import type { BbNavigate } from "@get-bb/plugin-sdk/app";

export const PANEL_ACTION_ID = "cortex";

/**
 * The task each thread's Cortex tab shows, shared by every slot in this app window; null follows the focus task.
 * bb keys a panel tab by its params, so passing a task id as params would open one tab per task.
 */
const selections = new Map<string, number | null>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function selectTask(threadId: string, taskId: number | null): void {
  selections.set(threadId, taskId);
  for (const listener of listeners) listener();
}

export function useSelectedTask(threadId: string): number | null {
  return useSyncExternalStore(subscribe, () => selections.get(threadId) ?? null);
}

/** Opens the thread's one Cortex tab, or focuses it, on `taskId`; false when bb declined. */
export function openCortexTab(navigate: BbNavigate, threadId: string, taskId: number | null): boolean {
  const accepted = navigate.openThreadPanel({ actionId: PANEL_ACTION_ID });
  if (accepted) selectTask(threadId, taskId);
  return accepted;
}
