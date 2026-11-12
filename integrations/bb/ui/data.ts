import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  type PluginRpcClient,
  type PluginRpcResult,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useSdk,
  experimental_usePluginId,
  experimental_useSidebarThreads,
  experimental_useServers,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import type { sectionRpcContract } from "../section-contract";
import type { draftRpcContract, DraftJob } from "../draft-contract";
import type { Binding, ThreadContext } from "./types";
import { draftRecoveryScope, readPendingDraft, type DraftRecoveryScope, type PendingDraft } from "./draft-intent";

// The one module the workstream UI uses to reach the plugin backend. Reads are
// shared by every slot in this app window (the context row, the card, the
// Memory tab and the Cortex page read one thread's context once), refreshed on
// the backend's `workstreams` signal, a reconnect, and after this window's writes.

type Contract = typeof rpcContract & typeof sectionRpcContract & typeof draftRpcContract;
type Method = Extract<keyof Contract, string>;
type Client = PluginRpcClient<Contract>;
type InputOf<M extends Method> = NonNullable<Contract[M]["input"]["~standard"]["types"]>["input"];
type OutputOf<M extends Method> = PluginRpcResult<Contract[M]>;
type CallFor<M extends Method> = (method: M, input: InputOf<M>) => Promise<OutputOf<M>>;

/** A refused or failed call in the words the backend chose; `code` drives which state the UI shows. */
export type RpcIssue = { path: Array<string | number>; message: string };
export type RpcFailure = { code: string; message: string; issues?: RpcIssue[]; issuesComplete?: boolean };

export function failureOf(cause: unknown): RpcFailure {
  if (typeof cause === "object" && cause !== null) {
    const code = Reflect.get(cause, "code");
    const message = Reflect.get(cause, "message");
    const rawIssues = Reflect.get(cause, "issues");
    const issues = Array.isArray(rawIssues) ? rawIssues.slice(0, 8).filter((issue): issue is RpcIssue => {
      if (typeof issue !== "object" || issue === null || Array.isArray(issue)) return false;
      const path = Reflect.get(issue, "path");
      const text = Reflect.get(issue, "message");
      return typeof text === "string" && text.length > 0 && text.length <= 4096 && Array.isArray(path) && path.length <= 16 && path.every(part => typeof part === "string" ? part.length <= 256 : typeof part === "number" && Number.isSafeInteger(part) && part >= 0);
    }).map(issue => ({ path: [...issue.path], message: issue.message })) : [];
    return {
      code: typeof code === "string" ? code : "unknown_error",
      message: code === "invalid_input" && issues.length > 0 ? issues[0]!.message : typeof message === "string" && message !== "" ? message : "Cortex did not answer.",
      ...(rawIssues !== undefined || Reflect.get(cause, "issuesComplete") === false ? { issues, issuesComplete: Reflect.get(cause, "issuesComplete") !== false && Array.isArray(rawIssues) && rawIssues.length === issues.length } : {}),
    };
  }
  return { code: "unknown_error", message: String(cause) };
}

export const isConflict = (failure: RpcFailure | null) => failure?.code === "conflict";

type Entry = { stale: boolean; data?: unknown; error: RpcFailure | null; loading: boolean; again: boolean; scope: string | null };
type Watcher = { run: () => Promise<unknown>; count: number; scope: string | null };

class ReadStore {
  private version = 0;
  private readonly listeners = new Set<() => void>();
  readonly entries = new Map<string, Entry>();
  private readonly watchers = new Map<string, Watcher>();
  /** Every mounted read subscribes to the signals; only the oldest one acts, so one event reloads each read once. */
  private readonly listenersOfSignals: symbol[] = [];

  joinSignals(id: symbol): () => void {
    this.listenersOfSignals.push(id);
    return () => {
      const index = this.listenersOfSignals.indexOf(id);
      if (index >= 0) this.listenersOfSignals.splice(index, 1);
    };
  }
  leads = (id: symbol) => this.listenersOfSignals[0] === id;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getVersion = () => this.version;
  private emit() {
    this.version++;
    for (const listener of this.listeners) listener();
  }

  watch(key: string, run: () => Promise<unknown>, scope: string | null): () => void {
    const watcher = this.watchers.get(key);
    if (watcher) watcher.count++;
    else this.watchers.set(key, { run, count: 1, scope });
    const entry = this.entries.get(key);
    if (entry) entry.scope = scope;
    if (entry === undefined || entry.stale || (entry.data === undefined && entry.error === null && !entry.loading)) void this.load(key);
    return () => {
      const current = this.watchers.get(key);
      if (current && --current.count === 0) {
        this.watchers.delete(key);
        queueMicrotask(() => {
          const cached = this.entries.get(key);
          if (cached && !this.watchers.has(key)) cached.stale = true;
        });
      }
    };
  }

