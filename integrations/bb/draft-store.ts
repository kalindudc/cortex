import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { draftConfigSchema, draftPreviewSchema, draftRecordSchema, draftRpcMethods, draftSourceSnapshotSchema, type DraftConfig, type DraftExecution, type DraftPreview, type DraftRecord, type DraftSelection, type DraftSource, DRAFT_LIMITS } from "./draft-contract";
import { draftHash, validateDraftOutput } from "./draft-validation";

export const DRAFT_MIGRATIONS = [
  "CREATE TABLE IF NOT EXISTS cortex_draft_config (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS cortex_draft_sources (id TEXT PRIMARY KEY, section_id TEXT NOT NULL, expires_at TEXT NOT NULL, payload TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS cortex_draft_jobs (request_id TEXT PRIMARY KEY, section_id TEXT NOT NULL, active INTEGER NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL)",
  "CREATE UNIQUE INDEX IF NOT EXISTS cortex_draft_worker ON cortex_draft_jobs(json_extract(payload,'$.worker.threadId')) WHERE json_extract(payload,'$.worker.threadId') IS NOT NULL",
];
type Database = ReturnType<BbPluginApi["storage"]["database"]>;
const privatePreviewSchema = draftPreviewSchema.safeExtend({ personalProjectId: z.string().min(1).max(200) }).strict();
const payload = (value: unknown) => JSON.stringify(value);
const pinned = (r: DraftRecord) => payload({ intent: r.intent, source: r.source, execution: r.execution, requester: r.requester, workerNonce: r.workerNonce,
  requestId: r.requestId, sectionId: r.sectionId, sourceThreadId: r.sourceThreadId, sourceSnapshotId: r.sourceSnapshotId, bindingRevision: r.bindingRevision, workstreamId: r.workstreamId, workstreamRevision: r.workstreamRevision, requestedAt: r.requestedAt, deadlineAt: r.deadlineAt, intendedIds: r.candidateResults.map(c => c.intendedId) });
