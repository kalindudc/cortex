// lib/useTaskDraft.ts — THE browser task draft owner (task 330, D1–D3;
// plan @400 N8/N16, Task 9).
//
// One hook instance per mounted task (TaskDocument keys by task id).
// Header (title), CodeMirror editor and rendered preview all consume the
// SAME draft: local text, per-field incoming (conflict) versions, an
// explicit body replacement epoch (the only thing besides task id that may
// remount the editor — D4), and a saveState derived from ACTUAL request
// acknowledgements. src/tui/drafts.ts implements the same semantics for the
// terminal.
//
// BASELINE (N8). Editing starts only once an ATOMIC TaskState is known: the
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
// released once clean, and are pruned when a task is confirmed deleted
// (pruneTaskDrafts). While any unsaved work exists, a beforeunload warning
// is armed (D2).

import { useEffect, useMemo, useRef } from "preact/hooks";
import { batch, useSignal } from "@preact/signals";
import { HttpError } from "../../api.ts";
import type { EditTaskRequest, TaskStateSnapshot, Versions } from "../../contracts.ts";
import type { Task } from "../api/types.ts";
import { api } from "../api/client.ts";
import { showError } from "../api/errors.ts";
import { useAutosave, type AutosaveApi, type Scheduler } from "./autosave.ts";

export type DraftField = "title" | "body";
export type SaveState = "saved" | "pending" | "saving" | "error";

const FIELDS: readonly DraftField[] = ["title", "body"];

export interface TaskDraft {
  title: string;
  body: string;
  bodyEpoch: number;
  saveState: SaveState;
  external: Record<DraftField, string | null>;
  /** True once the atomic baseline (text + version tokens) is known; editing is disabled before. */
  ready: boolean;
  /** Why reading the baseline failed (editing stays disabled until reload()), else null. */
  loadError: string | null;
  set(field: DraftField, value: string): void;
  flush(): void;
  retry(): void;
  apply(field: DraftField): void;
  keep(field: DraftField): void;
  /** Read the baseline again after it failed. */
  reload(): void;
}

// ---------------------------------------------------------------------------
// Module-level task-keyed draft memory (D2)
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
const liveDrafts = new Map<number, object>();

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

function describe(err: unknown): string {
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
    if (fs.some(f => f.errored)) return "error";
    if (fs.some(f => f.inFlight)) return "saving";
    if (fs.some(f => f.local !== f.base || f.incoming !== null)) return "pending";
    return "saved";
  };
  const saveState = useSignal<SaveState>(computeSaveState());

  // Liveness guard. Writing component-subscribed signals during the
  // unmount flush enqueues a re-render of the DYING component and crashes
  // preact's render queue (vnode parent already nulled). This cleanup is
  // registered BEFORE the useAutosave hooks so it flips first on unmount;
  // the flush that follows still writes and maintains the module-level
  // draft memory, but skips all signal writes.
  const alive = useRef(true);
  const owner = useRef<object>({});
  useEffect(() => {
    liveDrafts.set(taskId, owner.current);
    return () => {
      alive.current = false;
      if (liveDrafts.get(taskId) === owner.current) liveDrafts.delete(taskId);
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
    if (alive.current || !liveDrafts.has(taskId)) {
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
      core.loadError = describe(err);
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
  // exactly one trailing save carrying the LATEST text (D2).
  const runSave = async (field: DraftField): Promise<void> => {
    const f = core.fields[field];
    const token = f.token;
    if (!core.ready || token === null || f.incoming !== null) return; // no baseline, or paused by a conflict
    if (f.inFlight) {
      f.trailing = true;
      return;
    }
    if (f.local === f.base) {
      f.errored = false;
      changed();
      return;
    }
    const sent = f.local;
    const revision = f.revision;
    const request: EditTaskRequest = field === "title" ? { title: sent } : { body: sent === "" ? null : sent };
    // The guard names ONLY this field's token: other fields never conflict with it.
    const expected: Versions = field === "title" ? { title: token } : { body: token };
    f.inFlight = true;
    f.errored = false;
    f.sent = sent;
    core.writeEpoch++;
    changed(); // → saving
    try {
      const result = await api.versioned.editTask(taskId, request, { expected });
      core.writeEpoch++;
      f.inFlight = false;
      f.sent = null;
      f.base = sent;
      f.token = result.versions[field] ?? f.token;
      afterAck(field);
      if (f.revision !== revision) f.trailing = true; // newer text exists — never label it Saved
    } catch (err) {
      core.writeEpoch++;
      f.inFlight = false;
      f.sent = null;
      f.trailing = false;
      if (!isConflict(err)) {
        f.errored = true;
        showError(err); // global drawer, never this component's signals: safe after unmount too
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
              showError(new Error(`The ${field} save keeps being rejected as stale; Retry reads it again`));
            }
          }
        } catch (readErr) {
          f.errored = true;
          showError(new Error(`A newer version of the ${field} exists, and reading it failed: ${describe(readErr)}`));
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
    if (wantTrailing) void runSave(field);
  };

  const titleSave = useAutosave(() => void runSave("title"), undefined, undefined, scheduler);
  const bodySave = useAutosave(() => void runSave("body"), undefined, undefined, scheduler);
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

  const flush = (): void => {
    titleSave.flush();
    bodySave.flush();
  };

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
    // explicitly write ours over it (D3: an explicit decision, not a silent
    // overwrite) — still conditionally, so a newer write conflicts again.
    f.base = incoming.text;
    f.token = incoming.token;
    f.incoming = null;
    f.errored = false;
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
      if (clean && !liveDrafts.has(taskId)) markUnsaved(taskId, false);
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
