import { Database } from "bun:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import type { ResourceScope, TaskState, Versions, WriteGuard } from "./contracts.ts";
import { canonicalDatabasePath, type OwnerLease, OwnershipError, tryAcquireOwnership } from "./ownership.ts";
import { dbPath, ensureConfigDir } from "./paths.ts";
import { MEMORY_LIMITS } from "./memory.ts";

export type TaskStatus = "draft" | "open" | "review" | "blocked" | "done";
export type Severity = "progress" | "review" | "blocked";

export type Task = {
  id: number;
  lane: string;
  title: string;
  body: string | null;
  status: TaskStatus;
  priority: number | null;
  created: number;
  updated: number;
  tags: string[];
};

/**
 * Internal SQL row shape: a `Task` with `tags` replaced by the
 * GROUP_CONCAT'd CSV string returned from the LEFT JOIN. Lives module-scope
 * (not exported) so the public `Task` type stays clean.
 */
type TaskRow = Omit<Task, "tags"> & { tag_csv: string | null };

export type Update = {
  id: number;
  task_id: number;
  author: string;
  summary: string;
  body: string | null;
  severity: Severity;
  created: number;
};

export type Lane = {
  name: string;
  color: string | null;
  sort: number;
};

export type Tag = {
  name: string;
  color: string | null;
  created: number;
};

/**
 * Server-persisted notification row backing the dashboard's bell drawer.
 * `status` reuses the `TaskStatus` union so the UI can render the dot via
 * the existing `dot-status-${status}` CSS class family — no bespoke
 * notification colors. The value is a SNAPSHOT of the task's status at
 * the moment the notification fired; later transitions on the task do NOT
 * mutate historical rows. `read` is converted from SQLite's INTEGER 0/1
 * to a JS boolean at the rowToNotification() boundary (SQLite has no
 * native BOOLEAN affinity).
 */
export type Notification = {
  id: number;
  task_id: number | null;
  author: string | null;
  status: TaskStatus;
  title: string;
  message: string;
  read: boolean;
  created: number;
};

export type AddNotificationInput = {
  task_id?: number | null;
  author?: string | null;
  status: TaskStatus;
  title: string;
  message: string;
};

/**
 * Internal SQL row shape for notifications: identical to `Notification`
 * but with `read` as the raw INTEGER 0/1 returned by SQLite. The boundary
 * conversion happens in rowToNotification(), mirroring the rowToTask()
 * pattern that splits `tag_csv` into `tags`.
 */
type NotificationRow = Omit<Notification, "read"> & { read: number };

/**
 * Response shape of `Store.relatedTasks(id)` and `GET /api/tasks/:id/related`.
 * Three disjoint buckets — a task appears in at most one (priority order:
 * referencedBy > references > shared). Each list is sorted by
 * `priority ASC, id ASC` to match the default task-list ordering.
 */
export type RelatedTasks = {
  /** Other tasks whose body or update summaries contain `@id`. */
  referencedBy: Task[];
  /** Tasks that the active task's body or update summaries reference via `@id`. */
  references: Task[];
  /** Tasks that share ≥1 NON-ORGANIZATIONAL tag with the active task
   *  (organizational tags listed in SHARED_TAG_BLOCKLIST are ignored —
   *  see the constant for the rationale). */
  shared: Task[];
};

/**
 * Tags excluded from the `shared` relatedness computation. These are
 * organizational/type tags ("this is a plan", "this is a PR description")
 * that mark category rather than topic; including them dilutes shared
 * relatedness to uselessness on large databases. Curated manually until
 * we add a richer tag-kind model.
 */
export const SHARED_TAG_BLOCKLIST: ReadonlySet<string> = new Set(["plan", "pr-desc", "research"]);

/**
 * A memory stream row (plan @414): bodiless and token-lean. `synced` is the
 * last time the task's BODY changed (`_body_edits`), falling back to
 * `created`; title, status, lane, tag and update writes never move it.
 */
export type MemoryStreamRow = Pick<Task, "id" | "title" | "lane" | "status" | "tags" | "updated"> & { synced: number };
/** One ranked memory-search hit (GET /api/memory/search). */
export type MemoryHit = MemoryStreamRow & { score: number; matched: string[]; snippet: string };
/** One stream with its full update history (GET /api/memory/streams/:id). */
export type MemoryStream = {
  task: Task;
  updates: Update[];
  synced: number;
  /** Highest update id at the sync: updates above it are the breadcrumbs (ids order same-millisecond writes). */
  syncedUpdateId: number;
};

/**
 * Tag-name regex: lowercase letters, digits, `_`, `@`, `-`, length 1-32.
 * The trailing `-` inside the character class is literal (no escape needed).
 * Single source of truth — exported so the CLI flag parsers and HTTP route
 * handlers all gate through validateTagName() instead of duplicating the
 * regex.
 */
export const TAG_NAME_RE = /^[a-z0-9_@-]{1,32}$/;

/**
 * Inline reference grammar: `@<digits>` for a task ref, `#<tag-name>` for
 * a tag ref. Word-boundary lookbehind/lookahead keep us from matching
 * inside identifiers (`path@123`, `user@1example`) or URLs (`@123abc`),
 * and from matching markdown headings (`# Heading` — the space after `#`
 * is not in the tag character class so length-1 match fails).
 *
 * Shared by the server's `Store.relatedTasks` scan and the UI parsers in
 * `src/ui/lib/refs.ts` / `refsExtension.ts`. Each UI consumer holds its
 * own `RegExp` instance because `MatchDecorator` mutates `lastIndex`;
 * this server-side instance is standalone so the module has zero UI
 * imports. The tag character class is intentionally identical to
 * `TAG_NAME_RE`'s body so an in-text ref cannot validate but fail to
 * match a real tag.
 */
export const REF_RE = /(?<![A-Za-z0-9_])@(\d+)(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])#([a-z0-9_@-]{1,32})(?![A-Za-z0-9_])/g;
export function validateTagName(s: string): string {
  const v = s.trim();
  if (!TAG_NAME_RE.test(v)) {
    throw new Error(`invalid tag name '${s}': must match [a-z0-9_@-]{1,32}`);
  }
  return v;
}

type AddTaskFields = {
  lane?: string;
  body?: string | null;
  priority?: number | null;
  status?: TaskStatus;
  /** Applied in the insert's transaction (validated first; missing tag rows are auto-created like setTaskTags). */
  tags?: string[];
  /** Attribution (`cortex add --as`): records the first `created` update by this author in the same transaction. */
  author?: string;
  /**
   * Also persist the bell-drawer `created` notification (attributed to
   * `author`) in the insert's transaction, as the daemon's create route does.
   */
  notification?: { author: string | null };
};

/** Everything one create committed, for publishing after the transaction. */
export type CreatedTask = { task: Task; created: Update | null; notification: Notification | null };

/** An atomic tag-membership delta: names to add and names to remove (disjoint). */
export type TagDelta = { add?: string[]; remove?: string[] };

/**
 * Task creation input. An ordinary create names its title; the opt-in
 * `untitled: true` form (plan @400 N9) titles the task `untitled-<id>` inside
 * the insert's transaction, replacing the old POST-then-rename window. An
 * explicit title is never renamed.
 */
export type AddTaskInput =
  | (AddTaskFields & { title: string; untitled?: false })
  | (AddTaskFields & { untitled: true; title?: never });

export type EditTaskFields = {
  title?: string;
  body?: string | null;
  /** Anchor-based partial body edit. Mutually exclusive with `body`.
   *  Both `bodySearch` and `bodyReplace` MUST be present together; the
   *  search anchor must match exactly once in the current body or the
   *  operation throws BodySearchError (server returns 409). Empty string
   *  for `bodyReplace` is allowed (deletion). */
  bodySearch?: string;
  bodyReplace?: string;
  priority?: number | null;
};

/**
 * `Store.readSnapshot` found no database file. Typed so callers decide what
 * absence means (e.g. an empty restore projection) instead of creating one.
 */
export class DatabaseNotFoundError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`cortex database not found: ${path}`);
    this.name = "DatabaseNotFoundError";
    this.path = path;
  }
}

// ---------- revisions, guards and receipts (plan @400 N7-N9) ----------
//
// Private side tables, never columns on the public tables: `SELECT t.*`
// stays clean, legacy `INSERT INTO tasks_new SELECT * FROM tasks` rebuilds
// keep working and the v1 data-only backup never sees them.
//   _database_identity   one row: this database's UUID
//   _resource_revisions  (resource, scope) -> opaque token. A write gives each
//                        changed scope a fresh random token; rows are never
//                        deleted, so deletes leave tombstones and reissued ids
//                        or names can never match a stale guard (ABA). Scopes
//                        with no row yet (legacy data) read as a token derived
//                        from (database UUID, resource, scope), so reads never
//                        write.
//   _mutation_receipts   mutation id -> request digest + JSON result, written
//                        in the SAME transaction as the mutation's effects.

/** Resource families that carry revision tokens. */
export type ResourceKind = "task" | "lane" | "tag";

const TASK_SCOPES: readonly ResourceScope[] = ["entity", "title", "body", "priority", "lane", "status"];
const CATALOG_SCOPES: readonly ResourceScope[] = ["entity", "definition"];

function scopesOf(kind: ResourceKind): readonly ResourceScope[] {
  return kind === "task" ? TASK_SCOPES : CATALOG_SCOPES;
}

function resourceKey(kind: ResourceKind, key: number | string): string {
  return `${kind}:${key}`;
}

function newToken(): string {
  return randomBytes(16).toString("hex");
}

/** One stale scope of a guarded write. */
export type VersionMismatch = { scope: ResourceScope; expected: string; current: string };

/**
 * A guarded write's `expected` versions no longer match (HTTP 412); nothing
 * was written. `current` holds every scope's token at rejection time so a
 * client can keep both versions and rebase against the incoming one.
 */
export class ConflictError extends Error {
  readonly code = "version_conflict" as const;
  readonly kind: ResourceKind;
  readonly key: number | string;
  readonly mismatches: readonly VersionMismatch[];
  readonly current: Versions;
  constructor(kind: ResourceKind, key: number | string, mismatches: VersionMismatch[], current: Versions) {
    super(`${kind} ${key} changed since it was read (stale: ${mismatches.map(m => m.scope).join(", ")})`);
    this.name = "ConflictError";
    this.kind = kind;
    this.key = key;
    this.mismatches = mismatches;
    this.current = current;
  }
}

/** A malformed or partial WriteGuard (HTTP 400), rejected before anything is read or written. */
export class WriteGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WriteGuardError";
  }
}

/** A mutation id that already committed a DIFFERENT request (digest mismatch); nothing was written. */
export class MutationReuseError extends Error {
  readonly mutationId: string;
  constructor(mutationId: string) {
    super(`mutation id '${mutationId}' was already used for a different request`);
    this.name = "MutationReuseError";
    this.mutationId = mutationId;
  }
}

const MUTATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_TOKEN_LENGTH = 256;

function validateMutationId(id: unknown): string {
  if (typeof id !== "string" || !MUTATION_ID_RE.test(id)) {
    throw new WriteGuardError(
      "mutationId must be 1-128 characters of [A-Za-z0-9._:-], starting with a letter or digit",
    );
  }
  return id;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value)
      .filter(key => value[key] !== undefined)
      .sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Receipt digest for `Store.runIdempotent`: SHA-256 (hex) of the canonical
 * JSON of `[operation, input]` — object keys sorted, `undefined` members
 * dropped, array order kept. Digest the complete request (target, fields and
 * guard.expected) so a retry that changed anything is rejected.
 */
export function mutationDigest(operation: string, input: unknown): string {
  return createHash("sha256")
    .update(canonicalJson([operation, input]))
    .digest("hex");
}

const TASK_STATUSES: readonly TaskStatus[] = ["draft", "open", "review", "blocked", "done"];

function assertTaskStatus(status: unknown): asserts status is TaskStatus {
  if (!TASK_STATUSES.includes(status as TaskStatus)) {
    throw new Error(`invalid status '${String(status)}': must be one of ${TASK_STATUSES.join(", ")}`);
  }
}

/** Options for a status write. */
export type StatusOptions = {
  /** Attribution stamp for the `status → x` audit row (default "system"). */
  author?: string | null;
  /**
   * Persist the bell-drawer transition notification in the same transaction,
   * only when the status actually changes. Callers set it for attributed agent
   * writes; a human's own click stays silent (plan @400 N9).
   */
  notify?: boolean;
};

/** Everything one status write committed, for publishing after the transaction. */
export type StatusChange = {
  task: Task;
  previous: TaskStatus;
  audit: Update;
  notification: Notification | null;
};

/** Result of `postUpdate`: the message row plus the status write it carried, if any. */
export type PostedUpdate = { update: Update; status: StatusChange | null };

/** Thrown when a bodySearch/bodyReplace operation cannot apply because
 *  the anchor matches zero or multiple times. The server dispatches both
 *  cases to HTTP 409 Conflict; agents read `kind` (and `matches` when
 *  ambiguous) to decide whether to re-read + retry or refine the anchor. */