function integrity(r: DraftRecord) {
  if (r.intent.requestId !== r.requestId || r.intent.sectionId !== r.sectionId || r.intent.sourceThreadId !== r.sourceThreadId || r.intent.sourceSnapshotId !== r.sourceSnapshotId || r.intent.expectedBindingRevision !== r.bindingRevision || r.intent.expectedConfigRevision !== r.execution.configRevision || r.source.snapshotId !== r.sourceSnapshotId || r.source.sectionId !== r.sectionId || r.source.sourceThreadId !== r.sourceThreadId || r.source.bindingRevision !== r.bindingRevision || r.source.workstreamId !== r.workstreamId || r.source.workstreamRevision !== r.workstreamRevision) throw new Error("Draft intent and pinned source/execution do not match.");
  if (new Set(r.candidateResults.map(c => c.intendedId)).size !== DRAFT_LIMITS.findings) throw new Error("Draft candidate intended IDs must be distinct.");
  if (r.output !== null) validateDraftOutput(payload(r.output), r.source);
}
export function createDraftStore(db: Database) {
  function configGet(): DraftConfig {
    const row = db.prepare("SELECT payload FROM cortex_draft_config WHERE id=1").get() as { payload: string } | undefined;
    return row ? draftConfigSchema.parse(JSON.parse(row.payload)) : { revision: 0, selection: null, updatedAt: null, updatedBy: null };
  }
  function get(requestId: string): DraftRecord | null {
    const row = db.prepare("SELECT payload FROM cortex_draft_jobs WHERE request_id=?").get(requestId) as { payload: string } | undefined;
    return row ? draftRecordSchema.parse(JSON.parse(row.payload)) : null;
  }
  function put(record: DraftRecord) {
    db.prepare("INSERT INTO cortex_draft_jobs VALUES (?,?,?,?,?) ON CONFLICT(request_id) DO UPDATE SET active=excluded.active, revision=excluded.revision, payload=excluded.payload").run(record.requestId, record.sectionId, record.active ? 1 : 0, record.revision, payload(record));
  }
  function update(value: DraftRecord, expectedRevision: number): DraftRecord {
    return db.transaction(() => {
      const next = draftRecordSchema.parse(value); const current = get(next.requestId);
      if (!current || current.revision !== expectedRevision) throw new Error("Draft job revision conflict. Read the current job before retrying.");
      integrity(next);
      if (pinned(next) !== pinned(current)) throw new Error("Draft job intent/source/execution/candidate IDs are immutable and pinned.");
      for (const field of ["personalProjectId", "bootstrapQueueId", "setupUpdatedAt", "setupSendAt", "activationQueueId", "activationHash", "activationUpdatedAt", "admittedRequestId", "terminalTurnId"] as const)
        if (current[field] !== null && current[field] !== next[field]) throw new Error(`Draft ${field} identity is immutable once pinned.`);
      if (current.cancellation.state === "confirmed" && next.cancellation.state !== "confirmed") throw new Error("Confirmed cancellation cannot be reversed.");
      if (current.worker.threadId !== null && current.worker.threadId !== next.worker.threadId) throw new Error("An owned worker mapping cannot be replaced.");
      if (current.worker.state !== "not-requested" && next.worker.state === "not-requested") throw new Error("Uncertain worker creation cannot be reset. Discover the owned worker, never respawn.");
      if (current.worker.state !== "not-requested" && current.worker.state !== "requesting" && next.worker.state === "requesting") throw new Error("Uncertain worker creation cannot be retried. Discover the owned worker.");
      if (!next.active && next.worker.state !== "not-requested" && next.worker.state !== "stopped") throw new Error("Confirm the owned worker stopped before releasing active capacity.");
      if (current.cancellation.state !== "none" && next.cancellation.state === "none") throw new Error("Cancellation intent cannot be reset.");
      for (let i = 0; i < current.candidateResults.length; i++) {
        const old = current.candidateResults[i], result = next.candidateResults[i];
        if (old.canonicalId !== null && old.canonicalId !== result.canonicalId) throw new Error("A committed candidate link cannot be erased or retargeted.");
      }
      next.revision = current.revision + 1; next.updatedAt = new Date().toISOString(); put(next); return get(next.requestId)!;
    })();
  }
  return {
    configGet,
    configSet(expectedRevision: number, selection: DraftSelection | null, actor: DraftRecord["requester"]): DraftConfig {
      return db.transaction(() => {
        draftRpcMethods.draftConfigSet.input.parse({ expectedRevision, selection });
        const current = configGet();
        if (current.revision !== expectedRevision) throw new Error("Draft config revision conflict. Your selection was not changed.");
        const next = draftConfigSchema.parse({ revision: current.revision + 1, selection, updatedAt: new Date().toISOString(), updatedBy: actor });
        db.prepare("INSERT INTO cortex_draft_config VALUES (1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload").run(payload(next));
        return configGet();
      })();
    },
    snapshotPut(input: DraftSource, execution: DraftExecution, personalProjectId: string): DraftPreview {
      const source = draftSourceSnapshotSchema.parse(input); const next = privatePreviewSchema.parse({ ...source, execution, personalProjectId });
      return db.transaction(() => {
        const now = new Date().toISOString();
        db.prepare("DELETE FROM cortex_draft_sources WHERE expires_at<=?").run(now);
        const old = db.prepare("SELECT payload FROM cortex_draft_sources WHERE id=?").get(source.snapshotId) as { payload: string } | undefined;
        if (old && old.payload !== payload(next)) throw new Error("Draft source snapshot intent is immutable.");
        db.prepare("INSERT OR IGNORE INTO cortex_draft_sources VALUES (?,?,?,?)").run(source.snapshotId, source.sectionId, source.expiresAt, payload(next));
        db.prepare("DELETE FROM cortex_draft_sources WHERE rowid NOT IN (SELECT rowid FROM cortex_draft_sources ORDER BY rowid DESC LIMIT ?)").run(DRAFT_LIMITS.snapshots);
        const { personalProjectId: _route, ...publicPreview } = next;
        return publicPreview;
      })();
    },
    snapshotGet(snapshotId: string): z.infer<typeof privatePreviewSchema> | null {
      const row = db.prepare("SELECT payload FROM cortex_draft_sources WHERE id=? AND expires_at>?").get(snapshotId, new Date().toISOString()) as { payload: string } | undefined;
      return row ? privatePreviewSchema.parse(JSON.parse(row.payload)) : null;
    },
    create(value: DraftRecord): DraftRecord {
      return db.transaction(() => {
        const record = draftRecordSchema.parse(value); integrity(record);
        record.fingerprint = draftHash(payload(record.intent));
        const old = get(record.requestId);
        if (old) { if (old.fingerprint !== record.fingerprint) throw new Error("Draft request ID conflict: existing intent cannot be replaced."); return old; }
        const config = configGet();
        if (config.revision !== record.execution.configRevision) throw new Error("Draft config revision changed before job persistence.");
        // The resolver pins bb's standard tier for a saved choice without one, and drops the tier for providers that have none.
        const e = record.execution, chosen = config.selection;
        const tierMatches = e.serviceTier === undefined || e.serviceTier === (chosen?.serviceTier ?? "default");
        const matchesConfig = chosen === null ? e.origin === "source-thread" : e.origin === "configured" && e.providerId === chosen.providerId && e.model === chosen.model && e.reasoningLevel === chosen.reasoningLevel && tierMatches;
        // A draft that chose its own model skips the setting comparison; the config revision check above still applies.
        if (e.origin !== "override" && !matchesConfig) throw new Error("Draft execution does not match the pinned config selection.");
        const sectionCount = (db.prepare("SELECT count(*) AS n FROM cortex_draft_jobs WHERE section_id=? AND active=1").get(record.sectionId) as { n: number }).n;
        if (sectionCount >= DRAFT_LIMITS.activePerSection) throw new Error("An active draft job already exists in this section.");
        const globalCount = (db.prepare("SELECT count(*) AS n FROM cortex_draft_jobs WHERE active=1").get() as { n: number }).n;
        if (globalCount >= DRAFT_LIMITS.activeGlobal) throw new Error("The bounded global draft-job limit is reached.");
        record.revision = 1; put(record); return get(record.requestId)!;
      })();
    },
    get,
    update,
    list(sectionId: string, limit: number, offset: number) {
      draftRpcMethods.draftJobs.input.parse({ sectionId, limit, offset });
      const rows = db.prepare("SELECT payload FROM cortex_draft_jobs WHERE section_id=? ORDER BY rowid ASC LIMIT ? OFFSET ?").all(sectionId, limit, offset) as { payload: string }[];
      const total = (db.prepare("SELECT count(*) AS n FROM cortex_draft_jobs WHERE section_id=?").get(sectionId) as { n: number }).n;
      return { jobs: rows.map(r => draftRecordSchema.parse(JSON.parse(r.payload))), total, limit, offset };
    },
    ownsWorker(threadId: string): boolean {
      return db.prepare("SELECT request_id FROM cortex_draft_jobs WHERE json_extract(payload,'$.worker.threadId')=?").get(threadId) !== undefined;
    },
    byWorker(threadId: string): DraftRecord | null {
      const row = db.prepare("SELECT payload FROM cortex_draft_jobs WHERE json_extract(payload,'$.worker.threadId')=?").get(threadId) as { payload: string } | undefined;
      return row ? draftRecordSchema.parse(JSON.parse(row.payload)) : null;
    },
    active(): DraftRecord[] {
      const rows = db.prepare("SELECT payload FROM cortex_draft_jobs WHERE active=1 ORDER BY rowid ASC LIMIT ?").all(DRAFT_LIMITS.activeGlobal) as { payload: string }[];
      return rows.map(row => draftRecordSchema.parse(JSON.parse(row.payload)));
    },
    cancel(sectionId: string, requestId: string, expectedRevision: number): DraftRecord {
      const current = get(requestId);
      if (!current || current.sectionId !== sectionId) throw new Error("Draft job not found in selected section.");
      const now = new Date().toISOString(); const local = current.worker.state === "not-requested" || current.worker.state === "stopped";
      return update({ ...current, status: local ? "stopped" : "cancel-requested", active: !local, cancellation: { state: local ? "confirmed" : "requested", requestedAt: current.cancellation.requestedAt ?? now, confirmedAt: local ? now : null }, retry: local ? "none" : "discover-stop" }, expectedRevision);
    },
  };
}
export type DraftStore = ReturnType<typeof createDraftStore>;