  async load(key: string): Promise<void> {
    const watcher = this.watchers.get(key);
    if (!watcher) return;
    const entry = this.entries.get(key) ?? { stale: true, error: null, loading: false, again: false, scope: watcher.scope };
    if (entry.loading) {
      entry.again = true;
      return;
    }
    entry.loading = true;
    entry.again = false;
    this.entries.set(key, entry);
    this.emit();
    try {
      entry.data = await watcher.run();
      entry.error = null;
      entry.stale = !this.watchers.has(key);
    } catch (cause) {
      entry.error = failureOf(cause);
    } finally {
      entry.loading = false;
      this.emit();
    }
    if (entry.again) await this.load(key);
  }

  set(key: string, data: unknown, scope: string | null) {
    const entry = this.entries.get(key) ?? { stale: false, error: null, loading: false, again: false, scope };
    entry.data = data;
    entry.error = null;
    this.entries.set(key, entry);
    this.emit();
  }

  quarantine(affects: (key: string, data: unknown) => boolean, error: RpcFailure) {
    let changed = false;
    for (const [key, entry] of this.entries) {
      if (!affects(key, entry.data)) continue;
      entry.data = undefined; entry.error = error; changed = true;
    }
    if (changed) this.emit();
  }

  /** Refetch watched reads the change can affect; unwatched ones are dropped so the next view reloads them. */
  invalidate(affects: (key: string, scope: string | null) => boolean) {
    for (const key of [...this.entries.keys()]) {
      if (!affects(key, this.entries.get(key)?.scope ?? null)) continue;
      if (this.watchers.has(key)) void this.load(key);
      else this.entries.delete(key);
    }
  }
}

// useRpc clients belong to individual hooks. The public bound SDK belongs to
// one host QueryClient and plugin, so slots share reads without crossing hosts.
const stores = new WeakMap<object, Map<string, ReadStore>>();
function useReadStore(): ReadStore {
  const host = useSdk();
  const pluginId = experimental_usePluginId();
  let plugins = stores.get(host);
  if (!plugins) {
    plugins = new Map();
    stores.set(host, plugins);
  }
  let store = plugins.get(pluginId);
  if (!store) {
    store = new ReadStore();
    plugins.set(pluginId, store);
  }
  return store;
}

const keyOf = (method: string, input: unknown) => `${method}:${JSON.stringify(input ?? null)}`;
const THREAD_SCOPED = new Set<string>(["threadContext", "deliveryReceipts", "threadState", "memory"]);
const scopeOf = (method: string, input: unknown): string | null => {
  if (method === "contextVisibility") return "visibility";
  if (typeof input === "object" && input !== null) {
    const sectionId = Reflect.get(input, "sectionId");
    if (typeof sectionId === "string") return `section:${sectionId}`;
    const workstreamId = Reflect.get(input, method === "workstreamShow" ? "id" : "workstreamId");
    if (typeof workstreamId === "string") return `workstream:${workstreamId}`;
  }
  if (method === "memory") return `memory:${String(Reflect.get(input as object, "threadId"))}`;
  if (!THREAD_SCOPED.has(method)) return null;
  const threadId = typeof input === "object" && input !== null ? Reflect.get(input, "threadId") : null;
  return typeof threadId === "string" ? threadId : null;
};

export function useCortexRpc(): Client {
  return useRpc<Contract>();
}

/** Refreshes this window's reads on the backend's signals and when the realtime connection comes back. */
function useSignals(store: ReadStore) {
  const [id] = useState(() => Symbol("signals"));
  useEffect(() => store.joinSignals(id), [store, id]);
  const lead = (run: (payload: unknown) => void) => (payload: unknown) => {
    if (store.leads(id)) run(payload);
  };
  useSignalHandlers(store, lead);
  const connection = useRealtimeConnectionState();
  const previous = useRef(connection);
  useEffect(() => {
    if (previous.current !== "connected" && connection === "connected" && store.leads(id)) store.invalidate(() => true);
    previous.current = connection;
  }, [connection, store, id]);
}

function invalidateShared(store: ReadStore, payload: unknown) {
  if (typeof payload !== "object" || payload === null) {
    store.invalidate(() => true);
    return;
  }
  const threadId = Reflect.get(payload, "threadId");
  const sectionId = Reflect.get(payload, "sectionId");
  const workstreamId = Reflect.get(payload, "workstreamId");
  store.invalidate((key, scope) => {
    if (typeof threadId === "string" && (scope === threadId || scope === "visibility")) return true;
    if (typeof sectionId === "string" && (scope === `section:${sectionId}` || key.startsWith("sectionList:") || key.startsWith("sectionBindings:"))) return true;
    if (typeof workstreamId !== "string") return false;
    if (scope === `workstream:${workstreamId}` || key.startsWith("workstreamList:") || key.startsWith("reviewQueue:") || key.startsWith("knowledgeSearch:")) return true;
    const data = store.entries.get(key)?.data as { entry?: { workstreamId: string }; binding?: Binding; section?: { binding: { binding: Binding | null } } } | undefined;
    return data?.entry?.workstreamId === workstreamId || data?.binding?.workstreamId === workstreamId || data?.section?.binding.binding?.workstreamId === workstreamId;
  });
}

