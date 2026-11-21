import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export const DAY_MS = 86_400_000;
const LANE_LIMIT = 10;

export const MEMORY_WRITE_MIGRATIONS = [
  "CREATE TABLE IF NOT EXISTS memory_write_slots (id TEXT PRIMARY KEY, lane TEXT NOT NULL, reserved_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS memory_write_slots_lane ON memory_write_slots(lane, reserved_at)",
  "CREATE INDEX IF NOT EXISTS memory_write_slots_time ON memory_write_slots(reserved_at)",
  "CREATE TABLE IF NOT EXISTS memory_note_receipts (digest TEXT PRIMARY KEY, task_id INTEGER NOT NULL, task_created INTEGER NOT NULL, saved_at INTEGER NOT NULL, exclusion_note TEXT)",
  "CREATE INDEX IF NOT EXISTS memory_note_receipts_time ON memory_note_receipts(saved_at)",
  "CREATE TABLE IF NOT EXISTS memory_note_revisions (task_id INTEGER PRIMARY KEY, task_created INTEGER NOT NULL, update_id INTEGER NOT NULL)",
];

type Receipt = { task_id: number; task_created: number; exclusion_note: string | null };

export function createMemoryWriteStore(db: ReturnType<BbPluginApi["storage"]["database"]>) {
  return {
    reserve(lane: string, now: number): (() => void) | null {
      const cutoff = now - DAY_MS;
      const id = randomUUID();
      db.prepare("DELETE FROM memory_write_slots WHERE reserved_at <= ?").run(cutoff);
      const inserted = db.prepare(
        "INSERT INTO memory_write_slots SELECT ?, ?, ? WHERE (SELECT count(*) FROM memory_write_slots WHERE lane = ? AND reserved_at > ?) < ?",
      ).run(id, lane, now, lane, cutoff, LANE_LIMIT);
      return inserted.changes === 0 ? null : () => {
        db.prepare("DELETE FROM memory_write_slots WHERE id = ?").run(id);
      };
    },
    replay(digest: string, now: number): Receipt | undefined {
      return db.prepare(
        "SELECT task_id, task_created, exclusion_note FROM memory_note_receipts WHERE digest = ? AND saved_at > ?",
      ).get(digest, now - DAY_MS) as Receipt | undefined;
    },
    revision(taskId: number, taskCreated: number): number | undefined {
      const row = db.prepare("SELECT update_id FROM memory_note_revisions WHERE task_id = ? AND task_created = ?")
        .get(taskId, taskCreated) as { update_id: number } | undefined;
      return row?.update_id;
    },
    recordRevision(taskId: number, taskCreated: number, updateId: number): void {
      db.prepare("INSERT OR REPLACE INTO memory_note_revisions VALUES (?, ?, ?)").run(taskId, taskCreated, updateId);
    },
    record(digest: string, taskId: number, taskCreated: number, now: number, exclusionNote: string | null): void {
      db.prepare("DELETE FROM memory_note_receipts WHERE saved_at <= ?").run(now - DAY_MS);
      db.prepare("INSERT OR REPLACE INTO memory_note_receipts VALUES (?, ?, ?, ?, ?)").run(
        digest, taskId, taskCreated, now, exclusionNote,
      );
    },
  };
}
export type MemoryWriteStore = ReturnType<typeof createMemoryWriteStore>;
