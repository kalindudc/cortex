import { defineCommand } from "citty";
import type { LiveEvent } from "../contracts.ts";
import { ensureDaemon } from "../daemon.ts";
import { emitError } from "../output.ts";
import { dbPath } from "../paths.ts";
import { subscribeChanges } from "../subscription.ts";

/**
 * `cortex watch`: follow this database's change stream, one stdout line per
 * event, until SIGINT, SIGTERM or a closed stdout. There is no replay, so
 * ready (each connection) and resync (missed events) tell the consumer to
 * refetch state.
 */

const isEpipe = (err: unknown): boolean => (err as { code?: unknown } | null)?.code === "EPIPE";

function humanLine(event: LiveEvent): string {
  if (event.kind === "ready" || event.kind === "resync") return `${event.kind} (refetch state)`;
  const p = (typeof event.payload === "object" && event.payload !== null ? event.payload : {}) as Record<
    string,
    unknown
  >;
  const task = (typeof p.task === "object" && p.task !== null ? p.task : p) as Record<string, unknown>;
  const id = p.task_id ?? task.id;
  const text = p.summary ?? p.message ?? task.title ?? p.name ?? p.removed;
  return [event.kind, id === undefined ? "" : `@${id}`, p.author ? `[${p.author}]` : "", text ?? ""]
    .filter(Boolean)
    .join(" ");
}

export function watchLine(event: LiveEvent, json: boolean): string {
  if (!json) return humanLine(event);
  if (event.kind === "ready" || event.kind === "resync") return JSON.stringify({ kind: event.kind });
  return JSON.stringify({ kind: event.kind, cursor: event.cursor, payload: event.payload });
}

export default defineCommand({
  meta: { name: "watch", description: "follow changes, one line per event; refetch state after each ready or resync" },
  args: {
    json: {
      type: "boolean",
      default: false,
      description: "one JSON object per line: { kind, cursor, payload }, or { kind } for ready and resync",
    },
  },
  async run({ args }) {
    const json = args.json;
    const abort = new AbortController();
    let failure: unknown = null;
    const stop = (): void => abort.abort();
    // A closed stdout is the consumer leaving; any other write error is a failure.
    const onStdoutError = (err: unknown): void => {
      if (!isEpipe(err)) failure = err;
      stop();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    process.stdout.on("error", onStdoutError);
    try {
      const identity = await ensureDaemon({ databasePath: dbPath() });
      await subscribeChanges(
        identity.endpoint,
        event => console.log(watchLine(event, json)),
        () => {},
        abort.signal,
      );
    } catch (err) {
      if (!isEpipe(err)) failure = err;
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      process.stdout.off("error", onStdoutError);
    }
    if (failure !== null) emitError(json, failure);
  },
});
