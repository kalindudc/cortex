import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import type { CortexRealtimeChannel, CortexTaskDetail, CortexThreadState } from "../state";

const TASK_ID = /^[1-9][0-9]{0,8}$/;

/** A positive task id from an untrusted value, or null. */
export function parseTaskId(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isInteger(raw) && raw > 0 && raw < 1e9 ? raw : null;
  return typeof raw === "string" && TASK_ID.test(raw.trim()) ? Number(raw.trim()) : null;
}

/** The task id a panel tab was opened with (`{ taskId }`), or null; params round-trip through persistence. */
export function panelTaskId(params: unknown): number | null {
  if (typeof params !== "object" || params === null || Array.isArray(params)) return null;
  return parseTaskId((params as Record<string, unknown>).taskId);
}

function signalField(payload: unknown, field: "threadId" | "taskId"): unknown {
  return typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>)[field] : undefined;
}

export const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

export function useCortexRpc() {
  return useRpc<typeof rpcContract>();
}

function useChannel(channel: CortexRealtimeChannel, handler: (payload: unknown) => void): void {
  useRealtime(channel, handler);
}

/** The thread's Cortex view, refetched on its own thread signal, a change to a listed task, and reconnects. */
export function useThreadState(threadId: string) {
  const rpc = useCortexRpc();
  const [state, setState] = useState<CortexThreadState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  const listed = useRef(new Set<number>());
  const accept = useCallback((next: CortexThreadState) => {
    latest.current++;
    listed.current = new Set(next.links.map(link => link.id));
    setState(next);
    setError(null);
  }, []);
  const refetch = useCallback(() => {
    const request = ++latest.current;
    rpc.call("threadState", { threadId }).then(
      next => {
        if (request !== latest.current) return;
        listed.current = new Set(next.links.map(link => link.id));
        setState(next);
        setError(null);
      },
      cause => {
        if (request === latest.current) setError(errorText(cause));
      },
    );
  }, [rpc, threadId]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useChannel("thread", payload => {
    if (signalField(payload, "threadId") === threadId) refetch();
  });
  useChannel("task", payload => {
    const id = parseTaskId(signalField(payload, "taskId"));
    if (id !== null && listed.current.has(id)) refetch();
  });
  useChannel("all", () => refetch());
  return { rpc, state, error, accept, refetch };
}

/**
 * One task's detail for the thread, refetched when that task changes or the
 * stream reconnects. `apply` sets a detail from a write (or an optimistic
 * guess) and drops any read still in flight, so an older answer never wins.
 */
export function useTaskDetail(threadId: string, taskId: number | null) {
  const rpc = useCortexRpc();
  const [detail, setDetail] = useState<CortexTaskDetail | null>(null);
  const [error, setError] = useState<{ taskId: number; message: string } | null>(null);
  const latest = useRef(0);
  const refetch = useCallback(() => {
    const request = ++latest.current;
    if (taskId === null) return;
    rpc.call("task", { threadId, taskId }).then(
      next => {
        if (request !== latest.current) return;
        setDetail(next);
        setError(null);
      },
      cause => {
        if (request !== latest.current) return;
        setError({ taskId, message: errorText(cause) });
      },
    );
  }, [rpc, threadId, taskId]);
  const apply = useCallback((next: CortexTaskDetail) => {
    latest.current++;
    setDetail(next);
    setError(null);
  }, []);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useChannel("task", payload => {
    if (taskId !== null && parseTaskId(signalField(payload, "taskId")) === taskId) refetch();
  });
  useChannel("all", () => refetch());
  // A detail for another task (the selection just changed) is not shown.
  const current = detail !== null && detail.task.id === taskId ? detail : null;
  const failed = error !== null && error.taskId === taskId ? error.message : null;
  return { detail: current, error: current === null ? failed : null, refetch, apply };
}
