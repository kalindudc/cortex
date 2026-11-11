export type Actor = { id: string; type: "human" | "agent" | "system" };
export type Dimension = { mode: "value"; value: string } | { mode: "not-applicable" } | { mode: "unknown" };
export type Applicability = { environment: Dimension; host: Dimension };
export type Source = {
  ref: string;
  excerpt?: string;
  authorType: Actor["type"] | "unknown";
  observedAt: string;
  status?: "available" | "archived" | "unreachable";
};
export type Workstream = {
  id: string;
  name: string;
  description: string;
  revision: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  actor: Actor;
};
export type KnowledgeState =
  | "candidate"
  | "approved"
  | "disputed"
  | "superseded"
  | "recheck"
  | "archived"
  | "rejected"
  | "forgotten";
export type Knowledge = {
  id: string;
  workstreamId: string;
  subject: string;
  title: string;
  text: string;
  kind: "directive" | "finding";
  state: KnowledgeState;
  facet: string;
  applicability: Applicability;
  sources: Source[];
  revision: number;
  actor: Actor;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  approval: { actor: Actor; at: string } | null;
  supersedes: string[];
  supersededBy: string | null;
  conflicts: string[];
};
export type WorkstreamRevision = {
  id: string;
  revision: number;
  actor: Actor;
  at: string;
  action: string;
  reason: string;
  snapshot: Workstream | Knowledge;
};
export const REVIEW_HINT_LIMITS = { neighbors: 200, hints: 100 } as const;
export type AdmissionHint = { id: string; reason: "same-subject" | "same-text" | "shared-source" };
export type MutationResult = {
  outcome: "created" | "updated" | "no-save";
  workstream?: Workstream;
  entry?: Knowledge;
  hints?: AdmissionHint[];
  reason?: string;
};
type Guarded = { actor: Actor; id: string; expectedRevision: number; reason: string };
export type WorkstreamMutation =
  | { op: "create"; actor: Actor; name: string; description?: string }
  | (Guarded & { op: "edit-workstream"; name?: string; description?: string; archived?: boolean })
  | {
      op: "propose";
      actor: Actor;
      workstreamId: string;
      subject: string;
      title: string;
      text: string;
      kind: Knowledge["kind"];
      facet: string;
      applicability: Applicability;
      sources: Source[];
      expiresAt?: string | null;
    }
  | (Guarded & {
      op: "edit";
      title?: string;
      text?: string;
      facet?: string;
      sources?: Source[];
      expiresAt?: string | null;
    })
  | (Guarded & { op: "evidence"; sources: Source[] })
  | (Guarded & { op: "transition"; state: "approved" | "recheck" | "archived" | "rejected" | "forgotten" })
  | (Guarded & { op: "conflict" | "supersede"; otherId: string; otherExpectedRevision: number });
export type PageQuery = { limit?: number; offset?: number };
export type WorkstreamListQuery = PageQuery & { archived?: boolean };
export type ContextQuery = { topic?: string; environment?: string; host?: string };
export type WorkstreamList = { workstreams: Workstream[]; total: number; limit: number; offset: number };
export type WorkstreamDetail = {
  workstream: Workstream;
  entries: Knowledge[];
  total: number;
  limit: number;
  offset: number;
};
export type KnowledgeListQuery = PageQuery & {
  query?: string;
  workstream?: string;
  states?: KnowledgeState[];
  reviewOnly?: boolean;
};
export type KnowledgeList = {
  items: { entry: Knowledge; workstream: Workstream; hints: AdmissionHint[] }[];
  total: number;
  limit: number;
  offset: number;
};
export type WorkstreamHistory = { revisions: WorkstreamRevision[]; total: number; limit: number; offset: number };
export type ContextNotice = { id: string; revision: number; reason: string; sources: Source[] };
export type WorkstreamContext = {
  workstream: Workstream;
  entries: Knowledge[];
  notices: ContextNotice[];
  applicability: Applicability;
  topic: string | null;
};
export interface WorkstreamsApi {
  entry(id: string): Promise<Knowledge>;
  knowledge(query?: KnowledgeListQuery): Promise<KnowledgeList>;
  list(query?: WorkstreamListQuery): Promise<WorkstreamList>;
  show(id: string, query?: PageQuery): Promise<WorkstreamDetail>;
  read(id: string, query?: ContextQuery): Promise<WorkstreamContext>;
  history(id: string, query?: PageQuery): Promise<WorkstreamHistory>;
  mutate(input: WorkstreamMutation): Promise<MutationResult>;
}

