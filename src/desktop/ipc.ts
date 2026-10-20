/**
 * The desktop app's IPC contract: the `window.cortex` bridge the preload
 * exposes and the channels main answers. The renderer and the preload both
 * import this file, so it holds only constants and types.
 */

import type { ConnectionState } from "../contracts.ts";
import type { AgentsReply, AgentsRequest } from "./agents.ts";
import type { DeepLink } from "./deepLink.ts";
import type { ResumeRequest, ResumeResult } from "./resume.ts";

export const APP_SCHEME = "cortex";
export const APP_HOST = "app";
export const APP_ORIGIN = "cortex://app";

export const CHANNELS = {
  request: "cortex:request",
  attach: "cortex:attach",
  frame: "cortex:frame",
  state: "cortex:state",
  draftsState: "cortex:drafts-state",
  draftsSaveAll: "cortex:drafts-save-all",
  draftsSaved: "cortex:drafts-saved",
  draftExport: "cortex:draft-export",
  draftsRelease: "cortex:drafts-release",
  draftsReleased: "cortex:drafts-released",
  resume: "cortex:resume",
  agents: "cortex:agents",
  open: "cortex:open",
} as const;

export interface BridgeRequest {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface BridgeResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

/** One live-stream event as the renderer sees it: `event` is the LiveEvent kind, `id` its cursor. */
export interface BridgeFrame {
  event: string;
  data: string;
  id: string;
}

/** The renderer's unsaved drafts: live tasks with unsaved work, and kept text of deleted tasks. */
export interface DraftReport {
  dirty: number;
  orphaned: number;
}

/** Unsaved text the user exports to a file; main builds the file name and the dialog picks the path. */
export interface DraftExport {
  taskId: number;
  field: "title" | "body";
  text: string;
}

/** A request main sends to the renderer; `id` pairs it with the renderer's answer. */
export interface GuardRequest {
  id: number;
}
/** The renderer's answer to Save all. */
export interface SaveAllAnswer {
  id: number;
  report: DraftReport;
}

export interface CortexBridge {
  request(init: BridgeRequest): Promise<BridgeResponse>;
  /** (Re)start this window's live subscription; every call yields a fresh `ready` frame. */
  attach(): Promise<void>;
  onFrame(listener: (frame: BridgeFrame) => void): () => void;
  onState(listener: (state: ConnectionState) => void): () => void;
  /** Open the bb thread, or copy the pi command, of an author main finds resumable on the task. */
  resume(request: ResumeRequest): Promise<ResumeResult>;
  /** Check, install or reset the agent tools: main runs `cortex agents <action> --json` and returns its result. */
  agents(request: AgentsRequest): Promise<AgentsReply>;
  /** A launch link from a second launch of the app: show that task, at that heading. */
  onOpen(listener: (link: DeepLink) => void): () => void;
  drafts: {
    /** Tell main how many drafts are unsaved; it guards close, reload and quit while any are. */
    report(state: DraftReport): void;
    /** Answer main's Save all with the counts left once the saves settled. */
    onSaveAll(handler: () => Promise<DraftReport>): () => void;
    /**
     * Stop warning before unload: the user chose to leave. Main waits for this
     * before it reloads, closes or quits, because Chromium drops a navigation
     * that a still-armed beforeunload cancels without asking.
     */
    onRelease(handler: () => void): () => void;
    /** Ask where to write `text` with a native save dialog. */
    export(draft: DraftExport): Promise<{ saved: boolean }>;
  };
}

declare global {
  interface Window {
    cortex: CortexBridge;
  }
}
