// Per-task title/body drafts (plan @400 N8/N16, Task 9): the browser's
// tested autosave semantics (src/ui/lib/autosave.ts, useTaskDraft.ts),
// ported to an injected scheduler, with GUARDED writes and no browser hooks.
//
// - Autosave: every change arms a 600 ms idle timer and, on the first change
//   of a burst, a 3 s maximum, so a continuous typist still saves. Per field
//   at most ONE write is in flight; changes meanwhile leave exactly one
//   trailing write carrying the LATEST text.
// - "Saved" means the CURRENT text was acknowledged: never merely
//   dispatched, never a stale completion for older text. A failed write is
//   "failed" with its reason; newer typing is kept and retried (retry(), a
//   later change, or flush()), shown as "retrying".
// - Writes are guarded: each sends the field's expected token (from the
//   atomic TaskState the draft started from, then from every acknowledgement
//   or adopted version) and no mutation receipt (N8: autosaves are not
//   receipted). A 412 reads the incoming version and keeps BOTH as a
//   conflict, pausing that field's autosave. Apply adopts the incoming
//   version; Keep rebases on the displayed incoming token and writes again,
//   conditionally, so it can conflict again. Keep chosen while a write is in
//   flight waits for that write's answer and proceeds only if the version it
//   was chosen over is still the one shown (else it is a new decision).
// - Reconciling an incoming TaskState per field (never another field's
//   token, so unrelated metadata never creates a body conflict): the same
//   token is nothing new; our in-flight text or our own text converges; the
//   text we edited against (A→B→A) only rebases the token; a clean field
//   adopts the incoming version (onReplace); otherwise it is a conflict.
// - refresh() reads the TaskState itself and drops an answer that one of our
//   writes overtook (reads again), so a stale read never reverts saved text.
// - writeDraftFile() is the explicit export (`:w <path>`): a new private
//   (0600) file, or an atomic replacement for `:w!`; never automatic.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { HttpError, TransportError } from "../api.ts";
import type { CortexClient, TaskState, Versions } from "../contracts.ts";
import type { Task } from "../store.ts";
import type { Scheduler } from "../ui/lib/autosave.ts";

export type DraftField = "title" | "body";
export type FieldState = "saved" | "pending" | "saving" | "failed" | "retrying" | "conflict";

export const DRAFT_FIELDS: readonly DraftField[] = ["title", "body"];
/** The browser's autosave timings (useAutosave). */
export const IDLE_MS = 600;
export const MAX_MS = 3000;

export interface DraftHooks {
  /** Anything a draft shows changed. */
  onChange?(): void;
  /** The local text of `field` was replaced by an adopted version (a clean live update or Apply). */
  onReplace?(field: DraftField): void;
}

export interface TaskDraft {
  readonly taskId: number;
  /** The local text (what the user sees and edits). */
  text(field: DraftField): string;
  /** The acknowledged server text the local text is edited against. */
  base(field: DraftField): string;
  state(field: DraftField): FieldState;
  /** The incoming version of a conflicted field, else null. */
  incoming(field: DraftField): string | null;
  /** Why the last write of `field` failed, else null. */
  error(field: DraftField): string | null;
  /** The most urgent field state: conflict, failed, retrying, saving, pending, saved. */
  readonly saveState: FieldState;
  /** Fields that are not saved. */
  unsaved(): DraftField[];
  set(field: DraftField, text: string): void;
  /** Send every unsaved, unconflicted field now; resolves when their writes settled. */
  flush(): Promise<void>;
  /** Re-send the failed fields now; resolves when their writes settled. */
  retry(): Promise<void>;
  receive(task: TaskState): void;
  /** Read the TaskState and receive it, reading again when one of our writes overtook the read. */
  refresh(): Promise<void>;
  apply(field: DraftField): void;
  /** Write ours over the shown incoming version (after a write in flight answers); resolves once settled. */
  keep(field: DraftField): Promise<void>;
  /**
   * Stop for good: timers are cancelled and nothing is sent any more; the text
   * stays readable. The fields unsaved at this moment stay unsaved for good: a
   * write still in flight settles, but its answer is never acknowledged into
   * this (kept) copy's baseline.
   */
  discard(): void;
}

interface Incoming {
  readonly text: string;
  readonly token: string;
}

interface Field {
  local: string;
  base: string;
  token: string;
  incoming: Incoming | null;
  inFlight: boolean;
  trailing: boolean;
  errored: boolean;
  retrying: boolean;
  error: string | null;
  revision: number;
  /** The revision whose 412 already re-sent once automatically (A→B→A rebase). */
  resent: number;
  sent: string | null;
  /** Keep was chosen (over the version with this token) while a write was in flight: decided once it answers. */
  keepWanted: string | null;
  idle: unknown;
  max: unknown;
  armed: boolean;
  waiters: (() => void)[];
}