export class WorkstreamError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "WorkstreamError";
  }
}
function fail(message: string): never {
  throw new WorkstreamError(message);
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`unknown field: ${key}`);
}
function string(value: unknown, label: string, max = 512, empty = false): asserts value is string {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > max || value.includes("\0"))
    fail(`${label} must be ${empty ? "a" : "a nonempty"} string of at most ${max} characters`);
}
function timestamp(value: unknown, label: string): void {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    fail(`${label} must be an ISO UTC timestamp`);
}
function revision(value: unknown): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail("expectedRevision must be a positive integer");
}
function actor(value: unknown): void {
  const a = object(value, "actor");
  keys(a, ["id", "type"]);
  string(a.id, "actor.id", 128);
  if (!["human", "agent", "system"].includes(String(a.type))) fail("invalid actor.type");
}
function dimension(value: unknown): void {
  const d = object(value, "dimension");
  keys(d, d.mode === "value" ? ["mode", "value"] : ["mode"]);
  if (d.mode === "value") string(d.value, "dimension.value", 128);
  else if (d.mode !== "unknown" && d.mode !== "not-applicable") fail("invalid dimension.mode");
}
function applicability(value: unknown): void {
  const a = object(value, "applicability");
  keys(a, ["environment", "host"]);
  dimension(a.environment);
  dimension(a.host);
}
function sources(value: unknown): void {
  if (!Array.isArray(value) || value.length > 100) fail("sources must be an array of at most 100 items");
  for (const raw of value) {
    const s = object(raw, "source");
    keys(s, ["ref", "excerpt", "authorType", "observedAt", "status"]);
    if (s.status !== undefined && !["available", "archived", "unreachable"].includes(String(s.status)))
      fail("invalid source.status");
    string(s.ref, "source.ref", 2048);
    if (s.excerpt !== undefined) string(s.excerpt, "source.excerpt", 8192, true);
    if (!["human", "agent", "system", "unknown"].includes(String(s.authorType))) fail("invalid source.authorType");
    timestamp(s.observedAt, "source.observedAt");
  }
}
export function parseWorkstreamMutation(value: unknown): WorkstreamMutation {
  const m = object(value, "mutation");
  actor(m.actor);
  const base = ["op", "actor"];
  const guarded = [...base, "id", "expectedRevision", "reason"];
  if (m.op === "create") {
    keys(m, [...base, "name", "description"]);
    string(m.name, "name", 200);
    if (m.description !== undefined) string(m.description, "description", 8192, true);
  } else if (m.op === "propose") {
    keys(m, [
      ...base,
      "workstreamId",
      "subject",
      "title",
      "text",
      "kind",
      "facet",
      "applicability",
      "sources",
      "expiresAt",
    ]);
    string(m.workstreamId, "workstreamId", 128);
    string(m.subject, "subject", 256);
    string(m.title, "title", 512);
    string(m.text, "text", 32768);
    string(m.facet, "facet", 128);
    if (m.kind !== "directive" && m.kind !== "finding") fail("kind must be directive or finding");
    applicability(m.applicability);
    sources(m.sources);
  } else {
    string(m.id, "id", 128);
    revision(m.expectedRevision);
    string(m.reason, "reason", 2048);
    if (m.op === "edit-workstream") {
      keys(m, [...guarded, "name", "description", "archived"]);
      if (m.name !== undefined) string(m.name, "name", 200);
      if (m.description !== undefined) string(m.description, "description", 8192, true);
      if (m.archived !== undefined && typeof m.archived !== "boolean") fail("archived must be boolean");
    } else if (m.op === "edit") {
      keys(m, [...guarded, "title", "text", "facet", "sources", "expiresAt"]);
      if (m.title !== undefined) string(m.title, "title", 512);
      if (m.text !== undefined) string(m.text, "text", 32768);
      if (m.facet !== undefined) string(m.facet, "facet", 128);
      if (m.sources !== undefined) sources(m.sources);
    } else if (m.op === "evidence") {
      keys(m, [...guarded, "sources"]);
      sources(m.sources);
    } else if (m.op === "transition") {
      keys(m, [...guarded, "state"]);
      if (!["approved", "recheck", "archived", "rejected", "forgotten"].includes(String(m.state)))
        fail("invalid transition state");
    } else if (m.op === "conflict" || m.op === "supersede") {
      keys(m, [...guarded, "otherId", "otherExpectedRevision"]);
      string(m.otherId, "otherId", 128);
      revision(m.otherExpectedRevision);
    } else fail("unknown mutation op");
  }
  if (m.expiresAt !== undefined && m.expiresAt !== null) timestamp(m.expiresAt, "expiresAt");
  return structuredClone(m) as WorkstreamMutation;
}
export function pageQuery(query: PageQuery = {}): Required<PageQuery> {
  const limit = query.limit ?? 50;
  const offset = query.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0)
    fail("limit must be 1-200 and offset a nonnegative integer");
  return { limit, offset };
}
export function parseContextQuery(query: ContextQuery = {}): ContextQuery {
  for (const [key, value] of Object.entries(query)) {
    if (!["topic", "environment", "host"].includes(key)) fail(`unknown context field: ${key}`);
    if (value !== undefined) string(value, key, 128);
  }
  return query;
}
export function validateKnowledgeQuery(query: KnowledgeListQuery): void {
  pageQuery(query);
  if (query.query !== undefined) string(query.query, "query", 512);
  if (query.workstream !== undefined) string(query.workstream, "workstream", 128);
  if (query.reviewOnly !== undefined && typeof query.reviewOnly !== "boolean") fail("reviewOnly must be boolean");
  if (
    query.states !== undefined &&
    (!Array.isArray(query.states) ||
      !query.states.length ||
      query.states.some(
        s =>
          !["candidate", "approved", "disputed", "superseded", "recheck", "archived", "rejected", "forgotten"].includes(
            s,
          ),
      ))
  )
    fail("states must be a nonempty list of knowledge states");
}
export const normalizeKnowledgeText = (text: string): string =>
  text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
