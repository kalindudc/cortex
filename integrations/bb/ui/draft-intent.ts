import type { ExperimentalServers } from "@get-bb/plugin-sdk/app";
import { z } from "zod";
import { draftExecutionSchema, draftStartInputSchema, type DraftPreview } from "../draft-contract";

const pendingDraftSchema = z.object({
  version: z.literal(1),
  input: draftStartInputSchema,
  workstreamId: z.string().min(1).max(200),
  workstreamRevision: z.number().int().positive(),
  execution: draftExecutionSchema,
}).strict().refine(value => value.input.expectedConfigRevision === value.execution.configRevision);
export type PendingDraft = z.infer<typeof pendingDraftSchema>;
export type DraftRecoveryScope = { key: string | null; error: string | null };

function originOf(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.origin === "null") throw new Error("The server has no usable origin.");
  return url.origin;
}

export function draftRecoveryScope(servers: ExperimentalServers | null, pluginId: string, sectionId: string, browserOrigin: string): DraftRecoveryScope {
  try {
    if (servers?.status === "loading") throw new Error("Wait for the server list to finish loading.");
    const active = servers?.servers.filter(server => server.active);
    if (active && active.length !== 1) throw new Error("The active server cannot be identified safely.");
    const server = active?.[0];
    if (server && !server.id) throw new Error("The active server has no stable identity.");
    const identity = server ? ["server", server.id, originOf(server.origin)] : ["browser", originOf(browserOrigin)];
    return { key: `cortex:pending-draft:${JSON.stringify([...identity, pluginId, sectionId])}`, error: null };
  } catch (cause) {
    return { key: null, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

export function pendingDraft(input: PendingDraft["input"], preview: DraftPreview): PendingDraft {
  return pendingDraftSchema.parse({ version: 1, input, workstreamId: preview.workstreamId, workstreamRevision: preview.workstreamRevision, execution: preview.execution });
}

export function readPendingDraft(key: string, sectionId: string): PendingDraft | null {
  const raw = window.localStorage.getItem(key);
  if (raw === null) return null;
  try {
    const parsed = pendingDraftSchema.parse(JSON.parse(raw));
    if (parsed.input.sectionId !== sectionId) throw new Error("Wrong section.");
    return parsed;
  } catch {
    throw new Error("The saved recovery record is damaged. Do not start another draft until it is recovered or explicitly discarded.");
  }
}

export function savePendingDraft(key: string, value: PendingDraft): void {
  if (readPendingDraft(key, value.input.sectionId) !== null) throw new Error("A drafting request is already awaiting recovery. Reopen the preview to check it before continuing.");
  const raw = JSON.stringify(pendingDraftSchema.parse(value));
  window.localStorage.setItem(key, raw);
  if (window.localStorage.getItem(key) !== raw) throw new Error("The drafting request could not be saved for recovery.");
}

export function discardPendingDraft(key: string): void {
  window.localStorage.removeItem(key);
  if (window.localStorage.getItem(key) !== null) throw new Error("The recovery record could not be removed.");
}