export class BodySearchError extends Error {
  readonly kind: "not_found" | "ambiguous";
  readonly matches?: number;
  constructor(kind: "not_found" | "ambiguous", message: string, matches?: number) {
    super(message);
    this.name = "BodySearchError";
    this.kind = kind;
    if (matches !== undefined) this.matches = matches;
  }
}

/** Count occurrences of `needle` in `haystack` without overlap. Used by
 *  the bodySearch path to detect ambiguous anchors. Empty needle is
 *  caller-rejected upstream so we don't guard against the infinite loop
 *  that would produce here. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) return count;
    count++;
    from = i + needle.length;
  }
}

export type AddUpdateInput = {
  task_id: number;
  author: string;
  summary: string;
  body?: string | null;
  /** Also set the task's status in the SAME transaction: the message row, then the `status → x` audit row. */
  status?: TaskStatus;
  /** With `status`: persist its transition notification in that transaction (see StatusOptions.notify). */
  notify?: boolean;
};

export type AuthorTag = string;

/**
 * Validate an author tag posted via the CLI's REQUIRED `--as` flag.
 *
 * Rules (single chokepoint, called from both Store.addUpdate and server.ts):
 *   - no embedded newlines (would break per-line log/SSE rendering)
 *   - max 80 chars (sanity bound; session-id recipe stays well under this)
 *
 * Returns the trimmed value on success; throws on violation.
 */
export function validateAuthorTag(s: string): AuthorTag {
  if (s.includes("\n")) {
    throw new Error("author tag cannot contain newlines");
  }
  if (s.length > 80) {
    throw new Error(`author tag max 80 chars; got ${s.length}`);
  }
  return s.trim();
}

export type AuthorRow = {
  author: string;
  last_seen: number;
  posts: number;
};

export type AddLaneInput = {
  name: string;
  color?: string | null;
  sort?: number;
};

export type EditLaneFields = {
  color?: string | null;
  sort?: number;
  /** new lane name. ON UPDATE CASCADE propagates to tasks.lane FK. */
  rename?: string;
};

export type ListTasksFilter = {
  lane?: string;
  status?: TaskStatus;
  /** AND semantics: task must carry every listed tag. */
  tags?: string[];
  /** Free-text search across title and body (case-insensitive substring). */
  search?: string;
  /** Title-only search (case-insensitive substring). */
  title?: string;
  /** Tag-name search (case-insensitive substring). */
  tagQuery?: string;
};

const now = (): number => Date.now();

const clampInt = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.trunc(Number.isFinite(value) ? value : min)));

/** One FTS5 phrase for a memory term (terms are letters/digits only; quotes are doubled defensively). */
const quoteTerm = (term: string): string => `"${term.replaceAll('"', '""')}"`;

/** The memory stream row: bodiless task columns, sorted tag list, and `synced` (last body change, else `created`). */
const STREAM_ROW_SELECT = `
  SELECT t.id, t.title, t.lane, t.status, t.updated,
         COALESCE(e.edited, t.created) AS synced,
         COALESCE((SELECT GROUP_CONCAT(tag_name, ',' ORDER BY tag_name) FROM task_tags WHERE task_id = t.id), '') AS tag_csv
    FROM tasks t
    LEFT JOIN _body_edits e ON e.task_id = t.id`;

type StreamRowSql = Omit<MemoryStreamRow, "tags"> & { tag_csv: string };

const rowToStream = ({ tag_csv, ...rest }: StreamRowSql): MemoryStreamRow => ({
  ...rest,
  tags: tag_csv ? tag_csv.split(",") : [],
});

export type StoreOpenOptions = {
  warnMigrations?: boolean;
  /**
   * Lease the caller already holds for this database (the daemon, withClient's
   * offline path, maintenance commands); validated, reused, never released by
   * close(). Without it, a file-backed open acquires its own lease.
   */
  owner?: OwnerLease;
};

/**
 * Ownership for a writable open (plan @400 N2/N6): EVERY file-backed open
 * owns its database. A supplied lease must name the same canonical database
 * and is reused; otherwise the open acquires one for the Store's lifetime,
 * throwing `busy` when another owner holds it. There is no opt-out: code
 * that already holds the lease passes it. flock is per open file
 * description, so a second open of the same file in ONE process contends too
 * (share the Store, or pass the lease). `:memory:` has no file identity and
 * is exempt. Returns only a lease THIS open acquired. Readers that must not
 * own the database (dry-runs, doctor, tests beside a daemon) use
 * `Store.readSnapshot`.
 */
function claimOwnership(path: string, opts: StoreOpenOptions): OwnerLease | null {
  const inMemory = path === ":memory:";
  if (opts.owner) {
    const canonical = inMemory ? path : canonicalDatabasePath(path);
    if (canonical !== opts.owner.databasePath) {
      throw new OwnershipError("lease-mismatch", `ownership lease is for ${opts.owner.databasePath}, not ${canonical}`);
    }
    return null;
  }
  if (inMemory) return null;
  const canonical = canonicalDatabasePath(path);
  const lease = tryAcquireOwnership(canonical);
  if (lease === null) {
    throw new OwnershipError(
      "busy",
      `${canonical} is owned by another cortex process (a daemon or maintenance command); retry once it finishes`,
    );
  }
  return lease;
}

export class Store {
  /** The database UUID, read once (it never changes for a database file). */
  private cachedDatabaseId: string | null = null;
  /** Mutation id of the innermost runIdempotent call currently executing its write. */
  private activeMutationId: string | null = null;

  private constructor(
    private readonly db: Database,
    private readonly databaseFile: string,
    private readonly ownedLease: OwnerLease | null = null,
  ) {}

  static open(path: string = dbPath(), opts: StoreOpenOptions = {}): Store {
    if (path !== ":memory:") {
      ensureConfigDir();
    }
    const acquired = claimOwnership(path, opts);
    let db: Database | null = null;
    try {
      db = new Database(path, { strict: true, create: true });
      db.run("PRAGMA journal_mode = WAL;");
      db.run("PRAGMA foreign_keys = ON;");
      const store = new Store(db, path, acquired);
      store.migrate();
      if (opts.warnMigrations !== false) {
        const pending = store.pendingMigrations();
        if (pending.length > 0) {
          console.warn(
            `cortex: database migrations pending (${pending.join(", ")}); run \`cortex init\` to apply them safely`,
          );
        }
      }
      return store;
    } catch (err) {
      try {
        db?.close();
      } catch {
        /* keep the original open failure */
      }
      acquired?.release();
      throw err;
    }
  }

  /**
   * Run `read` against a readonly, NON-creating connection inside one read
   * transaction, then close it. No migrate(), no WAL/foreign-key pragmas and
   * no ownership lease, so it is safe beside a live daemon and leaves the
   * data and schema of legacy databases untouched; writes fail with
   * SQLITE_READONLY. `read` must be synchronous. Throws
   * `DatabaseNotFoundError` when the file does not exist.
   */
  static readSnapshot<T>(path: string, read: (store: Store) => T): T {
    if (path === ":memory:") throw new TypeError("Store.readSnapshot needs a database file, not :memory:");
    if (!fs.existsSync(path)) throw new DatabaseNotFoundError(path);
    let db: Database;
    try {
      db = new Database(path, { readonly: true, strict: true });
    } catch (err) {
      if (!fs.existsSync(path)) throw new DatabaseNotFoundError(path);
      throw err;
    }
    try {
      const store = new Store(db, path);
      return db.transaction(() => read(store))();
    } finally {
      db.close();
    }
  }

