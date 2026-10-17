import { type BbPluginApi, defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { type CortexRunner, createCortexRunner, verifyCortexFeatures } from "./cli";
import { STATUSES, splitNote } from "./detail";
import {
  type CortexRealtimeChannel,
  type CortexState,
  cliUpdateSchema,
  createCortexState,
  NEUTRAL_CWD,
  REMOTE_REASON,
  taskDetailSchema,
  taskRowSchema,
  threadStateSchema,
} from "./state";
import { registerCortexWatch } from "./watch";

const THREAD_ID = /^thr_[0-9a-z]{6,40}$/;
const threadIdInputSchema = z.object({ threadId: z.string().regex(THREAD_ID) });
const threadTaskInputSchema = threadIdInputSchema.extend({ taskId: z.number().int().positive() });
const pinInputSchema = threadIdInputSchema.extend({ taskId: z.number().int().positive().nullable() });
const setStatusInputSchema = threadTaskInputSchema.extend({ status: z.enum(STATUSES) });
// The text is split once here, so a bad note is an input error before any CLI call.
const postNoteInputSchema = threadTaskInputSchema
  .extend({ text: z.string().max(100_000), status: z.enum(STATUSES).optional() })
  .superRefine((input, ctx) => {
    const note = splitNote(input.text);
    if ("error" in note) ctx.addIssue({ code: "custom", path: ["text"], message: note.error });
  });
const searchInputSchema = z.object({ query: z.string().trim().min(1).max(200) });
const taskRowsSchema = z.object({ tasks: z.array(taskRowSchema) });

export const rpcContract = defineRpcContract({
  threadState: { input: threadIdInputSchema, output: threadStateSchema },
  task: { input: threadTaskInputSchema, output: taskDetailSchema },
  pin: { input: pinInputSchema, output: threadStateSchema },
  link: { input: threadTaskInputSchema, output: threadStateSchema },
  unlink: { input: threadTaskInputSchema, output: threadStateSchema },
  setStatus: { input: setStatusInputSchema, output: taskDetailSchema },
  postNote: { input: postNoteInputSchema, output: taskDetailSchema },
  searchTasks: { input: searchInputSchema, output: taskRowsSchema },
  recentTasks: {
    input: threadIdInputSchema,
    output: taskRowsSchema.extend({ lane: z.string().nullable() }),
  },
});

const doctorSchema = z.object({ author: z.string().min(1).optional() });
const INSTRUCTIONS_MAX = 4_096;
export const RECALL_BUDGET = 3;

const updateParameters = z.object({
  task_id: z.number().int().positive().describe("Task id (positive integer; see `cortex ls`)"),
  message: z
    .string()
    .max(4096)
    .refine(text => text.trim() !== "" && !/[\r\n]/.test(text), "message must be one non-blank line")
    .describe("What changed and what it means, in one or two plain sentences; max 4096 chars, no newlines"),
  status: z.enum(STATUSES).optional().describe("Optional status flip"),
  body: z.string().optional().describe("Optional detail shown in `cortex show`: numbers, lists, logs, evidence"),
});
const recallParameters = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      '"@<id>" loads one stream with a staleness check, "@<id>#<section>" one section of it; otherwise keywords (every lane)',
    ),
});
const updateResultSchema = z.object({ update: cliUpdateSchema, status: z.enum(STATUSES).optional() });

export const USAGE = [
  "Cortex is the user's task tracker and agent memory. Two tools use it:",
  "- cortex_update posts an update on a cortex task, credited to this thread. Pass task_id, message (one or two plain sentences on what changed and what it means; no newlines, at most 4,096 characters), and optionally status (draft|open|review|blocked|done) and body (numbers, lists, logs).",
  '- cortex_recall loads one memory stream ("@<id>", or "@<id>#<section>" for one section) with its staleness check, or searches memory by keywords across every lane, this project first. At most 3 calls per request and never the same query twice.',
  "Memory is a hint; the code and the user are the truth. When continuing a stream, follow its Next section and honour its Decisions.",
  'A line ::cortex{id="<id>"} in your reply shows that task as a card the user can open.',
].join("\n");

/** The usage block plus the project's cached primer, within bb's 4,096-character instruction limit. */
export function instructionsFor(primer: string | null): string {
  if (!primer) return USAGE;
  const open = "\n\n<cortex_memory>\n";
  const close = "\n</cortex_memory>";
  const room = INSTRUCTIONS_MAX - USAGE.length - open.length - close.length;
  const body = primer.length <= room ? primer : `${primer.slice(0, room - 1)}\u2026`;
  return `${USAGE}${open}${body}${close}`;
}

