import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  type PluginRpcClient,
  type PluginRpcResult,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import type { Binding, ThreadContext } from "./types";

// The one module the workstream UI uses to reach the plugin backend. Reads are
// shared by every slot in this app window (the context row, the card, the
// Memory tab and the Cortex page read one thread's context once), refreshed on
// the backend's `workstreams` signal, a reconnect, and after this window's writes.

type Contract = typeof rpcContract;
type Method = Extract<keyof Contract, string>;
type Client = PluginRpcClient<Contract>;
type InputOf<M extends Method> = NonNullable<Contract[M]["input"]["~standard"]["types"]>["input"];
type OutputOf<M extends Method> = PluginRpcResult<Contract[M]>;
type CallFor<M extends Method> = (method: M, input: InputOf<M>) => Promise<OutputOf<M>>;

/** A refused or failed call in the words the backend chose; `code` drives which state the UI shows. */
export type RpcFailure = { code: string; message: string };

export function failureOf(cause: unknown): RpcFailure {
  if (typeof cause === "object" && cause !== null) {
    const code = Reflect.get(cause, "code");
    const message = Reflect.get(cause, "message");
    return {
      code: typeof code === "string" ? code : "unknown_error",
      message: typeof message === "string" && message !== "" ? message : "Cortex did not answer.",
    };
  }
  return { code: "unknown_error", message: String(cause) };
}

export const isConflict = (failure: RpcFailure | null) => failure?.code === "conflict";

type Entry = { data?: unknown; error: RpcFailure | null; loading: boolean; again: boolean; scope: string | null };
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
    if (entry === undefined || (entry.data === undefined && entry.error === null && !entry.loading)) void this.load(key);
    return () => {
      const current = this.watchers.get(key);
      if (current && --current.count === 0) this.watchers.delete(key);
    };
  }

  async load(key: string): Promise<void> {
    const watcher = this.watchers.get(key);
    if (!watcher) return;
    const entry = this.entries.get(key) ?? { error: null, loading: false, again: false, scope: watcher.scope };
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
    } catch (cause) {
      entry.error = failureOf(cause);
    } finally {
      entry.loading = false;
      this.emit();
    }
    if (entry.again) await this.load(key);
  }

  set(key: string, data: unknown, scope: string | null) {
    const entry = this.entries.get(key) ?? { error: null, loading: false, again: false, scope };
    entry.data = data;
    entry.error = null;
    this.entries.set(key, entry);
    this.emit();
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

const stores = new WeakMap<object, ReadStore>();
function storeFor(rpc: object): ReadStore {
  let store = stores.get(rpc);
  if (!store) {
    store = new ReadStore();
    stores.set(rpc, store);
  }
  return store;
}

const keyOf = (method: string, input: unknown) => `${method}:${JSON.stringify(input ?? null)}`;
const THREAD_SCOPED = new Set<string>(["threadContext", "deliveryReceipts", "threadState", "memory"]);
const scopeOf = (method: string, input: unknown): string | null => {
  if (method === "contextVisibility") return "visibility";
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

function useSignalHandlers(store: ReadStore, lead: (run: (payload: unknown) => void) => (payload: unknown) => void) {
  useRealtime("workstreams", lead(payload => {
    const threadId = typeof payload === "object" && payload !== null ? Reflect.get(payload, "threadId") : undefined;
    if (typeof threadId === "string") {
      store.invalidate((_, scope) => scope === threadId || scope === "visibility");
    } else {
      store.invalidate(() => true);
    }
  }));
  useRealtime("all", lead(() => store.invalidate(() => true)));
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
  const store = storeFor(rpc);
  useSyncExternalStore(store.subscribe, store.getVersion);
  useSignals(store);
  const keys = enabled ? inputs.map(input => keyOf(method, input)) : [];
  const joined = keys.join("\u0000");
  const latest = useRef(inputs);
  latest.current = inputs;
  useEffect(() => {
    if (joined === "") return;
    const stops = latest.current.map(input =>
      store.watch(keyOf(method, input), () => (rpc.call as CallFor<M>)(method, input), scopeOf(method, input)),
    );
    return () => {
      for (const stop of stops) stop();
    };
  }, [joined, method, rpc, store]);
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
  const store = storeFor(rpc);
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
    return {
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

export type Writes = ReturnType<typeof useWorkstreamWrites>;
export type { InputOf, OutputOf };
