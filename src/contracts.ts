/**
 * Shared, environment-neutral wire contracts.
 *
 * TYPE-ONLY by design: the daemon, the native client and the environment-
 * neutral src/api.ts all import this module, so it must never pull a runtime
 * dependency (Store / bun:sqlite, node:*) into any of them. Every import is
 * `import type`; test/unit/contracts.test.ts enforces that and pins the shapes.
 */

import type { EventKind } from "./events.ts";
import type {
  Lane,
  MemoryHit,
  MemoryStream,
  MemoryStreamRow,
  Notification,
  RelatedTasks,
  Tag,
  Task,
  TaskStatus,
  Update,
} from "./store.ts";

/**
 * One independently versioned part of a resource. Tasks use `entity` plus the
 * field scopes (`title`, `body`, `priority`, `lane`, `status`); lanes and tags
 * use `entity` and `definition`. `entity` also covers dependent projections
 * and cascades (e.g. a tag rename changes every tagged task's entity, and
 * every update posted to a task, which its delete would cascade, changes that
 * task's entity but never its field tokens).
 */
export type ResourceScope = "entity" | "title" | "body" | "priority" | "lane" | "status" | "definition";

/**
 * Opaque revision tokens keyed by scope. Tokens are compared for equality
 * only, never ordered or parsed; they are not timestamps.
 */
export type Versions = Partial<Record<ResourceScope, string>>;

/**
 * Optional write preconditions. `expected` opts a write into compare-and-set:
 * it must name every scope the write changes, and any mismatch rejects the
 * whole write without mutation. `mutationId` deduplicates retries of the same
 * logical mutation (create/post/status); it is not meant for every autosave.
 */
export interface WriteGuard {
  expected?: Versions;
  mutationId?: string;
}

/** A task, its activity and the versions they were read at, from one read transaction. */
export interface TaskState {
  task: Task;
  updates: Update[];
  versions: Versions;
}

/** Where a daemon listens: its private Unix socket (`kind` keeps the published metadata shape). */
export type Endpoint = { kind: "unix"; socketPath: string };

/**
 * Published daemon metadata (`<db>.daemon.json`) and what a daemon answers
 * in `GET /api/health`; clients attach only when every identity field
 * matches. `databasePath` is canonical; `pid` is informative and never
 * signalled.
 */
export interface DaemonIdentity {
  protocol: 1;
  instanceId: string;
  databaseId: string;
  databasePath: string;
  endpoint: Endpoint;
  pid: number;
  /** Optional protocol-1 features (`control.shutdown`); always present in published metadata. */
  capabilities?: string[];
}

/** `GET /api/health`. A published daemon adds its identity; an in-process app has none. */
export interface HealthResponse {
  ok: boolean;
  version: string;
  identity?: DaemonIdentity;
}

/** One live-stream frame: an existing event kind or the stream's own ready/resync markers. */
export interface LiveEvent {
  kind: EventKind | "ready" | "resync";
  cursor: string;
  payload: unknown;
}

/**
 * One consistent read of the shared workspace plus the stream cursor it is
 * valid at. `identity` is null for an app with no published daemon identity
 * (in-process use and tests) instead of a fabricated endpoint.
 */
export interface WorkspaceSnapshot {
  identity: DaemonIdentity | null;
  cursor: string;
  tasks: Task[];
  lanes: Lane[];
  tags: (Tag & { task_count: number })[];
  notifications: Notification[];
}

// ---------- wire DTOs ----------
//
// Legacy JSON bodies are unchanged. A request opts into the versioned result
// shapes below with `Prefer: cortex-versioned` (the response then carries
// `Preference-Applied: cortex-versioned`), and any write may carry a
// `guard: WriteGuard` member in its JSON body (DELETE included).

/** A tag row with its member count, as GET /api/tags returns it. */
export type TagWithCount = Tag & { task_count: number };

/** A task plus its versions and the stream cursor, as GET /api/tasks/:id/state returns it. */
export interface TaskStateSnapshot extends TaskState {
  cursor: string;
}