const STATE_ORDER: readonly FieldState[] = ["conflict", "failed", "retrying", "saving", "pending", "saved"];

const fieldText = (task: Task, field: DraftField): string => (field === "title" ? task.title : (task.body ?? ""));
const normalize = (field: DraftField, text: string): string =>
  field === "title" ? text.replace(/[\r\n]+/g, " ") : text;

class Draft implements TaskDraft {
  readonly taskId: number;
  readonly #client: CortexClient;
  readonly #scheduler: Scheduler;
  readonly #hooks: DraftHooks;
  readonly #fields: Record<DraftField, Field>;
  #disposed = false;
  /** The fields that were unsaved when the draft was discarded (a kept copy never becomes saved). */
  #kept: ReadonlySet<DraftField> = new Set();
  #refreshGen = 0;
  /** Bumped whenever one of our writes starts or finishes (a read spanning it may predate it). */
  #writeEpoch = 0;

  constructor(state: TaskState, client: CortexClient, scheduler: Scheduler, hooks: DraftHooks) {
    this.taskId = state.task.id;
    this.#client = client;
    this.#scheduler = scheduler;
    this.#hooks = hooks;
    const field = (name: DraftField): Field => {
      const token = state.versions[name];
      if (token === undefined) {
        throw new Error(`the daemon did not report the ${name} version of @${state.task.id}; restart it (cortex stop)`);
      }
      const text = fieldText(state.task, name);
      return {
        local: text,
        base: text,
        token,
        incoming: null,
        inFlight: false,
        trailing: false,
        errored: false,
        retrying: false,
        error: null,
        revision: 0,
        resent: -1,
        sent: null,
        keepWanted: null,
        idle: null,
        max: null,
        armed: false,
        waiters: [],
      };
    };
    this.#fields = { title: field("title"), body: field("body") };
  }

  // ---------- reading ----------

  text(field: DraftField): string {
    return this.#fields[field].local;
  }

  base(field: DraftField): string {
    return this.#fields[field].base;
  }

  incoming(field: DraftField): string | null {
    return this.#fields[field].incoming?.text ?? null;
  }

  error(field: DraftField): string | null {
    return this.#fields[field].error;
  }

  state(field: DraftField): FieldState {
    if (this.#disposed) {
      if (!this.#kept.has(field)) return "saved";
      const live = this.#liveState(field);
      return live === "saved" ? "pending" : live;
    }
    return this.#liveState(field);
  }

  #liveState(field: DraftField): FieldState {
    const f = this.#fields[field];
    if (f.incoming !== null) return "conflict";
    if (f.inFlight) return f.retrying ? "retrying" : "saving";
    if (f.errored) return "failed";
    if (f.local !== f.base) return "pending";
    return "saved";
  }

  get saveState(): FieldState {
    const states = DRAFT_FIELDS.map(f => this.state(f));
    return STATE_ORDER.find(s => states.includes(s)) ?? "saved";
  }

  unsaved(): DraftField[] {
    return DRAFT_FIELDS.filter(f => this.state(f) !== "saved");
  }

  // ---------- autosave timers (useAutosave) ----------

