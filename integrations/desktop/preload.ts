// Exposes `window.cortex` to the sandboxed renderer. A sandboxed preload can
// require only `electron`, so `desktop:build` bundles this into one file.

import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";
import type { ConnectionState } from "../../src/contracts.ts";
import type { AgentsReply } from "../../src/desktop/agents.ts";
import type { DeepLink } from "../../src/desktop/deepLink.ts";
import {
  type BridgeFrame,
  type BridgeResponse,
  CHANNELS,
  type CortexBridge,
  type GuardRequest,
} from "../../src/desktop/ipc.ts";
import type { ResumeResult } from "../../src/desktop/resume.ts";

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, value: T): void => listener(value);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const bridge: CortexBridge = {
  request: init => ipcRenderer.invoke(CHANNELS.request, init) as Promise<BridgeResponse>,
  attach: () => ipcRenderer.invoke(CHANNELS.attach) as Promise<void>,
  onFrame: listener => subscribe<BridgeFrame>(CHANNELS.frame, listener),
  onState: listener => subscribe<ConnectionState>(CHANNELS.state, listener),
  resume: request => ipcRenderer.invoke(CHANNELS.resume, request) as Promise<ResumeResult>,
  agents: request => ipcRenderer.invoke(CHANNELS.agents, request) as Promise<AgentsReply>,
  onOpen: listener => subscribe<DeepLink>(CHANNELS.open, listener),
  drafts: {
    report: state => ipcRenderer.send(CHANNELS.draftsState, state),
    // A handler that fails sends no answer: main's Save all times out and the window stays open.
    onSaveAll: handler =>
      subscribe<GuardRequest>(CHANNELS.draftsSaveAll, ({ id }) => {
        handler()
          .then(report => ipcRenderer.invoke(CHANNELS.draftsSaved, { id, report }))
          .catch(() => {});
      }),
    onRelease: handler =>
      subscribe<GuardRequest>(CHANNELS.draftsRelease, ({ id }) => {
        handler();
        ipcRenderer.invoke(CHANNELS.draftsReleased, { id }).catch(() => {});
      }),
    export: draft => ipcRenderer.invoke(CHANNELS.draftExport, draft) as Promise<{ saved: boolean }>,
  },
};

contextBridge.exposeInMainWorld("cortex", bridge);