/**
 * GET /api/lanes/:name/state: a lane with its member count and catalog
 * versions from one read, plus the stream cursor. The versions guard the
 * lane's edits (`definition`, plus `entity` for a rename) and its delete
 * (`entity`, which moves whenever membership does).
 */
export interface LaneStateSnapshot {
  lane: Lane & { task_count: number };
  versions: Versions;
  cursor: string;
}

/** GET /api/tags/:name/state: a tag definition with its member count (the delete's impact) and versions. */
export interface TagStateSnapshot {
  tag: TagWithCount;
  versions: Versions;
  cursor: string;
}

/** Versioned result of a task write (create, edit, status, lane, tags). */
export interface TaskWriteResult {
  task: Task;
  versions: Versions;
  /** True when a mutationId matched a committed receipt: nothing was written or published again. */
  replayed: boolean;
}

/** Versioned result of POST /api/tasks/:id/updates; `audit` is the `status → x` row when the post set a status. */
export interface PostUpdateResult {
  update: Update;
  audit: Update | null;
  task: Task;
  versions: Versions;
  replayed: boolean;
}

export interface LaneWriteResult {
  lane: Lane;
  versions: Versions;
  replayed: boolean;
}

export interface TagWriteResult {
  tag: Tag;
  versions: Versions;
  replayed: boolean;
}

export interface RemoveResult {
  ok: true;
  replayed: boolean;
}

/**
 * Machine-readable `code` values of API error bodies. The two anchor codes
 * (409) predate this plan; `version_conflict` is a 412, `invalid_guard` a
 * 400, `mutation_reused` a 409 and `instance_mismatch` a 421. The control
 * routes add `instance_required` (400: control must name the instance).
 */
export type ApiErrorCode =
  | "body_search_not_found"
  | "body_search_ambiguous"
  | "version_conflict"
  | "invalid_guard"
  | "mutation_reused"
  | "instance_mismatch"
  | "instance_required";

/** The structured part of a 412 body: nothing was written; `current` holds every scope's token at rejection. */
export interface VersionConflict {
  kind: "task" | "lane" | "tag";
  key: number | string;
  mismatches: { scope: ResourceScope; expected: string; current: string }[];
  current: Versions;
}

// ---------- live-stream payloads ----------
//
// SSE ids (and every `cursor`) are `<epoch>:<seq>`: `epoch` names one
// publisher lifetime (a new one after every daemon start) and `seq` counts
// its events from 1 (0 = nothing published yet). There is no replay: after a
// reconnect, a new epoch, a gap or a `resync`, take a new snapshot.

/** `ready`: the stream is subscribed; snapshot now and apply only events after the snapshot's cursor. */
export interface ReadyPayload {
  cursor: string;
  epoch: string;
  instanceId: string | null;
  databaseId: string;
}

/** `resync`: events were dropped (slow reader, detected gap or changed epoch); take a new snapshot. */
export interface ResyncPayload {
  reason: "overflow" | "gap" | "epoch";
  cursor: string;
}

/** `task.blocked`: an actual transition into blocked (never creation, edits or same-status writes). */
export interface BlockedTransition {
  task: Task;
  previous: TaskStatus;
  author: string;
}

/**
 * `notification.changed`: acknowledgement state changed or rows went away;
 * refetch notifications. `id` names the row for read/unread/dismiss;
 * `task_id` names the deleted task whose notifications cascaded.
 */
export interface NotificationChange {
  action: "read" | "unread" | "read_all" | "dismiss" | "clear" | "task_removed";
  id: number | null;
  task_id: number | null;
}

/** Native subscription health: never live yet, live, or live before and now reconnecting. */
export type ConnectionState = "connecting" | "live" | "stale";

// ---------- request bodies ----------

