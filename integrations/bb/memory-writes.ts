import { createHash } from "node:crypto";
import { z } from "zod";
import { CortexCliError, type CortexRunner } from "./cli";
import { STATUSES } from "./detail";
import type { MemoryWriteStore } from "./memory-write-store";
import { cliTaskSchema, type CortexState } from "./state";

const HOUR_MS = 3_600_000;
const BODY_LIMIT = 30_000;
const NO_SHELL = "Never fall back to the shell.";
const DAILY = "the daily lane budget is full";
const PAUSED = "agent documents entering memory are paused";
const taskId = z.number().int().positive();
const memory = z.enum(["include", "exclude"]);
const line = (min: number, max: number) =>
  z.string().min(min).max(max).refine(s => !/[\r\n\0]/.test(s) && s.trim().length >= min, "must be one non-blank line").trim();
const editText = z.string().max(BODY_LIMIT).refine(s => !s.includes("\0"), "cannot contain NUL");
const title = line(8, 120).describe("Single-line document title");

const createInput = z.object({
  title,
  body: z.string().min(80).max(BODY_LIMIT).refine(s => s.trim().length >= 80, "provide at least 80 characters of Markdown"),
  kind: z.enum(["note", "plan", "research", "decision"]),
  tags: z.array(z.string().max(32).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)).max(5).optional(),
  memory: memory.optional(),
  status: z.enum(STATUSES).optional(),
}).strict();
const reviseFields = z.object({
  task_id: taskId,
  title: title.optional(),
  search: editText.refine(s => s.length > 0, "search cannot be empty").optional()
    .describe("Exact anchor that occurs once in the current body"),
  replace: editText.optional().describe("Replacement for the exact anchor; empty deletes it"),
  summary: line(1, 4096).describe("One-line update explaining what changed"),
}).strict();
const reviseInput = reviseFields.superRefine(({ title, search, replace }, ctx) => {
  if ((search === undefined) !== (replace === undefined)) {
    ctx.addIssue({ code: "custom", message: "search and replace must be supplied together" });
  } else if (title === undefined && search === undefined) {
    ctx.addIssue({ code: "custom", message: "provide title or search and replace" });
  }
});
export const noteParameters = createInput.partial().extend(reviseFields.partial().shape).strict();
export const curateParameters = z.object({
  task_id: taskId,
  memory,
  reason: line(10, 300).describe("Why this task belongs in memory or should be kept out"),
}).strict();

const savedTask = cliTaskSchema.extend({ memory_excluded: z.boolean() });
const shownTask = z.object({ task: savedTask });
const curatedTask = savedTask.extend({ changed: z.boolean() });
const similarTasks = z.object({
  hits: z.array(z.object({ id: taskId, title: z.string(), lane: z.string() })),
});
const revisedTask = savedTask.extend({ update: z.object({ id: taskId }) });
const TITLE_STOP_WORDS = new Set(
  ("the and for are but not you your our its his her they their this that these those " +
    "with from into onto over under about after before then than there here when where what which who why how " +
    "all any both each few more most other some such only own same very too can could would should will may " +
    "was were been being have has had does did just also now yet still please thanks").split(" "),
);
const titleWords = (title: string): Set<string> =>
  new Set((title.toLowerCase().match(/\p{L}{3,}/gu) ?? []).filter(word => !TITLE_STOP_WORDS.has(word)));

function similarTitle(words: ReadonlySet<string>, title: string): boolean {
  const other = titleWords(title);
  const shared = [...other].filter(word => words.has(word)).length;
  return shared > 0 && (shared * 2 >= words.size || shared === other.size);
}
type SavedTask = z.infer<typeof savedTask>;
type Call = { threadId: string; child: boolean; signal: AbortSignal };
type Action = "create" | "revise" | "curate";

const description = (task: SavedTask): string => `@${task.id} ${task.title} (lane ${task.lane})`;
const describeState = (task: SavedTask, reason: string | null = null): string =>
  `${description(task)}. Memory: ${task.memory_excluded ? `excluded${reason ? ` (${reason})` : ""}` : "included"}.`;
export const withTaskCard = (text: string, id: number): string => `${text}\nWrite on its own line: ::cortex{id="${id}"}`;

const existingState = (task: SavedTask) => withTaskCard(
  `${description(task)} is already ${task.memory_excluded ? "excluded from" : "included in"} memory; no change.`, task.id);

function knowFailed(err: unknown): boolean {
  // A lost response may follow a committed write. Do not reopen a budget slot on uncertainty.
  return !(err instanceof CortexCliError && ["timeout", "json", "shape"].includes(err.code));
}

