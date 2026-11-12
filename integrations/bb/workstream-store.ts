import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { createDraftStore, DRAFT_MIGRATIONS } from "./draft-store";
import {
  actorSchema,
  bindingRowSchema,
  bindingSchema,
  contextThreadIdSchema,
  deliveryReceiptSchema,
  threadGrantSchema,
  threadOverrideSchema,
  type DeliveryReceipt,
  type WorkstreamBinding,
} from "./workstream-contract";

import { createSectionJobStore, type JobRecord } from "./section-store";
import { createPendingStore, PENDING_CONTEXT_MIGRATIONS } from "./pending-context-store";

const prefsSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    binding: bindingSchema.nullable(),
    overrides: z.array(threadOverrideSchema).max(100),
    grants: z.array(threadGrantSchema).max(100),
    dismissed: z.boolean().nullable(),
  })
  .strict();
type Prefs = z.infer<typeof prefsSchema>;
const empty = (): Prefs => ({ revision: 0, binding: null, overrides: [], grants: [], dismissed: null });

export function createWorkstreamStore(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS workstream_bindings (key TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS workstream_thread_prefs (thread_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS workstream_receipts (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, emitted_at TEXT NOT NULL, payload TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS workstream_receipts_thread ON workstream_receipts(thread_id, emitted_at DESC)`,
    `CREATE TRIGGER IF NOT EXISTS workstream_receipts_immutable_update BEFORE UPDATE ON workstream_receipts BEGIN SELECT RAISE(ABORT, 'delivery receipts are immutable'); END`,
    `CREATE TRIGGER IF NOT EXISTS workstream_receipts_immutable_delete BEFORE DELETE ON workstream_receipts BEGIN SELECT RAISE(ABORT, 'delivery receipts are immutable'); END`,
    `CREATE TABLE IF NOT EXISTS workstream_prepared_bindings (thread_id TEXT PRIMARY KEY, payload TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS workstream_section_jobs (request_id TEXT PRIMARY KEY, section_id TEXT NOT NULL, payload TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS workstream_title_marks (section_id TEXT PRIMARY KEY, payload TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS workstream_binding_history (section_id TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(section_id, revision))`,
    ...DRAFT_MIGRATIONS,
    ...PENDING_CONTEXT_MIGRATIONS,
  ]);
  function thread(threadId: string): Prefs {
    contextThreadIdSchema.parse(threadId);
    const row = db.prepare("SELECT payload FROM workstream_thread_prefs WHERE thread_id = ?").get(threadId) as
      | { payload: string }
      | undefined;
    return row ? prefsSchema.parse(JSON.parse(row.payload)) : empty();
  }
  function change(threadId: string, expectedRevision: number | null, update: (prefs: Prefs) => void): Prefs {
    return db.transaction(() => {
      const prefs = thread(threadId);
      if (expectedRevision !== null && prefs.revision !== expectedRevision)
        throw new Error(
          `Thread context revision mismatch: expected ${expectedRevision}, current ${prefs.revision}. Re-read before saving; your input was not applied.`,
        );
      update(prefs);
      prefs.revision++;
      const payload = JSON.stringify(prefsSchema.parse(prefs));
      db.prepare(
        "INSERT INTO workstream_thread_prefs VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET revision=excluded.revision, payload=excluded.payload",
      ).run(threadId, prefs.revision, payload);
      return prefs;
    })();
  }
  function section(key: string) {
    const row = db.prepare("SELECT payload FROM workstream_bindings WHERE key = ?").get(key) as
      | { payload: string }
      | undefined;
    return row ? bindingRowSchema.parse(JSON.parse(row.payload)) : { key, revision: 0, binding: null };
  }
  const jobs = createSectionJobStore(db);
  const store = {
    jobs,
    drafts: createDraftStore(db),
    connectJob(record: Extract<JobRecord, { kind: "connect" }>, binding: WorkstreamBinding) {
      return db.transaction(() => {
        const current = section(record.input.sectionId);
        if (current.revision !== record.input.expectedRevision)
          throw new Error("Section binding revision conflict; connection was not applied.");
        const row = bindingRowSchema.parse({ key: current.key, revision: current.revision + 1, binding });
        db.prepare(
          "INSERT INTO workstream_bindings VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET revision=excluded.revision, payload=excluded.payload",
        ).run(row.key, row.revision, JSON.stringify(row));
        db.prepare("INSERT INTO workstream_binding_history VALUES (?, ?, ?)").run(
          row.key,
          row.revision,
          JSON.stringify({ ...row, actor: record.actor, at: new Date().toISOString(), requestId: record.requestId }),
        );
        jobs.put({ ...record, status: "connected", bindingRevision: row.revision, error: null });
        return row;
      })();
    },
    thread,
    section,
    sections() {
      return (
        db.prepare("SELECT payload FROM workstream_bindings ORDER BY key LIMIT 1000").all() as { payload: string }[]
      ).map(row => bindingRowSchema.parse(JSON.parse(row.payload)));
    },
    setSection(
      key: string,
      expectedRevision: number,
      binding: WorkstreamBinding | null,
      actor?: z.infer<typeof actorSchema>,
    ) {
      return db.transaction(() => {
        const current = section(key);
        if (current.revision !== expectedRevision)
          throw new Error(
            `Section binding revision mismatch: expected ${expectedRevision}, current ${current.revision}.`,
          );
        const next = bindingRowSchema.parse({ key, revision: current.revision + 1, binding });
        db.prepare(
          "INSERT INTO workstream_bindings VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET revision=excluded.revision, payload=excluded.payload",
        ).run(key, next.revision, JSON.stringify(next));
        if (actor)
          db.prepare("INSERT INTO workstream_binding_history VALUES (?, ?, ?)").run(
            key,
            next.revision,
            JSON.stringify({ ...next, actor: actorSchema.parse(actor), at: new Date().toISOString(), requestId: null }),
          );
        return next;
      })();
    },
    setThreadBinding(threadId: string, expectedRevision: number, binding: WorkstreamBinding | null) {
      return change(threadId, expectedRevision, prefs => {
        prefs.binding = binding;
      });
    },
    setOverride(threadId: string, expectedRevision: number, value: z.infer<typeof threadOverrideSchema>) {
      return change(threadId, expectedRevision, prefs => {
        const parsed = threadOverrideSchema.parse(value);
        prefs.overrides = prefs.overrides.filter(row => row.knowledgeId !== parsed.knowledgeId);
        if (parsed.excluded || parsed.text !== null) prefs.overrides.push(parsed);
      });
    },
    setGrant(
      threadId: string,
      expectedRevision: number,
      kind: "knowledge" | "legacy-task",
      id: string,
      granted: boolean,
      actor: z.infer<typeof actorSchema>,
    ) {
      return change(threadId, expectedRevision, prefs => {
        const old = prefs.grants.find(row => row.kind === kind && row.id === id);
        prefs.grants = prefs.grants.filter(row => row.kind !== kind || row.id !== id);
        const now = new Date().toISOString();
        if (granted) prefs.grants.push({ kind, id, actor: actorSchema.parse(actor), grantedAt: now, revokedAt: null });
        else if (old) prefs.grants.push({ ...old, revokedAt: now });
      });
    },
    hasBindings() {
      return (
        (
          db
            .prepare(
              "SELECT count(*) AS n FROM workstream_bindings WHERE json_extract(payload, '$.binding') IS NOT NULL",
            )
            .get() as { n: number }
        ).n > 0 ||
        (
          db
            .prepare(
              "SELECT count(*) AS n FROM workstream_thread_prefs WHERE json_extract(payload, '$.binding') IS NOT NULL",
            )
            .get() as { n: number }
        ).n > 0
      );
    },
    tracked(threadId: string) {
      const row = db.prepare("SELECT payload FROM workstream_prepared_bindings WHERE thread_id=?").get(threadId) as
        | { payload: string }
        | undefined;
      if (!row) return false;
      const parsed = z
        .object({ binding: bindingSchema.nullable(), changed: z.boolean() })
        .strict()
        .parse(JSON.parse(row.payload));
      return parsed.binding !== null || parsed.changed;
    },
    observeBinding(threadId: string, binding: WorkstreamBinding | null) {
      const schema = z.object({ binding: bindingSchema.nullable(), changed: z.boolean() }).strict();
      const row = db.prepare("SELECT payload FROM workstream_prepared_bindings WHERE thread_id=?").get(threadId) as
        | { payload: string }
        | undefined;
      const previous = row ? schema.parse(JSON.parse(row.payload)) : null;
      const changed = previous !== null && JSON.stringify(previous.binding) !== JSON.stringify(binding);
      db.prepare(
        "INSERT INTO workstream_prepared_bindings VALUES (?,?) ON CONFLICT(thread_id) DO UPDATE SET payload=excluded.payload",
      ).run(threadId, JSON.stringify({ binding, changed }));
      return changed;
    },
    dismiss(threadId: string, dismissed: boolean | null) {
      return change(threadId, null, prefs => {
        prefs.dismissed = dismissed;
      });
    },
    receipt(value: Omit<DeliveryReceipt, "id" | "emittedAt">) {
      const row = deliveryReceiptSchema.parse({ ...value, id: randomUUID(), emittedAt: new Date().toISOString() });
      db.prepare("INSERT INTO workstream_receipts VALUES (?, ?, ?, ?)").run(
        row.id,
        row.threadId,
        row.emittedAt,
        JSON.stringify(row),
      );
      return row;
    },
    receipts(threadId: string, limit: number, offset: number) {
      contextThreadIdSchema.parse(threadId);
      z.number().int().min(1).max(100).parse(limit);
      z.number().int().nonnegative().parse(offset);
      const rows = db
        .prepare(
          "SELECT payload FROM workstream_receipts WHERE thread_id = ? ORDER BY emitted_at DESC, rowid DESC LIMIT ? OFFSET ?",
        )
        .all(threadId, limit, offset) as { payload: string }[];
      const total = (
        db.prepare("SELECT count(*) AS n FROM workstream_receipts WHERE thread_id = ?").get(threadId) as { n: number }
      ).n;
      return { receipts: rows.map(row => deliveryReceiptSchema.parse(JSON.parse(row.payload))), total, limit, offset };
    },
  };
  return { ...store, pending: createPendingStore(db, store) };
}
