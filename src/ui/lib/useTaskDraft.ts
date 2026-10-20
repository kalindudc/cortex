// lib/useTaskDraft.ts — THE browser task draft owner.
//
// One hook instance per mounted task (TaskDocument keys by task id).
// Header (title), CodeMirror editor and rendered preview all consume the
// SAME draft: local text, per-field incoming (conflict) versions, an
// explicit body replacement epoch (the only thing besides task id that may
// remount the editor), and a saveState derived from ACTUAL request
// acknowledgements.
//
// BASELINE. Editing starts only once an ATOMIC TaskState is known: the
// text AND its version tokens from one GET /api/tasks/:id/state. Until then
// `ready` is false, set() is ignored and the UI shows an honest loading (or
// failure + Retry) state instead of an editor; reading shows the task copy
// meanwhile.
//
// GUARDED WRITES. Every title/body save is a versioned write
// (`Prefer: cortex-versioned`) whose guard names that field's expected
// token, never another field's; the acknowledged versions become the new
// baseline, and "Saved" means the CURRENT text was acknowledged. A 412 is
// not an error: the draft reads the incoming version atomically and keeps
// BOTH as a conflict, pausing that field's autosave. Apply adopts the
// incoming version; Keep rebases on the DISPLAYED incoming token and writes
// conditionally again, so it can conflict again. Every other failure
// (including the anchor 409s) is an error with Retry. Unguarded legacy
// writers (CLI/API) stay last-writer-wins on the server by design; they
// advance tokens, so a dirty draft still conflicts instead of overwriting.
//
// RECONCILIATION. A new task copy (live snapshot → `task` prop) is only a
// HINT: when its title or body leaves the draft's baseline, the draft reads
// the atomic TaskState and reconciles each field by ITS token, so status,
// tags, priority and activity never create title/body conflicts:
//   same token                    → nothing new
//   our in-flight text read back  → rebase on it
//   our base text (changed back)  → rebase the token only (our edit applies)
//   our local text                → converge
//   clean field                   → adopt (live update; body bumps epoch)
//   else                          → conflict: keep BOTH, pause autosave
// One read is in flight at a time; a read overtaken by one of our writes,
// or by a newer copy arriving meanwhile, is discarded and read again, so a
// stale answer never reverts acknowledged text or overwrites typing.
//
// Persistence of unsaved work is IN-MEMORY per task id (never browser
// storage): snapshots record the local text, the server baseline it was
// edited against and that baseline's token, survive navigation, are
// released once clean, and clean ones are pruned when a task is confirmed
// deleted (pruneTaskDrafts). Unsaved text of a deleted task is never dropped:
// it is listed by orphanedDrafts until the user exports or discards it. While
// any unsaved work exists, a beforeunload warning is armed, and the dirty and
// orphan counts feed the desktop close guard (closeGuard.ts).

import { useEffect, useMemo, useRef } from "preact/hooks";
import { batch, computed, signal, useSignal, type ReadonlySignal } from "@preact/signals";
import { HttpError, TransportError } from "../../api.ts";
import type { EditTaskRequest, TaskStateSnapshot, Versions } from "../../contracts.ts";
import type { Task } from "../api/types.ts";
import { api } from "../api/client.ts";
import { showError } from "../api/errors.ts";
import { useAutosave, type AutosaveApi, type Scheduler } from "./autosave.ts";

export type DraftField = "title" | "body";
export type SaveState = "saved" | "pending" | "saving" | "retrying" | "failed";

const FIELDS: readonly DraftField[] = ["title", "body"];

export interface TaskDraft {
  title: string;
  body: string;
  bodyEpoch: number;
  saveState: SaveState;
  /** Why the most urgent failed field failed, else null. */
  failure: string | null;
  external: Record<DraftField, string | null>;
  /** True once the atomic baseline (text + version tokens) is known; editing is disabled before. */
  ready: boolean;
  /** Why reading the baseline failed (editing stays disabled until reload()), else null. */
  loadError: string | null;
  set(field: DraftField, value: string): void;
  /** Resolves when no field of this task is in flight or queued. */
  flush(): Promise<void>;
  retry(): void;
  apply(field: DraftField): void;
  keep(field: DraftField): void;
  /** Read the baseline again after it failed. */
  reload(): void;
}