/**
 * GET /api/tasks filters (all optional, combined with AND): `lane`, `status`,
 * `search` (title+body substring; `@text` titles only, `#text` tag names) and
 * `tags` (the task carries every listed tag). The CLI's `ls` filters, sent
 * as query parameters.
 */
export interface TaskListQuery {
  lane?: string;
  status?: TaskStatus;
  search?: string;
  tags?: string[];
}

/**
 * GET /api/memory/search: `q` is tokenized server-side; every lane is
 * searched unless `lane` filters, `boost` ranks the caller's lane higher, and
 * `exclude` drops task ids the caller already showed.
 */
export interface MemorySearchQuery {
  q: string;
  lane?: string;
  boost?: string;
  limit?: number;
  exclude?: number[];
}

export interface MemorySearchResult {
  terms: string[];
  /** The query asked for the newest (recency words): equally covered hits are newest activity first. */
  recent: boolean;
  hits: MemoryHit[];
}

/** GET /api/memory/streams: bodiless rows, newest activity first. */
export interface MemoryStreamsQuery {
  lane?: string;
  /** Every lane except this one (the primer's "Recently active in other lanes"). */
  excludeLane?: string;
  author?: string;
  active?: boolean;
  /** Also list tasks the user excluded from memory: only the user's own views (bb's thread list) set it. */
  withExcluded?: boolean;
  limit?: number;
}

/** PATCH /api/tasks/:id/memory: keep the task out of what agent memory offers, or let memory offer it again. */
export interface MemoryRequest {
  excluded: boolean;
}

type CreateTaskFields = {
  lane?: string;
  body?: string | null;
  priority?: number | null;
  status?: TaskStatus;
  tags?: string[];
  /** Attribute the task: its first `created` update row, in the create's transaction. */
  author?: string;
};

/** POST /api/tasks. `untitled: true` names the task `untitled-<id>` atomically; explicit titles are never renamed. */
export type CreateTaskRequest =
  | (CreateTaskFields & { title: string; untitled?: false })
  | (CreateTaskFields & { untitled: true; title?: never });

/** PATCH /api/tasks/:id (`bodySearch`+`bodyReplace` is the anchored alternative to `body`). */
export interface EditTaskRequest {
  title?: string;
  body?: string | null;
  bodySearch?: string;
  bodyReplace?: string;
  priority?: number | null;
}

/** PATCH /api/tasks/:id/status. An `author` marks an attributed (agent) change, which notifies. */
export interface StatusRequest {
  status: TaskStatus;
  author?: string;
}

/** PATCH /api/tasks/:id/tags: exactly one of `set` (replace), `add` or `remove` (atomic deltas). */
export type TagChangeRequest = { set: string[] } | { add: string[] } | { remove: string[] };

/** POST /api/tasks/:id/updates. `status` commits with the message; `notify` marks it an attributed agent change. */
export interface PostUpdateRequest {
  author: string;
  summary: string;
  body?: string | null;
  status?: TaskStatus;
  notify?: boolean;
}

export interface CreateLaneRequest {
  name: string;
  color?: string | null;
  sort?: number;
}

export interface EditLaneRequest {
  color?: string | null;
  sort?: number;
  rename?: string;
}

export interface CreateTagRequest {
  name: string;
  color?: string | null;
}

export interface EditTagRequest {
  color?: string | null;
  rename?: string;
}

export interface BackupRequest {
  rotate?: number;
  outPath?: string;
}

export interface BackupResult {
  outPath: string;
  bytes: number;
  stats: {
    lanes: number;
    tags: number;
    tasks: number;
    updates: number;
    task_tags: number;
    notifications: number;
    memory_exclusions: number;
  };
  notification: Notification;
}

// ---------- clients ----------

/**
 * The legacy client surface with its request types corrected to what
 * the server accepts (for example, posts require an author). Legacy
 * requests and response shapes; no guards.
 */