function useSignalHandlers(store: ReadStore, lead: (run: (payload: unknown) => void) => (payload: unknown) => void) {
  useRealtime("workstreams", lead(payload => invalidateShared(store, payload)));
  const { threads } = experimental_useSidebarThreads();
  useRealtime("sections", lead(payload => {
    invalidateShared(store, payload);
    const sectionId = typeof payload === "object" && payload !== null ? Reflect.get(payload, "sectionId") : null;
    const affected = new Set(threads.filter(thread => thread.sectionId === sectionId).map(thread => thread.id));
    store.invalidate((key, scope) => affected.has(scope ?? "") && key.startsWith("threadContext:"));
  }));
  useRealtime("all", lead(() => store.invalidate(key => key.startsWith("threadState:") || key.startsWith("memory:"))));
  useRealtime("memory", lead(payload => {
    const threadId = typeof payload === "object" && payload !== null ? Reflect.get(payload, "threadId") : null;
    store.invalidate((_, scope) => (typeof threadId === "string" ? scope === `memory:${threadId}` : scope?.startsWith("memory:") === true));
  }));
  useRealtime("thread", lead(payload => {
    const threadId = typeof payload === "object" && payload !== null ? Reflect.get(payload, "threadId") : null;
    if (typeof threadId === "string") store.invalidate((key, scope) => scope === threadId && key.startsWith("threadState:"));
  }));
  useRealtime("task", lead(payload => {
    const taskId = typeof payload === "object" && payload !== null ? Number(Reflect.get(payload, "taskId")) : Number.NaN;
    store.invalidate(key => {
      if (!key.startsWith("threadState:")) return false;
      const links = (store.entries.get(key)?.data as { links?: Array<{ id: number }> } | undefined)?.links ?? [];
      return links.some(link => link.id === taskId);
    });
  }));
}

export type Read<T> = { data: T | undefined; error: RpcFailure | null; isLoading: boolean; refetch: () => void };

function useReadMany<M extends Method>(method: M, inputs: readonly InputOf<M>[], enabled = true): Array<Read<OutputOf<M>>> {
  const rpc = useCortexRpc();
  const store = useReadStore();
  useSyncExternalStore(store.subscribe, store.getVersion);
  useSignals(store);
  const keys = enabled ? inputs.map(input => keyOf(method, input)) : [];
  const joined = keys.join("\u0000");
  const latest = useRef(inputs);
  latest.current = inputs;
  const watched = useRef(new Map<string, () => void>());
  useEffect(() => {
    const desired = new Set(enabled ? latest.current.map(input => keyOf(method, input)) : []);
    for (const [key, stop] of watched.current) {
      if (!desired.has(key)) { stop(); watched.current.delete(key); }
    }
    for (const input of enabled ? latest.current : []) {
      const key = keyOf(method, input);
      if (!watched.current.has(key)) watched.current.set(key, store.watch(key, () => (rpc.call as CallFor<M>)(method, input), scopeOf(method, input)));
    }
  }, [joined, enabled, method, rpc, store]);
  useEffect(() => () => {
    for (const stop of watched.current.values()) stop();
    watched.current.clear();
  }, [method, rpc, store]);
  return keys.map(key => {
    const entry = store.entries.get(key);
    return {
      data: entry?.data as OutputOf<M> | undefined,
      error: entry?.error ?? null,
      isLoading: entry === undefined || (entry.data === undefined && entry.error === null),
      refetch: () => void store.load(key),
    };
  });
}

const DISABLED: Read<never> = { data: undefined, error: null, isLoading: false, refetch: () => {} };

function useRead<M extends Method>(method: M, input: InputOf<M> | null): Read<OutputOf<M>> {
  const inputs = useMemo(() => (input === null ? [] : [input]), [input === null ? null : keyOf(method, input)]);
  return useReadMany(method, inputs, input !== null)[0] ?? DISABLED;
}

export const useSections = () => useReadMany("sectionList", [null])[0]!;
export const useSectionCaptureJobs = (sectionId: string, offset = 0) => useRead("sectionCaptureJobs", { sectionId, limit: 20, offset });
export const useSectionDetail = (sectionId: string | null) => useRead("sectionDetail", sectionId === null ? null : { sectionId, limit: 50, offset: 0 });
export const useNewThreadContext = (input: InputOf<"newThreadContext"> | null) => useRead("newThreadContext", input);

export const useThreadContext = (threadId: string | null) =>
  useRead("threadContext", threadId === null ? null : { threadId });
const RECEIPT_PAGE = 20;
type Receipt = OutputOf<"deliveryReceipts">["receipts"][number];

