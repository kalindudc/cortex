import fs from "node:fs";
import path from "node:path";
import { type BbPluginApi, defineRpcContract, type PluginSettingDescriptors } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { type CortexRunner, createCortexRunner, verifyCortexFeatures } from "./cli";
import { STATUSES, splitNote } from "./detail";
import {
  createMemoryTracker,
  effectiveMode,
  MEMORY_MODES,
  MEMORY_SETTINGS,
  type MemoryState,
  type MemoryTracker,
  memorySetting,
  memoryStateSchema,
} from "./memory";
import {
  type CortexRealtimeChannel,
  type CortexState,
  cliUpdateSchema,
  createCortexState,
  NEUTRAL_CWD,
  overrideFrom,
  REMOTE_REASON,
  taskDetailSchema,
  taskRowSchema,
  threadStateSchema,
} from "./state";
import { type MemoryTurns, registerMemoryTurns, STEER_PROVIDERS } from "./turns";
import { registerCortexWatch } from "./watch";

const THREAD_ID = /^thr_[0-9a-z]{6,40}$/;
const threadIdInputSchema = z.object({ threadId: z.string().regex(THREAD_ID) });
const threadTaskInputSchema = threadIdInputSchema.extend({ taskId: z.number().int().positive() });
const pinInputSchema = threadIdInputSchema.extend({ taskId: z.number().int().positive().nullable() });
const setStatusInputSchema = threadTaskInputSchema.extend({ status: z.enum(STATUSES) });
const setMemoryExcludedInputSchema = threadTaskInputSchema.extend({ excluded: z.boolean() });
// The text is split once here, so a bad note is an input error before any CLI call.
const postNoteInputSchema = threadTaskInputSchema
  .extend({ text: z.string().max(100_000), status: z.enum(STATUSES).optional() })
  .superRefine((input, ctx) => {
    const note = splitNote(input.text);
    if ("error" in note) ctx.addIssue({ code: "custom", path: ["text"], message: note.error });
  });
const searchInputSchema = z.object({ query: z.string().trim().min(1).max(200) });
const taskRowsSchema = z.object({ tasks: z.array(taskRowSchema) });
const taskRowsInputSchema = z.object({ ids: z.array(z.number().int().positive()).max(500) });
const setMemoryModeInputSchema = threadIdInputSchema.extend({ mode: z.enum(MEMORY_MODES).nullable() });

