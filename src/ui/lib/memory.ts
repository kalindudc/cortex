// Keeping a task out of what agent memory offers, or letting memory offer it
// again: one versioned write (`versioned.setMemory`) and a notice for each outcome.

import { api } from "../api/client.ts";
import { showNotice } from "../state/notice.ts";
import { tasks } from "../state/signals.ts";

export async function setTaskMemory(id: number, excluded: boolean): Promise<void> {
  // The live row, not the one the palette was built from: a write since then may have changed it.
  const shown = tasks.value.find(t => t.id === id);
  if (shown === undefined) throw new Error(`@${id} is no longer in the workspace`);
  if (shown.memory_excluded === excluded) {
    showNotice(`@${id} is already ${excluded ? "out of" : "in"} agent memory`);
    return;
  }
  await api.versioned.setMemory(id, { excluded });
  showNotice(
    excluded ? `@${id} is out of agent memory; reading it by id still works` : `@${id} is back in agent memory`,
  );
}