/** The newest `pages` pages of a thread's context history; the store returns newest first. */
export function useDeliveryReceipts(threadId: string, pages = 1): Read<{ receipts: Receipt[]; total: number; changedWhileReading: boolean }> {
  const inputs = useMemo(
    () => Array.from({ length: Math.max(1, pages) }, (_, page) => ({ threadId, limit: RECEIPT_PAGE, offset: page * RECEIPT_PAGE })),
    [threadId, pages],
  );
  const reads = useReadMany("deliveryReceipts", inputs);
  const error = reads.find(read => read.error !== null)?.error ?? null;
  const ready = reads.every(read => read.data !== undefined);
  const data = useMemo(() => {
    if (!ready) return undefined;
    const seen = new Set<string>();
    const receipts = reads
      .flatMap(read => read.data?.receipts ?? [])
      .filter(receipt => {
        if (seen.has(receipt.id)) return false;
        seen.add(receipt.id);
        return true;
      });
    const total = reads[0]?.data?.total ?? 0;
    return { receipts, total, changedWhileReading: reads.some(read => read.data !== undefined && read.data.total !== total) };
  }, [ready, ...reads.map(read => read.data)]);
  return {
    data,
    error,
    isLoading: !ready && error === null,
    refetch: () => {
      for (const read of reads) read.refetch();
    },
  };
}
export const useReviewQueue = (limit = 100) => useRead("reviewQueue", { limit, offset: 0 });
export const useWorkstreams = (archived = false) => useRead("workstreamList", { limit: 100, offset: 0, archived });
export const useWorkstream = (id: string | null, limit = 100) =>
  useRead("workstreamShow", id === null ? null : { id, limit, offset: 0 });
const HISTORY_PAGE = 50;
type Revision = OutputOf<"workstreamHistory">["revisions"][number];

/**
 * The newest `pages` pages of an id's history, newest first. Cortex stores
 * history oldest first, so past one page this reads pages from the end.
 */
export type HistoryPages = { revisions: Revision[]; total: number; changedWhileReading: boolean };