export const rpcContract = defineRpcContract({
  threadState: { input: threadIdInputSchema, output: threadStateSchema },
  task: { input: threadTaskInputSchema, output: taskDetailSchema },
  pin: { input: pinInputSchema, output: threadStateSchema },
  link: { input: threadTaskInputSchema, output: threadStateSchema },
  unlink: { input: threadTaskInputSchema, output: threadStateSchema },
  setStatus: { input: setStatusInputSchema, output: taskDetailSchema },
  setMemoryExcluded: { input: setMemoryExcludedInputSchema, output: taskDetailSchema },
  postNote: { input: postNoteInputSchema, output: taskDetailSchema },
  searchTasks: { input: searchInputSchema, output: taskRowsSchema },
  recentTasks: {
    input: threadIdInputSchema,
    output: taskRowsSchema.extend({ lane: z.string().nullable() }),
  },
  memory: { input: threadIdInputSchema, output: memoryStateSchema },
  taskRows: { input: taskRowsInputSchema, output: taskRowsSchema },
  setMemoryMode: { input: setMemoryModeInputSchema, output: memoryStateSchema },
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

export const SETTINGS = {
  cortexPath: {
    type: "string",
    label: "Cortex executable",
    description:
      "Absolute path to the cortex binary. Empty looks on PATH, then ~/bin and ~/.local/bin. Run `bb plugin reload cortex` after changing it.",
    default: "",
  },
  memory: {
    type: "select",
    label: "Agent memory",
    description:
      "How agents use Cortex memory. Look up only keeps the matching tasks that arrive with a message and the recall tool, and leaves out the memory summary and the automatic save turn; the agent can still post updates when its instructions say so. A thread's Memory tab can choose differently for that thread. A change applies when bb next starts a thread's agent session.",
    options: [...MEMORY_SETTINGS],
    default: "auto",
    experimental_optionLabels: {
      auto: "Automatic: threads you start look up and save; threads started by another thread only look up",
      write: "Look up and save in every thread",
      read: "Look up only",
      off: "Off",
    },
  },
  memoryChip: {
    type: "boolean",
    label: "Memory icon",
    description:
      "Shows the thread's memory beside the context circle under the prompt box, or in the thread header when that row is not on screen. Hover it for a summary; click it to open the Memory tab.",
    default: true,
  },
  taskChip: { type: "boolean", label: "Task chip in the thread header", default: true },
} satisfies PluginSettingDescriptors;

const USAGE_TOOLS = "Cortex is the user's task tracker and agent memory. Two tools use it:";
const USAGE_UPDATE =
  "- cortex_update posts an update on a cortex task, credited to this thread. Pass task_id, message (one or two plain sentences on what changed and what it means; no newlines, at most 4,096 characters), and optionally status (draft|open|review|blocked|done) and body (numbers, lists, logs).";
const USAGE_RECALL =
  '- cortex_recall loads one memory stream ("@<id>", or "@<id>#<section>" for one section) with its staleness check, or searches memory by keywords across every lane, this project first. At most 3 calls per request and never the same query twice.';
const USAGE_HITS =
  "Matching tasks may arrive as a hidden cortex memory message shortly after a request starts; recall only what they do not cover.";
const USAGE_NO_HITS =
  "No matching tasks arrive on their own: call cortex_recall when the request refers to earlier work.";
const USAGE_HINT =
  "Memory is a hint; the code and the user are the truth. When continuing a stream, follow its Next section and honour its Decisions.";
const USAGE_CARD = 'A line ::cortex{id="<id>"} in your reply shows that task as a card the user can open.';

/**
 * Providers that get the plugin's skills. `cortex agents install` writes them to ~/.agents/skills, which every other
 * provider reads; Claude Code reads only ~/.claude/skills, and bb does not drop a plugin skill a provider already has.
 */
export const PLUGIN_SKILL_PROVIDERS: ReadonlySet<string> = new Set(["claude-code"]);

/** The plugin's skills a provider's configure selects. */
export function skillsFor(providerId: string, shipped: readonly string[]): string[] {
  return PLUGIN_SKILL_PROVIDERS.has(providerId) ? [...shipped] : [];
}

/** Sorted names of the skills under `<rootDir>/skills`: each a directory holding a SKILL.md file, as bb reads them. */
export function pluginSkillNames(rootDir: string): string[] {
  const dir = path.join(rootDir, "skills");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(
      entry =>
        entry.isDirectory() &&
        fs.statSync(path.join(dir, entry.name, "SKILL.md"), { throwIfNoEntry: false })?.isFile() === true,
    )
    .map(entry => entry.name)
    .sort();
}

/**
 * The usage block; without recall (memory off) it describes cortex_update alone. `hits` says whether matching tasks
 * arrive with a request, which only providers that take a steer mid-turn get.
 */
export function usageFor(recall: boolean, hits = true): string {
  const recallPart = `${USAGE_RECALL} ${hits ? USAGE_HITS : USAGE_NO_HITS}`;
  if (recall) return [USAGE_TOOLS, USAGE_UPDATE, recallPart, USAGE_HINT, USAGE_CARD].join("\n");
  return [USAGE_TOOLS.replace("Two tools use it:", "One tool uses it:"), USAGE_UPDATE, USAGE_CARD].join("\n");
}
export const USAGE = usageFor(true);

/** The usage block plus the project's cached primer, within bb's 4,096-character instruction limit. */
export function instructionsFor(
  primer: string | null,
  options: { recall: boolean; hits: boolean } = { recall: true, hits: true },
): string {
  const usage = usageFor(options.recall, options.hits);
  if (!primer) return usage;
  const open = "\n\n<cortex_memory>\n";
  const close = "\n</cortex_memory>";
  const room = INSTRUCTIONS_MAX - usage.length - open.length - close.length;
  const body = primer.length <= room ? primer : `${primer.slice(0, room - 1)}\u2026`;
  return `${usage}${open}${body}${close}`;
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
  const settings = bb.settings.define(SETTINGS);
  // configure is synchronous, so it reads the values kept here.
  let current = await settings.get();
  settings.onChange(next => {
    current = next;
    bb.realtime.publish("memory", null);
  });
  const { cortexPath } = current;

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
      setMemoryExcluded: unavailable,
      postNote: unavailable,
      searchTasks: unavailable,
      recentTasks: unavailable,
      memory: unavailable,
      taskRows: unavailable,
      setMemoryMode: unavailable,
    });
    // Without a configure, bb would give every provider the plugin's skills.
    bb.agents.configure(() => ({ tools: [], skills: [] }));
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
  const tracker = createMemoryTracker(RECALL_BUDGET);
  const publish = (channel: CortexRealtimeChannel, payload: unknown): void => bb.realtime.publish(channel, payload);
  const turns = registerMemoryTurns(bb, {
    runner,
    state,
    tracker,
    publish,
    modeOf: async thread =>
      effectiveMode(memorySetting(current.memory), await state.memoryOverride(thread.id), thread.parentThreadId !== null),
  });
  registerCortexTools(bb, runner, state, tracker, publish, turns);

  // bb fails a configure that names a skill the plugin lacks, so only the skills its install holds are selected.
  let shippedSkills: string[] = [];
  bb.sdk.plugins
    .list()
    .then(({ plugins }) => {
      const self = plugins.find(entry => entry.id === bb.pluginId);
      if (!self) throw new Error(`${bb.pluginId} is not in bb's plugin list`);
      shippedSkills = pluginSkillNames(self.rootDir);
    })
    .catch(err => bb.log.warn(`reading the plugin's skills failed, so no thread gets them: ${message(err)}`));

  bb.agents.configure(context => {
    const child = context.thread.parentThreadId !== null;
    const mode = effectiveMode(memorySetting(current.memory), overrideFrom(context.pluginMetadata), child);
    // As in the pi extension, only writers get the summary; off also drops recall.
    const primer = mode === "write" ? state.primerFor(context.project.id) : null;
    const summary = primer === null ? [] : state.primerIdsFor(context.project.id);
    const start = { mode, lane: state.laneFor(context.project.id), summary, chars: primer?.length ?? 0 };
    if (tracker.configured(context.thread.id, start)) publish("memory", { threadId: context.thread.id });
    return {
      tools: mode === "off" ? ["cortex_update"] : ["cortex_update", "cortex_recall"],
      skills: skillsFor(context.provider.id, shippedSkills),
      instructions: instructionsFor(primer, {
        recall: mode !== "off",
        hits: STEER_PROVIDERS.has(context.provider.id),
      }),
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
    setMemoryExcluded: ({ threadId, taskId, excluded }) =>
      written(threadId, state.setMemoryExcluded(threadId, taskId, excluded), taskId),
    postNote: ({ threadId, taskId, text, status }) => {
      const note = splitNote(text);
      if ("error" in note) throw new Error(note.error);
      return written(threadId, state.postNote(threadId, taskId, note, status), taskId);
    },
    searchTasks: async ({ query }) => ({ tasks: await state.searchTasks(query) }),
    recentTasks: ({ threadId }) => state.recentTasks(threadId),
    memory: ({ threadId }) => memoryState(threadId),
    taskRows: async ({ ids }) => ({ tasks: await state.taskRows(ids) }),
    setMemoryMode: async ({ threadId, mode }) => {
      await state.setMemoryOverride(threadId, mode);
      publish("memory", { threadId });
      return memoryState(threadId);
    },
  });

  async function memoryState(threadId: string): Promise<MemoryState> {
    const [thread, override] = await Promise.all([bb.sdk.threads.get({ threadId }), state.memoryOverride(threadId)]);
    const setting = memorySetting(current.memory);
    const child = thread.parentThreadId !== null;
    return {
      threadId,
      setting,
      override,
      mode: effectiveMode(setting, override, child),
      child,
      view: tracker.get(threadId)?.view ?? null,
    };
  }

  bb.events.on("thread.active", ({ thread }) => {
    if (tracker.nextRequest(thread.id)) publish("memory", { threadId: thread.id });
  });
  const forgetMemory = ({ thread }: { thread: { id: string } }): void => {
    tracker.forget(thread.id);
  };
  bb.events.on("thread.archived", forgetMemory);
  bb.events.on("thread.deleted", forgetMemory);

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

/** The two native tools every provider gets. */
function registerCortexTools(
  bb: BbPluginApi,
  runner: CortexRunner,
  state: CortexState,
  tracker: MemoryTracker,
  publish: (channel: CortexRealtimeChannel, payload: unknown) => void,
  turns: MemoryTurns,
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
      let out: z.infer<typeof updateResultSchema>;
      try {
        out = await runner.run(args, updateResultSchema, { signal: ctx.signal });
      } catch (err) {
        tracker.failed(ctx.threadId, message(err));
        publish("memory", { threadId: ctx.threadId });
        throw err;
      }
      state.refreshTask(params.task_id).catch(err => bb.log.warn(`cortex refresh failed: ${message(err)}`));
      tracker.updated(ctx.threadId, params.task_id);
      turns.wrote(ctx.threadId);
      publish("thread", { threadId: ctx.threadId });
      publish("task", { taskId: params.task_id });
      publish("memory", { threadId: ctx.threadId });
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
        const started = Date.now();
        const text = await recall(runner, query, { cwd, lane: state.laneFor(projectId), signal: ctx.signal });
        tracker.recalled(ctx.threadId, query, text, Date.now() - started);
        return text;
      } catch (err) {
        tracker.failed(ctx.threadId, message(err));
        entry.claimed.delete(key);
        throw err;
      } finally {
        publish("memory", { threadId: ctx.threadId });
      }
    },
  });
}
