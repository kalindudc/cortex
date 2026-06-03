import { Database } from "bun:sqlite";
import { dbPath, ensureConfigDir } from "./paths.ts";

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

export type AddTaskInput = {
  title: string;
  lane?: string;
  body?: string | null;
  priority?: number | null;
  status?: TaskStatus;
};

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

export class Store {
  private constructor(
    private readonly db: Database,
    private readonly databaseFile: string,
  ) {}

  static open(path: string = dbPath(), opts: { warnMigrations?: boolean } = {}): Store {
    if (path !== ":memory:") {
      ensureConfigDir();
    }
    const db = new Database(path, { strict: true, create: true });
    db.run("PRAGMA journal_mode = WAL;");
    db.run("PRAGMA foreign_keys = ON;");
    const store = new Store(db, path);
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
          summary  TEXT    NOT NULL CHECK(length(summary) <= 1024),
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
  }

  /** Return a list of pending migration names.
   *  Checks _migrations table first, then falls back to schema inspection
   *  for legacy DBs created before _migrations existed. */
  pendingMigrations(): string[] {
    const applied = new Set(
      this.db
        .query<{ name: string }, []>("SELECT name FROM _migrations;")
        .all()
        .map(r => r.name),
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

  /** Capture row counts for the tables affected by a given migration. */
  private _captureRowCounts(name: string): { tasks?: number; updates?: number } {
    const counts: { tasks?: number; updates?: number } = {};
    if (name === "tasks-status-draft" || name === "tasks-priority-nullable") {
      counts.tasks = this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tasks;").get()?.n ?? 0;
    } else if (name === "updates-summary-1024") {
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
    } else if (name === "updates-summary-1024") {
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

  // ---------- task methods ----------

  /**
   * Idempotently create a lane with default settings if it doesn't exist.
   * Used by addTask/moveTask so callers don't have to pre-create lanes.
   */
  private ensureLane(name: string): void {
    this.db.run(`INSERT OR IGNORE INTO lanes (name, color, sort) VALUES (?, NULL, 0);`, [name]);
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

  addTask(input: AddTaskInput): Task {
    const ts = now();
    const lane = input.lane ?? "now";
    const status: TaskStatus = input.status ?? "open";
    const priority = input.priority ?? null;
    const body = input.body ?? null;
    return this.db.transaction(() => {
      this.ensureLane(lane);
      const row = this.db
        .query<{ id: number }, [string, string, string | null, TaskStatus, number | null, number, number]>(
          `INSERT INTO tasks (lane, title, body, status, priority, created, updated)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           RETURNING id;`,
        )
        .get(lane, input.title, body, status, priority, ts, ts);
      if (!row) throw new Error("failed to insert task");
      const full = this.getTask(row.id);
      if (!full) throw new Error("failed to materialise inserted task");
      return full;
    })();
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

  editTask(id: number, fields: EditTaskFields): Task {
    return this.db.transaction(() => {
      // Resolve bodySearch/bodyReplace into a concrete body string FIRST,
      // inside the same transaction so the read-then-splice-then-write is
      // atomic against any concurrent writer. Mutual-exclusion with
      // `body` is enforced at the API layer (server.ts); the store throws
      // a generic Error if both are passed (defensive belt + braces).
      let resolvedBody: string | null | undefined = fields.body;
      if (fields.bodySearch !== undefined || fields.bodyReplace !== undefined) {
        if (fields.body !== undefined) {
          throw new Error("editTask: bodySearch/bodyReplace cannot be combined with body");
        }
        if (fields.bodySearch === undefined || fields.bodyReplace === undefined) {
          throw new Error("editTask: bodySearch and bodyReplace must be provided together");
        }
        if (fields.bodySearch.length === 0) {
          throw new Error("editTask: bodySearch cannot be empty");
        }
        const existing = this.getTask(id);
        if (!existing) throw new Error(`task ${id} not found`);
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
      if (sets.length === 0) {
        const existing = this.getTask(id);
        if (!existing) throw new Error(`task ${id} not found`);
        return existing;
      }
      sets.push("updated = ?");
      params.push(now());
      params.push(id);
      const sql = `UPDATE tasks SET ${sets.join(", ")} WHERE id = ? RETURNING id;`;
      const row = this.db.query<{ id: number }, (string | number | null)[]>(sql).get(...params);
      if (!row) throw new Error(`task ${id} not found`);
      const full = this.getTask(row.id);
      if (!full) throw new Error(`task ${id} not found`);
      return full;
    })();
  }

  moveTask(id: number, lane: string): Task {
    const existing = this.getTask(id);
    if (!existing) throw new Error(`task ${id} not found`);
    const ts = now();
    return this.db.transaction(() => {
      this.ensureLane(lane);
      const row = this.db
        .query<{ id: number }, [string, number, number]>(
          `UPDATE tasks SET lane = ?, updated = ? WHERE id = ? RETURNING id;`,
        )
        .get(lane, ts, id);
      if (!row) throw new Error(`task ${id} not found`);
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
   * cascade (`resolveAuthor()`).
   */
  setStatus(id: number, status: TaskStatus, opts: { author?: string | null } = {}): Task {
    const ts = now();
    return this.db.transaction(() => {
      const row = this.db
        .query<{ id: number }, [TaskStatus, number, number]>(
          `UPDATE tasks SET status = ?, updated = ? WHERE id = ? RETURNING id;`,
        )
        .get(status, ts, id);
      if (!row) throw new Error(`task ${id} not found`);
      // Audit-trail: an append-only marker row in `updates` so the inbox
      // surfaces every status flip, attributed to its caller. Preserved
      // verbatim from Plan 3 — setStatus's audit-row write is load-bearing.
      this.db.run(
        `INSERT INTO updates (task_id, author, summary, body, severity, created)
         VALUES (?, ?, ?, NULL, 'progress', ?);`,
        [id, opts.author ?? "system", `status \u2192 ${status}`, ts],
      );
      const full = this.getTask(row.id);
      if (!full) throw new Error(`task ${id} not found`);
      return full;
    })();
  }

  databasePath(): string {
    return this.databaseFile;
  }

  runInTransaction<T>(fn: (db: Database) => T): T {
    return this.db.transaction(() => fn(this.db))();
  }

  removeTask(id: number): void {
    const existing = this.getTask(id);
    if (!existing) throw new Error(`task ${id} not found`);
    this.db.run(`DELETE FROM tasks WHERE id = ?;`, [id]);
  }

  // ---------- tag methods ----------

  /**
   * Create a tag explicitly (CLI `cortex tag add`). Note that tags are
   * auto-created on first reference via `setTaskTags()`, so this is for
   * pre-creating a tag with a custom color.
   */
  addTag(input: { name: string; color?: string | null }): Tag {
    const name = validateTagName(input.name);
    const color = input.color ?? null;
    const ts = now();
    const row = this.db
      .query<Tag, [string, string | null, number]>(
        `INSERT INTO tags (name, color, created)
         VALUES (?, ?, ?)
         RETURNING *;`,
      )
      .get(name, color, ts);
    if (!row) throw new Error("failed to insert tag");
    return row;
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

  editTag(name: string, fields: { color?: string | null; rename?: string }): Tag {
    return this.db.transaction(() => {
      const sets: string[] = [];
      const params: Array<string | number | null> = [];
      if (fields.color !== undefined) {
        sets.push("color = ?");
        params.push(fields.color);
      }
      if (fields.rename !== undefined) {
        // Validate the new name BEFORE writing; ON UPDATE CASCADE on
        // task_tags propagates the change to join rows automatically.
        sets.push("name = ?");
        params.push(validateTagName(fields.rename));
      }
      if (sets.length === 0) {
        const existing = this.db.query<Tag, [string]>(`SELECT * FROM tags WHERE name = ?;`).get(name);
        if (!existing) throw new Error(`tag ${name} not found`);
        return existing;
      }
      params.push(name);
      const sql = `UPDATE tags SET ${sets.join(", ")} WHERE name = ? RETURNING *;`;
      const row = this.db.query<Tag, (string | number | null)[]>(sql).get(...params);
      if (!row) throw new Error(`tag ${name} not found`);
      return row;
    })();
  }

  /**
   * Remove a tag. Refuses if any task still uses it unless `force: true`,
   * mirroring `removeLane`. With force, FK ON DELETE CASCADE drops join
   * rows automatically; tasks themselves are never touched.
   */
  removeTag(name: string, opts: { force?: boolean } = {}): void {
    const existing = this.db.query<Tag, [string]>(`SELECT * FROM tags WHERE name = ?;`).get(name);
    if (!existing) throw new Error(`tag ${name} not found`);
    if (!opts.force) {
      const refs = this.db
        .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM task_tags WHERE tag_name = ?;`)
        .get(name);
      if (refs && refs.n > 0) {
        throw new Error(`cannot remove tag '${name}': ${refs.n} task(s) reference it (use --force)`);
      }
    }
    this.db.run(`DELETE FROM tags WHERE name = ?;`, [name]);
  }

  /**
   * Replace a task's tag set. The CLI computes the new set in TS for
   * `--add-tag`/`--rm-tag`/`--set-tags` and calls this once — single
   * transaction, no partial-failure states. Auto-creates any tag rows
   * referenced for the first time (`INSERT OR IGNORE`).
   */
  setTaskTags(id: number, names: string[]): Task {
    // Validate every name BEFORE opening the transaction so a bad input
    // can't leave the DB half-modified.
    const validated = names.map(n => validateTagName(n));
    const unique = Array.from(new Set(validated));
    return this.db.transaction(() => {
      const existing = this.getTask(id);
      if (!existing) throw new Error(`task ${id} not found`);
      const ts = now();
      // Auto-create missing tag rows. INSERT OR IGNORE so existing tags
      // (with their custom colors) are preserved.
      for (const n of unique) {
        this.db.run(`INSERT OR IGNORE INTO tags (name, color, created) VALUES (?, NULL, ?);`, [n, ts]);
      }
      // Replace semantics: drop everything, then re-insert.
      this.db.run(`DELETE FROM task_tags WHERE task_id = ?;`, [id]);
      for (const n of unique) {
        this.db.run(`INSERT INTO task_tags (task_id, tag_name) VALUES (?, ?);`, [id, n]);
      }
      const full = this.getTask(id);
      if (!full) throw new Error(`task ${id} not found`);
      return full;
    })();
  }

  // ---------- update methods ----------

  addUpdate(input: AddUpdateInput): Update {
    const ts = now();
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
    try {
      const row = this.db
        .query<Update, [number, string, string, string | null, Severity, number]>(
          `INSERT INTO updates (task_id, author, summary, body, severity, created)
           VALUES (?, ?, ?, ?, ?, ?)
           RETURNING *;`,
        )
        .get(input.task_id, input.author, input.summary, body, severity, ts);
      if (!row) throw new Error("failed to insert update");
      return row;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("CHECK constraint failed")) {
        throw new Error("summary too long");
      }
      throw err;
    }
  }

  listUpdates(taskId: number): Update[] {
    return this.db.query<Update, [number]>(`SELECT * FROM updates WHERE task_id = ? ORDER BY created ASC;`).all(taskId);
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
    const ts = now();
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

  markNotificationRead(id: number): void {
    this.db.run(`UPDATE notifications SET read = 1 WHERE id = ?;`, [id]);
  }

  /** Flip a previously-read notification back to unread. Pairs with
   *  markNotificationRead so a user who clicked through too quickly can
   *  re-pin the row to the top of the drawer (the merged feed sorts
   *  unread-first). */
  markNotificationUnread(id: number): void {
    this.db.run(`UPDATE notifications SET read = 0 WHERE id = ?;`, [id]);
  }

  markAllNotificationsRead(): void {
    this.db.run(`UPDATE notifications SET read = 1 WHERE read = 0;`);
  }

  dismissNotification(id: number): void {
    this.db.run(`DELETE FROM notifications WHERE id = ?;`, [id]);
  }

  clearNotifications(): void {
    this.db.run(`DELETE FROM notifications;`);
  }

  // ---------- lane methods ----------

  addLane(input: AddLaneInput): Lane {
    const color = input.color ?? null;
    const sort = input.sort ?? 0;
    const row = this.db
      .query<Lane, [string, string | null, number]>(
        `INSERT INTO lanes (name, color, sort)
         VALUES (?, ?, ?)
         RETURNING *;`,
      )
      .get(input.name, color, sort);
    if (!row) throw new Error("failed to insert lane");
    return row;
  }

  listLanes(): Lane[] {
    return this.db.query<Lane, []>(`SELECT * FROM lanes ORDER BY sort ASC, name ASC;`).all();
  }

  editLane(name: string, fields: EditLaneFields): Lane {
    return this.db.transaction(() => {
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
      if (sets.length === 0) {
        const existing = this.db.query<Lane, [string]>(`SELECT * FROM lanes WHERE name = ?;`).get(name);
        if (!existing) throw new Error(`lane ${name} not found`);
        return existing;
      }
      params.push(name);
      const sql = `UPDATE lanes SET ${sets.join(", ")} WHERE name = ? RETURNING *;`;
      const row = this.db.query<Lane, (string | number | null)[]>(sql).get(...params);
      if (!row) throw new Error(`lane ${name} not found`);
      return row;
    })();
  }

  removeLane(name: string): void {
    if (name === "now") {
      throw new Error("cannot remove the 'now' lane");
    }
    const refs = this.db.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM tasks WHERE lane = ?;`).get(name);
    if (refs && refs.n > 0) {
      throw new Error(`cannot remove lane '${name}': ${refs.n} task(s) reference it`);
    }
    const existing = this.db.query<Lane, [string]>(`SELECT * FROM lanes WHERE name = ?;`).get(name);
    if (!existing) throw new Error(`lane ${name} not found`);
    this.db.run(`DELETE FROM lanes WHERE name = ?;`, [name]);
  }

  close(): void {
    this.db.close();
  }
}