export function sameApplicability(a: Applicability, b: Applicability): boolean {
  return (["environment", "host"] as const).every(
    key =>
      a[key].mode === b[key].mode &&
      (a[key].mode !== "value" || (b[key].mode === "value" && a[key].value === b[key].value)),
  );
}
export function sourceKey(s: Source): string {
  return JSON.stringify([s.ref, s.authorType, s.observedAt, s.excerpt ?? ""]);
}
export function scrubKnowledge(e: Knowledge): Knowledge {
  return { ...e, subject: "", title: "", text: "", sources: [], approval: null };
}
export function selectWorkstreamContext(
  workstream: Workstream,
  knowledge: Knowledge[],
  query: ContextQuery = {},
  now = Date.now(),
): WorkstreamContext {
  parseContextQuery(query);
  const target = (value: string | undefined): Dimension =>
    value === undefined ? { mode: "unknown" } : { mode: "value", value };
  const result: WorkstreamContext = {
    workstream,
    entries: [],
    notices: [],
    applicability: { environment: target(query.environment), host: target(query.host) },
    topic: query.topic ?? null,
  };
  if (workstream.archived) return result;
  for (const e of knowledge) {
    if (e.workstreamId !== workstream.id || (e.facet !== "orientation" && e.facet !== query.topic)) continue;
    if (!["approved", "disputed", "recheck"].includes(e.state)) continue;
    let reason: string | null = null;
    for (const key of ["environment", "host"] as const) {
      const d = e.applicability[key];
      const wanted = result.applicability[key];
      if (d.mode === "unknown") reason = "unknown-applicability";
      else if (d.mode === "value" && (wanted.mode !== "value" || d.value !== wanted.value)) {
        reason = "applicability-mismatch";
        break;
      }
    }
    if (reason === "applicability-mismatch") continue;
    if (!reason && e.expiresAt !== null && Date.parse(e.expiresAt) <= now) reason = "expired";
    if (!reason && e.kind === "finding" && e.expiresAt !== null && e.sources.some(s => s.status === "unreachable"))
      reason = "source-unreachable";
    if (!reason && e.state !== "approved") reason = e.state;
    if (reason)
      result.notices.push({
        id: e.id,
        revision: e.revision,
        reason,
        sources: e.sources.map(({ excerpt: _excerpt, ...source }) => source),
      });
    else result.entries.push(e);
  }
  return result;
}
