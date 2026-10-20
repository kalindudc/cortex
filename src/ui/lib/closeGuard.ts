// lib/closeGuard.ts — the renderer half of the desktop close guard.
//
// Main guards closing, reloading and quitting while drafts are unsaved
// (src/desktop/draftGuard.ts), so it needs the current counts: they are
// reported on every change. Its Save all is answered by saving every mounted
// draft. A database change turns every unsaved draft into an orphan, so it
// is never written to a task of another database. Once the user chose to
// leave, main asks the page to stop warning before unload, so the reload,
// close or quit that follows is not cancelled by the page's own warning.

import { effect } from "@preact/signals";

import { onDatabaseChange } from "../state/refresh.ts";
import { dirtyCount, orphanCount, pruneTaskDrafts, releaseUnloadWarning, saveAllDrafts } from "./useTaskDraft.ts";

export function startCloseGuard(): () => void {
  const drafts = window.cortex.drafts;
  const stopReport = effect(() => drafts.report({ dirty: dirtyCount.value, orphaned: orphanCount.value }));
  const stopSaveAll = drafts.onSaveAll(saveAllDrafts);
  const stopRelease = drafts.onRelease(releaseUnloadWarning);
  const stopDatabase = onDatabaseChange(() => pruneTaskDrafts([]));
  return () => {
    stopReport();
    stopSaveAll();
    stopRelease();
    stopDatabase();
  };
}
