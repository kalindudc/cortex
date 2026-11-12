import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { actorSchema, knowledgeSourceSchema } from "./workstream-contract";
import { sectionRpcMethods, titleMarkSchema, type TitleMark } from "./section-contract";

export const jobRecordSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("connect"),
      requestId: z.string().uuid(),
      fingerprint: z.string(),
      input: sectionRpcMethods.sectionConnect.input,
      actor: actorSchema,
      intendedId: z.string(),
      status: z.enum(["pending", "connecting", "connected", "failed"]),
      bindingRevision: z.number().int().nonnegative().nullable(),
      error: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("capture"),
      requestId: z.string().uuid(),
      fingerprint: z.string(),
      input: sectionRpcMethods.sectionCapture.input.nullable(),
      sectionId: z.string(),
      workstreamId: z.string(),
      actor: actorSchema,
      intendedId: z.string(),
      canonicalId: z.string().nullable(),
      sources: z.array(knowledgeSourceSchema),
      status: z.enum(["pending", "saved", "no-save", "failed"]),
      error: z.string().nullable(),
      attempted: z.boolean().default(false),
      dismissed: z.boolean().default(false),
    })
    .strict(),
]);
export type JobRecord = z.infer<typeof jobRecordSchema>;
export const unmarked = (): TitleMark => ({
  status: "unmarked",
  originalTitle: null,
  decoratedTitle: null,
  error: null,
});

export function createSectionJobStore(db: ReturnType<BbPluginApi["storage"]["database"]>) {
  function get(requestId: string): JobRecord | null {
    const row = db.prepare("SELECT payload FROM workstream_section_jobs WHERE request_id=?").get(requestId) as
      | { payload: string }
      | undefined;
    return row ? jobRecordSchema.parse(JSON.parse(row.payload)) : null;
  }
  return {
    get,
    put(record: JobRecord) {
      const parsed = jobRecordSchema.parse(record);
      db.transaction(() => {
        const current = get(parsed.requestId);
        if (current && (current.kind !== parsed.kind || current.fingerprint !== parsed.fingerprint))
          throw new Error("Request ID conflict: persisted job intent cannot be replaced.");
        db.prepare(
          "INSERT INTO workstream_section_jobs VALUES (?, ?, ?) ON CONFLICT(request_id) DO UPDATE SET payload=excluded.payload",
        ).run(
          parsed.requestId,
          parsed.kind === "connect" ? parsed.input.sectionId : parsed.sectionId,
          JSON.stringify(parsed),
        );
      })();
    },
    latest(sectionId: string): JobRecord | null {
      const row = db
        .prepare(
          "SELECT payload FROM workstream_section_jobs WHERE section_id=? AND json_extract(payload, '$.kind')='connect' ORDER BY rowid DESC LIMIT 1",
        )
        .get(sectionId) as { payload: string } | undefined;
      return row ? jobRecordSchema.parse(JSON.parse(row.payload)) : null;
    },
    pendingCaptures(sectionId: string, limit: number, offset: number) {
      const where =
        "section_id=? AND json_extract(payload, '$.kind')='capture' AND json_extract(payload, '$.status') IN ('pending','failed') AND coalesce(json_extract(payload, '$.dismissed'),0)=0";
      const rows = db
        .prepare(`SELECT payload FROM workstream_section_jobs WHERE ${where} ORDER BY rowid ASC LIMIT ? OFFSET ?`)
        .all(sectionId, limit, offset) as { payload: string }[];
      const total = (
        db.prepare(`SELECT count(*) AS n FROM workstream_section_jobs WHERE ${where}`).get(sectionId) as { n: number }
      ).n;
      return {
        jobs: rows
          .map(row => jobRecordSchema.parse(JSON.parse(row.payload)))
          .filter((r): r is Extract<JobRecord, { kind: "capture" }> => r.kind === "capture"),
        total,
        limit,
        offset,
      };
    },
    marker(sectionId: string): TitleMark {
      const row = db.prepare("SELECT payload FROM workstream_title_marks WHERE section_id=?").get(sectionId) as
        | { payload: string }
        | undefined;
      return row ? titleMarkSchema.parse(JSON.parse(row.payload)) : unmarked();
    },
    setMarker(sectionId: string, marker: TitleMark) {
      const parsed = titleMarkSchema.parse(marker);
      db.prepare(
        "INSERT INTO workstream_title_marks VALUES (?, ?) ON CONFLICT(section_id) DO UPDATE SET payload=excluded.payload",
      ).run(sectionId, JSON.stringify(parsed));
      return parsed;
    },
  };
}
