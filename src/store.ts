import { Database } from "bun:sqlite";
import { dbPath, ensureConfigDir } from "./paths.ts";

export type TaskStatus = "open" | "review" | "blocked" | "done";
export type Severity = "progress" | "review" | "blocked";

export type Task = {
  id: number;
  lane: string;
  title: string;
  body: string | null;
  status: TaskStatus;
  priority: number;
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
 * Tag-name regex: lowercase letters, digits, `_`, `@`, `-`, length 1-32.
 * The trailing `-` inside the character class is literal (no escape needed).
 * Single source of truth — exported so the CLI flag parsers and HTTP route
 * handlers all gate through validateTagName() instead of duplicating the
 * regex.
 */
export const TAG_NAME_RE = /^[a-z0-9_@-]{1,32}$/;
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
  priority?: number;
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
  priority?: number;
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
};

const now = (): number => Date.now();

export class Store {
  private constructor(private readonly db: Database) {}

  static open(path: string = dbPath()): Store {
    if (path !== ":memory:") {
      ensureConfigDir();
    }
    const db = new Database(path, { strict: true, create: true });
    db.run("PRAGMA journal_mode = WAL;");
    db.run("PRAGMA foreign_keys = ON;");
    const store = new Store(db);
    store.migrate();
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
                   CHECK(status IN ('open','review','blocked','done')),
          priority INTEGER NOT NULL DEFAULT 1,
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
      // Legacy-DB warning: pre-Plan-3 DBs were created with the old 200-char
      // CHECK. SQLite cannot ALTER a CHECK constraint, and auto-recreating the
      // table is destructive; for a single-user tool we warn once and let the
      // human run `cortex reset` when they want the new limit.
      const updatesDdl = this.db
        .query<{ sql: string | null }, []>("SELECT sql FROM sqlite_master WHERE name='updates';")
        .get();
      if (updatesDdl?.sql?.includes("length(summary) <= 200")) {
        console.warn(
          "cortex: updates table has the old 200-char limit; run `cortex reset` to enable the 1024-char limit (existing data lost).",
        );
      }
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
      this.db.run(`INSERT OR IGNORE INTO lanes (name, color, sort) VALUES ('now', '#fe8019', 0);`);
      // NOTE: pre-existing DBs may still have `wip_limit` (lanes) and
      // `focus`/`parked_at`/`park_note` (tasks) columns from earlier versions.
      // SQLite cannot drop columns without a full table rebuild; since each
      // carries a NOT NULL DEFAULT (or is nullable), leaving them in place is
      // harmless — our INSERT/SELECT no longer reference them.
    })();
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
    const priority = input.priority ?? 1;
    const body = input.body ?? null;
    return this.db.transaction(() => {
      this.ensureLane(lane);
      const row = this.db
        .query<{ id: number }, [string, string, string | null, TaskStatus, number, number, number]>(
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
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    // priority ASC so 0 (highest) sorts first; tie-break by oldest-created.
    // GROUP_CONCAT(... ORDER BY tag_name) gives deterministic alphabetical
    // output. COALESCE turns the empty join (no tags) into '' so the TS split
    // produces [] uniformly.
    const sql = `
      SELECT t.*,
             COALESCE(GROUP_CONCAT(tt.tag_name, ',' ORDER BY tt.tag_name), '') AS tag_csv
        FROM tasks t
        LEFT JOIN task_tags tt ON tt.task_id = t.id
        ${where}
       GROUP BY t.id
       ORDER BY t.priority ASC, t.created ASC;
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
