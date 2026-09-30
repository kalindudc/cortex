/**
 * The native typed client for a daemon endpoint (plan @400 N6/N11).
 *
 * Why: a daemon's event publisher is in-process, so a CLI mutation that
 * wrote SQLite directly would be invisible to its SSE subscribers. While a
 * daemon serves a database, every command therefore sends its requests to
 * that verified instance; daemon.ts `withClient` finds it (published
 * metadata, identity checked over the socket) and hands commands this
 * client, or serves the same handlers in-process when no daemon runs.
 */

import { type ApiOptions, createApi, HttpError, type RequestSender } from "./api.ts";
import type { CortexClient, Endpoint } from "./contracts.ts";

// One error class for every client.
export { HttpError };

/** Default deadline for native requests, so a hung daemon fails instead of hanging the CLI/TUI. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The native typed client for a daemon endpoint: its private Unix socket or
 * an absolute URL (the legacy probe and in-process test listeners), over createApi (typed errors, versioned guarded
 * writes, instance binding). `timeoutMs` defaults to DEFAULT_TIMEOUT_MS.
 */
export function createClient(endpoint: Endpoint, options: ApiOptions = {}): CortexClient {
  return createApi(endpointSender(endpoint), { timeoutMs: DEFAULT_TIMEOUT_MS, ...options });
}

/** The native RequestSender for an endpoint: fetch over its Unix socket, or against its absolute URL. */
export function endpointSender(endpoint: Endpoint): RequestSender {
  return endpoint.kind === "unix"
    ? (path, init) => fetch(`http://localhost${path}`, { ...init, unix: endpoint.socketPath })
    : (path, init) => fetch(`${endpoint.url.replace(/\/+$/, "")}${path}`, init);
}