// ---------------------------------------------------------------------------
// Module-level task-keyed draft memory
// ---------------------------------------------------------------------------

interface FieldSnapshot {
  local: string;
  base: string; // server baseline the local text was edited against
  token: string; // that baseline's version token
}
type DraftSnapshot = Partial<Record<DraftField, FieldSnapshot>>;

const draftMemory = new Map<number, DraftSnapshot>();
const unsavedTasks = new Set<number>();
/** The mounted draft instance per task; a dead instance's late answers never touch a live one's memory. */
const liveDrafts = new Map<number, { flush(): Promise<void> }>();
/** The task ids of the last snapshot (null before the first one). */
let liveIds: ReadonlySet<number> | null = null;
/**
 * Bumped when a database change moves every snapshot to the sticky orphans.
 * A draft mounted before it never writes the memory again, so a late answer
 * of an old write cannot bring old text back under a reused id.
 */
let memoryEpoch = 0;

export interface OrphanDraft {
  readonly taskId: number;
  readonly field: DraftField;
  readonly text: string;
}
/**
 * Unsaved text from before a database change. Later prunes never clear it,
 * because the new database may reuse the same task ids: only Export or
 * Discard removes an entry.
 */
const stickyOrphans: OrphanDraft[] = [];

const orphanList = signal<readonly OrphanDraft[]>([]);
const dirtyTasks = signal(0);
/** Unsaved text whose task no longer exists; it cannot be saved, only exported or discarded. */
export const orphanedDrafts: ReadonlySignal<readonly OrphanDraft[]> = computed(() => orphanList.value);
/** Live tasks with unsaved, in-flight, failed or conflicted draft work. */
export const dirtyCount: ReadonlySignal<number> = computed(() => dirtyTasks.value);
export const orphanCount: ReadonlySignal<number> = computed(() => orphanList.value.length);

// A mounted draft is on screen, so it is never an orphan.
const isOrphanId = (id: number): boolean => liveIds !== null && !liveIds.has(id) && !liveDrafts.has(id);

function collectOrphans(): OrphanDraft[] {
  const out = [...stickyOrphans];
  for (const [taskId, entry] of draftMemory) {
    if (!isOrphanId(taskId)) continue;
    for (const field of FIELDS) {
      const snap = entry[field];
      if (snap != null) out.push({ taskId, field, text: snap.local });
    }
  }
  return out;
}

const sameOrphans = (a: readonly OrphanDraft[], b: readonly OrphanDraft[]): boolean =>
  a.length === b.length &&
  a.every((o, i) => o.taskId === b[i].taskId && o.field === b[i].field && o.text === b[i].text);

/** Recompute the counts and the unload warning after module draft state changed. */
function syncDrafts(): void {
  const orphans = collectOrphans();
  let dirty = 0;
  for (const id of unsavedTasks) if (!isOrphanId(id)) dirty++;
  batch(() => {
    if (!sameOrphans(orphans, orphanList.peek())) orphanList.value = orphans;
    dirtyTasks.value = dirty;
  });
  syncUnloadWarning(dirty > 0 || orphans.length > 0);
}

function beforeUnloadHandler(e: BeforeUnloadEvent): void {
  e.preventDefault();
  e.returnValue = ""; // legacy Chrome requires a set returnValue
}
let unloadArmed = false;
/** The user chose to leave this page (the close guard): never warn again before it unloads. */
let unloadReleased = false;
function syncUnloadWarning(wanted: boolean): void {
  const want = wanted && !unloadReleased;
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
  syncDrafts();
}

function markUnsaved(taskId: number, unsaved: boolean): void {
  if (unsaved) unsavedTasks.add(taskId);
  else unsavedTasks.delete(taskId);
  syncDrafts();
}

/** Stop the beforeunload warning for the rest of this page's life; the user chose to leave it. */
export function releaseUnloadWarning(): void {
  unloadReleased = true;
  syncUnloadWarning(false);
}

/** True while any task holds unsaved/failed draft work, or unsaved text of a deleted task is kept. */
export function hasUnsavedDrafts(): boolean {
  return unsavedTasks.size > 0 || stickyOrphans.length > 0;
}

