// lib/useTaskDraft.ts — THE task draft owner (task 330, D1–D3).
//
// One hook instance per mounted task (TaskDocument keys by task id).
// Header (title), CodeMirror editor and rendered preview all consume the
// SAME draft: local text, per-field external-conflict values, an explicit
// body replacement epoch (the only thing besides task id that may remount
// the editor — D4), and a saveState derived from ACTUAL request
// acknowledgements.
//
// Reconciliation per field (local / server-baseline / incoming):
//   incoming === baseline            → echo/no-op
//   incoming === local               → converge (our own write came back)
//   local === baseline               → clean live update (adopt; body bumps epoch)
//   else                             → conflict: keep BOTH, pause unsent
//                                      autosaves until Apply / Keep (D3)
//
// Persistence of unsaved work is IN-MEMORY per task id (never browser
// storage): snapshots record the local text and the server baseline it was
// edited against, survive navigation, are released once clean, and are
// pruned when a task is confirmed deleted (pruneTaskDrafts). While any
// unsaved work exists, a beforeunload warning is armed (D2).

import { useEffect, useMemo, useRef } from "preact/hooks";
import { useSignal } from "@preact/signals";
import type { Task } from "../api/types.ts";
import { api } from "../api/client.ts";
import { tryApi } from "../api/errors.ts";
import { useAutosave, type AutosaveApi, type Scheduler } from "./autosave.ts";

export type DraftField = "title" | "body";
export type SaveState = "saved" | "pending" | "saving" | "error";

export interface TaskDraft {
  title: string;
  body: string;
  bodyEpoch: number;
  saveState: SaveState;
  external: Record<DraftField, string | null>;
  set(field: DraftField, value: string): void;
  flush(): void;
  retry(): void;
  apply(field: DraftField): void;
  keep(field: DraftField): void;
}

// ---------------------------------------------------------------------------
// Module-level task-keyed draft memory (D2)
// ---------------------------------------------------------------------------

interface FieldSnapshot {
  local: string;
  base: string; // server baseline the local text was edited against
}
type DraftSnapshot = Partial<Record<DraftField, FieldSnapshot>>;

const draftMemory = new Map<number, DraftSnapshot>();
const unsavedTasks = new Set<number>();

function beforeUnloadHandler(e: BeforeUnloadEvent): void {
  e.preventDefault();
  e.returnValue = ""; // legacy Chrome requires a set returnValue
}
let unloadArmed = false;
function syncUnloadWarning(): void {
  const want = unsavedTasks.size > 0;
  if (want === unloadArmed) return;
  unloadArmed = want;
  if (typeof window === "undefined") return;
  if (want) window.addEventListener("beforeunload", beforeUnloadHandler);
  else window.removeEventListener("beforeunload", beforeUnloadHandler);
}

function writeSnapshot(taskId: number, field: DraftField, snap: FieldSnapshot | null): void {
  const entry = draftMemory.get(taskId) ?? {};
  if (snap == null) delete entry[field];
  else entry[field] = snap;
  if (entry.title == null && entry.body == null) draftMemory.delete(taskId);
  else draftMemory.set(taskId, entry);
}

function markUnsaved(taskId: number, unsaved: boolean): void {
  if (unsaved) unsavedTasks.add(taskId);
  else unsavedTasks.delete(taskId);
  syncUnloadWarning();
}

/** True while any task holds unsaved/failed draft work (drives beforeunload). */
export function hasUnsavedDrafts(): boolean {
  return unsavedTasks.size > 0;
}

/**
 * Drop draft memory for tasks that no longer exist (confirmed deletions).
 * Callers pass the CURRENT live task ids; anything else is pruned.
 */