  #arm(field: DraftField): void {
    const f = this.#fields[field];
    f.armed = true;
    if (f.idle !== null) this.#scheduler.clear(f.idle);
    f.idle = this.#scheduler.schedule(() => this.#fire(field), IDLE_MS);
    // The ceiling arms only on the FIRST change of a burst.
    if (f.max === null) f.max = this.#scheduler.schedule(() => this.#fire(field), MAX_MS);
  }

  #disarm(field: DraftField): void {
    const f = this.#fields[field];
    if (f.idle !== null) this.#scheduler.clear(f.idle);
    if (f.max !== null) this.#scheduler.clear(f.max);
    f.idle = null;
    f.max = null;
    f.armed = false;
  }

  #fire(field: DraftField): void {
    if (!this.#fields[field].armed) return;
    this.#disarm(field);
    void this.#save(field);
  }

  // ---------- editing ----------

  set(field: DraftField, text: string): void {
    if (this.#disposed) return;
    const f = this.#fields[field];
    const value = normalize(field, text);
    if (value === f.local) return;
    f.local = value;
    f.revision++;
    // Paused while a conflict is unresolved (Apply / Keep decide).
    if (f.incoming === null) this.#arm(field);
    this.#changed();
  }

  async flush(): Promise<void> {
    if (this.#disposed) return;
    for (const field of DRAFT_FIELDS) {
      const f = this.#fields[field];
      this.#disarm(field);
      if (f.incoming === null && (f.local !== f.base || f.errored)) void this.#save(field);
    }
    await Promise.all(DRAFT_FIELDS.map(field => this.#settled(field)));
  }

  async retry(): Promise<void> {
    if (this.#disposed) return;
    for (const field of DRAFT_FIELDS) {
      if (this.#fields[field].errored) {
        this.#disarm(field);
        void this.#save(field);
      }
    }
    await Promise.all(DRAFT_FIELDS.map(field => this.#settled(field)));
  }

  apply(field: DraftField): void {
    const f = this.#fields[field];
    const incoming = f.incoming;
    if (incoming === null || this.#disposed) return;
    this.#disarm(field); // superseded pending work dies here
    f.keepWanted = null;
    f.revision++;
    this.#adopt(field, incoming);
    this.#changed();
  }

  async keep(field: DraftField): Promise<void> {
    const f = this.#fields[field];
    const incoming = f.incoming;
    if (incoming === null || this.#disposed) return;
    if (f.inFlight) {
      // Its answer decides which version the daemon holds: keep after it.
      f.keepWanted = incoming.token;
      await this.#settled(field);
      return;
    }
    // The incoming text is what the daemon has: rebase on it (its token), then
    // explicitly write ours over it, still conditionally.
    f.base = incoming.text;
    f.token = incoming.token;
    f.incoming = null;
    f.errored = false;
    f.error = null;
    this.#changed();
    void this.#save(field);
    await this.#settled(field);
  }

  discard(): void {
    if (this.#disposed) return;
    // Frozen BEFORE disposing: a read-back or an answer arriving later never makes these saved.
    this.#kept = new Set(this.unsaved());
    this.#disposed = true;
    for (const field of DRAFT_FIELDS) {
      this.#disarm(field);
      this.#fields[field].keepWanted = null; // a deferred Keep is never sent either
      this.#settle(field, true);
    }
    this.#changed();
  }

  // ---------- writes ----------

  #settled(field: DraftField): Promise<void> {
    const f = this.#fields[field];
    if (!f.inFlight && !f.trailing) return Promise.resolve();
    return new Promise(resolve => f.waiters.push(resolve));
  }

  #settle(field: DraftField, force = false): void {
    const f = this.#fields[field];
    if (!force && (f.inFlight || f.trailing)) return;
    for (const resolve of f.waiters.splice(0)) resolve();
  }

  /** One serialized save of `field`: at most one write in flight, one trailing write with the latest text. */
  async #save(field: DraftField): Promise<void> {
    const f = this.#fields[field];
    if (this.#disposed || f.incoming !== null) {
      this.#settle(field);
      return;
    }
    if (f.inFlight) {
      f.trailing = true;
      return;
    }
    if (f.local === f.base) {
      f.errored = false;
      f.error = null;
      this.#changed();
      this.#settle(field);
      return;
    }
    const sent = f.local;
    const revision = f.revision;
    f.inFlight = true;
    f.retrying = f.errored;
    f.errored = false;
    f.error = null;
    f.sent = sent;
    this.#writeEpoch++;
    this.#changed();
    try {
      const request = field === "title" ? { title: sent } : { body: sent === "" ? null : sent };
      const expected: Versions = { [field]: f.token };
      const result = await this.#client.versioned.editTask(this.taskId, request, { expected });
      this.#writeEpoch++;
      f.inFlight = false;
      f.sent = null;
      if (this.#disposed) {
        // Discarded meanwhile (its task or its database went away): the write is settled but
        // never acknowledged into the kept copy, which stays unsaved (and keeps blocking :q).
        f.trailing = false;
        this.#changed();
        this.#settle(field);
        return;
      }
      f.base = sent;
      f.token = result.versions[field] ?? f.token;
      this.#afterAck(field);
      if (f.revision !== revision) f.trailing = true; // newer text exists: never label it saved
    } catch (err) {
      this.#writeEpoch++;
      f.inFlight = false;
      f.sent = null;
      if (err instanceof HttpError && err.status === 412) {
        // Stale token: read the incoming version and keep both (or converge).
        try {
          await this.refresh();
        } catch (readErr) {
          f.errored = true;
          f.error = `a newer version exists, and reading it failed: ${message(readErr)}; :w retries`;
        }
        if (!f.errored && f.incoming === null && f.local !== f.base) {
          // The daemon's text is still what we edited against (A→B→A): re-send once per revision.
          if (f.resent !== f.revision) {
            f.resent = f.revision;
            f.trailing = true;
          } else {
            f.errored = true;
            f.error = "the daemon keeps rejecting this save as stale; :w retries";
          }
        }
      } else {
        f.errored = true;
        f.trailing = false;
        f.error = failure(err);
      }
    }
    this.#keepAfterAnswer(field);
    const trailing = f.trailing && !f.errored && f.incoming === null && !this.#disposed;
    f.trailing = false;
    this.#changed();
    if (trailing) void this.#save(field);
    else this.#settle(field);
  }

  /**
   * Keep, chosen while the write that just answered was in flight: only if the
   * version the user chose to override is still the one shown (a newer one
   * needs a new decision), rebase on it and write ours over it, conditionally.
   */
  #keepAfterAnswer(field: DraftField): void {
    const f = this.#fields[field];
    const chosen = f.keepWanted;
    if (chosen === null) return;
    f.keepWanted = null;
    const incoming = f.incoming;
    if (incoming === null || incoming.token !== chosen || f.errored) return;
    f.base = incoming.text;
    f.token = incoming.token;
    f.incoming = null;
    f.trailing = true;
  }

  /** After our ack: an incoming version recorded meanwhile is ours, or (nothing unsaved) adopted. */
  #afterAck(field: DraftField): void {
    const f = this.#fields[field];
    const incoming = f.incoming;
    if (incoming === null) return;
    if (incoming.token === f.token || incoming.text === f.base) f.incoming = null;
    else if (f.local === f.base && f.keepWanted === null) this.#adopt(field, incoming);
  }

  #adopt(field: DraftField, version: Incoming): void {
    const f = this.#fields[field];
    this.#disarm(field);
    f.local = version.text;
    f.base = version.text;
    f.token = version.token;
    f.incoming = null;
    f.errored = false;
    f.error = null;
    this.#hooks.onReplace?.(field);
  }

  // ---------- reconciliation ----------

  receive(task: TaskState): void {
    if (this.#disposed) return;
    let changed = false;
    for (const field of DRAFT_FIELDS) {
      const token = task.versions[field];
      if (token !== undefined) changed = this.#reconcile(field, fieldText(task.task, field), token) || changed;
    }
    if (changed) this.#changed();
  }

  #reconcile(field: DraftField, text: string, token: string): boolean {
    const f = this.#fields[field];
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
      f.base = text;
      f.token = token;
      f.incoming = null;
      f.errored = false;
      f.error = null;
      return true;
    }
    if (f.local === f.base && !f.inFlight && f.incoming === null) {
      this.#adopt(field, { text, token }); // a clean live update
      return true;
    }
    // Both changed: keep both, pause this field's unsent autosave until Apply / Keep.
    f.incoming = { text, token };
    this.#disarm(field);
    return true;
  }

  async refresh(): Promise<void> {
    for (;;) {
      if (this.#disposed) return;
      const gen = ++this.#refreshGen;
      const epoch = this.#writeEpoch;
      const state = await this.#client.taskState(this.taskId).catch((err: unknown) => {
        if (gen === this.#refreshGen) throw err;
        return null;
      });
      if (state === null || gen !== this.#refreshGen || this.#disposed) return;
      if (epoch !== this.#writeEpoch) continue; // one of our writes overtook this read: read again
      this.receive(state);
      return;
    }
  }

  #changed(): void {
    this.#hooks.onChange?.();
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function failure(err: unknown): string {
  if (err instanceof TransportError && err.uncertain) {
    return `the save may have applied (${err.message}); :w retries safely (the write is guarded)`;
  }
  if (err instanceof HttpError && err.status === 404) return "the task no longer exists";
  return message(err);
}

/**
 * A draft of one task's title and body, starting from an atomic TaskState
 * (text and tokens together). Throws when the state lacks a title or body
 * token (a daemon that predates guarded writes).
 */
export function createTaskDraft(
  task: TaskState,
  client: CortexClient,
  scheduler: Scheduler,
  hooks: DraftHooks = {},
): TaskDraft {
  return new Draft(task, client, scheduler, hooks);
}

// ---------- the explicit export (`:w <path>`) ----------

/** `~/x`, relative (to the working directory) or absolute: an absolute path. */
export function resolveDraftPath(file: string, cwd: string = process.cwd()): string {
  const trimmed = file.trim();
  if (trimmed === "~" || trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(1));
  return path.resolve(cwd, trimmed);
}

/**
 * Write `text` to `file` as a private (0600) file. Without `overwrite` the
 * file must not exist yet (nothing is ever replaced silently); with it, a
 * private temporary file is renamed over the old one atomically.
 */
export function writeDraftFile(file: string, text: string, overwrite: boolean): void {
  if (!overwrite) {
    let fd: number;
    try {
      fd = fs.openSync(file, "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`${file} exists; :w! <path> replaces it`);
      }
      throw err;
    }
    try {
      fs.fchmodSync(fd, 0o600);
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return;
  }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) throw new Error(`${file} is a directory`);
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