/**
 * The text `cortex memory show|search` prints for agents, exactly what the
 * Cortex pi extension returns. A checkout on another machine cannot be
 * checked, so show runs outside any checkout and says why.
 */
export async function recall(
  runner: CortexRunner,
  query: string,
  options: { cwd: string | null; lane: string | null; signal?: AbortSignal },
): Promise<string> {
  const byId = /^@?(\d+)(?:#(.+))?$/.exec(query);
  if (byId) {
    const section = byId[2]?.trim();
    const args = ["memory", "show", byId[1] as string, ...(section ? [`--section=${section}`] : [])];
    const text = await runner.text(args, { cwd: options.cwd ?? NEUTRAL_CWD, signal: options.signal });
    return options.cwd === null ? `${text.trimEnd()}\n(staleness unverifiable: ${REMOTE_REASON})` : text;
  }
  // Leading dashes and whitespace carry no terms, and a dash-leading value would read as a flag.
  const terms = query.replace(/^[\s-]+/, "");
  const args = ["memory", "search", terms, "--limit=5", ...(options.lane ? [`--boost=${options.lane}`] : [])];
  return runner.text(args, { cwd: options.cwd ?? undefined, signal: options.signal });
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export default async function plugin(bb: BbPluginApi): Promise<void> {
  const settings = bb.settings.define({
    cortexPath: {
      type: "string",
      label: "Cortex executable",
      description:
        "Absolute path to the cortex binary. Empty looks on PATH, then ~/bin and ~/.local/bin. Run `bb plugin reload cortex` after changing it.",
      default: "",
    },
  });
  const { cortexPath } = await settings.get();

  let runner: CortexRunner;
  try {
    runner = await createCortexRunner(cortexPath);
    await verifyCortexFeatures(runner);
  } catch (err) {
    const reason = `Cortex is unavailable: ${message(err)}`;
    bb.status.needsConfiguration(
      `${reason}. Install or update cortex, or set its path with \`bb plugin config cortex set cortexPath <absolute path>\`, then run \`bb plugin reload cortex\`.`,
    );
    const unavailable = (): never => {
      throw new Error(reason);
    };
    bb.rpc.register(rpcContract, {
      threadState: unavailable,
      task: unavailable,
      pin: unavailable,
      link: unavailable,
      unlink: unavailable,
      setStatus: unavailable,
      postNote: unavailable,
      searchTasks: unavailable,
      recentTasks: unavailable,
    });
    return;
  }

  // A cortex whose doctor names the user's author can record changes as the user (`update --as-me`).
  let userAuthor: string | null = null;
  try {
    userAuthor = (await runner.run(["doctor", "--json"], doctorSchema)).author ?? null;
  } catch (err) {
    bb.log.warn(`cortex doctor failed, so the Cortex tab is read-only: ${message(err)}`);
  }
  const state = createCortexState(bb, runner, { userAuthor });
  const publish = (channel: CortexRealtimeChannel, payload: unknown): void => bb.realtime.publish(channel, payload);
  registerCortexTools(bb, runner, state, publish);

  bb.agents.configure(context => {
    if (context.provider.id === "pi") return { tools: [], skills: [] };
    return {
      tools: ["cortex_update", "cortex_recall"],
      skills: [],
      instructions: instructionsFor(state.primerFor(context.project.id)),
    };
  });

  async function written<T>(threadId: string, write: Promise<T>, taskId?: number): Promise<T> {
    const result = await write;
    publish("thread", { threadId });
    if (taskId !== undefined) publish("task", { taskId });
    return result;
  }
  bb.rpc.register(rpcContract, {
    threadState: ({ threadId }) => state.threadState(threadId),
    task: ({ threadId, taskId }) => state.task(threadId, taskId),
    pin: ({ threadId, taskId }) => written(threadId, state.pin(threadId, taskId)),
    link: ({ threadId, taskId }) => written(threadId, state.link(threadId, taskId)),
    unlink: ({ threadId, taskId }) => written(threadId, state.unlink(threadId, taskId)),
    setStatus: ({ threadId, taskId, status }) => written(threadId, state.setStatus(threadId, taskId, status), taskId),
    postNote: ({ threadId, taskId, text, status }) => {
      const note = splitNote(text);
      if ("error" in note) throw new Error(note.error);
      return written(threadId, state.postNote(threadId, taskId, note, status), taskId);
    },
    searchTasks: async ({ query }) => ({ tasks: await state.searchTasks(query) }),
    recentTasks: ({ threadId }) => state.recentTasks(threadId),
  });

  const warm = (threadId: string): void => {
    state.warmProject(threadId).catch(err => bb.log.warn(`primer warmup for ${threadId} failed: ${message(err)}`));
  };
  const warmIfCold = ({ thread }: { thread: { id: string; projectId: string } }): void => {
    if (state.primerFor(thread.projectId) === null) warm(thread.id);
  };
  bb.events.on("thread.created", warmIfCold);
  bb.events.on("thread.active", warmIfCold);
  bb.sdk.threads.listRunning().then(
    running => {
      for (const thread of running) warm(thread.id);
    },
    err => bb.log.warn(`listing running threads failed: ${message(err)}`),
  );

  registerCortexWatch(bb, runner, state);
}

/** The two native tools, named and shaped like the Cortex pi extension's. */
function registerCortexTools(
  bb: BbPluginApi,
  runner: CortexRunner,
  state: CortexState,
  publish: (channel: CortexRealtimeChannel, payload: unknown) => void,
): void {
  // Per thread for the current request: calls made and queries claimed (in flight or answered).
  const recalls = new Map<string, { count: number; claimed: Set<string> }>();
  const forget = ({ thread }: { thread: { id: string } }): void => {
    recalls.delete(thread.id);
  };
  bb.events.on("thread.idle", forget);
  bb.events.on("thread.deleted", forget);

  bb.agents.registerTool({
    name: "cortex_update",
    description:
      "Post an update on a cortex task, credited to this bb thread (bb-<thread id>). Mirrors `cortex update <id> -m <message> [-s <status>] [-b <body>]`.",
    presentation: { label: { pending: "Posting a cortex update", completed: "Posted a cortex update" } },
    parameters: updateParameters,
    async execute(params, ctx) {
      if (!THREAD_ID.test(ctx.threadId)) throw new Error(`not a bb thread id: ${ctx.threadId}`);
      const args = ["update", String(params.task_id), `--message=${params.message}`, `--as=bb-${ctx.threadId}`];
      if (params.status !== undefined) args.push(`--status=${params.status}`);
      if (params.body) args.push(`--body=${params.body}`);
      args.push("--json");
      const out = await runner.run(args, updateResultSchema, { signal: ctx.signal });
      state.refreshTask(params.task_id).catch(err => bb.log.warn(`cortex refresh failed: ${message(err)}`));
      publish("thread", { threadId: ctx.threadId });
      publish("task", { taskId: params.task_id });
      const lines = [`\u2713 update [${out.update.id}] posted on task ${params.task_id}`];
      if (out.status) lines.push(`\u2713 status \u2192 ${out.status}`);
      return lines.join("\n");
    },
  });

  bb.agents.registerTool({
    name: "cortex_recall",
    description:
      'Load one cortex memory stream by id ("@<id>" leads with its Next/Open questions/Decisions, names the latest linked stream and reports staleness; "@<id>#<section>" loads one section) or search cortex memory by keywords (every lane, this project first). Budget: 3 calls per request.',
    presentation: { label: { pending: "Recalling cortex memory", completed: "Recalled cortex memory" } },
    parameters: recallParameters,
    async execute(params, ctx) {
      let entry = recalls.get(ctx.threadId);
      if (!entry) {
        entry = { count: 0, claimed: new Set() };
        recalls.set(ctx.threadId, entry);
      }
      if (++entry.count > RECALL_BUDGET) {
        return "Recall budget for this request is spent; continue the task with what you have.";
      }
      const query = params.query.trim();
      // The section is part of the query text, so `@12#next` and `@12` are distinct recalls.
      const key = query.toLowerCase().replace(/\s+/g, " ");
      if (entry.claimed.has(key)) return "Already recalled in this request; see the earlier result.";
      // Claimed before the CLI runs, so a parallel duplicate sees it in flight; a failure releases it.
      entry.claimed.add(key);
      try {
        const { projectId, cwd } = await state.locate(ctx.threadId);
        return await recall(runner, query, { cwd, lane: state.laneFor(projectId), signal: ctx.signal });
      } catch (err) {
        entry.claimed.delete(key);
        throw err;
      }
    },
  });
}
