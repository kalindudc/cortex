/**
 * The renderer's daemon client. The page never reaches the daemon itself:
 * every request and every live event goes through `window.cortex`, the bridge
 * the preload exposes, and main validates each call.
 */

import { createApi, type RequestSender } from "../../api.ts";
import type {
  CortexClient,
  CreateLaneRequest,
  CreateTagRequest,
  EditLaneRequest,
  EditTagRequest,
  TagWithCount,
} from "../../contracts.ts";
import type { CortexBridge } from "../../desktop/ipc.ts";

export type AddLaneBody = CreateLaneRequest;
export type EditLaneBody = EditLaneRequest;
export type AddTagBody = CreateTagRequest;
export type EditTagBody = EditTagRequest;
export type { TagWithCount };

/** Read at call time: the preload defines it before any page script runs. */
const bridge = (): CortexBridge => window.cortex;

/** `new Response(body, { status: 204 })` throws, so these statuses get a null body. */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 204, 205, 304]);

function headerRecord(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(headers).forEach((value, name) => {
    out[name] = value;
  });
  return out;
}

const send: RequestSender = async (path, init = {}) => {
  if (init.body !== undefined && init.body !== null && typeof init.body !== "string") {
    throw new TypeError("the desktop bridge sends only string bodies");
  }
  const reply = await bridge().request({
    method: init.method ?? "GET",
    path,
    headers: headerRecord(init.headers),
    ...(typeof init.body === "string" ? { body: init.body } : {}),
  });
  const body = NULL_BODY_STATUSES.has(reply.status) ? null : reply.body;
  return new Response(body, { status: reply.status, statusText: reply.statusText, headers: reply.headers });
};

export const api: CortexClient = createApi(send);

/**
 * The live stream as an EventTarget: each bridge frame is dispatched as a
 * MessageEvent named after its kind (`ready`, `resync`, `task.added`, ...)
 * with `lastEventId` set to its cursor, and any state other than live
 * dispatches `error`. It does not attach: the caller wires its listeners to
 * the returned target, then calls `window.cortex.attach()` once, so the first
 * `ready` cannot be missed.
 */
export function connectLiveSource(): EventTarget {
  const source = new EventTarget();
  const cortex = bridge();
  cortex.onFrame(frame => {
    source.dispatchEvent(new MessageEvent(frame.event, { data: frame.data, lastEventId: frame.id }));
  });
  cortex.onState(state => {
    if (state !== "live") source.dispatchEvent(new Event("error"));
  });
  return source;
}
