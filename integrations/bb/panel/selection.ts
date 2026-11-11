import { useSyncExternalStore } from "react";

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
