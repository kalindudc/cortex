import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { type PendingSelection, pendingSelectionSchema } from "./pending-context-contract";
import type { threadOverrideSchema } from "./workstream-contract";
import type { z } from "zod";

export const PENDING_CONTEXT_MIGRATIONS = [
  "CREATE TABLE IF NOT EXISTS cortex_pending_context (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, payload TEXT NOT NULL)",
];
/** Used and expired selections stay this long, so a retry on the thread that used one still finds it. */
const RETAIN_MS = 24 * 60 * 60 * 1000;
type Database = ReturnType<BbPluginApi["storage"]["database"]>;
/** The existing thread-override path of the workstream store. */
type OverrideWriter = {
  thread(threadId: string): { revision: number };
  setOverride(threadId: string, expectedRevision: number, value: z.infer<typeof threadOverrideSchema>): unknown;
};

export function createPendingStore(db: Database, workstreams: OverrideWriter) {
  function get(id: string): PendingSelection | null {
    const row = db.prepare("SELECT payload FROM cortex_pending_context WHERE id = ?").get(id) as
      | { payload: string }
      | undefined;
    return row ? pendingSelectionSchema.parse(JSON.parse(row.payload)) : null;
  }
  function put(record: PendingSelection): PendingSelection {
    const parsed = pendingSelectionSchema.parse(record);
    db.prepare(
      "INSERT INTO cortex_pending_context VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET expires_at=excluded.expires_at, payload=excluded.payload",
    ).run(parsed.id, Date.parse(parsed.expiresAt), JSON.stringify(parsed));
    return parsed;
  }
  return {
    get,
    put,
    remove(id: string) {
      db.prepare("DELETE FROM cortex_pending_context WHERE id = ?").run(id);
    },
    /** A thread whose first dispatch was refused is deleted; its selection becomes usable again by the restored draft. */
    release(threadId: string) {
      const rows = db
        .prepare("SELECT payload FROM cortex_pending_context WHERE json_extract(payload, '$.usedBy') = ?")
        .all(threadId) as { payload: string }[];
      for (const row of rows) put({ ...pendingSelectionSchema.parse(JSON.parse(row.payload)), usedBy: null, usedAt: null });
    },
    prune(now: number) {
      db.prepare("DELETE FROM cortex_pending_context WHERE expires_at < ?").run(now - RETAIN_MS);
    },
    /**
     * Writes the selection's changes as the thread's overrides and marks it used, in one transaction, so concurrent
     * attempts on one thread write them once and another thread can never take a used selection.
     */
    apply(id: string, threadId: string, check: (record: PendingSelection) => void): "applied" | "already" {
      return db.transaction(() => {
        const record = get(id);
        if (!record) throw new Error("The Cortex changes in this message no longer exist.");
        if (record.usedBy === threadId) return "already" as const;
        if (record.usedBy !== null) throw new Error("These Cortex changes were already used by another thread.");
        check(record);
        const at = new Date().toISOString();
        for (const change of record.changes)
          workstreams.setOverride(threadId, workstreams.thread(threadId).revision, {
            knowledgeId: change.knowledgeId,
            canonicalRevision: change.canonicalRevision,
            excluded: change.excluded,
            text: change.text,
            actor: record.actor,
            updatedAt: at,
          });
        put({ ...record, usedBy: threadId, usedAt: at });
        return "applied" as const;
      })();
    },
  };
}
export type PendingStore = ReturnType<typeof createPendingStore>;