export function useHistory(id: string | null, pages = 1): Read<HistoryPages> {
  const first = useRead("workstreamHistory", id === null ? null : { id, limit: HISTORY_PAGE, offset: 0 });
  const total = first.data?.total ?? 0;
  const tailInputs = useMemo(() => {
    const inputs: Array<{ id: string; limit: number; offset: number }> = [];
    if (id === null || total <= HISTORY_PAGE) return inputs;
    for (let page = 0; page < pages; page++) {
      const end = total - page * HISTORY_PAGE;
      if (end <= 0) break;
      const offset = Math.max(0, end - HISTORY_PAGE);
      inputs.push({ id, limit: end - offset, offset });
    }
    return inputs;
  }, [id, total, pages]);
  const tail = useReadMany("workstreamHistory", tailInputs);
  const parts = total <= HISTORY_PAGE ? [first] : tail;
  const error = first.error ?? tail.find(read => read.error !== null)?.error ?? null;
  const ready = first.data !== undefined && parts.every(read => read.data !== undefined);
  const data = useMemo(() => {
    if (!ready) return undefined;
    const seen = new Set<string>();
    const revisions = parts
      .flatMap(read => read.data?.revisions ?? [])
      .filter(row => {
        const key = `${row.id}:${row.revision}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => b.at.localeCompare(a.at) || b.revision - a.revision);
    // Pages are separate reads; a revision saved between them shifts the offsets.
    const changedWhileReading = parts.some(read => read.data !== undefined && read.data.total !== total);
    return { revisions, total, changedWhileReading };
  }, [ready, total, ...parts.map(read => read.data)]);
  return {
    data,
    error,
    isLoading: !ready && error === null,
    refetch: () => {
      first.refetch();
      for (const read of tail) read.refetch();
    },
  };
}
export const useKnowledgeSearch = (query: string, workstreamId?: string) =>
  useRead(
    "knowledgeSearch",
    query.trim() === "" ? null : { query: query.trim(), limit: 50, offset: 0, ...(workstreamId ? { workstreamId } : {}) },
  );
/** Current entries by id, one read each; callers keep the list short and load more on request. */
export const useKnowledgeEntries = (ids: readonly string[]) =>
  useReadMany(
    "knowledgeShow",
    useMemo(() => ids.map(id => ({ id })), [ids.join(",")]),
  );
export const useThreadStates = (threadIds: readonly string[]) =>
  useReadMany(
    "threadState",
    useMemo(() => threadIds.map(threadId => ({ threadId })), [threadIds.join(",")]),
  );

/** Section bindings take a null input, which `useRead` uses to mean "disabled"; read them directly. */
export function useBindings(): Read<OutputOf<"sectionBindings">> {
  const inputs = useMemo(() => [null as unknown as InputOf<"sectionBindings">], []);
  return useReadMany("sectionBindings", inputs)[0]!;
}

export const useTaskState = (threadId: string | null) => useRead("threadState", threadId === null ? null : { threadId });
export const useMemoryState = (threadId: string | null) => useRead("memory", threadId === null ? null : { threadId });

export function useVisibility(threadIds: readonly string[]) {
  const ids = useMemo(() => [...new Set(threadIds)].sort().slice(0, 200), [threadIds.join(",")]);
  const read = useRead("contextVisibility", ids.length === 0 ? null : { threadIds: ids });
  return useMemo(() => {
    const map = new Map<string, { dismissed: boolean; dismissedPreference: boolean | null }>();
    for (const row of read.data?.threads ?? []) map.set(row.threadId, row);
    return map;
  }, [read.data]);
}

/** Every write the workstream UI makes. Each resolves with the backend's answer or throws an RpcFailure. */
export function useWorkstreamWrites() {
  const rpc = useCortexRpc();
  const store = useReadStore();
  return useMemo(() => {
    const call = async <M extends Method>(method: M, input: InputOf<M>): Promise<OutputOf<M>> => {
      try {
        return await (rpc.call as CallFor<M>)(method, input);
      } catch (cause) {
        throw failureOf(cause);
      }
    };
    const thread = async <M extends Method>(method: M, input: InputOf<M> & { threadId: string }) => {
      const next = (await call(method, input)) as ThreadContext;
      store.set(keyOf("threadContext", { threadId: input.threadId }), next, input.threadId);
      store.invalidate((_, scope) => scope === "visibility");
      return next;
    };
    const everywhere = async <M extends Method>(method: M, input: InputOf<M>) => {
      const out = await call(method, input);
      store.invalidate(() => true);
      return out;
    };
    const section = async <M extends Method>(method: M, input: InputOf<M>) => {
      const out = await call(method, input);
      const result = out as { sectionId?: string; workstreamId?: string; entry?: { workstreamId: string } | null };
      invalidateShared(store, { ...input as object, sectionId: result.sectionId ?? Reflect.get(input as object, "sectionId"), workstreamId: result.workstreamId ?? result.entry?.workstreamId });
      return out;
    };
    return {
      refreshKnowledge: () => store.invalidate(() => true),
      connectSection: (input: InputOf<"sectionConnect">) => section("sectionConnect", input),
      retrySection: (requestId: string) => section("sectionConnectRetry", { requestId }),
      markSection: (input: InputOf<"sectionTitleMark">) => section("sectionTitleMark", input),
      capture: (input: InputOf<"sectionCapture">) => section("sectionCapture", input),
      retryCapture: (requestId: string) => section("sectionCaptureRetry", { requestId }),
      dismissCapture: (sectionId: string, requestId: string) => section("sectionCaptureDismiss", { sectionId, requestId }),
      editCandidate: (input: InputOf<"sectionCandidateEdit">) => section("sectionCandidateEdit", input),
      acceptCandidate: (input: InputOf<"sectionCandidateAccept">) => section("sectionCandidateAccept", input),
      setDismissed: (threadId: string, dismissed: boolean | null) => thread("setContextDismissed", { threadId, dismissed }),
      setOverride: (input: {
        threadId: string;
        expectedRevision: number;
        knowledgeId: string;
        canonicalRevision: number;
        excluded: boolean;
        text: string | null;
      }) => thread("setThreadOverride", input),
      setGrant: (input: {
        threadId: string;
        expectedRevision: number;
        kind: "knowledge" | "legacy-task";
        id: string;
        granted: boolean;
      }) => thread("setThreadGrant", input),
      setThreadBinding: (input: { threadId: string; expectedRevision: number; binding: Binding | null }) =>
        thread("setThreadBinding", input),
      prepare: (threadId: string) => call("prepareThreadContext", { threadId }),
      setSectionBinding: (input: { sectionId: string; expectedRevision: number; binding: Binding | null }) =>
        everywhere("setSectionBinding", input),
      createWorkstream: (input: { name: string; description?: string }) => everywhere("workstreamCreate", input),
      editWorkstream: (input: InputOf<"workstreamEdit">) => everywhere("workstreamEdit", input),
      propose: (input: InputOf<"knowledgePropose">) => everywhere("knowledgePropose", input),
      edit: (input: InputOf<"knowledgeEdit">) => everywhere("knowledgeEdit", input),
      evidence: (input: InputOf<"knowledgeEvidence">) => everywhere("knowledgeEvidence", input),
      transition: (input: InputOf<"knowledgeTransition">) => everywhere("knowledgeTransition", input),
      conflict: (input: InputOf<"knowledgeConflict">) => everywhere("knowledgeConflict", input),
      supersede: (input: InputOf<"knowledgeSupersede">) => everywhere("knowledgeSupersede", input),
    };
  }, [rpc, store]);
}

const draftStores = new WeakMap<object, Map<string, ReadStore>>();
function useDraftStore(): ReadStore {
  const host = useSdk();
  const pluginId = experimental_usePluginId();
  let plugins = draftStores.get(host);
  if (!plugins) { plugins = new Map(); draftStores.set(host, plugins); }
  let store = plugins.get(pluginId);
  if (!store) { store = new ReadStore(); plugins.set(pluginId, store); }
  return store;
}

function useDraftSignals(store: ReadStore) {
  const [id] = useState(() => Symbol("draft-signals"));
  useEffect(() => store.joinSignals(id), [store, id]);
  useRealtime("drafts", payload => {
    if (!store.leads(id) || typeof payload !== "object" || payload === null) return;
    const configRevision = Reflect.get(payload, "configRevision");
    const sectionId = Reflect.get(payload, "sectionId");
    const requestId = Reflect.get(payload, "requestId");
    store.invalidate((key, scope) =>
      typeof configRevision === "number" && key.startsWith("draftConfigGet:") ||
      typeof sectionId === "string" && scope === `section:${sectionId}` &&
      (key.startsWith("draftJobs:") || key.startsWith("draftJob:") && typeof requestId === "string" && key.includes(JSON.stringify(requestId))),
    );
  });
  const connection = useRealtimeConnectionState();
  const previous = useRef(connection);
  useEffect(() => {
    if (previous.current !== "connected" && connection === "connected" && store.leads(id)) store.invalidate(() => true);
    previous.current = connection;
  }, [connection, store, id]);
}

type DraftMethod = Extract<keyof typeof draftRpcContract, Method>;
type DraftIdentity = { job?: DraftJob; expected?: PendingDraft };
const draftIdentities = new WeakMap<ReadStore, Map<string, DraftIdentity>>();
const draftKeyOf = (method: string, input: unknown, recoveryKey: string | null) => `${keyOf(method, input)}${recoveryKey === null ? "" : `:${JSON.stringify(recoveryKey)}`}`;
function draftIdentity(store: ReadStore, target: InputOf<"draftJob">, recoveryKey: string): DraftIdentity {
  let identities = draftIdentities.get(store);
  if (!identities) { identities = new Map(); draftIdentities.set(store, identities); }
  const key = draftKeyOf("draftJob", target, recoveryKey);
  let identity = identities.get(key);
  if (!identity) { identity = {}; identities.set(key, identity); }
  return identity;
}
const executionMatches = (a: DraftJob["execution"], b: DraftJob["execution"]) =>
  a.providerId === b.providerId && a.model === b.model && a.reasoningLevel === b.reasoningLevel && a.serviceTier === b.serviceTier && a.hostId === b.hostId && a.configRevision === b.configRevision && a.origin === b.origin && a.permissionMode === b.permissionMode;

const expectedDraftMatches = (job: DraftJob, expected: PendingDraft) =>
  job.sectionId === expected.input.sectionId && job.requestId === expected.input.requestId && job.sourceThreadId === expected.input.sourceThreadId && job.sourceSnapshotId === expected.input.sourceSnapshotId && job.bindingRevision === expected.input.expectedBindingRevision && job.workstreamId === expected.workstreamId && job.workstreamRevision === expected.workstreamRevision && executionMatches(job.execution, expected.execution);
const draftMismatch = (): RpcFailure => ({ code: "invalid_output", message: "The drafting response changed the pinned source or settings. Check the original request before continuing." });

function installDraftExpectation(store: ReadStore, expected: PendingDraft, recoveryKey: string) {
  const target = { sectionId: expected.input.sectionId, requestId: expected.input.requestId };
  const identity = draftIdentity(store, target, recoveryKey);
  if (identity.expected && JSON.stringify(identity.expected) !== JSON.stringify(expected)) throw draftMismatch();
  identity.expected = expected;
  if (identity.job && !expectedDraftMatches(identity.job, expected)) {
    identity.job = undefined;
    store.quarantine((key, data) => key === draftKeyOf("draftJob", target, recoveryKey) ||
      key.startsWith("draftJobs:") && key.endsWith(`:${JSON.stringify(recoveryKey)}`) &&
      (data as OutputOf<"draftJobs"> | undefined)?.jobs.some(job => job.requestId === target.requestId && !expectedDraftMatches(job, expected)) === true, draftMismatch());
  }
}
function hydrateDraftExpectation(store: ReadStore, sectionId: string, scope: DraftRecoveryScope): string {
  let restored: PendingDraft | null;
  try {
    if (!scope.key) throw new Error(scope.error ?? "The active server cannot be identified safely.");
    restored = readPendingDraft(scope.key, sectionId);
  } catch (cause) {
    throw { code: "recovery_blocked", message: `Drafting recovery is blocked. ${failureOf(cause).message} Check recovery storage before continuing.` } satisfies RpcFailure;
  }
  if (restored) installDraftExpectation(store, restored, scope.key!);
  return scope.key!;
}

function checkedDraftJob(store: ReadStore, out: DraftJob, target: InputOf<"draftJob">, recoveryKey: string, start?: InputOf<"draftStart">): DraftJob {
  if (out.sectionId !== target.sectionId || out.requestId !== target.requestId) throw { code: "invalid_output", message: "The drafting response does not match this request. Check the original request before continuing." } satisfies RpcFailure;
  const { job: known, expected } = draftIdentity(store, target, recoveryKey);
  const input = expected?.input ?? start;
  if (input && (out.sourceThreadId !== input.sourceThreadId || out.sourceSnapshotId !== input.sourceSnapshotId || out.bindingRevision !== input.expectedBindingRevision || out.execution.configRevision !== input.expectedConfigRevision) ||
    expected && !expectedDraftMatches(out, expected) ||
    known && (out.sourceThreadId !== known.sourceThreadId || out.sourceSnapshotId !== known.sourceSnapshotId || out.bindingRevision !== known.bindingRevision || out.workstreamId !== known.workstreamId || out.workstreamRevision !== known.workstreamRevision || out.requestedAt !== known.requestedAt || out.deadlineAt !== known.deadlineAt || !executionMatches(out.execution, known.execution) || known.worker.threadId !== null && out.worker.threadId !== known.worker.threadId)) {
    throw draftMismatch();
  }
  return known && known.revision > out.revision ? known : out;
}
function retainDraftJob(store: ReadStore, job: DraftJob, recoveryKey: string): DraftJob {
  draftIdentity(store, { sectionId: job.sectionId, requestId: job.requestId }, recoveryKey).job = job;
  return job;
}
// Cancelling verified work must not depend on storage used to recover a new request.
function knownDraftCancelKey(store: ReadStore, input: InputOf<"draftCancel">, scope: DraftRecoveryScope): string {
  if (!scope.key) throw { code: "recovery_blocked", message: `Drafting recovery is blocked. ${scope.error} Check the original request before continuing.` } satisfies RpcFailure;
  const target = { sectionId: input.sectionId, requestId: input.requestId };
  const known = draftIdentities.get(store)?.get(draftKeyOf("draftJob", target, scope.key))?.job;
  if (!known) throw { code: "recovery_blocked", message: "The drafting job has not been verified in this scope. Check the original request before stopping it." } satisfies RpcFailure;
  checkedDraftJob(store, known, target, scope.key);
  if (input.expectedRevision !== known.revision) throw { code: "conflict", message: "The drafting job changed. Check its current status before stopping it." } satisfies RpcFailure;
  return scope.key;
}
function useDraftRead<M extends DraftMethod>(method: M, input: InputOf<M> | null, enabled = true): Read<OutputOf<M>> {
  const rpc = useCortexRpc();
  const store = useDraftStore();
  useSyncExternalStore(store.subscribe, store.getVersion);
  useDraftSignals(store);
  const servers = experimental_useServers();
  const pluginId = experimental_usePluginId();
  const sectionId = (method === "draftJobs" || method === "draftJob") && input ? (input as InputOf<"draftJob">).sectionId : null;
  const recovery = sectionId === null ? null : draftRecoveryScope(servers, pluginId, sectionId, window.location.origin);
  const key = draftKeyOf(method, input, recovery === null ? null : recovery.key ?? "blocked");
  const [access, setAccess] = useState<{ key: string; valid: boolean } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    if (recovery && sectionId) {
      let valid = true;
      try { hydrateDraftExpectation(store, sectionId, recovery); }
      // The shared loader publishes the failure; cached rows stay hidden meanwhile.
      catch { valid = false; }
      setAccess({ key, valid });
    }
    const cached = recovery !== null && store.entries.has(key);
    const stop = store.watch(key, async () => {
      const recoveryKey = recovery && sectionId ? hydrateDraftExpectation(store, sectionId, recovery) : null;
      const out = await (rpc.call as CallFor<M>)(method, input as InputOf<M>);
      if (recovery && sectionId) hydrateDraftExpectation(store, sectionId, recovery);
      if (method === "draftJob") return retainDraftJob(store, checkedDraftJob(store, out as DraftJob, input as InputOf<"draftJob">, recoveryKey!), recoveryKey!);
      if (method === "draftJobs") {
        const page = out as OutputOf<"draftJobs">;
        const jobs = page.jobs.map(job => checkedDraftJob(store, job, { sectionId: sectionId!, requestId: job.requestId }, recoveryKey!));
        for (const job of jobs) retainDraftJob(store, job, recoveryKey!);
        return { ...page, jobs };
      }
      return out;
    }, scopeOf(method, input));
    if (cached && !store.entries.get(key)?.loading) void store.load(key);
    return stop;
  }, [enabled, key, method, rpc, store, recovery?.error]);
  const entry = store.entries.get(key);
  const ready = recovery === null || access?.key === key && (access.valid || entry?.error === null && !entry.loading);
  return {
    data: ready && entry?.error?.code !== "recovery_blocked" ? entry?.data as OutputOf<M> | undefined : undefined,
    error: entry?.error ?? null,
    isLoading: enabled && (entry === undefined || entry.data === undefined && entry.error === null),
    refetch: () => { if (enabled) void store.load(key); },
  };
}
export const useDraftConfig = (enabled = true) => useDraftRead("draftConfigGet", null, enabled);
export const useDraftCapabilities = (enabled = true) => useDraftRead("draftCapabilities", null, enabled);
export const useDraftJobs = (sectionId: string, offset = 0, enabled = true) => useDraftRead("draftJobs", { sectionId, limit: 20, offset }, enabled);
export const useDraftJob = (target: InputOf<"draftJob"> | null) => useDraftRead("draftJob", target, target !== null);

export function useDraftWrites() {
  const rpc = useCortexRpc();
  const store = useDraftStore();
  const shared = useReadStore();
  const servers = experimental_useServers();
  const pluginId = experimental_usePluginId();
  const currentScope = useRef({ servers, pluginId });
  currentScope.current = { servers, pluginId };
  return useMemo(() => {
    const call = async <M extends DraftMethod>(method: M, input: InputOf<M>): Promise<OutputOf<M>> => {
      try { return await (rpc.call as CallFor<M>)(method, input); }
      catch (cause) { throw failureOf(cause); }
    };
    const remember = (job: DraftJob, recoveryKey: string) => {
      retainDraftJob(store, job, recoveryKey);
      store.set(draftKeyOf("draftJob", { sectionId: job.sectionId, requestId: job.requestId }, recoveryKey), job, `section:${job.sectionId}`);
      if (job.candidateResults.some(result => result.status === "saved")) invalidateShared(shared, { sectionId: job.sectionId, workstreamId: job.workstreamId });
      return job;
    };
    const jobCall = async <M extends "draftStart" | "draftCancel" | "draftResumeSave" | "draftJob">(method: M, input: InputOf<M>, expected?: PendingDraft) => {
      const target = { sectionId: input.sectionId, requestId: input.requestId };
      const cancel = method === "draftCancel" ? input as InputOf<"draftCancel"> : null;
      const context = cancel ? currentScope.current : { servers, pluginId };
      const recovery = draftRecoveryScope(context.servers, context.pluginId, input.sectionId, window.location.origin);
      const recoveryKey = cancel ? knownDraftCancelKey(store, cancel, recovery) : hydrateDraftExpectation(store, input.sectionId, recovery);
      if (expected) installDraftExpectation(store, expected, recoveryKey);
      try {
        const out = await call(method, input);
        if (cancel) {
          const current = draftRecoveryScope(currentScope.current.servers, currentScope.current.pluginId, input.sectionId, window.location.origin);
          if (current.key !== recoveryKey) throw { code: "recovery_blocked", message: "The active drafting scope changed. Check the original request before continuing." } satisfies RpcFailure;
          if (out.revision < cancel.expectedRevision) throw { code: "invalid_output", message: "The drafting response is older than the cancellation request. Check the original request before continuing." } satisfies RpcFailure;
        } else hydrateDraftExpectation(store, input.sectionId, recovery);
        return remember(checkedDraftJob(store, out, target, recoveryKey, method === "draftStart" ? input as InputOf<"draftStart"> : undefined), recoveryKey);
      }
      finally { store.invalidate((key, scope) => scope === `section:${input.sectionId}` && key.startsWith("draftJobs:")); }
    };
    return {
      config: async (input: InputOf<"draftConfigSet">) => {
        const out = await call("draftConfigSet", input);
        store.set(keyOf("draftConfigGet", null), out, null);
        return out;
      },
      preview: async (input: InputOf<"draftSourcePreview">) => {
        const out = await call("draftSourcePreview", input);
        if (out.sectionId !== input.sectionId || out.sourceThreadId !== input.sourceThreadId || out.bindingRevision !== input.expectedBindingRevision) throw { code: "invalid_output", message: "The preview does not match the chosen section and source. No draft was started." } satisfies RpcFailure;
        return out;
      },
      start: (input: InputOf<"draftStart">, expected: PendingDraft) => jobCall("draftStart", input, expected),
      lookup: (sectionId: string, requestId: string, expected?: PendingDraft) => jobCall("draftJob", { sectionId, requestId }, expected),
      cancel: (input: InputOf<"draftCancel">) => jobCall("draftCancel", input),
      resume: (input: InputOf<"draftResumeSave">) => jobCall("draftResumeSave", input),
    };
  }, [rpc, store, shared, servers, pluginId]);
}

export type Writes = ReturnType<typeof useWorkstreamWrites>;
export type { InputOf, OutputOf };