export function createMemoryWrites(
  store: MemoryWriteStore,
  deps: {
    runner: CortexRunner;
    state: Pick<CortexState, "locate" | "laneFor">;
    paused: () => boolean;
    atomicEdit: boolean;
    changed: (threadId: string, task: SavedTask, focus: boolean) => void;
    clock?: () => number;
  },
) {
  const { runner, state, paused, changed, clock = Date.now } = deps;
  const hourly = new Map<string, { at: number }[]>();
  const locks = new Map<string, Promise<unknown>>();
  let nextSweep = 0;

  function serialized<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = locks.get(key);
    // Both a failed call and a successful one leave the next caller free to retry.
    const pending = previous ? previous.then(run, run) : run();
    locks.set(key, pending);
    return pending.finally(() => {
      if (locks.get(key) === pending) locks.delete(key);
    });
  }

  function reserveHour(call: Call, action: Action): () => void {
    call.signal.throwIfAborted();
    const now = clock();
    const cutoff = now - HOUR_MS;
    if (now >= nextSweep) {
      for (const [key, attempts] of hourly) {
        if (attempts.every(a => a.at <= cutoff)) hourly.delete(key);
      }
      nextSweep = now + HOUR_MS;
    }
    const key = `${call.threadId}:${action}`;
    const attempts = (hourly.get(key) ?? []).filter(a => a.at > cutoff);
    const limit = action === "create" ? (call.child ? 1 : 2) : action === "revise" ? 10 : 5;
    if (attempts.length >= limit) {
      const alternative = action === "create" ? "Revise an existing task"
        : action === "revise" ? "Post a cortex_update" : "Report the need to the lead";
      throw new Error(`This thread has spent its hourly ${action} budget. ${alternative} instead. ${NO_SHELL}`);
    }
    const reservation = { at: now };
    attempts.push(reservation);
    hourly.set(key, attempts);
    return () => {
      const live = hourly.get(key);
      if (!live) return;
      const index = live.indexOf(reservation);
      if (index !== -1) live.splice(index, 1);
      if (live.length === 0) hourly.delete(key);
    };
  }

  async function laneOf(call: Call): Promise<string> {
    const { projectId, cwd } = await state.locate(call.threadId);
    call.signal.throwIfAborted();
    if (cwd !== null) {
      try {
        const lane = (await runner.text(["memory", "lane", "--checkout"], { cwd, signal: call.signal })).trim();
        if (lane && !/[\r\n\0]/.test(lane)) return lane;
      } catch (err) {
        // A removed checkout has no lane of its own; do not use the runner's cwd.
        if (call.signal.aborted || !(err instanceof CortexCliError && err.code === "missing")) throw err;
      }
    }
    const cached = state.laneFor(projectId, true);
    if (cached) return cached;
    throw new Error(`no lane for this thread's project; ask the lead. ${NO_SHELL}`);
  }

  const show = async (id: number, signal: AbortSignal) =>
    (await runner.run(["show", String(id), "--json"], shownTask, { signal })).task;

  async function create(input: z.infer<typeof createInput>, call: Call): Promise<string> {
    const lane = await laneOf(call);
    const author = `bb-${call.threadId}`;
    const digest = createHash("sha256").update(JSON.stringify([author, lane, input.title, input.body])).digest("hex");
    return serialized(digest, async () => {
      call.signal.throwIfAborted();
      const receipt = store.replay(digest, clock());
      if (receipt) {
        try {
          const task = await show(receipt.task_id, call.signal);
          if (task.created === receipt.task_created) {
            return withTaskCard(`Already saved: ${describeState(task, receipt.exclusion_note)}`, task.id);
          }
        } catch (err) {
          if (!(err instanceof CortexCliError && err.code === "exit" && err.message.endsWith(`task ${receipt.task_id} not found`))) throw err;
        }
      }
      const releaseHour = reserveHour(call, "create");
      let releaseLane: (() => void) | null = null;
      let why: string | null = null;
      let task: SavedTask;
      try {
        if (input.memory !== "exclude") {
          if (paused()) why = PAUSED;
          else {
            releaseLane = store.reserve(lane, clock());
            if (releaseLane === null) why = DAILY;
          }
        }
        const excluded = input.memory === "exclude" || why !== null;
        const exclusionReason = why === DAILY ? "Saved excluded: the lane's daily memory budget is used"
          : why === PAUSED ? "Saved excluded: the memory pause is on"
          : input.memory === "exclude" ? "Saved excluded by its author" : null;
        const tags = [...new Set([input.kind, ...(input.tags ?? [])])].join(",");
        // A dispatched write settles even if the requester leaves, so the receipt can be recorded.
        task = await runner.run(
          ["add", `--lane=${lane}`, `--status=${input.status ?? "open"}`, `--tags=${tags}`, `--as=${author}`,
            "--body-file=-", "--json", ...(excluded ? ["--memory-excluded"] : []),
            ...(exclusionReason ? [`--memory-exclusion-reason=${exclusionReason}`] : []), "--", input.title],
          savedTask,
          { input: input.body },
        );
      } catch (err) {
        if (knowFailed(err)) {
          releaseHour();
          releaseLane?.();
        }
        throw err;
      }
      store.record(digest, task.id, task.created, clock(), why);
      changed(call.threadId, task, true);
      const result = `Saved ${describeState(task, why)}`;
      const words = titleWords(input.title);
      if (words.size === 0) return withTaskCard(result, task.id);
      try {
        const { hits } = await runner.run(
          ["memory", "search", `--boost=${lane}`, "--limit=12", "--json", "--", input.title],
          similarTasks,
          { signal: call.signal },
        );
        const others = hits.filter(hit => hit.id !== task.id && similarTitle(words, hit.title))
          .sort((a, b) => Number(b.lane === lane) - Number(a.lane === lane)).slice(0, 3);
        if (others.length === 0) return withTaskCard(result, task.id);
        return withTaskCard([
          result,
          "Similar tasks:",
          ...others.map(hit => `- @${hit.id} ${hit.title} (lane ${hit.lane})`),
          "If one of these covers the same topic, revise it with cortex_note task_id and exclude this one with cortex_curate.",
        ].join("\n"), task.id);
      } catch (err) {
        return withTaskCard(`${result}\nSimilar-task lookup failed: ${err instanceof Error ? err.message : String(err)}.`, task.id);
      }
    });
  }

  async function revise(input: z.infer<typeof reviseInput>, call: Call): Promise<string> {
    if (!deps.atomicEdit) {
      throw new Error(`Update Cortex to revise tasks with an attributed summary. ${NO_SHELL}`);
    }
    const id = input.task_id;
    return serialized(`task:${id}`, async () => {
      const refusal = (status: string) => new Error(`@${id} is ${status}; post a cortex_update instead of revising it. ${NO_SHELL}`);
      if (paused()) {
        const existing = await show(id, call.signal);
        if (existing.status === "review" || existing.status === "done") throw refusal(existing.status);
        if (!existing.memory_excluded) {
          throw new Error(`Cannot revise @${id} while memory is paused; post a cortex_update instead. ${NO_SHELL}`);
        }
      }
      const release = reserveHour(call, "revise");
      const args = ["edit", String(id), "--json", `--message=${input.summary}`, `--as=bb-${call.threadId}`, "--unless-status=review,done"];
      if (input.title !== undefined) args.push(`--title=${input.title}`);
      // citty coerces values on kebab-case spellings that are not its declared string keys.
      if (input.search !== undefined) args.push(`--bodySearch=${input.search}`, `--bodyReplace=${input.replace}`);
      let task: z.infer<typeof revisedTask>;
      try {
        task = await runner.run(args, revisedTask);
      } catch (err) {
        if (knowFailed(err)) release();
        if (err instanceof CortexCliError && err.code === "exit") {
          const status = new RegExp(`task ${id} is (review|done)$`).exec(err.message)?.[1];
          if (status) throw refusal(status);
        }
        throw err;
      }
      try {
        store.recordRevision(task.id, task.created, task.update.id);
      } finally {
        changed(call.threadId, task, true);
      }
      return withTaskCard(`Revised ${describeState(task)}`, task.id);
    });
  }

  async function curate(input: z.infer<typeof curateParameters>, call: Call): Promise<string> {
    return serialized(`task:${input.task_id}`, async () => {
      const include = input.memory === "include";
      const existing = include ? await show(input.task_id, call.signal) : null;
      if (existing && !existing.memory_excluded) return existingState(existing);
      const releaseHour = reserveHour(call, "curate");
      let releaseLane: (() => void) | null = null;
      let task: z.infer<typeof curatedTask>;
      try {
        if (existing) {
          if (paused()) throw new Error(`Cannot include @${input.task_id}: ${PAUSED}. Report the need to the lead. ${NO_SHELL}`);
          releaseLane = store.reserve(existing.lane, clock());
          if (releaseLane === null) {
            throw new Error(`Cannot include @${input.task_id}: ${DAILY}. Report the need to the lead. ${NO_SHELL}`);
          }
        }
        task = await runner.run(
          ["memory", input.memory, String(input.task_id), `--message=${input.reason}`, `--as=bb-${call.threadId}`, "--json"],
          curatedTask,
        );
      } catch (err) {
        if (knowFailed(err)) {
          releaseHour();
          releaseLane?.();
        }
        throw err;
      }
      if (!task.changed) {
        releaseHour();
        releaseLane?.();
        return existingState(task);
      }
      changed(call.threadId, task, false);
      return withTaskCard(`Updated ${describeState(task)} Reason: ${input.reason}${/[.!?]$/.test(input.reason) ? "" : "."}`, task.id);
    });
  }

  return {
    async note(input: z.infer<typeof noteParameters>, call: Call): Promise<string> {
      if (input.task_id === undefined) return create(createInput.parse(input), call);
      return revise(reviseInput.parse(input), call);
    },
    curate,
  };
}