export function pruneTaskDrafts(liveIds: Iterable<number>): void {
  const live = new Set(liveIds);
  for (const id of [...draftMemory.keys()]) if (!live.has(id)) draftMemory.delete(id);
  for (const id of [...unsavedTasks]) if (!live.has(id)) unsavedTasks.delete(id);
  syncUnloadWarning();
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useTaskDraft(task: Task, scheduler?: Scheduler): TaskDraft {
  const taskId = task.id;
  const serverTitle = task.title;
  const serverBody = task.body || "";

  // Seed from recovered snapshots (computed once per mount; the hook lives
  // and dies with its task's mounted lifetime).
  const seed = useMemo(() => {
    const snap = draftMemory.get(taskId);
    const restore = (field: DraftField, server: string): { local: string; conflict: string | null } => {
      const s = snap?.[field];
      if (s == null || s.local === server) return { local: server, conflict: null };
      // Server unchanged since the interrupted edit → clean recovery
      // (re-queued below). Server moved → surface the conflict instead of
      // silently overwriting either side.
      if (s.base === server) return { local: s.local, conflict: null };
      return { local: s.local, conflict: server };
    };
    return {
      title: restore("title", serverTitle),
      body: restore("body", serverBody),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  const titleLocal = useSignal(seed.title.local);
  const bodyLocal = useSignal(seed.body.local);
  const titleServer = useSignal(serverTitle);
  const bodyServer = useSignal(serverBody);
  const titleExternal = useSignal<string | null>(seed.title.conflict);
  const bodyExternal = useSignal<string | null>(seed.body.conflict);
  const bodyEpoch = useSignal(0);
  const saveState = useSignal<SaveState>("saved");

  // Liveness guard. Writing component-subscribed signals during the
  // unmount flush enqueues a re-render of the DYING component and crashes
  // preact's render queue (vnode parent already nulled). This cleanup is
  // registered BEFORE the useAutosave hooks so it flips first on unmount;
  // the flush that follows still PATCHes and maintains the module-level
  // draft memory, but skips all signal writes.
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  // Imperative per-field bookkeeping (not render state).
  const flight = useRef<
    Record<DraftField, { inFlight: boolean; trailing: boolean; errored: boolean; revision: number }>
  >({
    title: { inFlight: false, trailing: false, errored: false, revision: 0 },
    body: { inFlight: false, trailing: false, errored: false, revision: 0 },
  });

  const sig = (field: DraftField) =>
    field === "title"
      ? { local: titleLocal, server: titleServer, external: titleExternal }
      : { local: bodyLocal, server: bodyServer, external: bodyExternal };

  // Imperative reads use peek() throughout — these code paths run from
  // timers, promise continuations and unmount cleanups where a tracked
  // read could accidentally subscribe whatever rendering context happens
  // to be open. Subscription is the getters' job (bottom of the hook).
  const recomputeState = (): void => {
    const f = flight.current;
    const dirty = (field: DraftField): boolean => sig(field).local.peek() !== sig(field).server.peek();
    const unsaved =
      f.title.inFlight || f.body.inFlight || f.title.errored || f.body.errored || dirty("title") || dirty("body");
    markUnsaved(taskId, unsaved);
    if (!alive.current) return; // never re-render a dying component
    let next: SaveState = "saved";
    if (f.title.errored || f.body.errored) next = "error";
    else if (f.title.inFlight || f.body.inFlight) next = "saving";
    else if (dirty("title") || dirty("body") || titleExternal.peek() != null || bodyExternal.peek() != null)
      next = "pending";
    saveState.value = next;
  };

  const updateSnapshot = (field: DraftField): void => {
    const s = sig(field);
    if (s.local.peek() === s.server.peek()) writeSnapshot(taskId, field, null);
    else writeSnapshot(taskId, field, { local: s.local.peek(), base: s.server.peek() });
  };

  // One serialized save runner per field: at most one PATCH in flight,
  // exactly one trailing save carrying the LATEST text (D2).
  const runSave = async (field: DraftField): Promise<void> => {
    const s = sig(field);
    const m = flight.current[field];
    if (s.external.peek() != null) return; // paused by an unresolved conflict
    if (m.inFlight) {
      m.trailing = true;
      return;
    }
    const value = s.local.peek();
    if (value === s.server.peek() && !m.errored) {
      recomputeState();
      return;
    }
    m.inFlight = true;
    m.errored = false;
    const revisionAtStart = m.revision;
    const prevServer = s.server.peek();
    // Optimistic baseline: our own SSE echo then classifies as a no-op
    // instead of an external change (D3). Skipped once unmounted — the
    // baseline signal dies with the instance; draft memory is the record.
    if (alive.current) s.server.value = value;
    recomputeState(); // → saving
    try {
      await tryApi(() => api.editTask(taskId, field === "title" ? { title: value } : { body: value || null }));
      m.inFlight = false;
      if (m.revision !== revisionAtStart) m.trailing = true; // newer text exists — never label it Saved
      if (!alive.current) {
        // Ack after unmount: the local text reached the server — release
        // the recovery snapshot (unless newer text was typed, which cannot
        // happen post-unmount).
        writeSnapshot(taskId, field, null);
        markUnsaved(taskId, false);
      }
    } catch {
      // tryApi already reported the error; restore the baseline so the
      // dirty check stays truthful. The recovery snapshot keeps the local
      // text (with its pre-save baseline) either way.
      m.inFlight = false;
      m.trailing = false;
      m.errored = true;
      if (alive.current) s.server.value = prevServer;
      else {
        writeSnapshot(taskId, field, { local: value, base: prevServer });
        markUnsaved(taskId, true);
        return;
      }
    }
    const wantTrailing = m.trailing;
    m.trailing = false;
    updateSnapshot(field);
    recomputeState();
    if (wantTrailing && !m.errored) void runSave(field);
  };

  const titleSave = useAutosave(() => void runSave("title"), undefined, undefined, scheduler);
  const bodySave = useAutosave(() => void runSave("body"), undefined, undefined, scheduler);
  const autosaveOf = (field: DraftField): AutosaveApi => (field === "title" ? titleSave : bodySave);

  // Recovered-but-clean-base snapshots are unsaved work: re-queue the
  // interrupted save on mount (debounced; a failure lands in error state).
  useEffect(() => {
    if (seed.title.conflict == null && seed.title.local !== serverTitle) {
      flight.current.title.revision++;
      titleSave.schedule();
    }
    if (seed.body.conflict == null && seed.body.local !== serverBody) {
      flight.current.body.revision++;
      bodySave.schedule();
    }
    recomputeState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  // SSE reconciliation (see header). Runs whenever the server-sourced prop
  // changes under this mounted task.
  const reconcile = (field: DraftField, incoming: string): void => {
    const s = sig(field);
    if (incoming === s.server.peek()) return; // echo / steady state
    if (incoming === s.local.peek()) {
      s.server.value = incoming; // converge — our text, their ack
      s.external.value = null;
      updateSnapshot(field);
      recomputeState();
      return;
    }
    if (s.local.peek() === s.server.peek()) {
      s.local.value = incoming; // clean live update
      s.server.value = incoming;
      s.external.value = null;
      if (field === "body") bodyEpoch.value++;
      updateSnapshot(field);
      recomputeState();
      return;
    }
    // Conflict: retain both; pause unsent autosaves until Apply/Keep (D3).
    s.external.value = incoming;
    autosaveOf(field).cancel();
    updateSnapshot(field);
    recomputeState();
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => reconcile("title", serverTitle), [serverTitle]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => reconcile("body", serverBody), [serverBody]);

  const set = (field: DraftField, value: string): void => {
    const s = sig(field);
    // Title is a single-line semantic field even on a wrapping textarea.
    const v = field === "title" ? value.replace(/\n+/g, " ") : value;
    if (v === s.local.peek()) return;
    s.local.value = v;
    flight.current[field].revision++;
    updateSnapshot(field);
    if (s.external.peek() == null) autosaveOf(field).schedule();
    recomputeState();
  };

  const flush = (): void => {
    titleSave.flush();
    bodySave.flush();
  };

  const retry = (): void => {
    for (const field of ["title", "body"] as DraftField[]) {
      if (flight.current[field].errored) void runSave(field);
    }
  };

  const apply = (field: DraftField): void => {
    const s = sig(field);
    const incoming = s.external.peek();
    if (incoming == null) return;
    autosaveOf(field).cancel(); // superseded pending work dies here
    flight.current[field].revision++;
    flight.current[field].errored = false;
    s.local.value = incoming;
    s.server.value = incoming;
    s.external.value = null;
    if (field === "body") bodyEpoch.value++;
    updateSnapshot(field);
    recomputeState();
  };

  const keep = (field: DraftField): void => {
    const s = sig(field);
    if (s.external.peek() == null) return;
    s.external.value = null;
    // The external text is what the server currently has — reflect that
    // baseline, then explicitly queue OUR text over it (D3: an explicit
    // decision, not a silent overwrite).
    recomputeState();
    void runSave(field);
  };

  // Release clean entries after unmount; keep dirty/failed snapshots for
  // recovery. The unmount flush (useAutosave) fires first and its async
  // completion updates the snapshot through the captured closures.
  useEffect(
    () => () => {
      const entry = draftMemory.get(taskId);
      const clean = entry == null || (entry.title == null && entry.body == null);
      if (clean) markUnsaved(taskId, false);
    },
    [taskId],
  );

  // LIVE GETTERS, not eager reads: a consumer subscribes to exactly the
  // signals whose properties it touches during ITS render, and the hook's
  // own host component subscribes to nothing (so imperative writes during
  // unmount-flush cannot re-render a dying component). Tests get
  // synchronous reads for free.
  return {
    get title() {
      return titleLocal.value;
    },
    get body() {
      return bodyLocal.value;
    },
    get bodyEpoch() {
      return bodyEpoch.value;
    },
    get saveState() {
      return saveState.value;
    },
    get external() {
      return { title: titleExternal.value, body: bodyExternal.value };
    },
    set,
    flush,
    retry,
    apply,
    keep,
  };
}