/**
 * Drop clean draft memory for tasks that no longer exist (confirmed
 * deletions). Callers pass the CURRENT live task ids. An empty list is what
 * a database change sends: every snapshot left then moves to the sticky
 * orphans, so a task of the new database never adopts the old text.
 */
export function pruneTaskDrafts(ids: Iterable<number>): void {
  const live = new Set(ids);
  for (const id of [...draftMemory.keys()]) if (!live.has(id) && !unsavedTasks.has(id)) draftMemory.delete(id);
  // dirty snapshots of tasks that are gone stay, and are listed by orphanedDrafts()
  if (live.size === 0) {
    for (const [taskId, entry] of draftMemory) {
      for (const field of FIELDS) {
        const snap = entry[field];
        if (snap != null) stickyOrphans.push({ taskId, field, text: snap.local });
      }
    }
    draftMemory.clear();
    unsavedTasks.clear();
    memoryEpoch++;
  }
  liveIds = live;
  syncDrafts();
}

/** Drop one orphaned draft (after Export, or when the user discards it). */
export function discardOrphan(taskId: number, field: DraftField): void {
  const i = stickyOrphans.findIndex(o => o.taskId === taskId && o.field === field);
  if (i >= 0) stickyOrphans.splice(i, 1);
  else if (isOrphanId(taskId)) {
    writeSnapshot(taskId, field, null);
    if (!draftMemory.has(taskId)) unsavedTasks.delete(taskId);
  }
  syncDrafts();
}

/**
 * Save every mounted draft now and wait for the writes. Unmounted,
 * conflicted, failed and orphaned drafts cannot be written here, so they
 * stay counted: that is what keeps the window open.
 */
export async function saveAllDrafts(): Promise<{ dirty: number; orphaned: number }> {
  await Promise.all([...liveDrafts.values()].map(d => d.flush()));
  return { dirty: dirtyCount.value, orphaned: orphanCount.value };
}

// ---------------------------------------------------------------------------
// Per-mount draft state
// ---------------------------------------------------------------------------

interface Incoming {
  readonly text: string;
  readonly token: string;
}

interface FieldCore {
  /** What the user sees and edits. */
  local: string;
  /** The server text `local` is edited against. */
  base: string;
  /** `base`'s version token; null until the baseline is known. */
  token: string | null;
  /** The other version of a conflicted field, else null. */
  incoming: Incoming | null;
  inFlight: boolean;
  /** The text of the write in flight. */
  sent: string | null;
  trailing: boolean;
  errored: boolean;
  /** Why the last write failed, else null. */
  error: string | null;
  /** The write in flight follows a failure. */
  retrying: boolean;
  /** The save run in flight (with its trailing saves), else null. */
  running: Promise<void> | null;
  revision: number;
  /** The revision whose 412 already re-sent once automatically (changed and changed back). */
  resent: number;
  /** Keep was chosen (over the version with this token) while a write was in flight: decided once it settles. */
  keepWanted: string | null;
}

interface Core {
  ready: boolean;
  loadError: string | null;
  bodyEpoch: number;
  /** Bumped whenever one of our writes starts or finishes (a read spanning it may predate it). */
  writeEpoch: number;
  /** The TaskState read in flight, if any. */
  reading: Promise<void> | null;
  /** A newer copy arrived while `reading` was in flight: its answer must be read again. */
  again: boolean;
  /** Fields that showed a recovered snapshot before the baseline was known. */
  recovered: Record<DraftField, boolean>;
  fields: Record<DraftField, FieldCore>;
}

const fieldText = (task: Task, field: DraftField): string => (field === "title" ? task.title : (task.body ?? ""));

const isConflict = (err: unknown): boolean => err instanceof HttpError && err.status === 412;

