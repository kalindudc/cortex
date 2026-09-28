// api/client.ts — Typed HTTP client for the cortex dashboard (plan @400 N11).
//
// A thin browser adapter: the environment-neutral createApi (src/api.ts)
// owns every route, DTO, error and the versioned/guarded write surface; this
// file only supplies relative same-origin fetch, because the dashboard is
// served by the daemon it talks to. Errors are typed: an HTTP error status
// rejects with an HttpError whose `message` is the server's error text (what
// showError() toasts), and a request with an unknown outcome rejects with a
// TransportError.
//
// BROWSER BOUNDARY: never import src/client.ts (the native socket client),
// src/store.ts, node:* or Bun at runtime from the dashboard.
// test/unit/api/client.test.ts bundles src/ui/index.tsx for the browser and
// fails if any of them enters the graph.
//
// The names below are the ones UI callers already import; they now alias the
// corrected wire contracts in src/contracts.ts (for example, posts require an
// author and PATCH /api/tasks/:id accepts only title/body/priority fields).

import { createApi, type RequestSender } from "../../api.ts";
import type {
  ApiClient,
  BackupResult,
  CortexClient,
  CreateLaneRequest,
  CreateTagRequest,
  CreateTaskRequest,
  EditLaneRequest,
  EditTagRequest,
  EditTaskRequest,
  PostUpdateRequest,
  TagWithCount,
} from "../../contracts.ts";

export type { ApiClient, TagWithCount };
export type BackupResponse = BackupResult;
// Request bodies, by their historical dashboard names.
export type AddTaskBody = CreateTaskRequest;
export type EditTaskBody = EditTaskRequest;
export type AddLaneBody = CreateLaneRequest;
export type EditLaneBody = EditLaneRequest;
export type AddTagBody = CreateTagRequest;
export type EditTagBody = EditTagRequest;
export type PostUpdateBody = PostUpdateRequest;

// Resolved at call time (not captured at load) so tests can stub fetch.
const send: RequestSender = (path, init) => fetch(path, init);

// No instance binding (the browser is an unbound same-origin client) and no
// client-side deadline, matching the dashboard's previous plain fetch.
export const api: CortexClient = createApi(send);