  migrate(): void {
    this.db.transaction(() => {
      this.db.run(`
        CREATE TABLE IF NOT EXISTS lanes (
          name  TEXT PRIMARY KEY,
          color TEXT,
          sort  INTEGER NOT NULL DEFAULT 0
        );
      `);
      this.db.run(`
        CREATE TABLE IF NOT EXISTS tasks (
          id       INTEGER PRIMARY KEY AUTOINCREMENT,
          lane     TEXT    NOT NULL DEFAULT 'now',
          title    TEXT    NOT NULL,
          body     TEXT,
          status   TEXT    NOT NULL DEFAULT 'open'
                   CHECK(status IN ('draft','open','review','blocked','done')),
          priority INTEGER,
          created  INTEGER NOT NULL,
          updated  INTEGER NOT NULL,
          FOREIGN KEY(lane) REFERENCES lanes(name) ON UPDATE CASCADE
        );
      `);
      this.db.run(`
        CREATE TABLE IF NOT EXISTS updates (
          id       INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id  INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          author   TEXT    NOT NULL,
          summary  TEXT    NOT NULL CHECK(length(summary) <= 4096),
          body     TEXT,
          severity TEXT    NOT NULL
                   CHECK(severity IN ('progress','review','blocked')),
          created  INTEGER NOT NULL
        );
      `);
      this.db.run(`
        CREATE TABLE IF NOT EXISTS _migrations (
          name       TEXT PRIMARY KEY,
          applied_at INTEGER NOT NULL
        );
      `);
      // Tag tables (Plan 5). `task_tags` cascades from BOTH parents:
      //   ON DELETE on tasks  -> mirrors `updates` so removeTask drops join rows
      //   ON DELETE on tags   -> `cortex tag rm -f` drops join rows but never tasks
      //   ON UPDATE on tags   -> rename via editTag propagates without manual updates
      this.db.run(`
        CREATE TABLE IF NOT EXISTS tags (
          name    TEXT PRIMARY KEY,
          color   TEXT,
          created INTEGER NOT NULL
        );
      `);
      this.db.run(`
        CREATE TABLE IF NOT EXISTS task_tags (
          task_id  INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          tag_name TEXT    NOT NULL REFERENCES tags(name) ON UPDATE CASCADE ON DELETE CASCADE,
          PRIMARY KEY(task_id, tag_name)
        );
      `);
      // Notifications: server-persisted bell-drawer feed. New table,
      // follows the `tags`/`task_tags` precedent — a `CREATE TABLE IF NOT
      // EXISTS` block, no entry in pendingMigrations()/applyMigrations()
      // (those are for schema TRANSFORMS on existing tables).
      //
      // task_id is nullable so future system messages without a task can
      // land here; cascade matches `updates` so removing a task drops its
      // notifications. `status` reuses the TaskStatus enum — see the
      // `Notification` type for the snapshot semantics. `read` is
      // INTEGER 0/1 because SQLite has no native BOOLEAN affinity; the
      // boundary conversion to JS boolean lives in rowToNotification().
      this.db.run(`
        CREATE TABLE IF NOT EXISTS notifications (
          id       INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id  INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
          author   TEXT,
          status   TEXT    NOT NULL
                   CHECK(status IN ('draft','open','review','blocked','done')),
          title    TEXT    NOT NULL,
          message  TEXT    NOT NULL,
          read     INTEGER NOT NULL DEFAULT 0 CHECK(read IN (0,1)),
          created  INTEGER NOT NULL
        );
      `);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created DESC);`);
      // Private concurrency metadata (plan @400 N7/N8). Additive side tables
      // under the notifications precedent: CREATE TABLE IF NOT EXISTS, no
      // _migrations entry (no transform of an existing table), no foreign
      // keys or triggers (so the legacy table rebuilds and their integrity /
      // foreign_key checks never see them) and no AUTOINCREMENT. Never
      // exported by backups; wiped only by `cortex reset`. See the
      // "revisions, guards and receipts" block above for the token model.
      this.db.run(`
        CREATE TABLE IF NOT EXISTS _database_identity (
          id          INTEGER PRIMARY KEY CHECK(id = 1),
          database_id TEXT    NOT NULL,
          created     INTEGER NOT NULL
        );
      `);
      this.db.run(`INSERT OR IGNORE INTO _database_identity (id, database_id, created) VALUES (1, ?, ?);`, [
        randomUUID(),
        now(),
      ]);
      this.db.run(`
        CREATE TABLE IF NOT EXISTS _resource_revisions (
          resource TEXT NOT NULL,
          scope    TEXT NOT NULL
                   CHECK(scope IN ('entity','title','body','priority','lane','status','definition')),
          token    TEXT NOT NULL,
          PRIMARY KEY(resource, scope)
        ) WITHOUT ROWID;
      `);
      this.db.run(`
        CREATE TABLE IF NOT EXISTS _mutation_receipts (
          mutation_id TEXT    PRIMARY KEY,
          digest      TEXT    NOT NULL,
          result      TEXT    NOT NULL,
          created     INTEGER NOT NULL
        ) WITHOUT ROWID;
      `);
      // Body-sync record for agent memory (plan @414): when each task's BODY
      // last changed, written ONLY by createTask and by editTask when the body
      // text actually changes. Staleness and breadcrumbs are measured from it,
      // never from `tasks.updated` (which status/lane writes also move).
      // Private metadata under the `_mutation_receipts` precedent: additive,
      // no foreign keys or triggers, never backed up. `update_id` is the
      // task's highest update id at the sync: the breadcrumb watermark (a post
      // in the same millisecond as the sync, but after it, still counts;
      // timestamps cannot order the two). removeTask deletes the row and the
      // backup merge forgets the ids it writes (a restore can reissue a deleted
      // id), so a restored task falls back to its archived `created`.
      this.db.run(`
        CREATE TABLE IF NOT EXISTS _body_edits (
          task_id   INTEGER PRIMARY KEY,
          edited    INTEGER NOT NULL,
          update_id INTEGER NOT NULL DEFAULT 0
        ) WITHOUT ROWID;
      `);
      this.db.run(`INSERT OR IGNORE INTO lanes (name, color, sort) VALUES ('now', '#fe8019', 0);`);
      // NOTE: pre-existing DBs may still have `wip_limit` (lanes) and
      // `focus`/`parked_at`/`park_note` (tasks) columns from earlier versions.
      // SQLite cannot drop columns without a full table rebuild; since each
      // carries a NOT NULL DEFAULT (or is nullable), leaving them in place is
      // harmless — our INSERT/SELECT no longer reference them.
    })();
    // Seed _migrations for DBs created with the current schema so they don't
    // show as pending on the next open.
    this._seedMigrations();
  }

  /** For DBs created before the _migrations table existed, seed entries
   *  when the schema already matches the desired state. Idempotent. */
  private _seedMigrations(): void {
    const tasksDdl = this.db
      .query<{ sql: string | null }, []>("SELECT sql FROM sqlite_master WHERE name='tasks';")
      .get();
    if (!tasksDdl?.sql?.includes("CHECK(status IN ('open','review','blocked','done'))")) {
      this.db.run(`INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES (?, ?);`, ["tasks-status-draft", now()]);
    }
    // tasks-priority-nullable: seed when the live `tasks` DDL already
    // shows `priority INTEGER` without NOT NULL / DEFAULT 1, i.e. a fresh
    // DB created after this migration landed. Detected by absence of the
    // pre-migration string.
    if (tasksDdl?.sql && !tasksDdl.sql.includes("priority INTEGER NOT NULL DEFAULT 1")) {
      this.db.run(`INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES (?, ?);`, [
        "tasks-priority-nullable",
        now(),
      ]);
    }
    const updatesDdl = this.db
      .query<{ sql: string | null }, []>("SELECT sql FROM sqlite_master WHERE name='updates';")
      .get();
    if (!updatesDdl?.sql?.includes("length(summary) <= 200")) {
      this.db.run(`INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES (?, ?);`, [
        "updates-summary-1024",
        now(),
      ]);
    }
    // updates-summary-4096: seed only when the live DDL already carries the
    // 4096 cap (fresh DB). A 1024-era DB must NOT be seeded here — it is
    // picked up as pending below.
    if (updatesDdl?.sql?.includes("length(summary) <= 4096")) {
      this.db.run(`INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES (?, ?);`, [
        "updates-summary-4096",
        now(),
      ]);
    }
  }

  /** Return a list of pending migration names.
   *  Checks _migrations table first, then falls back to schema inspection
   *  for legacy DBs created before _migrations existed. Never writes, so it
   *  is safe inside readSnapshot, where a pre-_migrations database has no
   *  such table yet (read as nothing applied). */
  pendingMigrations(): string[] {
    const applied = new Set(
      this.hasTable("_migrations")
        ? this.db
            .query<{ name: string }, []>("SELECT name FROM _migrations;")
            .all()
            .map(r => r.name)
        : [],
    );
    const pending: string[] = [];

    if (!applied.has("tasks-status-draft")) {
      const tasksDdl = this.db
        .query<{ sql: string | null }, []>("SELECT sql FROM sqlite_master WHERE name='tasks';")
        .get();
      if (tasksDdl?.sql?.includes("CHECK(status IN ('open','review','blocked','done'))")) {
        pending.push("tasks-status-draft");
      }
    }

    if (!applied.has("tasks-priority-nullable")) {
      const tasksDdl = this.db
        .query<{ sql: string | null }, []>("SELECT sql FROM sqlite_master WHERE name='tasks';")
        .get();
      if (tasksDdl?.sql?.includes("priority INTEGER NOT NULL DEFAULT 1")) {
        pending.push("tasks-priority-nullable");
      }
    }

    if (!applied.has("updates-summary-1024")) {
      const updatesDdl = this.db
        .query<{ sql: string | null }, []>("SELECT sql FROM sqlite_master WHERE name='updates';")
        .get();
      if (updatesDdl?.sql?.includes("length(summary) <= 200")) {
        pending.push("updates-summary-1024");
      }
    }

    if (!applied.has("updates-summary-4096")) {
      const updatesDdl = this.db
        .query<{ sql: string | null }, []>("SELECT sql FROM sqlite_master WHERE name='updates';")
        .get();
      // Pending for EVERY older cap, not just 1024: a 200-era DB gets both
      // rebuilds queued in one applyMigrations() pass (1024 runs first —
      // list order — then 4096 rebuilds again) instead of needing a second
      // `cortex init` to reach the current cap.
      const sql = updatesDdl?.sql ?? "";
      if (sql.includes("length(summary) <= 200") || sql.includes("length(summary) <= 1024")) {
        pending.push("updates-summary-4096");
      }
    }

    return pending;
  }

  /** Apply every pending migration using SQLite's safe table-rebuild pattern.
   *  Before each migration a backup is created via VACUUM INTO. After the
   *  data copy, row counts, integrity_check, and foreign_key_check are run.
   *  The old table is ONLY dropped after all validations pass. If anything
   *  fails the old table is kept, the new table is discarded, and an error
   *  is thrown with the backup path for manual recovery.
   *
   *  Returns the names of migrations that were applied. */
  applyMigrations(): string[] {
    const pending = this.pendingMigrations();
    if (pending.length === 0) return [];

    const applied: string[] = [];
    const ts = now();
    const dbFile = dbPath();

    for (const name of pending) {
      // --- 1. Backup ---
      const backupPath = `${dbFile}.bak.${name}.${ts}`;
      try {
        this.db.run(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
      } catch (err) {
        throw new Error(`migration ${name} aborted: backup failed (${(err as Error).message}). No changes were made.`);
      }

      // --- 2. Capture pre-migration state ---
      const oldCounts = this._captureRowCounts(name);

      // --- 3. Apply migration ---
      let newTableName: string | undefined;
      try {
        newTableName = this._runMigration(name);
      } catch (err) {
        this._cleanupNewTable(newTableName);
        throw new Error(
          `migration ${name} failed during rebuild: ${(err as Error).message}\n` +
            `Database is unchanged. Backup: ${backupPath}\n` +
            `To restore: cp ${backupPath} ${dbFile}`,
        );
      }

      // --- 4. Validate ---
      const validation = this._validateMigration(name, oldCounts);
      if (!validation.ok) {
        this._cleanupNewTable(newTableName);
        throw new Error(
          `migration ${name} validation failed: ${validation.error}\n` +
            `Database is unchanged. Backup: ${backupPath}\n` +
            `To restore: cp ${backupPath} ${dbFile}`,
        );
      }

      // --- 5. Record migration ---
      this.db.run(`INSERT INTO _migrations (name, applied_at) VALUES (?, ?);`, [name, ts]);
      applied.push(name);

      // --- 6. Clean up backup ---
      try {
        import("node:fs").then(({ rmSync }) => rmSync(backupPath, { force: true }));
      } catch {
        /* non-fatal — backup can be cleaned up manually */
      }
    }

    return applied;
  }

  /** Whether the schema has table `name` (older databases lack the tables later releases added). */
  private hasTable(name: string): boolean {
    return (
      this.db
        .query<{ one: number }, [string]>(`SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = ?;`)
        .get(name) !== null
    );
  }

  /**
   * Row counts of tasks, lanes and tags for `cortex doctor`. Plain COUNT(*)
   * reads that never write, so they are safe inside readSnapshot; a table an
   * older schema does not have yet counts 0.
   */
  counts(): { tasks: number; lanes: number; tags: number } {
    const count = (table: "tasks" | "lanes" | "tags"): number =>
      this.hasTable(table)
        ? (this.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table};`).get()?.n ?? 0)
        : 0;
    return { tasks: count("tasks"), lanes: count("lanes"), tags: count("tags") };
  }

  /** Capture row counts for the tables affected by a given migration. */
  private _captureRowCounts(name: string): { tasks?: number; updates?: number } {
    const counts: { tasks?: number; updates?: number } = {};
    if (name === "tasks-status-draft" || name === "tasks-priority-nullable") {
      counts.tasks = this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tasks;").get()?.n ?? 0;
    } else if (name === "updates-summary-1024" || name === "updates-summary-4096") {
      counts.updates = this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM updates;").get()?.n ?? 0;
    }
    return counts;
  }

  /** Run a single migration's table rebuild. Returns the name of the new
   *  table so the caller can clean it up on failure. */
  private _runMigration(name: string): string {
    this.db.run("PRAGMA foreign_keys = OFF;");
    try {
      if (name === "tasks-status-draft") {
        this.db.run(`
          CREATE TABLE tasks_new (
            id       INTEGER PRIMARY KEY AUTOINCREMENT,
            lane     TEXT    NOT NULL DEFAULT 'now',
            title    TEXT    NOT NULL,
            body     TEXT,
            status   TEXT    NOT NULL DEFAULT 'open'
                     CHECK(status IN ('draft','open','review','blocked','done')),
            priority INTEGER NOT NULL DEFAULT 1,
            created  INTEGER NOT NULL,
            updated  INTEGER NOT NULL,
            FOREIGN KEY(lane) REFERENCES lanes(name) ON UPDATE CASCADE
          );
        `);
        this.db.run(`INSERT INTO tasks_new SELECT * FROM tasks;`);
        this.db.run(`DROP TABLE tasks;`);
        this.db.run(`ALTER TABLE tasks_new RENAME TO tasks;`);
        this.db.run(
          `INSERT OR REPLACE INTO sqlite_sequence (name, seq) VALUES ('tasks', (SELECT MAX(id) FROM tasks));`,
        );
        return "tasks_new";
      }

      if (name === "tasks-priority-nullable") {
        // Schema-only: widen `priority` from `INTEGER NOT NULL DEFAULT 1`
        // to nullable `INTEGER`. Existing rows are copied untouched
        // (priority=1 stays priority=1). The user owns any data cleanup
        // separately.
        this.db.run(`
          CREATE TABLE tasks_new (
            id       INTEGER PRIMARY KEY AUTOINCREMENT,
            lane     TEXT    NOT NULL DEFAULT 'now',
            title    TEXT    NOT NULL,
            body     TEXT,
            status   TEXT    NOT NULL DEFAULT 'open'
                     CHECK(status IN ('draft','open','review','blocked','done')),
            priority INTEGER,
            created  INTEGER NOT NULL,
            updated  INTEGER NOT NULL,
            FOREIGN KEY(lane) REFERENCES lanes(name) ON UPDATE CASCADE
          );
        `);
        this.db.run(`INSERT INTO tasks_new SELECT * FROM tasks;`);
        this.db.run(`DROP TABLE tasks;`);
        this.db.run(`ALTER TABLE tasks_new RENAME TO tasks;`);
        this.db.run(
          `INSERT OR REPLACE INTO sqlite_sequence (name, seq) VALUES ('tasks', (SELECT MAX(id) FROM tasks));`,
        );
        return "tasks_new";
      }

      if (name === "updates-summary-1024") {
        this.db.run(`
          CREATE TABLE updates_new (
            id       INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id  INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            author   TEXT    NOT NULL,
            summary  TEXT    NOT NULL CHECK(length(summary) <= 1024),
            body     TEXT,
            severity TEXT    NOT NULL
                     CHECK(severity IN ('progress','review','blocked')),
            created  INTEGER NOT NULL
          );
        `);
        this.db.run(`INSERT INTO updates_new SELECT * FROM updates;`);
        this.db.run(`DROP TABLE updates;`);
        this.db.run(`ALTER TABLE updates_new RENAME TO updates;`);
        this.db.run(
          `INSERT OR REPLACE INTO sqlite_sequence (name, seq) VALUES ('updates', (SELECT MAX(id) FROM updates));`,
        );
        return "updates_new";
      }

      if (name === "updates-summary-4096") {
        // Schema-only: widen the summary CHECK 1024 -> 4096 (or 200 -> 4096
        // when chained after updates-summary-1024). Rows copy untouched.
        this.db.run(`
          CREATE TABLE updates_new (
            id       INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id  INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            author   TEXT    NOT NULL,
            summary  TEXT    NOT NULL CHECK(length(summary) <= 4096),
            body     TEXT,
            severity TEXT    NOT NULL
                     CHECK(severity IN ('progress','review','blocked')),
            created  INTEGER NOT NULL
          );
        `);
        this.db.run(`INSERT INTO updates_new SELECT * FROM updates;`);
        this.db.run(`DROP TABLE updates;`);
        this.db.run(`ALTER TABLE updates_new RENAME TO updates;`);
        this.db.run(
          `INSERT OR REPLACE INTO sqlite_sequence (name, seq) VALUES ('updates', (SELECT MAX(id) FROM updates));`,
        );
        return "updates_new";
      }

      throw new Error(`unknown migration: ${name}`);
    } finally {
      this.db.run("PRAGMA foreign_keys = ON;");
    }
  }

  /** Drop a partially-created new table after a failed migration. */
  private _cleanupNewTable(name: string | undefined): void {
    if (!name) return;
    try {
      this.db.run(`DROP TABLE IF EXISTS ${name};`);
    } catch {
      /* best effort */
    }
  }

  /** Validate a migration: row counts, integrity_check, foreign_key_check. */
  private _validateMigration(
    name: string,
    oldCounts: { tasks?: number; updates?: number },
  ): { ok: boolean; error?: string } {
    // Row count
    if (name === "tasks-status-draft" || name === "tasks-priority-nullable") {
      const newCount = this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tasks;").get()?.n ?? 0;
      if (newCount !== oldCounts.tasks) {
        return { ok: false, error: `tasks row count mismatch (expected ${oldCounts.tasks}, got ${newCount})` };
      }
    } else if (name === "updates-summary-1024" || name === "updates-summary-4096") {
      const newCount = this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM updates;").get()?.n ?? 0;
      if (newCount !== oldCounts.updates) {
        return { ok: false, error: `updates row count mismatch (expected ${oldCounts.updates}, got ${newCount})` };
      }
    }

    // Integrity check
    const integrity = this.db.query<{ integrity_check: string }, []>("PRAGMA integrity_check;").get();
    if (integrity?.integrity_check !== "ok") {
      return { ok: false, error: `integrity check failed: ${integrity?.integrity_check}` };
    }

    // Foreign key check
    const fkErrors = this.db
      .query<{ table: string; rowid: number; parent: string; fkid: number }, []>("PRAGMA foreign_key_check;")
      .all();
    if (fkErrors.length > 0) {
      const first = fkErrors[0];
      return {
        ok: false,
        error: `foreign key violation on ${first.table} (row ${first.rowid}) -> ${first.parent}`,
      };
    }

    return { ok: true };
  }

  // ---------- identity, revisions and receipts (plan @400 N7/N8) ----------

  /** This database's UUID: stable for the file's lifetime, new after `cortex reset`. */
  databaseId(): string {
    if (this.cachedDatabaseId === null) {
      const row = this.db
        .query<{ database_id: string }, []>(`SELECT database_id FROM _database_identity WHERE id = 1;`)
        .get();
      if (!row) throw new Error("database identity is missing; open the database writable once to migrate it");
      this.cachedDatabaseId = row.database_id;
    }
    return this.cachedDatabaseId;
  }

  /**
   * A task with its activity and per-scope versions, all from ONE read
   * transaction, so the tokens describe exactly the text returned. Null when
   * the task does not exist. Never writes (safe inside readSnapshot).
   */
  taskState(id: number): TaskState | null {
    return this.db.transaction(() => {
      const task = this.getTask(id);
      if (!task) return null;
      return { task, updates: this.listUpdates(id), versions: this.readVersions("task", id) };
    })();
  }

  /**
   * A lane with its member count and catalog tokens from ONE read
   * transaction, so a guard built from it covers exactly the definition and
   * count it returns (a confirmed delete cannot go stale). Null when the lane
   * does not exist. Never writes.
   */
  laneState(name: string): { lane: Lane & { task_count: number }; versions: Versions } | null {
    return this.db.transaction(() => {
      const lane = this.db.query<Lane, [string]>(`SELECT * FROM lanes WHERE name = ?;`).get(name);
      if (!lane) return null;
      const count =
        this.db.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM tasks WHERE lane = ?;`).get(name)?.n ?? 0;
      return { lane: { ...lane, task_count: count }, versions: this.readVersions("lane", name) };
    })();
  }

  /** A tag with its member count and catalog tokens from ONE read transaction (see laneState). */
  tagState(name: string): { tag: Tag & { task_count: number }; versions: Versions } | null {
    return this.db.transaction(() => {
      const tag = this.db
        .query<Tag & { task_count: number }, [string]>(
          `SELECT g.name, g.color, g.created, COUNT(tt.task_id) AS task_count
             FROM tags g
             LEFT JOIN task_tags tt ON tt.tag_name = g.name
            WHERE g.name = ?
            GROUP BY g.name;`,
        )
        .get(name);
      if (!tag) return null;
      return { tag, versions: this.readVersions("tag", name) };
    })();
  }

  /** Current tokens for every scope of a live task, lane or tag; null once it does not exist. */
  versions(kind: ResourceKind, key: number | string): Versions | null {
    return this.db.transaction(() => (this.resourceExists(kind, key) ? this.readVersions(kind, key) : null))();
  }

  /**
   * Run `write` at most once per mutation id. Looks the receipt up FIRST
   * (before any guard or existence check inside `write`): the same id and
   * digest replay the original JSON result with `replayed: true` and write
   * nothing; the same id with another digest throws MutationReuseError.
   * Otherwise `write` runs and its receipt (digest + JSON of the result) is
   * inserted in the SAME transaction, so effects and receipt commit or roll
   * back together; a failed attempt leaves no receipt. Receipts survive
   * restarts until the database is reset. `write` must be synchronous and
   * return JSON-serializable data (a replay returns the JSON round-trip;
   * `undefined` becomes `null`). Guards passed to Store writes inside `write`
   * may carry this same `mutationId`.
   */
  runIdempotent<T>(id: string, digest: string, write: () => T): { value: T; replayed: boolean } {
    validateMutationId(id);
    if (typeof digest !== "string" || digest.length === 0 || digest.length > MAX_TOKEN_LENGTH) {
      throw new TypeError("runIdempotent: digest must be a non-empty string (see mutationDigest)");
    }
    return this.db.transaction(() => {
      const prior = this.db
        .query<{ digest: string; result: string }, [string]>(
          `SELECT digest, result FROM _mutation_receipts WHERE mutation_id = ?;`,
        )
        .get(id);
      if (prior) {
        if (prior.digest !== digest) throw new MutationReuseError(id);
        return { value: JSON.parse(prior.result) as T, replayed: true };
      }
      const outer = this.activeMutationId;
      this.activeMutationId = id;
      let value: T;
      try {
        value = write();
      } finally {
        this.activeMutationId = outer;
      }
      this.db.run(`INSERT INTO _mutation_receipts (mutation_id, digest, result, created) VALUES (?, ?, ?, ?);`, [
        id,
        digest,
        JSON.stringify(value === undefined ? null : value) ?? "null",
        now(),
      ]);
      return { value, replayed: false };
    })();
  }

  /**
   * Give scopes of the listed resources fresh tokens (default: every scope of
   * the kind). For writers that bypass the Store's methods — the backup
   * merge stamps imported task ids and the catalogs they touched — and must
   * be called inside the same transaction as those writes.
   */
  stampRevisions(
    kind: ResourceKind,
    keys: Iterable<number | string>,
    scopes: readonly ResourceScope[] = scopesOf(kind),
  ): void {
    for (const scope of scopes) {
      if (!scopesOf(kind).includes(scope)) throw new TypeError(`'${scope}' is not a revision scope of a ${kind}`);
    }
    this.db.transaction(() => {
      for (const key of keys) this.bump(kind, key, scopes);
    })();
  }

  /**
   * Forget the body-sync record (agent memory) of tasks written by a raw
   * writer, which must call it inside the same transaction: the backup merge
   * can reissue a deleted id, whose stale record (left by an older binary's
   * delete) must not make the restored task look synced. Those tasks fall
   * back to their archived `created`.
   */
  forgetBodySync(taskIds: Iterable<number>): void {
    this.db.transaction(() => {
      for (const id of taskIds) this.db.run(`DELETE FROM _body_edits WHERE task_id = ?;`, [id]);
    })();
  }

  /** Record a body sync at `ts`, watermarked with the task's highest update id (call inside the write's transaction). */
  private recordBodySync(id: number, ts: number): void {
    this.db.run(
      `INSERT OR REPLACE INTO _body_edits (task_id, edited, update_id)
       VALUES (?, ?, COALESCE((SELECT MAX(id) FROM updates WHERE task_id = ?), 0));`,
      [id, ts, id],
    );
  }

  private resourceExists(kind: ResourceKind, key: number | string): boolean {
    const sql =
      kind === "task"
        ? `SELECT 1 AS one FROM tasks WHERE id = ?;`
        : kind === "lane"
          ? `SELECT 1 AS one FROM lanes WHERE name = ?;`
          : `SELECT 1 AS one FROM tags WHERE name = ?;`;
    return this.db.query<{ one: number }, [number | string]>(sql).get(key) !== null;
  }

  private readVersions(kind: ResourceKind, key: number | string): Versions {
    const resource = resourceKey(kind, key);
    const rows = this.db
      .query<{ scope: ResourceScope; token: string }, [string]>(
        `SELECT scope, token FROM _resource_revisions WHERE resource = ?;`,
      )
      .all(resource);
    const stored = new Map(rows.map(row => [row.scope, row.token]));
    const versions: Versions = {};
    for (const scope of scopesOf(kind)) {
      versions[scope] = stored.get(scope) ?? this.implicitToken(resource, scope);
    }
    return versions;
  }

  /**
   * Token for a scope never stamped (rows written before revisions existed or
   * by raw SQL): derived from (database UUID, resource, scope), so reads stay
   * write-free and tokens never coincide across databases. The first real
   * write replaces it with a random token.
   */
  private implicitToken(resource: string, scope: ResourceScope): string {
    return createHash("sha256").update(`${this.databaseId()}\n${resource}\n${scope}`).digest("hex").slice(0, 32);
  }

  /** Fresh random tokens for `scopes`; rows are upserted, never deleted (tombstones). */
  private bump(kind: ResourceKind, key: number | string, scopes: readonly ResourceScope[]): void {
    const resource = resourceKey(kind, key);
    const upsert = this.db.query<unknown, [string, string, string]>(
      `INSERT INTO _resource_revisions (resource, scope, token) VALUES (?, ?, ?)
       ON CONFLICT(resource, scope) DO UPDATE SET token = excluded.token;`,
    );
    for (const scope of scopes) upsert.run(resource, scope, newToken());
  }

  /**
   * Validate a guard for a write that changes `changed` scopes (pure; before
   * any read). `expected`, when present, opts into compare-and-set and must
   * name every changed scope; extra scopes of the same resource are extra
   * preconditions. A `mutationId` must belong to the enclosing runIdempotent.
   * Returns the versions to compare, or undefined for an unguarded write.
   */
  private parseGuard(
    guard: WriteGuard | undefined,
    target: string,
    allowed: readonly ResourceScope[],
    changed: readonly ResourceScope[],
  ): Versions | undefined {
    if (guard === undefined) return undefined;
    if (!isPlainObject(guard)) throw new WriteGuardError("guard must be an object");
    for (const field of Object.keys(guard)) {
      if (field !== "expected" && field !== "mutationId") throw new WriteGuardError(`unknown guard field '${field}'`);
    }
    if (guard.mutationId !== undefined) {
      validateMutationId(guard.mutationId);
      if (guard.mutationId !== this.activeMutationId) {
        throw new WriteGuardError(`mutationId '${guard.mutationId}' must be applied through Store.runIdempotent`);
      }
    }
    if (guard.expected === undefined) return undefined;
    if (!isPlainObject(guard.expected)) throw new WriteGuardError("guard.expected must map scopes to tokens");
    const expected: Versions = {};
    for (const [scope, value] of Object.entries(guard.expected)) {
      if (value === undefined) continue;
      if (!(allowed as readonly string[]).includes(scope)) {
        throw new WriteGuardError(`'${scope}' is not a revision scope of ${target}`);
      }
      if (typeof value !== "string" || value.length === 0 || value.length > MAX_TOKEN_LENGTH) {
        throw new WriteGuardError(`guard.expected.${scope} must be a non-empty token string`);
      }
      expected[scope as ResourceScope] = value;
    }
    const missing = changed.filter(scope => expected[scope] === undefined);
    if (missing.length > 0) {
      throw new WriteGuardError(`guard must cover every changed scope; missing: ${missing.join(", ")}`);
    }
    return expected;
  }

  /** Compare a parsed guard with the current tokens; call inside the write's transaction, before writing. */
  private assertVersions(kind: ResourceKind, key: number | string, expected: Versions | undefined): void {
    if (expected === undefined) return;
    const current = this.readVersions(kind, key);
    const mismatches: VersionMismatch[] = [];
    for (const scope of scopesOf(kind)) {
      const want = expected[scope];
      const have = current[scope];
      if (want !== undefined && have !== undefined && want !== have) {
        mismatches.push({ scope, expected: want, current: have });
      }
    }
    if (mismatches.length > 0) throw new ConflictError(kind, key, mismatches, current);
  }

  // ---------- task methods ----------

  /**
   * Idempotently create a lane with default settings if it doesn't exist.
   * Used by addTask/moveTask so callers don't have to pre-create lanes.
   * Returns whether the lane was created.
   */
  private ensureLane(name: string): boolean {
    return this.db.run(`INSERT OR IGNORE INTO lanes (name, color, sort) VALUES (?, NULL, 0);`, [name]).changes > 0;
  }

  /** Insert missing tag rows (existing rows keep their colors); returns the names created. */
  private ensureTags(names: readonly string[], ts: number): Set<string> {
    const created = new Set<string>();
    for (const name of names) {
      const inserted = this.db.run(`INSERT OR IGNORE INTO tags (name, color, created) VALUES (?, NULL, ?);`, [
        name,
        ts,
      ]);
      if (inserted.changes > 0) created.add(name);
    }
    return created;
  }

  /** Task ids currently in a lane or carrying a tag (the dependents a rename/delete cascades into). */
  private memberTaskIds(kind: "lane" | "tag", name: string): number[] {
    const sql =
      kind === "lane"
        ? `SELECT id FROM tasks WHERE lane = ? ORDER BY id;`
        : `SELECT task_id AS id FROM task_tags WHERE tag_name = ? ORDER BY task_id;`;
    return this.db
      .query<{ id: number }, [string]>(sql)
      .all(name)
      .map(row => row.id);
  }

  /**
   * Internal row shape for the LEFT JOIN that materialises a task plus its
   * comma-separated tag list. `tag_csv` is alphabetically sorted at the SQL
   * level via GROUP_CONCAT(... ORDER BY tt.tag_name) so JSON output is
   * deterministic; the CLI/UI never re-sort.
   */
  private rowToTask(row: TaskRow): Task {
    const { tag_csv, ...rest } = row;
    return {
      ...rest,
      tags: tag_csv ? tag_csv.split(",") : [],
    };
  }

  /**
   * Create a task. Tags, the optional `created` attribution row and the
   * opt-in `untitled-<id>` title all commit in the insert's transaction
   * (plan @400 N9), after validation, so a create never half-applies. A guard
   * may carry a mutationId (see runIdempotent); a create has no prior
   * versions, so `expected` must be empty.
   */
  addTask(input: AddTaskInput, guard?: WriteGuard): Task {
    return this.createTask(input, guard).task;
  }

  /**
   * addTask returning every row it committed (task, `created` update,
   * notification) so the daemon can publish them after the transaction.
   */
  createTask(input: AddTaskInput, guard?: WriteGuard): CreatedTask {
    const lane = input.lane ?? "now";
    const status: TaskStatus = input.status ?? "open";
    const priority = input.priority ?? null;
    const body = input.body ?? null;
    if (input.untitled === true && input.title !== undefined) {
      throw new Error("an untitled create takes its title from the new id; omit title");
    }
    const title = input.untitled === true ? "untitled" : input.title;
    const tags = Array.from(new Set((input.tags ?? []).map(name => validateTagName(name))));
    const author = input.author === undefined ? undefined : validateAuthorTag(input.author);
    const notification = input.notification;
    this.parseGuard(guard, "a new task", [], []);
    const ts = now();
    return this.db.transaction((): CreatedTask => {
      const laneCreated = this.ensureLane(lane);
      const row = this.db
        .query<{ id: number }, [string, string, string | null, TaskStatus, number | null, number, number]>(
          `INSERT INTO tasks (lane, title, body, status, priority, created, updated)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           RETURNING id;`,
        )
        .get(lane, title, body, status, priority, ts, ts);
      if (!row) throw new Error("failed to insert task");
      if (input.untitled === true) {
        this.db.run(`UPDATE tasks SET title = ? WHERE id = ?;`, [`untitled-${row.id}`, row.id]);
      }
      const createdTags = this.ensureTags(tags, ts);
      for (const name of tags) {
        this.db.run(`INSERT INTO task_tags (task_id, tag_name) VALUES (?, ?);`, [row.id, name]);
      }
      let created: Update | null = null;
      if (author !== undefined) {
        created = this.db
          .query<Update, [number, string, number]>(
            `INSERT INTO updates (task_id, author, summary, body, severity, created)
             VALUES (?, ?, 'created', NULL, 'progress', ?)
             RETURNING *;`,
          )
          .get(row.id, author, ts);
        if (!created) throw new Error("failed to insert created update");
      }
      // The body as created is the stream's first sync (agent memory).
      this.recordBodySync(row.id, ts);
      // Every scope starts fresh (an id reissued after a legacy rebuild never
      // inherits old tokens); the lane and tags gained a member.
      this.bump("task", row.id, TASK_SCOPES);
      this.bump("lane", lane, laneCreated ? CATALOG_SCOPES : ["entity"]);
      for (const name of tags) this.bump("tag", name, createdTags.has(name) ? CATALOG_SCOPES : ["entity"]);
      const full = this.getTask(row.id);
      if (!full) throw new Error("failed to materialise inserted task");
      const notice =
        notification === undefined
          ? null
          : this.insertNotification(
              {
                task_id: full.id,
                author: notification.author,
                status: full.status,
                title: `[${full.id}] ${full.title}`,
                message: "created",
              },
              ts,
            );
      return { task: full, created, notification: notice };
    })();
  }

  /**
   * Run `fn` in one transaction (a savepoint when nested), so a caller can
   * pair a write with reads of its result, e.g. the versions of the row it
   * returned. `fn` must be synchronous and use Store methods only.
   */
  atomically<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /** Tasks, lanes, tags and notifications from ONE read transaction (GET /api/workspace). Never writes. */
  workspace(): { tasks: Task[]; lanes: Lane[]; tags: (Tag & { task_count: number })[]; notifications: Notification[] } {
    return this.db.transaction(() => ({
      tasks: this.listTasks(),
      lanes: this.listLanes(),
      tags: this.listTags(),
      notifications: this.listNotifications(),
    }))();
  }

  listTasks(filter: ListTasksFilter = {}): Task[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter.lane) {
      clauses.push("t.lane = ?");
      params.push(filter.lane);
    }
    if (filter.status) {
      clauses.push("t.status = ?");
      params.push(filter.status);
    }
    if (filter.tags && filter.tags.length > 0) {
      // AND filter: a task must carry every listed tag. Counting DISTINCT
      // matches against the IN list yields the intersection without an N-way
      // self-join. `validateTagName` is NOT called here — callers (CLI flag
      // parsers, HTTP route handlers) gate input; this method trusts its
      // inputs the same way `lane` and `status` are trusted.
      const placeholders = filter.tags.map(() => "?").join(",");
      clauses.push(
        `t.id IN (SELECT task_id FROM task_tags WHERE tag_name IN (${placeholders}) GROUP BY task_id HAVING COUNT(DISTINCT tag_name) = ?)`,
      );
      params.push(...filter.tags, filter.tags.length);
    }
    if (filter.search) {
      const q = `%${filter.search.toLowerCase()}%`;
      clauses.push(`(LOWER(t.title) LIKE ? OR LOWER(COALESCE(t.body, '')) LIKE ?)`);
      params.push(q, q);
    }
    if (filter.title) {
      const q = `%${filter.title.toLowerCase()}%`;
      clauses.push(`LOWER(t.title) LIKE ?`);
      params.push(q);
    }
    if (filter.tagQuery) {
      const q = `%${filter.tagQuery.toLowerCase()}%`;
      clauses.push(`t.id IN (SELECT task_id FROM task_tags WHERE LOWER(tag_name) LIKE ?)`);
      params.push(q);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    // priority ASC so 0 (highest) sorts first; tie-break by oldest-created.
    // `(t.priority IS NULL)` is a 0/1 expression — sorting it ASC pushes
    // null-priority rows AFTER all prioritized rows while preserving the
    // created-time tie-break inside each group. GROUP_CONCAT(... ORDER BY
    // tag_name) gives deterministic alphabetical output. COALESCE turns
    // the empty join (no tags) into '' so the TS split produces []
    // uniformly.
    const sql = `
      SELECT t.*,
             COALESCE(GROUP_CONCAT(tt.tag_name, ',' ORDER BY tt.tag_name), '') AS tag_csv
        FROM tasks t
        LEFT JOIN task_tags tt ON tt.task_id = t.id
        ${where}
       GROUP BY t.id
       ORDER BY (t.priority IS NULL), t.priority ASC, t.created ASC;
    `;
    const rows = this.db.query<TaskRow, (string | number)[]>(sql).all(...params);
    return rows.map(r => this.rowToTask(r));
  }

  getTask(id: number): Task | null {
    const row = this.db
      .query<TaskRow, [number]>(
        `SELECT t.*,
                COALESCE(GROUP_CONCAT(tt.tag_name, ',' ORDER BY tt.tag_name), '') AS tag_csv
           FROM tasks t
           LEFT JOIN task_tags tt ON tt.task_id = t.id
          WHERE t.id = ?
          GROUP BY t.id;`,
      )
      .get(id);
    return row ? this.rowToTask(row) : null;
  }

  /**
   * Compute the three Related buckets for `id`. Inbound references are
   * resolved at the SQL boundary via a bracketed `LIKE` substring search
   * (`'%@[<id>]%'`); bracket delimiters make the match unambiguous — id 1
   * cannot match `@[12]` because `]` immediately follows the captured id.
   * Outbound references re-use the same `REF_RE` grammar over the active
   * task's body + update summaries so the UI and server see one ruleset.
   *
   * Buckets are pairwise-disjoint: `mentions` wins over `mentioned`, both
   * win over `shared`. The active task itself is never returned. Each
   * bucket is materialised through `getTask()` so callers see the
   * standard `Task` shape with tags resolved.
   */
  relatedTasks(id: number): RelatedTasks {
    // --- referencedBy: other tasks whose body OR any update summary mentions `@id`.
    //
    // SQLite LIKE has no regex/word-boundary support, so we use a cheap
    // substring scan (`%@123%`) and then post-filter each candidate's
    // corpus with the canonical REF_RE on the server side. The post-filter
    // is necessary to reject false positives like `@1234` matching
    // `%@123%`. The LIKE pass keeps us off a full table scan when many
    // rows clearly don't reference us.
    const likePat = `%@${id}%`;
    const candidateRows = this.db
      .query<{ id: number; body: string | null }, [number, string, string]>(
        `SELECT DISTINCT t.id, t.body
           FROM tasks t
           LEFT JOIN updates u ON u.task_id = t.id
          WHERE t.id != ?
            AND (t.body LIKE ? OR u.summary LIKE ?);`,
      )
      .all(id, likePat, likePat);
    const referencedByIds = new Set<number>();
    // Resolve referencedBy with a strict regex pass over each candidate's
    // body + update summaries. Distinct REF_RE instance per loop iteration
    // (matchAll consumes lastIndex internally; recreating defensively).
    for (const row of candidateRows) {
      if (referencedByIds.has(row.id)) continue;
      const corpus: string[] = [];
      if (row.body) corpus.push(row.body);
      for (const u of this.listUpdates(row.id)) corpus.push(u.summary);
      const text = corpus.join("\n");
      const scan = new RegExp(REF_RE.source, REF_RE.flags);
      for (const m of text.matchAll(scan)) {
        if (m[1] && Number(m[1]) === id) {
          referencedByIds.add(row.id);
          break;
        }
      }
    }
    const referencedBy = [...referencedByIds]
      .map(rid => this.getTask(rid))
      .filter((t): t is Task => t !== null)
      // null priority sorts last — mirrors the `(priority IS NULL)`
      // ORDER BY in listTasks() so Related output matches list output.
      .sort(
        (a, b) => (a.priority ?? Number.POSITIVE_INFINITY) - (b.priority ?? Number.POSITIVE_INFINITY) || a.id - b.id,
      );
    const referencedByIdSet = new Set(referencedBy.map(t => t.id));

    // --- references: this task's body + update summaries -> outbound @id
    const me = this.getTask(id);
    const corpus: string[] = [];
    if (me?.body) corpus.push(me.body);
    for (const u of this.listUpdates(id)) corpus.push(u.summary);
    const joined = corpus.join("\n");
    const outboundIds = new Set<number>();
    const refScan = new RegExp(REF_RE.source, REF_RE.flags);
    for (const m of joined.matchAll(refScan)) {
      if (m[1]) {
        const targetId = Number(m[1]);
        if (Number.isFinite(targetId) && targetId !== id) outboundIds.add(targetId);
      }
    }
    const references = [...outboundIds]
      .map(tid => this.getTask(tid))
      .filter((t): t is Task => t !== null && !referencedByIdSet.has(t.id))
      .sort(
        (a, b) => (a.priority ?? Number.POSITIVE_INFINITY) - (b.priority ?? Number.POSITIVE_INFINITY) || a.id - b.id,
      );
    const referencesIdSet = new Set(references.map(t => t.id));

    // --- shared: tasks sharing ≥1 NON-blocklisted tag with the active task.
    //
    // Build the candidate tagset in JS (filtering blocklist) instead of
    // embedding the blocklist in SQL — the set is short-lived, comes from
    // the live constant, and avoids parameter-binding gymnastics with
    // dynamic IN lists. Falls back to an empty result when every tag of
    // the active task is blocklisted (e.g. a ["plan"]-only task).
    const myTagsRow = me?.tags ?? [];
    const myTopicalTags = myTagsRow.filter(t => !SHARED_TAG_BLOCKLIST.has(t));
    let shared: Task[] = [];
    if (myTopicalTags.length > 0) {
      // Dynamic placeholder list; safe because tag names are validated at
      // ingest (TAG_NAME_RE) and bound via params.
      const placeholders = myTopicalTags.map(() => "?").join(", ");
      const sharedRows = this.db
        .query<{ id: number }, (string | number)[]>(
          `SELECT DISTINCT t.id
             FROM tasks t
             JOIN task_tags tt ON tt.task_id = t.id
            WHERE t.id != ?
              AND tt.tag_name IN (${placeholders})
            ORDER BY t.priority ASC, t.id ASC;`,
        )
        .all(id, ...myTopicalTags);
      shared = sharedRows
        .map(r => this.getTask(r.id))
        .filter((t): t is Task => t !== null && !referencedByIdSet.has(t.id) && !referencesIdSet.has(t.id))
        .sort(
          (a, b) => (a.priority ?? Number.POSITIVE_INFINITY) - (b.priority ?? Number.POSITIVE_INFINITY) || a.id - b.id,
        );
    }

    return { referencedBy, references, shared };
  }

  /**
   * Edit title/body/priority. With a guard, `expected` must cover each
   * requested field (a body-search counts as `body`) and is compared in the
   * write's transaction (412 ConflictError, nothing written). Unguarded
   * calls stay last-writer-wins. Only values that actually change advance
   * their field token; any accepted write advances `entity`.
   */
  editTask(id: number, fields: EditTaskFields, guard?: WriteGuard): Task {
    // Mutual-exclusion with `body` is enforced at the API layer (server.ts);
    // the store throws a generic Error too (defensive belt + braces).
    const anchored = fields.bodySearch !== undefined || fields.bodyReplace !== undefined;
    if (anchored) {
      if (fields.body !== undefined) {
        throw new Error("editTask: bodySearch/bodyReplace cannot be combined with body");
      }
      if (fields.bodySearch === undefined || fields.bodyReplace === undefined) {
        throw new Error("editTask: bodySearch and bodyReplace must be provided together");
      }
      if (fields.bodySearch.length === 0) {
        throw new Error("editTask: bodySearch cannot be empty");
      }
    }
    const changed: ResourceScope[] = [];
    if (fields.title !== undefined) changed.push("title");
    if (fields.body !== undefined || anchored) changed.push("body");
    if (fields.priority !== undefined) changed.push("priority");
    const expected = this.parseGuard(guard, "a task", TASK_SCOPES, changed);
    return this.db.transaction(() => {
      const existing = this.getTask(id);
      if (!existing) throw new Error(`task ${id} not found`);
      this.assertVersions("task", id, expected);
      // Resolve bodySearch/bodyReplace into a concrete body string inside the
      // same transaction so the read-then-splice-then-write is atomic against
      // any concurrent writer.
      let resolvedBody: string | null | undefined = fields.body;
      if (fields.bodySearch !== undefined && fields.bodyReplace !== undefined) {
        const current = existing.body ?? "";
        const matches = countOccurrences(current, fields.bodySearch);
        if (matches === 0) {
          throw new BodySearchError("not_found", "body-search anchor not found in body");
        }
        if (matches > 1) {
          throw new BodySearchError(
            "ambiguous",
            `body-search anchor matched ${matches} times; refine for uniqueness`,
            matches,
          );
        }
        const idx = current.indexOf(fields.bodySearch);
        resolvedBody = current.slice(0, idx) + fields.bodyReplace + current.slice(idx + fields.bodySearch.length);
      }
      const sets: string[] = [];
      const params: Array<string | number | null> = [];
      if (fields.title !== undefined) {
        sets.push("title = ?");
        params.push(fields.title);
      }
      if (resolvedBody !== undefined) {
        sets.push("body = ?");
        params.push(resolvedBody);
      }
      if (fields.priority !== undefined) {
        sets.push("priority = ?");
        params.push(fields.priority);
      }
      if (sets.length === 0) return existing;
      const ts = now();
      sets.push("updated = ?");
      params.push(ts);
      params.push(id);
      const sql = `UPDATE tasks SET ${sets.join(", ")} WHERE id = ? RETURNING id;`;
      const row = this.db.query<{ id: number }, (string | number | null)[]>(sql).get(...params);
      if (!row) throw new Error(`task ${id} not found`);
      const bumped: ResourceScope[] = ["entity"];
      if (fields.title !== undefined && fields.title !== existing.title) bumped.push("title");
      if (resolvedBody !== undefined && resolvedBody !== existing.body) {
        bumped.push("body");
        this.recordBodySync(id, ts);
      }
      if (fields.priority !== undefined && fields.priority !== existing.priority) bumped.push("priority");
      this.bump("task", id, bumped);
      const full = this.getTask(row.id);
      if (!full) throw new Error(`task ${id} not found`);
      return full;
    })();
  }

  /** Move a task to a lane (auto-created if missing). A guard must cover `lane`. */
  moveTask(id: number, lane: string, guard?: WriteGuard): Task {
    const expected = this.parseGuard(guard, "a task", TASK_SCOPES, ["lane"]);
    return this.db.transaction(() => {
      const existing = this.getTask(id);
      if (!existing) throw new Error(`task ${id} not found`);
      this.assertVersions("task", id, expected);
      const laneCreated = this.ensureLane(lane);
      const row = this.db
        .query<{ id: number }, [string, number, number]>(
          `UPDATE tasks SET lane = ?, updated = ? WHERE id = ? RETURNING id;`,
        )
        .get(lane, now(), id);
      if (!row) throw new Error(`task ${id} not found`);
      if (existing.lane !== lane) {
        this.bump("task", id, ["entity", "lane"]);
        this.bump("lane", existing.lane, ["entity"]);
        this.bump("lane", lane, laneCreated ? CATALOG_SCOPES : ["entity"]);
      } else {
        this.bump("task", id, ["entity"]);
      }
      const full = this.getTask(row.id);
      if (!full) throw new Error(`task ${id} not found`);
      return full;
    })();
  }

  /**
   * Mutate a task's status AND append an audit-trail row to `updates` in the
   * SAME transaction. Conflicting status changes from parallel coding agents
   * become inbox history (chronological), not silent overwrites.
   *
   * `opts.author` is the attribution stamp for the audit row. The CLI passes
   * the validated `--as` value; the dashboard route passes the server-side
   * cascade (`resolveAuthor()`). See transitionStatus for `notify`/guards.
   */
  setStatus(id: number, status: TaskStatus, opts: StatusOptions = {}, guard?: WriteGuard): Task {
    return this.transitionStatus(id, status, opts, guard).task;
  }

  /**
   * setStatus returning everything it committed (task, previous status, audit
   * row, notification) so callers can publish after the transaction. Every
   * accepted write — same status included — is audited and advances the
   * `status` token; a transition notification is persisted only with
   * `opts.notify` and an actual change. A guard must cover `status`.
   */
  transitionStatus(id: number, status: TaskStatus, opts: StatusOptions = {}, guard?: WriteGuard): StatusChange {
    assertTaskStatus(status);
    const expected = this.parseGuard(guard, "a task", TASK_SCOPES, ["status"]);
    return this.db.transaction(() => {
      if (!this.getTask(id)) throw new Error(`task ${id} not found`);
      this.assertVersions("task", id, expected);
      return this.writeStatus(id, status, opts);
    })();
  }

  /** The status write shared by transitionStatus and status-bearing posts; runs inside the caller's transaction. */
  private writeStatus(id: number, status: TaskStatus, opts: StatusOptions): StatusChange {
    const existing = this.getTask(id);
    if (!existing) throw new Error(`task ${id} not found`);
    const ts = now();
    this.db.run(`UPDATE tasks SET status = ?, updated = ? WHERE id = ?;`, [status, ts, id]);
    // Audit-trail: an append-only marker row in `updates` so the inbox
    // surfaces every status flip, attributed to its caller. Preserved
    // verbatim from Plan 3 — setStatus's audit-row write is load-bearing.
    const audit = this.db
      .query<Update, [number, string, string, number]>(
        `INSERT INTO updates (task_id, author, summary, body, severity, created)
         VALUES (?, ?, ?, NULL, 'progress', ?)
         RETURNING *;`,
      )
      .get(id, opts.author ?? "system", `status \u2192 ${status}`, ts);
    if (!audit) throw new Error("failed to insert status audit row");
    this.bump("task", id, ["entity", "status"]);
    const notification =
      opts.notify === true && existing.status !== status
        ? this.insertNotification(
            {
              task_id: id,
              author: opts.author ?? null,
              status,
              title: `[${id}] ${existing.title}`,
              message: `${existing.status} \u2192 ${status}`,
            },
            ts,
          )
        : null;
    const task = this.getTask(id);
    if (!task) throw new Error(`task ${id} not found`);
    return { task, previous: existing.status, audit, notification };
  }

  databasePath(): string {
    return this.databaseFile;
  }

  /**
   * Raw access for callers that need their own SQL inside one transaction
   * (the backup merge). Such writes bypass revision stamping: call
   * stampRevisions for what they touched before returning.
   */
  runInTransaction<T>(fn: (db: Database) => T): T {
    return this.db.transaction(() => fn(this.db))();
  }

  /**
   * Delete a task (updates, tags and notifications cascade). Every scope gets
   * a fresh tombstone token, so a guard read before the delete never matches a
   * reissued id. A guard must cover `entity`, which every accepted task write
   * and every committed update (posts, status audits, `created` rows)
   * advances, so a confirmed delete never cascades a row committed after the
   * confirmation's read. Reports how many notification rows the cascade
   * removed.
   */
  removeTask(id: number, guard?: WriteGuard): { notifications: number } {
    const expected = this.parseGuard(guard, "a task", TASK_SCOPES, ["entity"]);
    return this.db.transaction(() => {
      const existing = this.getTask(id);
      if (!existing) throw new Error(`task ${id} not found`);
      this.assertVersions("task", id, expected);
      const cascaded =
        this.db.query<{ n: number }, [number]>(`SELECT COUNT(*) AS n FROM notifications WHERE task_id = ?;`).get(id)
          ?.n ?? 0;
      this.db.run(`DELETE FROM tasks WHERE id = ?;`, [id]);
      this.db.run(`DELETE FROM _body_edits WHERE task_id = ?;`, [id]);
      this.bump("task", id, TASK_SCOPES);
      this.bump("lane", existing.lane, ["entity"]);
      for (const tag of existing.tags) this.bump("tag", tag, ["entity"]);
      return { notifications: cascaded };
    })();
  }

  // ---------- tag methods ----------

  /**
   * Create a tag explicitly (CLI `cortex tag add`). Note that tags are
   * auto-created on first reference via `setTaskTags()`, so this is for
   * pre-creating a tag with a custom color. A new tag has no prior versions,
   * so a guard may only carry a mutationId (see runIdempotent).
   */
  addTag(input: { name: string; color?: string | null }, guard?: WriteGuard): Tag {
    const name = validateTagName(input.name);
    const color = input.color ?? null;
    this.parseGuard(guard, "a new tag", [], []);
    const ts = now();
    return this.db.transaction(() => {
      const row = this.db
        .query<Tag, [string, string | null, number]>(
          `INSERT INTO tags (name, color, created)
           VALUES (?, ?, ?)
           RETURNING *;`,
        )
        .get(name, color, ts);
      if (!row) throw new Error("failed to insert tag");
      // Fresh tokens even when the name existed before (tombstone), so a
      // recreated tag never matches a guard read from its predecessor.
      this.bump("tag", row.name, CATALOG_SCOPES);
      return row;
    })();
  }

  /**
   * List every tag with the count of tasks currently carrying it. Powers
   * `cortex tag ls` and the dashboard's tag picker. Sorted alphabetically.
   */
  listTags(): (Tag & { task_count: number })[] {
    return this.db
      .query<Tag & { task_count: number }, []>(
        `SELECT g.name, g.color, g.created,
                COALESCE(COUNT(tt.task_id), 0) AS task_count
           FROM tags g
           LEFT JOIN task_tags tt ON tt.tag_name = g.name
          GROUP BY g.name
          ORDER BY g.name ASC;`,
      )
      .all();
  }

  /**
   * Recolor and/or rename a tag. A guard must cover `definition`, plus
   * `entity` for a rename: the old name is retired (tombstoned), the new one
   * starts fresh and every tagged task's entity token advances.
   */
  editTag(name: string, fields: { color?: string | null; rename?: string }, guard?: WriteGuard): Tag {
    // Validate the new name BEFORE writing; ON UPDATE CASCADE on
    // task_tags propagates the change to join rows automatically.
    const rename = fields.rename === undefined ? undefined : validateTagName(fields.rename);
    const changed: ResourceScope[] = [];
    if (fields.color !== undefined || rename !== undefined) changed.push("definition");
    if (rename !== undefined) changed.push("entity");
    const expected = this.parseGuard(guard, "a tag", CATALOG_SCOPES, changed);
    return this.db.transaction(() => {
      const existing = this.db.query<Tag, [string]>(`SELECT * FROM tags WHERE name = ?;`).get(name);
      if (!existing) throw new Error(`tag ${name} not found`);
      this.assertVersions("tag", name, expected);
      const sets: string[] = [];
      const params: Array<string | number | null> = [];
      if (fields.color !== undefined) {
        sets.push("color = ?");
        params.push(fields.color);
      }
      if (rename !== undefined) {
        sets.push("name = ?");
        params.push(rename);
      }
      if (sets.length === 0) return existing;
      const members = rename !== undefined && rename !== name ? this.memberTaskIds("tag", name) : [];
      params.push(name);
      const sql = `UPDATE tags SET ${sets.join(", ")} WHERE name = ? RETURNING *;`;
      const row = this.db.query<Tag, (string | number | null)[]>(sql).get(...params);
      if (!row) throw new Error(`tag ${name} not found`);
      if (row.name !== name) {
        this.bump("tag", name, CATALOG_SCOPES);
        this.bump("tag", row.name, CATALOG_SCOPES);
        for (const taskId of members) this.bump("task", taskId, ["entity"]);
      } else if (row.color !== existing.color) {
        this.bump("tag", name, CATALOG_SCOPES);
      }
      return row;
    })();
  }

  /**
   * Remove a tag. Refuses if any task still uses it unless `force: true`,
   * mirroring `removeLane`. With force, FK ON DELETE CASCADE drops join
   * rows automatically; tasks themselves are never touched (their entity
   * tokens advance). A guard must cover `entity`, which moves whenever the
   * tag's membership does, so a confirmed impact count cannot go stale. The
   * guard is compared before the membership policy: a confirmation raced by
   * a new member is a conflict, not a refusal.
   */
  removeTag(name: string, opts: { force?: boolean } = {}, guard?: WriteGuard): void {
    const expected = this.parseGuard(guard, "a tag", CATALOG_SCOPES, ["entity"]);
    this.db.transaction(() => {
      const existing = this.db.query<Tag, [string]>(`SELECT * FROM tags WHERE name = ?;`).get(name);
      if (!existing) throw new Error(`tag ${name} not found`);
      this.assertVersions("tag", name, expected);
      const members = this.memberTaskIds("tag", name);
      if (!opts.force && members.length > 0) {
        throw new Error(`cannot remove tag '${name}': ${members.length} task(s) reference it (use --force)`);
      }
      this.db.run(`DELETE FROM tags WHERE name = ?;`, [name]);
      this.bump("tag", name, CATALOG_SCOPES);
      for (const taskId of members) this.bump("task", taskId, ["entity"]);
    })();
  }

  /**
   * Replace a task's tag set. The CLI computes the new set in TS for
   * `--add-tag`/`--rm-tag`/`--set-tags` and calls this once — single
   * transaction, no partial-failure states. Auto-creates any tag rows
   * referenced for the first time (`INSERT OR IGNORE`). Whole-set
   * replacement from a stale snapshot is what `entity` guards against, so a
   * guard must cover it.
   */
  setTaskTags(id: number, names: string[], guard?: WriteGuard): Task {
    // Validate every name BEFORE opening the transaction so a bad input
    // can't leave the DB half-modified.
    const validated = names.map(n => validateTagName(n));
    const unique = Array.from(new Set(validated));
    const expected = this.parseGuard(guard, "a task", TASK_SCOPES, ["entity"]);
    return this.db.transaction(() => {
      const existing = this.getTask(id);
      if (!existing) throw new Error(`task ${id} not found`);
      this.assertVersions("task", id, expected);
      // Auto-create missing tag rows. INSERT OR IGNORE so existing tags
      // (with their custom colors) are preserved.
      const created = this.ensureTags(unique, now());
      // Replace semantics: drop everything, then re-insert.
      this.db.run(`DELETE FROM task_tags WHERE task_id = ?;`, [id]);
      for (const n of unique) {
        this.db.run(`INSERT INTO task_tags (task_id, tag_name) VALUES (?, ?);`, [id, n]);
      }
      const before = new Set(existing.tags);
      const after = new Set(unique);
      const touched = [...existing.tags.filter(n => !after.has(n)), ...unique.filter(n => !before.has(n))];
      if (touched.length > 0) this.bump("task", id, ["entity"]);
      for (const n of touched) this.bump("tag", n, created.has(n) ? CATALOG_SCOPES : ["entity"]);
      const full = this.getTask(id);
      if (!full) throw new Error(`task ${id} not found`);
      return full;
    })();
  }

  /**
   * Add and/or remove tag memberships in ONE transaction without replacing
   * the rest of the set, so concurrent unrelated membership changes survive
   * (no read-then-replace). Names are validated first; a name in both lists
   * is rejected. Missing tag rows are auto-created for adds; removing an
   * absent membership is a no-op. Deltas are commutative, so a guard is
   * optional and covers nothing by itself: any scopes it names are extra
   * preconditions. Only real membership changes advance the task's `entity`
   * and each touched tag's tokens.
   */
  changeTaskTags(id: number, delta: TagDelta, guard?: WriteGuard): Task {
    const adds = Array.from(new Set((delta.add ?? []).map(n => validateTagName(n))));
    const removes = Array.from(new Set((delta.remove ?? []).map(n => validateTagName(n))));
    const overlap = adds.filter(n => removes.includes(n));
    if (overlap.length > 0) {
      throw new Error(`tag(s) cannot be both added and removed: ${overlap.join(", ")}`);
    }
    const expected = this.parseGuard(guard, "a task", TASK_SCOPES, []);
    return this.db.transaction(() => {
      if (!this.getTask(id)) throw new Error(`task ${id} not found`);
      this.assertVersions("task", id, expected);
      const created = this.ensureTags(adds, now());
      const touched: string[] = [];
      for (const n of adds) {
        const inserted = this.db.run(`INSERT OR IGNORE INTO task_tags (task_id, tag_name) VALUES (?, ?);`, [id, n]);
        if (inserted.changes > 0) touched.push(n);
      }
      for (const n of removes) {
        const deleted = this.db.run(`DELETE FROM task_tags WHERE task_id = ? AND tag_name = ?;`, [id, n]);
        if (deleted.changes > 0) touched.push(n);
      }
      if (touched.length > 0) this.bump("task", id, ["entity"]);
      for (const n of touched) this.bump("tag", n, created.has(n) ? CATALOG_SCOPES : ["entity"]);
      const full = this.getTask(id);
      if (!full) throw new Error(`task ${id} not found`);
      return full;
    })();
  }

  // ---------- update methods ----------

  /** Post an update and return its row. See postUpdate for `status`/`notify` and guards. */
  addUpdate(input: AddUpdateInput, guard?: WriteGuard): Update {
    return this.postUpdate(input, guard).update;
  }

  /**
   * Post an update. With `status`, ONE transaction writes the message row,
   * then the task's status and its `status → x` audit row by the same author
   * and, with `notify`, the transition notification (plan @400 N9). Every
   * post advances the task's `entity` token (a delete would cascade the new
   * row, so a delete confirmed before it must conflict) and never a field
   * token, so title/body drafts stay valid (N7). A guard must cover `status`
   * when one is set; a stale guard writes neither row.
   */
  postUpdate(input: AddUpdateInput, guard?: WriteGuard): PostedUpdate {
    // Schema requires a non-null severity; Plan 3 makes the column inert —
    // no flag writes to it, no UI surfaces it. Always 'progress'. The column
    // stays in the schema (zero migration cost); a future plan can drop it.
    const severity: Severity = "progress";
    const body = input.body ?? null;
    // Validate the author tag at the single chokepoint. The CLI also
    // validates at flag-parse time (defense in depth) and the HTTP server
    // validates the request body before calling us.
    if (input.author !== undefined && input.author !== null) {
      validateAuthorTag(input.author);
    }
    const status = input.status;
    if (status !== undefined) assertTaskStatus(status);
    const expected = this.parseGuard(guard, "a task", TASK_SCOPES, status === undefined ? [] : ["status"]);
    return this.db.transaction(() => {
      // Plain posts keep the foreign-key failure for a missing task; status or
      // guarded posts check first so the guard is compared before any write.
      if (status !== undefined || expected !== undefined) {
        if (!this.getTask(input.task_id)) throw new Error(`task ${input.task_id} not found`);
        this.assertVersions("task", input.task_id, expected);
      }
      let update: Update | null;
      try {
        update = this.db
          .query<Update, [number, string, string, string | null, Severity, number]>(
            `INSERT INTO updates (task_id, author, summary, body, severity, created)
             VALUES (?, ?, ?, ?, ?, ?)
             RETURNING *;`,
          )
          .get(input.task_id, input.author, input.summary, body, severity, now());
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("CHECK constraint failed")) {
          throw new Error("summary too long (max 4096 chars)");
        }
        throw err;
      }
      if (!update) throw new Error("failed to insert update");
      // writeStatus advances `entity` (with `status`) for a status post.
      if (status === undefined) this.bump("task", input.task_id, ["entity"]);
      const change =
        status === undefined
          ? null
          : this.writeStatus(input.task_id, status, { author: input.author, notify: input.notify });
      return { update, status: change };
    })();
  }

  /** Chronological; `id` breaks same-millisecond ties (a status post's message precedes its audit row). */
  listUpdates(taskId: number): Update[] {
    return this.db
      .query<Update, [number]>(`SELECT * FROM updates WHERE task_id = ? ORDER BY created ASC, id ASC;`)
      .all(taskId);
  }

  /**
   * Distinct authors seen on `updates` in the last 24 hours, with their most
   * recent post timestamp and total post count. Powers the dashboard's
   * Authors tab — a derived view, no new schema, no new column.
   */
  listAuthorsLast24h(): AuthorRow[] {
    return this.db
      .query<AuthorRow, []>(
        `SELECT author,
                MAX(created) AS last_seen,
                COUNT(*)     AS posts
           FROM updates
          WHERE author IS NOT NULL
            AND created > strftime('%s','now','-24 hours') * 1000
          GROUP BY author
          ORDER BY last_seen DESC;`,
      )
      .all();
  }

  // ---------- memory index (plan @414: derived; lazily created; reconciled on every search) ----------

  /**
   * Create the derived FTS5 index on first use, never in migrate(): a SQLite
   * built without FTS5 then breaks only memory search, loudly. Both tables
   * are private (not in backup.ts TABLES), so backups never export them.
   */
  private ensureMemoryIndex(): void {
    this.db.run(
      `CREATE VIRTUAL TABLE IF NOT EXISTS _memory_fts USING fts5(title, tags, body, log, tokenize='porter unicode61');`,
    );
    this.db.run(
      `CREATE TABLE IF NOT EXISTS _memory_index (task_id INTEGER PRIMARY KEY, sig TEXT NOT NULL) WITHOUT ROWID;`,
    );
  }

  /**
   * Bring the index in line with `tasks` (reconcile-on-read: no write path
   * knows the index exists). A task is re-indexed when its signature differs:
   * the `entity` revision token, fresh on EVERY accepted task write (edits,
   * moves, status, posts, tag changes and cascades, restores), plus `updated`
   * for rows never stamped. Removed tasks leave the index. The log column
   * holds update summaries minus machine rows (status audits, `created`).
   */
  private reconcileMemoryIndex(): void {
    const current = this.db
      .query<{ id: number; sig: string }, []>(
        `SELECT t.id AS id, COALESCE(r.token, '') || ':' || t.updated AS sig
           FROM tasks t
           LEFT JOIN _resource_revisions r ON r.resource = 'task:' || t.id AND r.scope = 'entity';`,
      )
      .all();
    const indexed = new Map(
      this.db
        .query<{ task_id: number; sig: string }, []>(`SELECT task_id, sig FROM _memory_index;`)
        .all()
        .map(row => [row.task_id, row.sig]),
    );
    const drop = this.db.query<unknown, [number]>(`DELETE FROM _memory_fts WHERE rowid = ?;`);
    const insert = this.db.query<unknown, [number, string, string, string, string]>(
      `INSERT INTO _memory_fts (rowid, title, tags, body, log) VALUES (?, ?, ?, ?, ?);`,
    );
    const stamp = this.db.query<unknown, [number, string]>(
      `INSERT OR REPLACE INTO _memory_index (task_id, sig) VALUES (?, ?);`,
    );
    const log = this.db.query<{ summary: string }, [number]>(
      `SELECT summary FROM updates
        WHERE task_id = ? AND summary NOT LIKE 'status \u2192 %' AND summary <> 'created'
        ORDER BY id;`,
    );
    for (const { id, sig } of current) {
      const seen = indexed.get(id);
      indexed.delete(id);
      if (seen === sig) continue;
      const task = this.getTask(id);
      if (!task) continue;
      drop.run(id);
      const summaries = log.all(id).map(row => row.summary);
      insert.run(id, task.title, task.tags.join(" "), task.body ?? "", summaries.join("\n"));
      stamp.run(id, sig);
    }
    for (const gone of indexed.keys()) {
      drop.run(gone);
      this.db.run(`DELETE FROM _memory_index WHERE task_id = ?;`, [gone]);
    }
  }

  /**
   * Ranked memory hits for already-tokenized `terms` (src/memory.ts
   * memoryTerms: the ONLY text that may reach MATCH, each term quoted).
   * Coverage first: a task must match at least min(terms, minMatched)
   * distinct terms (a wrong memory is worse than none), then BM25 with
   * title > tags > body > log weights. Ensures and reconciles the index in
   * the same transaction, so a hit always reflects the current task.
   */
  searchMemory(
    terms: readonly string[],
    opts: { lane?: string; limit?: number; exclude?: readonly number[] } = {},
  ): MemoryHit[] {
    if (terms.length === 0) return [];
    const limit = clampInt(opts.limit ?? MEMORY_LIMITS.hits, 1, MEMORY_LIMITS.maxHits);
    const exclude = new Set(opts.exclude ?? []);
    const needed = Math.min(terms.length, MEMORY_LIMITS.minMatched);
    return this.db.transaction((): MemoryHit[] => {
      this.ensureMemoryIndex();
      this.reconcileMemoryIndex();
      const matchOne = this.db.query<{ id: number }, [string]>(
        `SELECT rowid AS id FROM _memory_fts WHERE _memory_fts MATCH ?;`,
      );
      const sets = terms.map(term => new Set(matchOne.all(quoteTerm(term)).map(row => row.id)));
      const coverage = new Map<number, number>();
      for (const set of sets) for (const id of set) coverage.set(id, (coverage.get(id) ?? 0) + 1);
      const candidates = [...coverage].filter(([id, n]) => n >= needed && !exclude.has(id)).map(([id]) => id);
      if (candidates.length === 0) return [];
      const params: (string | number)[] = [terms.map(quoteTerm).join(" OR "), ...candidates];
      let laneClause = "";
      if (opts.lane) {
        laneClause = "AND t.lane = ?";
        params.push(opts.lane);
      }
      params.push(limit);
      const rows = this.db
        .query<{ id: number; rank: number; snippet: string }, (string | number)[]>(
          `SELECT _memory_fts.rowid AS id,
                  bm25(_memory_fts, 6.0, 4.0, 1.0, 0.5) AS rank,
                  snippet(_memory_fts, -1, '**', '**', '\u2026', ${MEMORY_LIMITS.snippetTokens}) AS snippet
             FROM _memory_fts JOIN tasks t ON t.id = _memory_fts.rowid
            WHERE _memory_fts MATCH ? AND _memory_fts.rowid IN (${candidates.map(() => "?").join(", ")}) ${laneClause}
            ORDER BY rank
            LIMIT ?;`,
        )
        .all(...params);
      return rows.flatMap(row => {
        const stream = this.streamRow(row.id);
        if (!stream) return [];
        const matched = terms.filter((_, i) => sets[i]?.has(row.id));
        return [{ ...stream, score: Number((-row.rank).toPrecision(4)), matched, snippet: row.snippet }];
      });
    })();
  }

  /**
   * Bodiless stream rows, newest activity first: `lane`, `author` (tasks with
   * an update by exactly that tag) and `active` (not done) filters. Powers
   * the agent primer (GET /api/memory/streams).
   */
  memoryStreams(filter: { lane?: string; author?: string; active?: boolean; limit?: number } = {}): MemoryStreamRow[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filter.lane) {
      clauses.push("t.lane = ?");
      params.push(filter.lane);
    }
    if (filter.author) {
      clauses.push("t.id IN (SELECT task_id FROM updates WHERE author = ?)");
      params.push(filter.author);
    }
    if (filter.active) clauses.push("t.status <> 'done'");
    params.push(clampInt(filter.limit ?? MEMORY_LIMITS.primerStreams + 1, 1, 50));
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db
      .query<StreamRowSql, (string | number)[]>(
        `${STREAM_ROW_SELECT} ${where} ORDER BY t.updated DESC, t.id DESC LIMIT ?;`,
      )
      .all(...params)
      .map(rowToStream);
  }

  /** One stream with its full update history and body-sync time, from one read transaction; null when missing. */
  memoryStream(id: number): MemoryStream | null {
    return this.db.transaction((): MemoryStream | null => {
      const task = this.getTask(id);
      if (!task) return null;
      const updates = this.listUpdates(id);
      const sync = this.db
        .query<{ edited: number; update_id: number }, [number]>(
          `SELECT edited, update_id FROM _body_edits WHERE task_id = ?;`,
        )
        .get(id);
      if (sync) return { task, updates, synced: sync.edited, syncedUpdateId: sync.update_id };
      // No record (legacy, restored, or written by an older binary): the body
      // as created is the sync; updates written with the task are not breadcrumbs.
      const atCreation = updates.filter(u => u.created <= task.created).reduce((max, u) => Math.max(max, u.id), 0);
      return { task, updates, synced: task.created, syncedUpdateId: atCreation };
    })();
  }

  private streamRow(id: number): MemoryStreamRow | null {
    const row = this.db.query<StreamRowSql, [number]>(`${STREAM_ROW_SELECT} WHERE t.id = ?;`).get(id);
    return row ? rowToStream(row) : null;
  }

  // ---------- notification methods ----------

  /**
   * Convert the SQLite row shape (read INTEGER 0/1) to the public
   * `Notification` (read boolean). Mirrors rowToTask() at the data
   * boundary so the rest of the codebase never sees the 0/1 encoding.
   */
  private rowToNotification(row: NotificationRow): Notification {
    const { read, ...rest } = row;
    return { ...rest, read: read === 1 };
  }

  /** Insert a notification row. The CHECK constraint on `status` rejects
   *  values outside the TaskStatus enum at the SQL boundary. */
  addNotification(input: AddNotificationInput): Notification {
    return this.insertNotification(input, now());
  }

  private insertNotification(input: AddNotificationInput, ts: number): Notification {
    const taskId = input.task_id ?? null;
    const author = input.author ?? null;
    const row = this.db
      .query<NotificationRow, [number | null, string | null, TaskStatus, string, string, number]>(
        `INSERT INTO notifications (task_id, author, status, title, message, created)
         VALUES (?, ?, ?, ?, ?, ?)
         RETURNING *;`,
      )
      .get(taskId, author, input.status, input.title, input.message, ts);
    if (!row) throw new Error("failed to insert notification");
    return this.rowToNotification(row);
  }

  /** Newest-first listing for the bell drawer. The composite ORDER BY
   *  (created DESC, id DESC) tie-breaks rows that share a millisecond
   *  timestamp by insertion order, so test ordering is deterministic. */
  listNotifications(): Notification[] {
    const rows = this.db
      .query<NotificationRow, []>(`SELECT * FROM notifications ORDER BY created DESC, id DESC;`)
      .all();
    return rows.map(r => this.rowToNotification(r));
  }

  /** Returns whether a row changed (false for an unknown or already-read id). */
  markNotificationRead(id: number): boolean {
    return this.db.run(`UPDATE notifications SET read = 1 WHERE id = ? AND read = 0;`, [id]).changes > 0;
  }

  /** Flip a previously-read notification back to unread. Pairs with
   *  markNotificationRead so a user who clicked through too quickly can
   *  re-pin the row to the top of the drawer (the merged feed sorts
   *  unread-first). */
  markNotificationUnread(id: number): boolean {
    return this.db.run(`UPDATE notifications SET read = 0 WHERE id = ? AND read = 1;`, [id]).changes > 0;
  }

  /** Returns how many rows flipped to read. */
  markAllNotificationsRead(): number {
    return this.db.run(`UPDATE notifications SET read = 1 WHERE read = 0;`).changes;
  }

  /** Returns whether a row was deleted. */
  dismissNotification(id: number): boolean {
    return this.db.run(`DELETE FROM notifications WHERE id = ?;`, [id]).changes > 0;
  }

  /** Returns how many rows were deleted. */
  clearNotifications(): number {
    return this.db.run(`DELETE FROM notifications;`).changes;
  }

  // ---------- lane methods ----------

  /** Create a lane. A new lane has no prior versions, so a guard may only carry a mutationId. */
  addLane(input: AddLaneInput, guard?: WriteGuard): Lane {
    const color = input.color ?? null;
    const sort = input.sort ?? 0;
    this.parseGuard(guard, "a new lane", [], []);
    return this.db.transaction(() => {
      const row = this.db
        .query<Lane, [string, string | null, number]>(
          `INSERT INTO lanes (name, color, sort)
           VALUES (?, ?, ?)
           RETURNING *;`,
        )
        .get(input.name, color, sort);
      if (!row) throw new Error("failed to insert lane");
      // Fresh tokens even for a previously deleted name (tombstone).
      this.bump("lane", row.name, CATALOG_SCOPES);
      return row;
    })();
  }

  listLanes(): Lane[] {
    return this.db.query<Lane, []>(`SELECT * FROM lanes ORDER BY sort ASC, name ASC;`).all();
  }

  /**
   * Recolor, re-sort and/or rename a lane. A guard must cover `definition`,
   * plus `entity` for a rename: the old name is retired (tombstoned), the new
   * one starts fresh, and every member task's `lane` and `entity` tokens
   * advance (ON UPDATE CASCADE rewrote their lane).
   */
  editLane(name: string, fields: EditLaneFields, guard?: WriteGuard): Lane {
    const changed: ResourceScope[] = [];
    if (fields.color !== undefined || fields.sort !== undefined || fields.rename !== undefined) {
      changed.push("definition");
    }
    if (fields.rename !== undefined) changed.push("entity");
    const expected = this.parseGuard(guard, "a lane", CATALOG_SCOPES, changed);
    return this.db.transaction(() => {
      const existing = this.db.query<Lane, [string]>(`SELECT * FROM lanes WHERE name = ?;`).get(name);
      if (!existing) throw new Error(`lane ${name} not found`);
      this.assertVersions("lane", name, expected);
      const sets: string[] = [];
      const params: Array<string | number | null> = [];
      if (fields.color !== undefined) {
        sets.push("color = ?");
        params.push(fields.color);
      }
      if (fields.sort !== undefined) {
        sets.push("sort = ?");
        params.push(fields.sort);
      }
      if (fields.rename !== undefined) {
        sets.push("name = ?");
        params.push(fields.rename);
      }
      if (sets.length === 0) return existing;
      const members = fields.rename !== undefined && fields.rename !== name ? this.memberTaskIds("lane", name) : [];
      params.push(name);
      const sql = `UPDATE lanes SET ${sets.join(", ")} WHERE name = ? RETURNING *;`;
      const row = this.db.query<Lane, (string | number | null)[]>(sql).get(...params);
      if (!row) throw new Error(`lane ${name} not found`);
      if (row.name !== name) {
        this.bump("lane", name, CATALOG_SCOPES);
        this.bump("lane", row.name, CATALOG_SCOPES);
        for (const taskId of members) this.bump("task", taskId, ["entity", "lane"]);
      } else if (row.color !== existing.color || row.sort !== existing.sort) {
        this.bump("lane", name, CATALOG_SCOPES);
      }
      return row;
    })();
  }

  /**
   * Delete an empty, non-`now` lane. A guard must cover `entity` (membership
   * moves it); it is compared before the emptiness policy, so a confirmation
   * raced by a new member is a conflict, not a refusal.
   */
  removeLane(name: string, guard?: WriteGuard): void {
    if (name === "now") {
      throw new Error("cannot remove the 'now' lane");
    }
    const expected = this.parseGuard(guard, "a lane", CATALOG_SCOPES, ["entity"]);
    this.db.transaction(() => {
      const existing = this.db.query<Lane, [string]>(`SELECT * FROM lanes WHERE name = ?;`).get(name);
      if (!existing) throw new Error(`lane ${name} not found`);
      this.assertVersions("lane", name, expected);
      const refs = this.db.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM tasks WHERE lane = ?;`).get(name);
      if (refs && refs.n > 0) {
        throw new Error(`cannot remove lane '${name}': ${refs.n} task(s) reference it`);
      }
      this.db.run(`DELETE FROM lanes WHERE name = ?;`, [name]);
      this.bump("lane", name, CATALOG_SCOPES);
    })();
  }

  /** Close the connection, then release the ownership lease if (and only if) this Store acquired it. */
  close(): void {
    try {
      this.db.close();
    } finally {
      this.ownedLease?.release();
    }
  }
}
