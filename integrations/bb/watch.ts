import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { CortexRunner } from "./cli";
import type { CortexRealtimeChannel, CortexState } from "./state";

const BB_AUTHOR = /^bb-(thr_[0-9a-z]{6,40})$/;
const STDERR_CHARS = 4_000;
// A single event line is a task with its body: far below this unless the stream is corrupt.
const MAX_LINE_CHARS = 8 * 1024 * 1024;
const KILL_GRACE_MS = 2_000;

type Publish = (channel: CortexRealtimeChannel, payload: unknown) => void;
type ScheduleRefresh = (taskId: number | null, lane?: string) => void;

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const positiveId = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
const laneOf = (task: Record<string, unknown> | null): string | undefined =>
  typeof task?.lane === "string" ? task.lane : undefined;

/**
 * One parsed `cortex watch --json` line to realtime signals and cache
 * refreshes. Refreshes run first so a client refetching on the signal never
 * reads a cached copy. Unknown or malformed frames are ignored; duplicates
 * only cause a refetch.
 */
export function routeCortexEvent(line: unknown, publish: Publish, scheduleRefresh: ScheduleRefresh): void {
  const event = record(line);
  if (event === null || typeof event.kind !== "string") return;
  const payload = record(event.payload);
  switch (event.kind) {
    case "ready":
    case "resync":
      scheduleRefresh(null);
      publish("all", null);
      return;
    case "update.posted": {
      const id = positiveId(payload?.task_id);
      if (id === null) return;
      scheduleRefresh(id);
      publish("task", { taskId: id });
      const author = typeof payload?.author === "string" ? BB_AUTHOR.exec(payload.author) : null;
      if (author) publish("thread", { threadId: author[1] });
      return;
    }
    case "task.added":
    case "task.updated":
    case "task.removed": {
      const id = positiveId(payload?.id);
      if (id === null) return;
      scheduleRefresh(id, laneOf(payload));
      publish("task", { taskId: id });
      return;
    }
    case "task.blocked": {
      const task = record(payload?.task);
      const id = positiveId(task?.id);
      if (id === null) return;
      scheduleRefresh(id, laneOf(task));
      publish("task", { taskId: id });
      return;
    }
  }
}

/** Follows `cortex watch --json` for the plugin's lifetime; the host restarts it with backoff when it exits. */
export function registerCortexWatch(bb: BbPluginApi, runner: CortexRunner, state: CortexState): void {
  const publish: Publish = (channel, payload) => bb.realtime.publish(channel, payload);
  const scheduleRefresh: ScheduleRefresh = (taskId, lane) => {
    const work = taskId === null ? state.refreshAll() : state.refreshTask(taskId, lane);
    work.catch(err => bb.log.warn(`cortex refresh failed: ${String(err)}`));
  };

  bb.background.service("watch", {
    start(signal) {
      return new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        const child = spawn(runner.binary, ["watch", "--json"], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
        const decoder = new StringDecoder("utf8");
        let buffer = "";
        let stderr = "";
        let killTimer: ReturnType<typeof setTimeout> | null = null;

        const handle = (text: string): void => {
          const line = text.trim();
          if (!line) return;
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            bb.log.warn(`ignored a malformed cortex watch line: ${line.slice(0, 200)}`);
            return;
          }
          routeCortexEvent(parsed, publish, scheduleRefresh);
        };
        const onAbort = (): void => {
          child.kill("SIGTERM");
          killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
          killTimer.unref?.();
        };
        const settle = (error: Error | null): void => {
          signal.removeEventListener("abort", onAbort);
          if (killTimer !== null) clearTimeout(killTimer);
          if (signal.aborted || error === null) resolve();
          else reject(error);
        };

        child.stdout.on("data", (chunk: Buffer) => {
          buffer += decoder.write(chunk);
          let newline = buffer.indexOf("\n");
          while (newline !== -1) {
            handle(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf("\n");
          }
          if (buffer.length > MAX_LINE_CHARS) {
            bb.log.warn("dropped an oversized cortex watch line");
            buffer = "";
          }
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_CHARS);
        });
        signal.addEventListener("abort", onAbort, { once: true });
        child.once("error", err => settle(err));
        child.once("close", (code, killedBy) => {
          handle(buffer + decoder.end());
          const detail = stderr.trim() || `exit ${code ?? killedBy}`;
          settle(new Error(`cortex watch stopped: ${detail}`));
        });
      });
    },
  });
}
