// api/client.ts — Typed HTTP client for the cortex dashboard.
//
// One method per server route in src/server.ts. Methods are typed against the
// browser DTOs in ./types.ts. The internal `j()` helper is file-local so
// every method body collapses to a single fetch + JSON parse line.

import type { Task, Lane, Tag, Update } from "./types.ts";

// Server response shape for GET /api/tags — the tag row plus the rollup
// task_count column populated by Store.listTags(). Re-exported via
// state/signals.ts as TagWithCount; mirrored here so the api client's
// return types match the actual server payload (the previous Tag[] return
// type lied about the shape and forced every consumer to cast).
export type TagWithCount = Tag & { task_count: number };

// Inputs accepted by POST /api/tasks. Server requires lane + title; the rest
// have server-side defaults (status: open, priority: lane default, body: "").
export type AddTaskBody = Pick<Task, "lane" | "title"> & Partial<Omit<Task, "id" | "created" | "updated">>;
// Inputs accepted by PATCH /api/tasks/:id. Every field is optional —
// callers send only the keys they want to change.
export type EditTaskBody = Partial<Pick<Task, "lane" | "title" | "body" | "status" | "priority" | "tags">>;
export type AddLaneBody = Pick<Lane, "name"> & Partial<Pick<Lane, "color" | "sort">>;
export type EditLaneBody = Partial<Pick<Lane, "color" | "sort">> & { rename?: string };
export type AddTagBody = Pick<Tag, "name"> & Partial<Pick<Tag, "color">>;
export type EditTagBody = Partial<Pick<Tag, "color">> & { rename?: string };
// POST /api/tasks/:id/updates body. Server fills `created` + resolves author
// if omitted.
export type PostUpdateBody = Pick<Update, "summary"> & Partial<Pick<Update, "author" | "severity" | "body">>;

export interface ApiClient {
  tasks(): Promise<Task[]>;
  lanes(): Promise<Lane[]>;
  updates(id: number): Promise<Update[]>;
  migrations(): Promise<{ pending: string[] }>;
  addTask(b: AddTaskBody): Promise<Task>;
  editTask(id: number, b: EditTaskBody): Promise<Task>;
  setStat(id: number, status: Task["status"]): Promise<Task>;
  moveLane(id: number, lane: string): Promise<Task>;
  delTask(id: number): Promise<void>;
  postUpd(id: number, b: PostUpdateBody): Promise<Update>;
  addLane(b: AddLaneBody): Promise<Lane>;
  editLane(n: string, b: EditLaneBody): Promise<Lane>;
  delLane(n: string): Promise<void>;
  // ---- tags ----
  tags(): Promise<TagWithCount[]>;
  setTags(id: number, ns: string[]): Promise<Task>;
  addTag(b: AddTagBody): Promise<Tag>;
  editTag(n: string, b: EditTagBody): Promise<Tag>;
  delTag(n: string, force?: boolean): Promise<void>;
}

const j = async <T>(p: string, init?: RequestInit): Promise<T> => {
  const r = await fetch(p, init);
  const txt = await r.text();
  const body = txt ? JSON.parse(txt) : null;
  if (!r.ok) throw new Error(body?.error ?? r.statusText);
  return body as T;
};

const JSON_HEAD = { "content-type": "application/json" } as const;

export const api: ApiClient = {
  tasks: () => j<Task[]>("/api/tasks"),
  lanes: () => j<Lane[]>("/api/lanes"),
  updates: id => j<Update[]>(`/api/tasks/${id}/updates`),
  addTask: b => j<Task>("/api/tasks", { method: "POST", headers: JSON_HEAD, body: JSON.stringify(b) }),
  editTask: (id, b) => j<Task>(`/api/tasks/${id}`, { method: "PATCH", headers: JSON_HEAD, body: JSON.stringify(b) }),
  setStat: (id, status) =>
    j<Task>(`/api/tasks/${id}/status`, { method: "PATCH", headers: JSON_HEAD, body: JSON.stringify({ status }) }),
  moveLane: (id, lane) =>
    j<Task>(`/api/tasks/${id}/lane`, { method: "PATCH", headers: JSON_HEAD, body: JSON.stringify({ lane }) }),
  delTask: id => j<void>(`/api/tasks/${id}`, { method: "DELETE" }),
  postUpd: (id, b) =>
    j<Update>(`/api/tasks/${id}/updates`, { method: "POST", headers: JSON_HEAD, body: JSON.stringify(b) }),
  addLane: b => j<Lane>("/api/lanes", { method: "POST", headers: JSON_HEAD, body: JSON.stringify(b) }),
  editLane: (n, b) =>
    j<Lane>(`/api/lanes/${encodeURIComponent(n)}`, { method: "PATCH", headers: JSON_HEAD, body: JSON.stringify(b) }),
  delLane: n => j<void>(`/api/lanes/${encodeURIComponent(n)}`, { method: "DELETE" }),
  // ---- tags ----
  migrations: () => j<{ pending: string[] }>("/api/migrations"),
  tags: () => j<TagWithCount[]>("/api/tags"),
  setTags: (id, ns) =>
    j<Task>(`/api/tasks/${id}/tags`, { method: "PATCH", headers: JSON_HEAD, body: JSON.stringify({ set: ns }) }),
  addTag: b => j<Tag>("/api/tags", { method: "POST", headers: JSON_HEAD, body: JSON.stringify(b) }),
  editTag: (n, b) =>
    j<Tag>(`/api/tags/${encodeURIComponent(n)}`, { method: "PATCH", headers: JSON_HEAD, body: JSON.stringify(b) }),
  // `force` cascades the join rows. Mirrors the CLI's `cortex tag rm -f`.
  delTag: (n, force) => j<void>(`/api/tags/${encodeURIComponent(n)}${force ? "?force=1" : ""}`, { method: "DELETE" }),
};