export interface ApiClient {
  tasks(query?: TaskListQuery): Promise<Task[]>;
  lanes(): Promise<Lane[]>;
  updates(id: number): Promise<Update[]>;
  related(id: number): Promise<RelatedTasks>;
  migrations(): Promise<{ pending: string[] }>;
  backup(request?: BackupRequest): Promise<BackupResult>;
  addTask(request: CreateTaskRequest): Promise<Task>;
  editTask(id: number, request: EditTaskRequest): Promise<Task>;
  moveLane(id: number, lane: string): Promise<Task>;
  delTask(id: number): Promise<void>;
  postUpd(id: number, request: PostUpdateRequest): Promise<Update>;
  addLane(request: CreateLaneRequest): Promise<Lane>;
  editLane(name: string, request: EditLaneRequest): Promise<Lane>;
  delLane(name: string): Promise<void>;
  tags(): Promise<TagWithCount[]>;
  setTags(id: number, names: string[]): Promise<Task>;
  addTaskTag(id: number, name: string): Promise<Task>;
  removeTaskTag(id: number, name: string): Promise<Task>;
  addTag(request: CreateTagRequest): Promise<Tag>;
  editTag(name: string, request: EditTagRequest): Promise<Tag>;
  delTag(name: string, force?: boolean): Promise<void>;
  notifications(): Promise<Notification[]>;
  markNotifRead(id: number): Promise<void>;
  markNotifUnread(id: number): Promise<void>;
  markAllNotifRead(): Promise<void>;
  delNotif(id: number): Promise<void>;
  clearNotifs(): Promise<void>;
}

/** Writes that opt into versioned results (`Prefer: cortex-versioned`) and may carry a WriteGuard. */
export interface VersionedWrites {
  addTask(request: CreateTaskRequest, guard?: WriteGuard): Promise<TaskWriteResult>;
  editTask(id: number, request: EditTaskRequest, guard?: WriteGuard): Promise<TaskWriteResult>;
  setStatus(id: number, request: StatusRequest, guard?: WriteGuard): Promise<TaskWriteResult>;
  moveTask(id: number, lane: string, guard?: WriteGuard): Promise<TaskWriteResult>;
  changeTags(id: number, request: TagChangeRequest, guard?: WriteGuard): Promise<TaskWriteResult>;
  setMemory(id: number, request: MemoryRequest, guard?: WriteGuard): Promise<TaskWriteResult>;
  removeTask(id: number, guard?: WriteGuard): Promise<RemoveResult>;
  postUpdate(id: number, request: PostUpdateRequest, guard?: WriteGuard): Promise<PostUpdateResult>;
  addLane(request: CreateLaneRequest, guard?: WriteGuard): Promise<LaneWriteResult>;
  editLane(name: string, request: EditLaneRequest, guard?: WriteGuard): Promise<LaneWriteResult>;
  removeLane(name: string, guard?: WriteGuard): Promise<RemoveResult>;
  addTag(request: CreateTagRequest, guard?: WriteGuard): Promise<TagWriteResult>;
  editTag(name: string, request: EditTagRequest, guard?: WriteGuard): Promise<TagWriteResult>;
  removeTag(name: string, options?: { force?: boolean }, guard?: WriteGuard): Promise<RemoveResult>;
}

/** The full typed client (desktop app and CLI): ApiClient plus snapshots and versioned writes. */
export interface CortexClient extends ApiClient {
  health(): Promise<HealthResponse>;
  me(): Promise<{ author: string }>;
  workspace(): Promise<WorkspaceSnapshot>;
  taskState(id: number): Promise<TaskStateSnapshot>;
  laneState(name: string): Promise<LaneStateSnapshot>;
  tagState(name: string): Promise<TagStateSnapshot>;
  /** Agent memory over the derived FTS5 index and the body-sync record (GET /api/memory/...). */
  memorySearch(query: MemorySearchQuery): Promise<MemorySearchResult>;
  memoryStreams(query?: MemoryStreamsQuery): Promise<MemoryStreamRow[]>;
  memoryStream(id: number): Promise<MemoryStream>;
  readonly versioned: VersionedWrites;
}
