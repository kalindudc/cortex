// lib/resume.ts — Resume a task's author through the main process. Main
// re-reads the task's updates and decides; the renderer's candidate list
// (state/computed.ts#resumeCandidatesForTask) only chooses what to show.

import { signal } from "@preact/signals";
import { showError } from "../api/errors.ts";

/** The last resume's outcome, shown under the Authors table of its task. */
export const resumeOutcome = signal<{ taskId: number; text: string } | null>(null);

export async function resumeSession(taskId: number, author: string): Promise<void> {
  try {
    const result = await window.cortex.resume({ taskId, author });
    if (!result.ok) {
      showError(new Error(result.error));
      return;
    }
    resumeOutcome.value = {
      taskId,
      text:
        result.harness === "bb"
          ? `Opened ${result.author.slice("bb-".length)} in bb`
          : `Copied ${result.command}: paste it into a terminal to resume that session`,
    };
  } catch (e) {
    showError(e);
  }
}