function failure(err: unknown): string {
  if (err instanceof TransportError && err.uncertain) {
    return `the save may have applied (${err.message}); Retry is safe (the write is guarded)`;
  }
  if (err instanceof HttpError && err.status === 404) return "the task no longer exists";
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useTaskDraft(task: Task, scheduler?: Scheduler): TaskDraft {
  const taskId = task.id;
  const serverTitle = task.title;
  const serverBody = task.body || "";

  // Created once per mount (the hook lives and dies with its task's mounted
  // lifetime). Until the baseline arrives, the text shown is the recovered
  // snapshot (unsaved work from an earlier mount) or the task copy.
  const core = useMemo<Core>(() => {
    const snap = draftMemory.get(taskId);
    const initial = (field: DraftField, server: string): FieldCore => ({
      local: snap?.[field]?.local ?? server,
      base: server,
      token: null,
      incoming: null,
      inFlight: false,
      sent: null,
      trailing: false,
      errored: false,
      error: null,
      retrying: false,
      running: null,
      revision: 0,
      resent: -1,
      keepWanted: null,
    });
    return {
      ready: false,
      loadError: null,
      bodyEpoch: 0,
      writeEpoch: 0,
      reading: null,
      again: false,
      recovered: { title: snap?.title != null, body: snap?.body != null },
      fields: { title: initial("title", serverTitle), body: initial("body", serverBody) },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  const titleLocal = useSignal(core.fields.title.local);
  const bodyLocal = useSignal(core.fields.body.local);
  const titleExternal = useSignal<string | null>(null);
  const bodyExternal = useSignal<string | null>(null);
  const bodyEpoch = useSignal(0);
  const ready = useSignal(false);
  const loadError = useSignal<string | null>(null);

  const computeSaveState = (): SaveState => {
    const fs = FIELDS.map(field => core.fields[field]);
    if (fs.some(f => f.errored)) return "failed";
    if (fs.some(f => f.inFlight && f.retrying)) return "retrying";
    if (fs.some(f => f.inFlight)) return "saving";
    if (fs.some(f => f.local !== f.base || f.incoming !== null)) return "pending";
    return "saved";
  };
  const saveState = useSignal<SaveState>(computeSaveState());
  const computeFailure = (): string | null =>
    FIELDS.map(field => core.fields[field]).find(f => f.errored)?.error ?? null;
  const failureText = useSignal<string | null>(null);

  // Liveness guard. Writing component-subscribed signals during the
  // unmount flush enqueues a re-render of the DYING component and crashes
  // preact's render queue (vnode parent already nulled). This cleanup is
  // registered BEFORE the useAutosave hooks so it flips first on unmount;
  // the flush that follows still writes and maintains the module-level
  // draft memory, but skips all signal writes.
  const alive = useRef(true);
  const epoch = useRef(memoryEpoch);
  const flushRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const owner = useRef<{ flush(): Promise<void> }>({ flush: () => flushRef.current() });
  useEffect(() => {
    liveDrafts.set(taskId, owner.current);
    syncDrafts();
    return () => {
      alive.current = false;
      if (liveDrafts.get(taskId) === owner.current) liveDrafts.delete(taskId);
      syncDrafts();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const unsaved = (): boolean =>
    FIELDS.some(field => {
      const f = core.fields[field];
      return f.local !== f.base || f.inFlight || f.errored || f.incoming !== null;
    });

  const updateSnapshot = (field: DraftField): void => {
    const f = core.fields[field];
    if (f.token === null) return; // no baseline yet: a recovered snapshot stays as it was
    if (f.local === f.base && f.incoming === null) writeSnapshot(taskId, field, null);
    else writeSnapshot(taskId, field, { local: f.local, base: f.base, token: f.token });
  };

  // Imperative reads/writes go through `core`; this mirrors it into the
  // render signals (and the module-level memory + unload marker).
  const changed = (): void => {
    // After unmount the memory is still maintained, unless the task was
    // mounted again: the live instance owns it then.
    if (epoch.current === memoryEpoch && (alive.current || !liveDrafts.has(taskId))) {
      for (const field of FIELDS) updateSnapshot(field);
      markUnsaved(taskId, unsaved());
    }
    if (!alive.current) return; // never re-render a dying component
    batch(() => {
      titleLocal.value = core.fields.title.local;
      bodyLocal.value = core.fields.body.local;
      titleExternal.value = core.fields.title.incoming?.text ?? null;
      bodyExternal.value = core.fields.body.incoming?.text ?? null;
      bodyEpoch.value = core.bodyEpoch;
      saveState.value = computeSaveState();
      failureText.value = computeFailure();
      ready.value = core.ready;
      loadError.value = core.loadError;
    });
  };

  // ---------- reads ----------

  /** Adopt `version` as the field's text and baseline (a clean live update or Apply). */
  const adopt = (field: DraftField, version: Incoming): void => {
    const f = core.fields[field];
    autosaveOf(field).cancel(); // superseded pending work dies here
    f.local = version.text;
    f.base = version.text;
    f.token = version.token;
    f.incoming = null;
    f.errored = false;
    f.error = null;
    if (field === "body") core.bodyEpoch++;
  };

  /** Initialize text + tokens from the first atomic read, recovering unsaved work from an earlier mount. */
  const seed = (state: TaskStateSnapshot): void => {
    for (const field of FIELDS) {
      if (state.versions[field] === undefined) {
        throw new Error(`the daemon did not report the ${field} version of task ${taskId}; restart it (cortex stop)`);
      }
    }
    const snap = draftMemory.get(taskId);
    for (const field of FIELDS) {
      const f = core.fields[field];
      const text = fieldText(state.task, field);
      const token = state.versions[field] as string;
      const saved = snap?.[field];
      f.base = text;
      f.token = token;
      f.incoming = null;
      if (saved == null || saved.local === text) {
        f.local = text;
        continue;
      }
      f.local = saved.local;
      if (saved.token === token || saved.base === text) {
        // Unchanged since the interrupted edit (or changed and changed
        // back): the edit still applies. Re-queue it (debounced).
        f.revision++;
        autosaveOf(field).schedule();
      } else {
        // Moved meanwhile: surface a conflict, never a silent overwrite.
        f.incoming = { text, token };
      }
    }
    core.ready = true;
    core.loadError = null;
  };

  /** Reconcile one field with an incoming version; true when anything changed. */
  const reconcile = (field: DraftField, text: string, token: string): boolean => {
    const f = core.fields[field];
    if (token === f.token) return false; // nothing new for this field
    if (f.inFlight && text === f.sent) {
      // Our in-flight write, read back before its answer.
      f.base = text;
      f.token = token;
      return true;
    }
    if (text === f.base) {
      f.token = token; // changed and changed back: our edit still applies
      return true;
    }
    if (text === f.local) {
      f.base = text; // converge — our text, their ack
      f.token = token;
      f.incoming = null;
      f.errored = false;
      f.error = null;
      return true;
    }
    if (f.local === f.base && !f.inFlight && f.incoming === null) {
      adopt(field, { text, token }); // clean live update
      return true;
    }
    // Both changed: keep BOTH and pause this field's unsent autosave until Apply / Keep.
    f.incoming = { text, token };
    autosaveOf(field).cancel();
    return true;
  };

  const receive = (state: TaskStateSnapshot): void => {
    for (const field of FIELDS) {
      const token = state.versions[field];
      if (token !== undefined) reconcile(field, fieldText(state.task, field), token);
    }
  };

  /**
   * Read the atomic TaskState and seed or reconcile from it. One read at a
   * time: callers during a read share it, and it is read again when one of
   * our writes (or a newer copy) overtook it. Rejects when the read fails.
   */
  const refresh = (): Promise<void> => {
    if (core.reading !== null) {
      core.again = true;
      return core.reading;
    }
    const reading: Promise<void> = Promise.resolve()
      .then(async () => {
        for (;;) {
          core.again = false;
          const epoch = core.writeEpoch;
          const state = await api.taskState(taskId);
          if (!alive.current) return;
          if (core.again || epoch !== core.writeEpoch) continue; // overtaken: read again
          if (core.ready) receive(state);
          else seed(state);
          changed();
          return;
        }
      })
      .finally(() => {
        if (core.reading === reading) core.reading = null;
      });
    core.reading = reading;
    return reading;
  };

  const loadBaseline = (): void => {
    refresh().catch((err: unknown) => {
      if (!alive.current || core.ready) return;
      core.loadError = failure(err);
      changed();
    });
  };

  // ---------- writes ----------

  /** After our ack: an incoming version recorded meanwhile is ours, or (nothing unsaved) adopted. */
  const afterAck = (field: DraftField): void => {
    const f = core.fields[field];
    const incoming = f.incoming;
    if (incoming === null) return;
    if (incoming.token === f.token || incoming.text === f.base) f.incoming = null;
    else if (f.local === f.base && f.keepWanted === null) adopt(field, incoming);
  };

  // Read fresh after an await (a read may have recorded a conflict meanwhile);
  // TypeScript would otherwise keep the pre-await narrowing of `f.incoming`.
  const incomingOf = (field: DraftField): Incoming | null => core.fields[field].incoming;

  // One serialized save runner per field: at most one write in flight,
  // exactly one trailing save carrying the LATEST text. The returned promise
  // settles once this field's write and its trailing saves are done.
  const runSave = (field: DraftField): Promise<void> => {
    const f = core.fields[field];
    if (f.inFlight) {
      f.trailing = true;
      return f.running ?? Promise.resolve();
    }
    const run: Promise<void> = saveOnce(field).finally(() => {
      if (f.running === run) f.running = null;
    });
    f.running = run;
    return run;
  };

  const saveOnce = async (field: DraftField): Promise<void> => {
    const f = core.fields[field];
    const token = f.token;
    if (!core.ready || token === null || f.incoming !== null) return; // no baseline, or paused by a conflict
    if (f.local === f.base) {
      f.errored = false;
      f.error = null;
      changed();
      return;
    }
    const sent = f.local;
    const revision = f.revision;
    const request: EditTaskRequest = field === "title" ? { title: sent } : { body: sent === "" ? null : sent };
    // The guard names ONLY this field's token: other fields never conflict with it.
    const expected: Versions = field === "title" ? { title: token } : { body: token };
    f.inFlight = true;
    f.retrying = f.errored;
    f.errored = false;
    f.error = null;
    f.sent = sent;
    core.writeEpoch++;
    changed(); // → saving
    try {
      const result = await api.versioned.editTask(taskId, request, { expected });
      core.writeEpoch++;
      f.inFlight = false;
      f.retrying = false;
      f.sent = null;
      f.base = sent;
      f.token = result.versions[field] ?? f.token;
      afterAck(field);
      if (f.revision !== revision) f.trailing = true; // newer text exists — never label it Saved
    } catch (err) {
      core.writeEpoch++;
      f.inFlight = false;
      f.retrying = false;
      f.sent = null;
      f.trailing = false;
      if (!isConflict(err)) {
        f.errored = true;
        f.error = failure(err);
        showError(new Error(f.error)); // global drawer, never this component's signals: safe after unmount too
      } else if (alive.current) {
        // Stale token: read the incoming version and keep both (or converge).
        // After unmount the recorded snapshot keeps the edit and its old
        // token instead: the next mount's baseline read surfaces it.
        try {
          await refresh();
          if (incomingOf(field) === null && f.local !== f.base) {
            // The daemon's text is still what we edited against: re-send once per revision.
            if (f.resent !== f.revision) {
              f.resent = f.revision;
              f.trailing = true;
            } else {
              f.errored = true;
              f.error = `the ${field} save keeps being rejected as stale; Retry reads it again`;
              showError(new Error(`The ${field} save keeps being rejected as stale; Retry reads it again`));
            }
          }
        } catch (readErr) {
          f.errored = true;
          f.error = `a newer version of the ${field} exists, and reading it failed: ${failure(readErr)}`;
          showError(new Error(`A newer version of the ${field} exists, and reading it failed: ${failure(readErr)}`));
        }
      }
    }
    if (f.keepWanted !== null) {
      // Keep, chosen while this write was in flight: only if the version the
      // user chose to override is still the one shown (a newer one needs a
      // new decision), rebase on it and write ours over it, conditionally.
      const chosen = f.keepWanted;
      f.keepWanted = null;
      const incoming = incomingOf(field);
      if (incoming !== null && incoming.token === chosen && !f.errored) {
        f.base = incoming.text;
        f.token = incoming.token;
        f.incoming = null;
        f.trailing = true;
      }
    }
    const wantTrailing = f.trailing && !f.errored && incomingOf(field) === null && alive.current;
    f.trailing = false;
    changed();
    if (wantTrailing) await runSave(field);
  };

  const titleSave = useAutosave(() => runSave("title"), undefined, undefined, scheduler);
  const bodySave = useAutosave(() => runSave("body"), undefined, undefined, scheduler);
  function autosaveOf(field: DraftField): AutosaveApi {
    return field === "title" ? titleSave : bodySave;
  }

  // The atomic baseline, read once per mount (reload() retries a failure).
  useEffect(() => {
    changed(); // publish the initial (possibly recovered) state + unload marker
    loadBaseline();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  // A new copy of the task (live snapshot) is a hint: re-read when its title
  // or body left the baseline. Metadata-only copies never get here.
  const seen = useRef({ title: serverTitle, body: serverBody });
  useEffect(() => {
    if (seen.current.title === serverTitle && seen.current.body === serverBody) return;
    seen.current = { title: serverTitle, body: serverBody };
    if (!core.ready) {
      // Still loading (or failed): show the newer copy meanwhile, and make
      // sure the baseline comes from a read at least as new as it.
      for (const field of FIELDS) {
        const f = core.fields[field];
        f.base = field === "title" ? serverTitle : serverBody;
        if (!core.recovered[field]) f.local = f.base;
      }
      core.loadError = null;
      changed();
      loadBaseline();
      return;
    }
    const { title, body } = core.fields;
    if (serverTitle === title.base && serverBody === body.base && title.incoming === null && body.incoming === null) {
      return;
    }
    refresh().catch((err: unknown) => {
      // Deleted meanwhile: the snapshot's removal decides what happens next.
      if (!alive.current || (err instanceof HttpError && err.status === 404)) return;
      showError(err);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverTitle, serverBody]);

  const set = (field: DraftField, value: string): void => {
    if (!core.ready) return; // editing is disabled until the baseline is known
    const f = core.fields[field];
    // Title is a single-line semantic field even on a wrapping textarea.
    const v = field === "title" ? value.replace(/\n+/g, " ") : value;
    if (v === f.local) return;
    f.local = v;
    f.revision++;
    if (f.incoming === null) autosaveOf(field).schedule();
    changed();
  };

  const flush = async (): Promise<void> => {
    await Promise.all([titleSave.flush(), bodySave.flush()]);
    for (;;) {
      const running = FIELDS.map(field => core.fields[field].running).filter(r => r !== null);
      if (running.length === 0) return;
      await Promise.all(running);
    }
  };
  flushRef.current = flush;

  const retry = (): void => {
    for (const field of FIELDS) {
      if (core.fields[field].errored) void runSave(field);
    }
  };

  const apply = (field: DraftField): void => {
    const f = core.fields[field];
    const incoming = f.incoming;
    if (incoming === null) return;
    f.keepWanted = null;
    f.revision++;
    adopt(field, incoming);
    changed();
  };

  const keep = (field: DraftField): void => {
    const f = core.fields[field];
    const incoming = f.incoming;
    if (incoming === null) return;
    if (f.inFlight) {
      // Its answer decides which version the daemon holds: keep after it.
      f.keepWanted = incoming.token;
      return;
    }
    // The incoming version is what the daemon has: rebase on its token, then
    // explicitly write ours over it (an explicit decision, not a silent
    // overwrite) — still conditionally, so a newer write conflicts again.
    f.base = incoming.text;
    f.token = incoming.token;
    f.incoming = null;
    f.errored = false;
    f.error = null;
    changed();
    void runSave(field);
  };

  const reload = (): void => {
    if (core.ready || core.reading !== null) return;
    core.loadError = null;
    changed();
    loadBaseline();
  };

  // Release clean entries after unmount; keep dirty/failed snapshots for
  // recovery. The unmount flush (useAutosave) fires first and its async
  // completion updates the snapshot through the captured closures.
  useEffect(
    () => () => {
      const entry = draftMemory.get(taskId);
      const clean = entry == null || (entry.title == null && entry.body == null);
      if (clean && !liveDrafts.has(taskId) && epoch.current === memoryEpoch) markUnsaved(taskId, false);
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
    get failure() {
      return failureText.value;
    },
    get external() {
      return { title: titleExternal.value, body: bodyExternal.value };
    },
    get ready() {
      return ready.value;
    },
    get loadError() {
      return loadError.value;
    },
    set,
    flush,
    retry,
    apply,
    keep,
    reload,
  };
}
