import type { ExperimentalPanelController } from "@get-bb/plugin-sdk/app";
import { selectTask } from "../panel/selection";

export const TASK_TAB_ID = "cortex";
export const MEMORY_TAB_ID = "cortex-memory";

const tab = (id: string) => ({ id, context: { kind: "thread" as const }, availability: "action" as const });

/**
 * Opens the thread's one Cortex tab, or focuses it, on `taskId` (null follows the focus task); false when bb declined.
 * bb keys an action tab by its params, so every open is the same paramless request.
 */
export function openTaskTab(panel: Pick<ExperimentalPanelController, "openTab">, threadId: string, taskId: number | null): boolean {
  const accepted = panel.openTab({ tab: tab(TASK_TAB_ID) });
  if (accepted) selectTask(threadId, taskId);
  return accepted;
}

export function openMemoryTab(panel: Pick<ExperimentalPanelController, "openTab">): boolean {
  return panel.openTab({ tab: tab(MEMORY_TAB_ID) });
}
