// The `:` command registry (plan @400 N17/P9): ONE list of CommandSpec
// (name, aliases, usage, description, completer, handler) drives execution
// (parseCommand + run), Tab completion (completeCommandLine), `?`/:help
// (commandHelp) and the searchable :commands reference (searchCommands).
//
// - Handlers parse and validate their argument and throw CommandError with
//   an explanation; the session shows it and changes nothing.
// - Completers return whole argument values for the typed argument prefix:
//   task ids (by id prefix or by title search), statuses, lanes, tags,
//   option names, themes, and the current document's heading slugs and code
//   block numbers (`describe` says what a candidate names).
// - Metadata and catalog commands (P3/P4) write through the shared guarded
//   API only (session.client.versioned, `Prefer: cortex-versioned`): each
//   reads ONE atomic state (task, lane or tag with its versions), refuses a
//   stale view as a conflict before writing, then sends a guard {expected
//   tokens of exactly the scopes it changes, mutationId}. A 412 is shown as
//   a conflict with context and nothing is applied locally: the session's
//   copy only ever changes through the live stream, never from a write's
//   answer (no stale list replacement), and uncertain transport failures are
//   never retried. Writes run one at a time (session.mutate); a queued write
//   acts on the task selected when it was SUBMITTED (submittedTask), and only
//   on the database it was submitted against: every request of a write goes
//   through the client mutate hands it (refused once that database was
//   replaced), and a command that reads or asks first passes mutate the
//   database generation it captured when it was submitted.
// - Human status changes send no author, exactly as the web does, so they
//   never pose as attributed agent changes (N9).
// - Tag membership changes are atomic add/remove deltas, never a whole-list
//   replace; removing a tag from a task never deletes its definition.
// - Documents (Task 9): :read/:edit/:split change the saved preferred mode
//   (nothing else does); :title goes through the task's draft (in place
//   without text); :w saves every draft (or exports with a path, :w @<id>
//   <path> a kept draft of a deleted task; :w! replaces), :wq/:x quit only
//   after acknowledged saves, :q refuses while a draft is unsaved and :q!
//   discards; :apply/:keep resolve a conflict.
// - The reader (Task 10, src/tui/reader.ts): :heading [slug] (bare: the
//   outline), :links (links and references; Enter follows), :copy [n] (an
//   explicit OSC 52 copy of a code block), :source (the raw source).
// - Later slices add their commands to COMMANDS; nothing else needs to change.

import { HttpError, newMutationId, TransportError } from "../api.ts";
import type {
  BackupResult,
  CortexClient,
  CreateLaneRequest,
  CreateTagRequest,
  CreateTaskRequest,
  EditLaneRequest,
  EditTagRequest,
  LaneStateSnapshot,
  ResourceScope,
  TagStateSnapshot,
  TaskStateSnapshot,
  TaskWriteResult,
  Versions,
} from "../contracts.ts";
import type { Task, TaskStatus } from "../store.ts";
import { searchCatalog } from "../ui/lib/catalogSearch.ts";
import { isValidTagName, nextStatusFor, STATUS, STATUS_LABEL } from "../ui/lib/constants.ts";
import { searchTasks } from "../ui/lib/fuzzy.ts";
import { UNTAGGED } from "../ui/lib/taskView.ts";
import type { Activity } from "./activity.ts";
import { openRichPreview, resumeTask } from "./bridge.ts";
import { DENSITIES, type Density, isDensity } from "./config.ts";
import { type Dialog, type DialogRow, showDialog } from "./dialogs.ts";
import { TASK_GROUPS, TASK_SORTS, type TaskFilter, type TaskGroup, type TaskSort } from "./preferences.ts";
import type { Reader, ReaderCodeBlock, ReaderLink } from "./reader.ts";
import type { TaskPanel, ThemeControl, TuiSession } from "./session.ts";
import { BUNDLED_THEME_NAMES, type ResolvedTheme, type ThemeSource } from "./theme.ts";
import { describeFilters, filterChips, filterCounts, STATUS_MARK, tagLabel } from "./workspace.ts";

/** Input the user must correct: shown as an error message, nothing changes. */
export class CommandError extends Error {}

export interface CommandSpec {
  name: string;
  aliases: readonly string[];
  usage: string;
  description: string;
  /** Acts on the open dialog instead of closing it (:w, :q ...). */
  dialog?: boolean;
  /** Whole argument values for the typed argument prefix. */
  complete?(prefix: string, session: TuiSession): readonly string[];
  /** What a completed argument names, beside the candidate (raw text). */
  describe?(argument: string, session: TuiSession): string | undefined;
  run(session: TuiSession, argument: string): void | Promise<void>;
}

const TASK_REF = /^@?(\d+)$/;
const SPLIT = /^(\S+)(?:\s+([\s\S]*))?$/;

export function findCommand(name: string, specs: readonly CommandSpec[]): CommandSpec | undefined {
  return specs.find(s => s.name === name || s.aliases.includes(name));
}

/**
 * Resolve one command line (with or without its leading `:`) to a command
 * and its argument (trimmed at both ends). `<id>` and `@<id>` are `:open`.
 * Throws CommandError for an empty line or an unknown command.
 */
export function parseCommand(input: string, specs: readonly CommandSpec[]): { spec: CommandSpec; argument: string } {
  const line = input.trim().replace(/^:/, "").trim();
  if (line === "") throw new CommandError("Type a command after ':' (Tab completes, :help lists them)");
  if (TASK_REF.test(line)) {
    const open = findCommand("open", specs);
    if (open) return { spec: open, argument: line };
  }
  const match = SPLIT.exec(line);
  const name = match?.[1] ?? line;
  const spec = findCommand(name, specs);
  if (!spec) throw new CommandError(`Unknown command :${name}; Tab completes, :help lists the commands`);
  return { spec, argument: (match?.[2] ?? "").trim() };
}

/**
 * Tab candidates for a whole command line: command names (alphabetically)
 * while the first word is typed, task ids for the `:<id>` shorthand, then
 * the command's own argument completions (keeping the name as typed).
 */
export function completeCommandLine(line: string, specs: readonly CommandSpec[], session: TuiSession): string[] {
  const text = line.replace(/^:/, "").trimStart();
  const space = text.search(/\s/);
  if (space < 0) {
    if (/^@?\d+$/.test(text)) return taskIdCandidates(text, session);
    return specs
      .map(s => s.name)
      .filter(n => n.startsWith(text))
      .sort();
  }
  const name = text.slice(0, space);
  const spec = findCommand(name, specs);
  if (spec?.complete === undefined) return [];
  const prefix = text.slice(space).replace(/^\s+/, "");
  return spec.complete(prefix, session).map(argument => `${name} ${argument}`);
}

/** A short explanation of a completion candidate: the task a task argument names, else the command's description. */
export function describeCandidate(
  candidate: string,
  specs: readonly CommandSpec[],
  session: TuiSession,
): string | undefined {
  const text = candidate.trim();
  const title = (ref: string): string | undefined => {
    const m = TASK_REF.exec(ref);
    return m ? session.tasks.find(t => t.id === Number(m[1]))?.title : undefined;
  };
  if (TASK_REF.test(text)) return title(text);
  const match = SPLIT.exec(text);
  const spec = match?.[1] === undefined ? undefined : findCommand(match[1], specs);
  if (spec === undefined) return undefined;
  const argument = (match?.[2] ?? "").trim();
  if (argument === "") return spec.description;
  return spec.describe?.(argument, session) ?? title(argument);
}

export interface CommandHelp {
  readonly name: string;
  readonly usage: string;
  /** Other ways to type it (`:quit` beside `:q`), not repeated from the usage. */
  readonly names: readonly string[];
  readonly description: string;
}

/** The registry as help entries, in registry order. */
export function commandHelp(specs: readonly CommandSpec[]): CommandHelp[] {
  return specs.map(s => ({
    name: s.name,
    usage: s.usage,
    names: [s.name, ...s.aliases].map(n => `:${n}`).filter(n => n !== s.usage && !s.usage.startsWith(`${n} `)),
    description: s.description,
  }));
}

/** The :commands reference search: literal, case-insensitive AND keywords over names, usage and description; uncapped. */
export function searchCommands(specs: readonly CommandSpec[], query: string): CommandSpec[] {
  return searchCatalog(specs, query, s =>
    [`:${s.name}`, ...s.aliases.map(a => `:${a}`), s.usage, s.description].join(" "),
  ).items;
}

/** Whether a command accepts an argument (its usage shows one). */
export function takesArgument(spec: CommandSpec): boolean {
  return /[<[]/.test(spec.usage);
}

// ---------- completion helpers ----------

/** Task ids for a task argument: by id prefix (`12`, `@12`), else by search relevance of the text. */
function taskIdCandidates(prefix: string, session: TuiSession): string[] {
  const text = prefix.trim();
  const byId = /^(@?)(\d*)$/.exec(text);
  if (byId) {
    const [, at = "", digits = ""] = byId;
    return session.tasks
      .map(t => t.id)
      .filter(id => String(id).startsWith(digits))
      .sort((a, b) => a - b)
      .map(id => `${at}${id}`);
  }
  return searchTasks(session.tasks, text).map(r => String(r.task.id));
}

/** Complete the LAST blank-separated word of `prefix` from `choices`, keeping the words before it. */
function lastWord(prefix: string, choices: readonly string[], sign = false): string[] {
  const at = prefix.search(/\S*$/);
  const before = prefix.slice(0, at);
  const word = prefix.slice(at);
  const mark = sign && /^[+\-#]/.test(word) ? (word[0] ?? "") : "";
  const stem = word.slice(mark.length);
  return choices.filter(c => c.startsWith(stem)).map(c => `${before}${mark}${c}`);
}

function noArgument(name: string, argument: string): void {
  if (argument !== "") throw new CommandError(`:${name} takes no argument`);
}

// ---------- :filter ----------

const FILTER_SLOTS = ["lane", "status", "tags"] as const;

function completeFilter(prefix: string, session: TuiSession): string[] {
  const match = /^(\S*)(\s+([\s\S]*))?$/.exec(prefix);
  const slot = match?.[1] ?? "";
  if (match?.[2] === undefined) return FILTER_SLOTS.filter(s => s.startsWith(slot));
  const rest = match[3] ?? "";
  switch (slot) {
    case "status":
      return STATUS.filter(s => s.startsWith(rest)).map(s => `status ${s}`);
    case "lane":
      return session.lanes
        .map(l => l.name)
        .filter(n => n.startsWith(rest))
        .map(n => `lane ${n}`);
    case "tag":
    case "tags":
      return lastWord(rest, [...session.tags.map(t => t.name), "untagged"], true).map(v => `${slot} ${v}`);
    default:
      return [];
  }
}

function runFilter(session: TuiSession, argument: string): void {
  if (argument === "") {
    const parts = describeFilters(session.listView);
    session.notify(
      "info",
      parts.length > 0
        ? `Filters: ${parts.join(" · ")} (:clear clears them)`
        : "No filters: :filter status|lane|tags <value> narrows the list, / searches it",
    );
    return;
  }
  const match = SPLIT.exec(argument);
  session.setFilter(nextFilter(session, match?.[1] ?? "", (match?.[2] ?? "").trim()));
}

/** The filter slots after `:filter <slot> <value>`; throws CommandError for bad input. */
function nextFilter(session: TuiSession, slot: string, value: string): TaskFilter {
  const current = session.filter;
  switch (slot) {
    case "status": {
      if (value === "") return { ...current, status: null };
      if (!(STATUS as readonly string[]).includes(value)) {
        throw new CommandError(
          `Unknown status "${value}": draft, open, review, blocked or done (a bare :filter status clears it)`,
        );
      }
      return { ...current, status: value as TaskStatus };
    }
    case "lane": {
      if (value === "") return { ...current, lane: null };
      if (!session.lanes.some(l => l.name === value)) {
        throw new CommandError(`No lane "${value}" (lanes: ${session.lanes.map(l => l.name).join(", ") || "none"})`);
      }
      return { ...current, lane: value };
    }
    case "tag":
    case "tags": {
      if (value === "") return { ...current, tags: [] };
      const plain: string[] = [];
      const add: string[] = [];
      const remove: string[] = [];
      for (const token of value.split(/\s+/)) {
        const sign = token.startsWith("+") || token.startsWith("-") ? token.charAt(0) : "";
        const raw = token.slice(sign.length).replace(/^#/, "");
        const name = raw === "untagged" ? UNTAGGED : raw;
        if (name === "") throw new CommandError(`A tag name is missing in "${token}"`);
        if (sign !== "-" && name !== UNTAGGED && !session.tags.some(t => t.name === name)) {
          throw new CommandError(`No tag "${name}" (:filter tags <names> replaces, +name adds, -name removes)`);
        }
        (sign === "+" ? add : sign === "-" ? remove : plain).push(name);
      }
      const next = plain.length > 0 ? [...new Set(plain)] : [...current.tags];
      for (const name of add) if (!next.includes(name)) next.push(name);
      return { ...current, tags: next.filter(name => !remove.includes(name)) };
    }
    default:
      throw new CommandError(`Unknown filter "${slot}": status, lane or tags`);
  }
}

// ---------- the filter picker (f) ----------

/** The picker's one-key status toggles (digits are reserved; done is `x`, a checked box). */
const STATUS_KEYS: Readonly<Record<TaskStatus, string>> = {
  draft: "d",
  open: "o",
  review: "r",
  blocked: "b",
  done: "x",
};

/** One press of a status: the status slot becomes it, or is cleared when it already is (one slot, like the web). */
function toggleStatus(session: TuiSession, status: TaskStatus): void {
  const f = session.filter;
  session.setFilter({ ...f, status: f.status === status ? null : status });
}

function toggleLane(session: TuiSession, lane: string): void {
  const f = session.filter;
  session.setFilter({ ...f, lane: f.lane === lane ? null : lane });
}

/** A tag (or untagged) joins or leaves the tag slot (tags OR together). */
function toggleTag(session: TuiSession, name: string): void {
  const f = session.filter;
  session.setFilter({ ...f, tags: f.tags.includes(name) ? f.tags.filter(t => t !== name) : [...f.tags, name] });
}

/** The live count line: what the list shows now and the filters behind it. */
function filterSummary(session: TuiSession): string {
  const shown = session.workspace().rows.length;
  const chips = filterChips(session.listView);
  if (session.includeDone) chips.push("+done");
  return `${plural(shown, "task")} shown · ${chips.length > 0 ? chips.join(" ") : "no filters"}`;
}

function filterRows(session: TuiSession): DialogRow[] {
  const f = session.filter;
  const counts = filterCounts(session.tasks, session.listView);
  const radio = (on: boolean): string => (on ? "(\u2022)" : "( )");
  const box = (on: boolean): string => (on ? "[x]" : "[ ]");
  const rows: DialogRow[] = STATUS.map(status => ({
    key: `status:${status}`,
    section: "Status",
    fixed: true,
    toggle: true,
    mark: radio(f.status === status),
    label: `${STATUS_MARK[status]} ${status}`,
    detail: `${counts.statuses[status]} · ${STATUS_KEYS[status]}`,
  }));
  rows.push({
    key: "done",
    section: "Status",
    fixed: true,
    toggle: true,
    mark: box(session.includeDone),
    label: "include done",
    detail: "a · shows done tasks too",
  });
  for (const lane of session.lanes) {
    rows.push({
      key: `lane:${lane.name}`,
      section: "Lane",
      toggle: true,
      mark: radio(f.lane === lane.name),
      label: lane.name,
      detail: String(counts.lanes.get(lane.name) ?? 0),
    });
  }
  rows.push({
    key: `tag:${UNTAGGED}`,
    section: "Tags (any of them)",
    fixed: true,
    toggle: true,
    mark: box(f.tags.includes(UNTAGGED)),
    label: "untagged",
    detail: `${counts.untagged} · u`,
  });
  const names = session.tags.map(t => t.name).sort((a, b) => a.localeCompare(b));
  for (const name of names) {
    rows.push({
      key: `tag:${name}`,
      section: "Tags (any of them)",
      toggle: true,
      mark: box(f.tags.includes(name)),
      label: tagLabel(name),
      detail: String(counts.tags.get(name) ?? 0),
    });
  }
  return rows;
}

/**
 * The filter picker (`f`): Status, Lane and Tags sections with live counts
 * (each slot counted over the search and the other slots). One key toggles
 * a status (d o r b x), untagged (u) or include-done (a); Space toggles the
 * highlighted row; F clears like :clear; `/` searches the lanes and tags as
 * you type. Every toggle applies at once (the list behind follows); Enter,
 * Esc and q only close it, so the filters stay applied.
 */
export function openFilterPicker(session: TuiSession): void {
  const keys = STATUS.map(status => ({
    key: STATUS_KEYS[status],
    label: status,
    run: () => toggleStatus(session, status),
  }));
  showDialog(
    session,
    {
      kind: "list",
      title: "FILTERS",
      label: "filters",
      pickLabel: "closes",
      noun: "lanes and tags",
      live: true,
      hints: ["Space toggles", "Enter/Esc close (the filters stay)", "d o r b x u a toggle", "F clears", "/ searches"],
      empty: "No lane or tag matches the search",
      summary: () => filterSummary(session),
      rows: () => filterRows(session),
      keys: [
        ...keys,
        { key: "u", label: "untagged", run: () => toggleTag(session, UNTAGGED) },
        { key: "a", label: "include done", run: () => session.setIncludeDone(!session.includeDone) },
        { key: "F", label: "clears", run: () => session.clearFilters() },
      ],
      pick: (row, dialog, via) => {
        if (via === "enter") {
          dialog.finish();
          return;
        }
        const at = row.key.indexOf(":");
        const kind = at < 0 ? row.key : row.key.slice(0, at);
        const value = at < 0 ? "" : row.key.slice(at + 1);
        if (kind === "status") toggleStatus(session, value as TaskStatus);
        else if (kind === "lane") toggleLane(session, value);
        else if (kind === "tag") toggleTag(session, value);
        else if (kind === "done") session.setIncludeDone(!session.includeDone);
      },
    },
    "right",
  );
}

// ---------- :sort and :group ----------

const SORT_HELP: Readonly<Record<TaskSort, string>> = {
  id: "ascending task id (the default)",
  "-id": "newest task first",
  title: "title, A to Z (numbers in order)",
  "-title": "title, Z to A",
  lane: "lane order, then id",
  status: "draft, open, review, blocked, done",
  priority: "P0 first, unset last",
  updated: "least recently updated first",
  "-updated": "most recently updated first",
};

const GROUP_HELP: Readonly<Record<TaskGroup, string>> = {
  none: "one flat list",
  lane: "a header per lane, with its count",
  status: "a header per status, with its count",
};

const isSort = (value: string): value is TaskSort => (TASK_SORTS as readonly string[]).includes(value);
const isGroup = (value: string): value is TaskGroup => (TASK_GROUPS as readonly string[]).includes(value);

function runSort(session: TuiSession, argument: string): void {
  if (argument === "") {
    openOrderPicker(session, "sort");
    return;
  }
  if (!isSort(argument)) throw new CommandError(`Unknown order "${argument}": ${TASK_SORTS.join(", ")}`);
  session.setSort(argument);
  if (session.query !== "") {
    session.notify("info", `The search ranks by relevance; sort ${argument} applies once it is cleared`);
  }
}

function runGroup(session: TuiSession, argument: string): void {
  if (argument === "") {
    openOrderPicker(session, "group");
    return;
  }
  if (!isGroup(argument)) {
    throw new CommandError(
      `Unknown grouping "${argument}": ${TASK_GROUPS.slice(0, -1).join(", ")} or ${TASK_GROUPS.at(-1)}`,
    );
  }
  session.setGroup(argument);
  if (session.query !== "" && argument !== "none") {
    session.notify("info", `The search shows one list by relevance; group ${argument} applies once it is cleared`);
  }
}

/** The sort and group picker (bare :sort/:group, ;o): Space applies a row, Enter applies it and closes. */
function openOrderPicker(session: TuiSession, start: "sort" | "group"): void {
  const mark = (on: boolean): string => (on ? "(\u2022)" : "( )");
  showDialog(session, {
    kind: "list",
    title: "SORT AND GROUP",
    label: "sort",
    pickLabel: "applies and closes",
    spaceLabel: "applies",
    initial: start === "sort" ? `sort:${session.sort}` : `group:${session.group}`,
    rows: () => [
      ...TASK_SORTS.map(v => ({
        key: `sort:${v}`,
        section: "Sort (a search ranks by relevance)",
        toggle: true,
        label: v,
        mark: mark(session.sort === v),
        detail: SORT_HELP[v],
      })),
      ...TASK_GROUPS.map(v => ({
        key: `group:${v}`,
        section: "Group",
        toggle: true,
        label: v,
        mark: mark(session.group === v),
        detail: GROUP_HELP[v],
      })),
    ],
    pick: (row, dialog, via) => {
      const value = row.key.slice(row.key.indexOf(":") + 1);
      if (row.key.startsWith("sort:") && isSort(value)) session.setSort(value);
      else if (isGroup(value)) session.setGroup(value);
      if (via !== "space") dialog.finish();
    },
  });
}

// ---------- :set ----------

interface SessionOption {
  readonly label: string;
  get(session: TuiSession): boolean;
  set(session: TuiSession, value: boolean): void;
}

const OPTIONS: Readonly<Record<string, SessionOption>> = {
  done: {
    label: "show done tasks",
    get: s => s.includeDone,
    set: (s, v) => s.setIncludeDone(v),
  },
  tasks: {
    label: "show the task list",
    get: s => s.taskListVisible,
    set: (s, v) => s.setTaskListVisible(v),
  },
  number: {
    label: "source line numbers in Read and the Split preview",
    get: s => s.lineNumbers,
    set: (s, v) => s.setLineNumbers(v),
  },
};

const OPTION_WORDS = Object.keys(OPTIONS)
  .flatMap(name => [name, `${name}!`, `no${name}`])
  .sort();

function runSet(session: TuiSession, argument: string): void {
  const names = Object.keys(OPTIONS);
  if (argument === "") {
    const state = names.map(n => ((OPTIONS[n] as SessionOption).get(session) ? n : `no${n}`)).join(" ");
    session.notify("info", `Options: ${state} (:set <name>, no<name>, <name>! toggles, <name>? shows)`);
    return;
  }
  const known = names.map(n => `${n} (${(OPTIONS[n] as SessionOption).label})`).join(" or ");
  const plans = argument.split(/\s+/).map(token => {
    const m = /^(no|inv)?([a-z]+)([!?])?$/.exec(token);
    const name = m?.[2] ?? token.replace(/[!?]$/, "");
    const option = m && Object.hasOwn(OPTIONS, name) ? OPTIONS[name] : undefined;
    if (!m || option === undefined || (m[1] !== undefined && m[3] !== undefined)) {
      throw new CommandError(`Unknown option "${name}": ${known}`);
    }
    return { name, option, prefix: m[1], suffix: m[3] };
  });
  for (const { name, option, prefix, suffix } of plans) {
    if (suffix === "?") {
      session.notify("info", `${name} (${option.label}): ${option.get(session) ? "on" : "off"}`);
      continue;
    }
    const toggle = suffix === "!" || prefix === "inv";
    option.set(session, toggle ? !option.get(session) : prefix !== "no");
  }
}

// ---------- guarded writes (P3/P4) ----------

const isConflict = (err: unknown): boolean => err instanceof HttpError && err.status === 412;
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
const hashes = (names: readonly string[]): string => names.map(n => `#${n}`).join(" ");
const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);

/** The task the singular commands act on: the explicit selection (even filtered out), else the fallback. */
function currentTask(session: TuiSession): Task {
  if (!session.loaded) throw new CommandError("The workspace is still loading");
  const task = session.selectedTask();
  if (task === null) throw new CommandError("No task selected: :open <id> picks one");
  return task;
}

/**
 * The current task, captured when a command is SUBMITTED: a write queued behind
 * earlier ones (session.mutate) acts on THIS task when it runs, whatever was
 * selected meanwhile. The returned function re-reads its latest copy from the
 * workspace at run time; a task deleted meanwhile is a CommandError (nothing
 * written). A replaced database never runs it at all (session.mutate).
 */
function submittedTask(session: TuiSession, attempt: string): () => Task {
  const id = currentTask(session).id;
  return () => {
    const task = session.tasks.find(t => t.id === id);
    if (task === undefined) throw new CommandError(`@${id} no longer exists; ${attempt} did nothing`);
    return task;
  };
}

/** A write's failure with its context. An uncertain one may have applied: it is reported, never retried. */
function writeFailure(err: unknown, attempt: string): CommandError {
  if (err instanceof CommandError) return err;
  if (err instanceof TransportError && err.uncertain) {
    return new CommandError(
      `The outcome of "${attempt}" is unknown, so it may or may not have applied (${err.message}); the list shows what the daemon has: repeat it only if it did not`,
    );
  }
  return new CommandError(`Could not ${attempt}: ${err instanceof Error ? err.message : String(err)}`);
}

/** The token of `scope`, which a guard must carry. */
function token(versions: Versions, scope: ResourceScope, what: string): string {
  const value = versions[scope];
  if (value === undefined) {
    throw new CommandError(`The daemon did not report the ${scope} version of ${what}; restart it (cortex stop)`);
  }
  return value;
}

async function readTask(client: CortexClient, id: number, attempt: string): Promise<TaskStateSnapshot> {
  try {
    return await client.taskState(id);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404)
      throw new CommandError(`@${id} no longer exists; ${attempt} did nothing`);
    throw writeFailure(err, `read @${id}`);
  }
}

async function readLane(client: CortexClient, name: string): Promise<LaneStateSnapshot> {
  try {
    return await client.laneState(name);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) throw new CommandError(`There is no lane ${name} any more`);
    throw writeFailure(err, `read lane ${name}`);
  }
}

async function readTag(client: CortexClient, name: string): Promise<TagStateSnapshot> {
  try {
    return await client.tagState(name);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) throw new CommandError(`There is no tag #${name} any more`);
    throw writeFailure(err, `read #${name}`);
  }
}

type TaskField = "title" | "status" | "priority" | "lane";

function fieldValue(task: Task, field: TaskField): string {
  switch (field) {
    case "title":
      return JSON.stringify(task.title);
    case "status":
      return STATUS_LABEL[task.status];
    case "priority":
      return task.priority === null ? "none" : `P${task.priority}`;
    case "lane":
      return task.lane;
  }
}

function fieldConflict(shown: Task, now: Task | null, field: TaskField, attempt: string): CommandError {
  const value = now === null ? "" : ` (now ${fieldValue(now, field)})`;
  return new CommandError(
    `Conflict: @${shown.id}'s ${field} changed${value} before ${attempt} applied. Nothing was changed; run it again to apply it`,
  );
}

/**
 * One field write of the current task: ONE atomic state read, a conflict if
 * the shown value is stale (so :next never steps from a status the daemon no
 * longer has), then the write guarded by that field's own token. A 412 is a
 * conflict with the incoming value. Nothing is applied locally. Every request
 * goes through `client` (the one session.mutate handed the write).
 */
async function writeField(
  client: CortexClient,
  shown: Task,
  field: TaskField,
  attempt: string,
  write: (expected: Versions) => Promise<TaskWriteResult>,
): Promise<void> {
  const state = await readTask(client, shown.id, attempt);
  if (fieldValue(state.task, field) !== fieldValue(shown, field))
    throw fieldConflict(shown, state.task, field, attempt);
  const expected: Versions = {};
  expected[field] = token(state.versions, field, `@${shown.id}`);
  try {
    await write(expected);
  } catch (err) {
    if (isConflict(err)) {
      const now = await client.taskState(shown.id).then(
        s => s.task,
        () => null,
      );
      throw fieldConflict(shown, now, field, attempt);
    }
    throw writeFailure(err, `run ${attempt}`);
  }
}

function setStatus(session: TuiSession, target: TaskStatus | "next", attempt: string): Promise<void> {
  const submitted = submittedTask(session, attempt);
  return session.mutate(async client => {
    const shown = submitted();
    const status = target === "next" ? nextStatusFor(shown.status) : target;
    if (status === shown.status) {
      session.notify("info", `@${shown.id} is already ${STATUS_LABEL[status]}`);
      return;
    }
    // No author: a human change, exactly as the web's status buttons (N9).
    await writeField(client, shown, "status", attempt, expected =>
      client.versioned.setStatus(shown.id, { status }, { expected, mutationId: newMutationId() }),
    );
    session.notify("info", `@${shown.id}: ${STATUS_LABEL[shown.status]} → ${STATUS_LABEL[status]}`);
  });
}

function parsePriority(argument: string): number | null {
  if (argument === "") throw new CommandError("Usage: :priority <n|none> (0 is the highest)");
  if (argument.toLowerCase() === "none") return null;
  const n = /^\d+$/.test(argument) ? Number(argument) : Number.NaN;
  if (!Number.isSafeInteger(n)) {
    throw new CommandError(`Priority "${argument}" is not a whole number from 0 (the highest) up, or none`);
  }
  return n;
}

/** `+a b -c #d` as tag deltas: a bare name adds; `#` is optional; names are validated first. */
function parseTagDelta(argument: string): { add: string[]; remove: string[] } {
  const add: string[] = [];
  const remove: string[] = [];
  for (const token of argument.split(/\s+/)) {
    const sign = token.startsWith("-") ? "-" : "+";
    const name = token.replace(/^[+-]/, "").replace(/^#/, "");
    if (!isValidTagName(name)) {
      throw new CommandError(`Invalid tag name "${name}": 1-32 characters from a-z, 0-9, _ @ -`);
    }
    const list = sign === "-" ? remove : add;
    if (!list.includes(name)) list.push(name);
  }
  const both = add.filter(n => remove.includes(n));
  if (both.length > 0) throw new CommandError(`${hashes(both)} cannot be both added and removed`);
  return { add, remove };
}

/** Every request goes through `client` (the one session.mutate handed the write): a part refused is reported with what was done. */
async function changeTags(
  session: TuiSession,
  client: CortexClient,
  shown: Task,
  add: readonly string[],
  remove: readonly string[],
): Promise<void> {
  const adds = add.filter(n => !shown.tags.includes(n));
  const removes = remove.filter(n => shown.tags.includes(n));
  const skipped = [
    ...add.filter(n => shown.tags.includes(n)).map(n => `already tagged #${n}`),
    ...remove.filter(n => !shown.tags.includes(n)).map(n => `not tagged #${n}`),
  ];
  if (adds.length === 0 && removes.length === 0) {
    session.notify("info", `@${shown.id}: ${skipped.join(", ")}; nothing to change`);
    return;
  }
  const done: string[] = [];
  // Two atomic deltas (the API takes one mode per request); each is
  // commutative with other writers, so it needs no expected tokens.
  if (adds.length > 0) {
    try {
      await client.versioned.changeTags(shown.id, { add: adds }, { mutationId: newMutationId() });
    } catch (err) {
      throw writeFailure(err, `tag @${shown.id} ${hashes(adds)}`);
    }
    done.push(`Tagged @${shown.id} ${hashes(adds)}`);
  }
  if (removes.length > 0) {
    try {
      await client.versioned.changeTags(shown.id, { remove: removes }, { mutationId: newMutationId() });
    } catch (err) {
      const failure = writeFailure(err, `untag ${hashes(removes)}`);
      throw done.length > 0 ? new CommandError(`${done.join("")}, but ${lowerFirst(failure.message)}`) : failure;
    }
    done.push(done.length > 0 ? `untagged ${hashes(removes)}` : `Untagged @${shown.id} ${hashes(removes)}`);
  }
  session.notify("info", [...done, ...skipped].join(" · "));
}

/** The current task's tag picker (the web's TagPicker): Enter toggles one membership; `/` filters; a new valid name can be created. */
function openTagPicker(session: TuiSession, task: Task): void {
  const id = task.id;
  const database = session.databaseGeneration; // each toggle writes to the database it was opened for
  // Attached tags stay first for this opening (a stable order while toggling).
  const attachedAtOpen = new Set(task.tags);
  const live = (): Task | null => session.tasks.find(t => t.id === id) ?? null;
  showDialog(session, {
    kind: "list",
    title: `TAGS OF @${id}`,
    label: "task tags",
    pickLabel: "toggles",
    empty: "No tag matches: / with a new name offers to create it",
    rows: () => {
      const current = live();
      const names = session.tags.map(t => t.name).sort((a, b) => a.localeCompare(b));
      const ordered = [...names.filter(n => attachedAtOpen.has(n)), ...names.filter(n => !attachedAtOpen.has(n))];
      const count = new Map(session.tags.map(t => [t.name, t.task_count]));
      return ordered.map(name => ({
        key: name,
        toggle: true,
        label: `#${name}`,
        mark: current?.tags.includes(name) ? "[x]" : "[ ]",
        detail: plural(count.get(name) ?? 0, "task"),
      }));
    },
    extra: filter => {
      const name = filter.trim().replace(/^#/, "");
      return name !== "" && isValidTagName(name) && !session.tags.some(t => t.name === name)
        ? [{ key: `+create:${name}`, label: `+ Create #${name}`, detail: "and tag this task" }]
        : [];
    },
    pick: (row, dialog) =>
      session.mutate(async client => {
        const current = live();
        if (current === null) {
          dialog.close();
          throw new CommandError(`@${id} no longer exists`);
        }
        const create = row.key.startsWith("+create:");
        const name = create ? row.key.slice("+create:".length) : row.key;
        const remove = !create && current.tags.includes(name);
        try {
          await client.versioned.changeTags(id, remove ? { remove: [name] } : { add: [name] }, {
            mutationId: newMutationId(),
          });
        } catch (err) {
          throw writeFailure(err, `${remove ? "untag" : "tag"} @${id} #${name}`);
        }
        if (create) {
          attachedAtOpen.add(name);
          dialog.search("");
        }
        session.notify("info", `${remove ? "Untagged" : "Tagged"} @${id} #${name}`);
      }, database),
  });
}

async function confirmDelete(session: TuiSession): Promise<void> {
  const shown = currentTask(session);
  // Submitted now: a replacement while the state is read (or the dialog is open) deletes nothing.
  const database = session.databaseGeneration;
  const state = await readTask(session.client, shown.id, ":delete");
  session.requireDatabase(database);
  const updates = state.updates.length;
  // N16: a dirty draft is offered for export (:w <path> works inside this dialog) or discarded by y.
  const unsaved = session.unsavedDrafts().filter(d => !d.orphaned && d.taskId === shown.id);
  const draftLines =
    unsaved.length === 0
      ? []
      : [
          `It has unsaved changes (${unsaved.map(d => d.field).join(" and ")}): :w <path> exports them to a file first; y discards them.`,
        ];
  showDialog(session, {
    kind: "confirm",
    title: "DELETE TASK",
    label: "delete",
    message: [
      `Delete @${shown.id} ${state.task.title}?`,
      updates > 0 ? `Its ${plural(updates, "update")} go with it. This cannot be undone.` : "This cannot be undone.",
      ...draftLines,
    ],
    yes: unsaved.length === 0 ? "deletes it" : "discards the draft and deletes it",
    no: "keeps it",
    confirm: () =>
      session.mutate(async client => {
        session.expectRemoval(shown.id);
        try {
          // The entity token read for this confirmation: any change since then, a newly
          // posted update (which the delete would cascade) included, is a 412.
          await client.versioned.removeTask(shown.id, {
            expected: { entity: token(state.versions, "entity", `@${shown.id}`) },
            mutationId: newMutationId(),
          });
        } catch (err) {
          session.expectRemoval(shown.id, false);
          if (isConflict(err)) {
            throw new CommandError(
              `Conflict: @${shown.id} changed after you confirmed; nothing was deleted (:delete again shows it as it is now)`,
            );
          }
          throw writeFailure(err, `delete @${shown.id}`);
        }
        session.notify("info", `Deleted @${shown.id} ${state.task.title}`);
      }, database),
  });
}

// ---------- catalogs (P4) ----------

const LANE_KEY = "lane:";
const TAG_KEY = "tag:";
const NEW_KEY = "+new";

function parseColor(text: string): string | null {
  const value = text.trim().toLowerCase();
  if (value === "" || value === "none") return null;
  if (!/^#[0-9a-f]{6}$/.test(value)) {
    throw new CommandError(`Color "${text.trim()}" is not #rrggbb (for example #2563eb); leave it empty for none`);
  }
  return value;
}

function parseSort(text: string): number {
  const value = text.trim();
  const n = /^-?\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(n)) throw new CommandError(`Sort "${value}" is not a whole number (lower sorts first)`);
  return n;
}

function laneConflict(name: string): CommandError {
  return new CommandError(
    `Conflict: lane ${name} changed while you edited it. Your input is kept: Enter saves it over theirs, :q! discards yours`,
  );
}

/** `database`: the generation the form was opened for (its submits write only there). */
function openLaneForm(
  session: TuiSession,
  state: LaneStateSnapshot | null,
  database = session.databaseGeneration,
): void {
  let base = state;
  const lane = state?.lane ?? null;
  const defaultSort = session.lanes.reduce((max, l) => Math.max(max, l.sort + 1), 0);
  showDialog(session, {
    kind: "form",
    title: lane === null ? "NEW LANE" : `EDIT LANE ${lane.name}`,
    label: lane === null ? "new lane" : "lane",
    guarded: true,
    submitLabel: lane === null ? "creates" : "saves",
    fields: [
      {
        name: "name",
        label: "Name",
        value: lane?.name ?? "",
        ...(lane?.name === "now" ? { locked: "the now lane cannot be renamed" } : {}),
      },
      { name: "color", label: "Color", value: lane?.color ?? "", hint: "#rrggbb, empty for none" },
      { name: "sort", label: "Sort", value: String(lane?.sort ?? defaultSort), hint: "lower sorts first" },
    ],
    submit: async (values, form) => {
      const name = (values.name ?? "").trim();
      const color = parseColor(values.color ?? "");
      const sort = parseSort(values.sort ?? "");
      if (base === null) {
        if (name === "") throw new CommandError("A new lane needs a name");
        if (session.lanes.some(l => l.name === name)) throw new CommandError(`Lane ${name} already exists`);
        const request: CreateLaneRequest = { name, sort };
        if (color !== null) request.color = color;
        await session.mutate(async client => {
          try {
            await client.versioned.addLane(request, { mutationId: newMutationId() });
          } catch (err) {
            throw writeFailure(err, `create lane ${name}`);
          }
        }, database);
        session.notify("info", `Created lane ${name}`);
        return true;
      }
      const current = base;
      const was = current.lane.name;
      const fields: EditLaneRequest = {};
      if (was !== "now" && name !== was) {
        if (name === "") throw new CommandError("A lane needs a name");
        fields.rename = name;
      }
      if (color !== current.lane.color) fields.color = color;
      if (sort !== current.lane.sort) fields.sort = sort;
      if (Object.keys(fields).length === 0) {
        session.notify("info", `Lane ${was}: nothing changed`);
        return true;
      }
      const expected: Versions = { definition: token(current.versions, "definition", `lane ${was}`) };
      if (fields.rename !== undefined) expected.entity = token(current.versions, "entity", `lane ${was}`);
      await session.mutate(async client => {
        try {
          await client.versioned.editLane(was, fields, { expected, mutationId: newMutationId() });
        } catch (err) {
          if (isConflict(err)) {
            const fresh = await client.laneState(was).catch(() => null);
            if (fresh !== null) {
              base = fresh;
              form.rebase({ name: fresh.lane.name, color: fresh.lane.color ?? "", sort: String(fresh.lane.sort) });
            }
            throw laneConflict(was);
          }
          throw writeFailure(err, `save lane ${was}`);
        }
      }, database);
      // The web's LaneEditModal: a lane filter follows the rename.
      if (fields.rename !== undefined && session.filter.lane === was) {
        session.setFilter({ ...session.filter, lane: fields.rename });
      }
      session.notify(
        "info",
        fields.rename === undefined ? `Saved lane ${was}` : `Renamed lane ${was} to ${fields.rename}`,
      );
      return true;
    },
  });
}

async function editLane(session: TuiSession, name: string): Promise<void> {
  const database = session.databaseGeneration;
  const state = await readLane(session.client, name);
  session.requireDatabase(database);
  openLaneForm(session, state, database);
}

async function deleteLane(session: TuiSession, name: string): Promise<void> {
  if (name === "now") throw new CommandError("The now lane cannot be deleted");
  const inLane = (n: number) =>
    new CommandError(`${name} has ${plural(n, "task")}: move them to another lane first (:lane <name>)`);
  const shown = session.tasks.filter(t => t.lane === name).length;
  if (shown > 0) throw inLane(shown);
  const database = session.databaseGeneration;
  const state = await readLane(session.client, name);
  session.requireDatabase(database);
  if (state.lane.task_count > 0) throw inLane(state.lane.task_count);
  showDialog(session, {
    kind: "confirm",
    title: "DELETE LANE",
    label: "delete lane",
    message: [`Delete lane ${name}?`, "It has no tasks."],
    yes: "deletes it",
    no: "keeps it",
    confirm: () =>
      session.mutate(async client => {
        try {
          await client.versioned.removeLane(name, {
            expected: { entity: token(state.versions, "entity", `lane ${name}`) },
            mutationId: newMutationId(),
          });
        } catch (err) {
          if (isConflict(err)) {
            throw new CommandError(`Conflict: lane ${name} changed after you confirmed; nothing was deleted`);
          }
          throw writeFailure(err, `delete lane ${name}`);
        }
        session.notify("info", `Deleted lane ${name}`);
      }, database),
  });
}

function openLanes(session: TuiSession): void {
  const laneOf = (row: DialogRow | null): string | null =>
    row?.key.startsWith(LANE_KEY) ? row.key.slice(LANE_KEY.length) : null;
  showDialog(session, {
    kind: "list",
    title: "LANES",
    label: "lanes",
    pickLabel: "edit",
    rows: () => {
      const counts = new Map<string, number>();
      for (const t of session.tasks) counts.set(t.lane, (counts.get(t.lane) ?? 0) + 1);
      return [
        ...session.lanes.map(l => ({
          key: `${LANE_KEY}${l.name}`,
          label: l.name,
          detail: [
            plural(counts.get(l.name) ?? 0, "task"),
            `sort ${l.sort}`,
            l.color ?? "no color",
            ...(l.name === "now" ? ["protected"] : []),
          ].join(" · "),
        })),
        { key: NEW_KEY, label: "+ New lane…", pinned: true },
      ];
    },
    keys: [
      { key: "a", label: "add", run: () => openLaneForm(session, null) },
      {
        key: "d",
        label: "delete",
        row: true,
        run: row => {
          const name = laneOf(row);
          if (name === null) throw new CommandError("Highlight a lane to delete it");
          return deleteLane(session, name);
        },
      },
    ],
    pick: row => {
      const name = laneOf(row);
      return name === null ? openLaneForm(session, null) : editLane(session, name);
    },
  });
}

/** `database`: the generation the form was opened for (its submits write only there). */
function openTagForm(session: TuiSession, state: TagStateSnapshot | null, database = session.databaseGeneration): void {
  let base = state;
  const tag = state?.tag ?? null;
  const invalid = () => new CommandError("Tag names are 1-32 characters from a-z, 0-9, _ @ -");
  showDialog(session, {
    kind: "form",
    title: tag === null ? "NEW TAG" : `EDIT TAG #${tag.name}`,
    label: tag === null ? "new tag" : "tag",
    guarded: true,
    submitLabel: tag === null ? "creates" : "saves",
    fields: [
      { name: "name", label: "Name", value: tag?.name ?? "", hint: "a-z 0-9 _ @ -" },
      { name: "color", label: "Color", value: tag?.color ?? "", hint: "#rrggbb, empty for none" },
    ],
    submit: async (values, form) => {
      const name = (values.name ?? "").trim().replace(/^#/, "");
      const color = parseColor(values.color ?? "");
      if (!isValidTagName(name)) throw invalid();
      if (base === null) {
        if (session.tags.some(t => t.name === name)) throw new CommandError(`#${name} already exists`);
        const request: CreateTagRequest = { name };
        if (color !== null) request.color = color;
        await session.mutate(async client => {
          try {
            await client.versioned.addTag(request, { mutationId: newMutationId() });
          } catch (err) {
            throw writeFailure(err, `create #${name}`);
          }
        }, database);
        session.notify("info", `Created #${name}`);
        return true;
      }
      const current = base;
      const was = current.tag.name;
      const fields: EditTagRequest = {};
      if (name !== was) fields.rename = name;
      if (color !== current.tag.color) fields.color = color;
      if (Object.keys(fields).length === 0) {
        session.notify("info", `#${was}: nothing changed`);
        return true;
      }
      const expected: Versions = { definition: token(current.versions, "definition", `#${was}`) };
      if (fields.rename !== undefined) expected.entity = token(current.versions, "entity", `#${was}`);
      await session.mutate(async client => {
        try {
          await client.versioned.editTag(was, fields, { expected, mutationId: newMutationId() });
        } catch (err) {
          if (isConflict(err)) {
            const fresh = await client.tagState(was).catch(() => null);
            if (fresh !== null) {
              base = fresh;
              form.rebase({ name: fresh.tag.name, color: fresh.tag.color ?? "" });
            }
            throw new CommandError(
              `Conflict: #${was} changed while you edited it. Your input is kept: Enter saves it over theirs, :q! discards yours`,
            );
          }
          throw writeFailure(err, `save #${was}`);
        }
      }, database);
      // The web's TagEditModal: a tag filter follows the rename.
      const rename = fields.rename;
      if (rename !== undefined && session.filter.tags.includes(was)) {
        session.setFilter({ ...session.filter, tags: session.filter.tags.map(n => (n === was ? rename : n)) });
      }
      session.notify("info", rename === undefined ? `Saved #${was}` : `Renamed #${was} to #${rename}`);
      return true;
    },
  });
}

async function editTag(session: TuiSession, name: string): Promise<void> {
  const database = session.databaseGeneration;
  const state = await readTag(session.client, name);
  session.requireDatabase(database);
  openTagForm(session, state, database);
}

async function deleteTag(session: TuiSession, name: string): Promise<void> {
  // The impact count and the guard's entity token come from the SAME read.
  const database = session.databaseGeneration;
  const state = await readTag(session.client, name);
  session.requireDatabase(database);
  const count = state.tag.task_count;
  showDialog(session, {
    kind: "confirm",
    title: "DELETE TAG",
    label: "delete tag",
    message: [
      `Delete the tag #${name}?`,
      count > 0 ? `It is removed from ${plural(count, "task")} (the tasks stay).` : "No task carries it.",
    ],
    yes: "deletes it",
    no: "keeps it",
    confirm: () =>
      session.mutate(async client => {
        try {
          await client.versioned.removeTag(
            name,
            { force: count > 0 },
            { expected: { entity: token(state.versions, "entity", `#${name}`) }, mutationId: newMutationId() },
          );
        } catch (err) {
          if (isConflict(err)) {
            throw new CommandError(
              `Conflict: #${name} changed after you confirmed (its tasks changed); nothing was deleted: d again shows the new count`,
            );
          }
          throw writeFailure(err, `delete #${name}`);
        }
        session.notify("info", `Deleted #${name}`);
      }, database),
  });
}

function openTags(session: TuiSession): void {
  const tagOf = (row: DialogRow | null): string | null =>
    row?.key.startsWith(TAG_KEY) ? row.key.slice(TAG_KEY.length) : null;
  showDialog(session, {
    kind: "list",
    title: "TAGS",
    label: "tags",
    pickLabel: "edit",
    rows: () => [
      ...[...session.tags]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(t => ({
          key: `${TAG_KEY}${t.name}`,
          label: `#${t.name}`,
          detail: [plural(t.task_count, "task"), t.color ?? "no color"].join(" · "),
        })),
      { key: NEW_KEY, label: "+ New tag…", pinned: true },
    ],
    keys: [
      { key: "a", label: "add", run: () => openTagForm(session, null) },
      {
        key: "d",
        label: "delete",
        row: true,
        run: row => {
          const name = tagOf(row);
          if (name === null) throw new CommandError("Highlight a tag to delete it");
          return deleteTag(session, name);
        },
      },
    ],
    pick: row => {
      const name = tagOf(row);
      return name === null ? openTagForm(session, null) : editTag(session, name);
    },
  });
}

// ---------- themes (P9) ----------

const THEME_SOURCE: Readonly<Record<ThemeSource, (theme: ResolvedTheme) => string>> = {
  session: () => "your :theme choice (saved)",
  cli: () => "--theme (this session only)",
  saved: () => "your saved :theme choice",
  config: () => "tui.toml theme pins it (:theme <name> overrides it; auto keeps it)",
  appearance: t => `tui.toml theme_${t.appearance} for a ${t.appearance} terminal`,
  default: t => `auto (a ${t.appearance} terminal)`,
  colors: () => "auto (a 16-color terminal)",
};

/** Which precedence level chose the active theme, for the status line (N22). */
export function themeSourceText(theme: ResolvedTheme): string {
  return `Theme ${theme.name} · ${THEME_SOURCE[theme.source](theme)}`;
}

function themeNames(session: TuiSession): string[] {
  return session.themeControl?.choices().map(c => c.name) ?? [...BUNDLED_THEME_NAMES];
}

function requireThemes(session: TuiSession): ThemeControl {
  const control = session.themeControl;
  if (control === null) throw new CommandError("Themes need the terminal workspace");
  return control;
}

function openThemePicker(session: TuiSession, control: ThemeControl): void {
  const current = session.theme;
  const inUse = current?.explicit ? current.name : "auto";
  const choices = control.choices();
  const rows: DialogRow[] = [
    {
      key: "auto",
      label: "auto",
      detail: `follow the terminal (light or dark)${inUse === "auto" ? " · in use" : ""}`,
    },
    ...choices.map(c => ({ key: c.name, label: c.name, detail: `${c.source}${inUse === c.name ? " · in use" : ""}` })),
  ];
  showDialog(session, {
    kind: "list",
    title: current === null ? "THEME" : `THEME · ${current.name}: ${THEME_SOURCE[current.source](current)}`,
    label: "theme",
    pickLabel: "applies",
    initial: inUse,
    rows: () => rows,
    highlight: row => {
      if (row !== null) control.preview(row.key === "auto" ? null : row.key);
    },
    dismiss: () => control.restore(),
    pick: (row, dialog: Dialog) => {
      const theme = control.apply(row.key === "auto" ? null : row.key);
      dialog.finish();
      session.notify("info", themeSourceText(theme));
    },
  });
}

// ---------- :density ----------

const DENSITY_HELP: Readonly<Record<Density, string>> = {
  comfortable: "blank rows under the headers and above the status line (the default)",
  compact: "no spacer rows: more rows for tasks and text",
};

// ---------- the reader: :heading, :links, :copy, :source ----------

function requireReader(session: TuiSession): Reader {
  const reader = session.reader;
  if (reader === null) throw new CommandError("The document reader needs the terminal workspace");
  return reader;
}

// ---------- maintenance: :backup and pending migrations (P10, Task 11) ----------

/** Sessions with a :backup in flight (one at a time: a backup is never sent twice by accident). */
const backingUp = new WeakSet<TuiSession>();

/** :backup: ONE data-only backup through the daemon (the dashboard's button); never retried. */
async function runBackup(session: TuiSession): Promise<void> {
  if (backingUp.has(session)) throw new CommandError("A backup is already being written: wait for its result");
  backingUp.add(session);
  session.notify("info", "Writing a backup…");
  let result: BackupResult;
  try {
    result = await session.client.backup({});
  } catch (err) {
    if (err instanceof TransportError) {
      throw new CommandError(
        `The backup's outcome is unknown (${err.message}): it may have been written; check the backups before running :backup again`,
      );
    }
    throw new CommandError(`Backup failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    backingUp.delete(session);
  }
  const { stats } = result;
  session.notify(
    "info",
    `Backup written to ${result.outPath} (${result.bytes} bytes: ${stats.tasks} tasks, ${stats.updates} updates, ${stats.lanes} lanes, ${stats.tags} tags); cortex restore restores it`,
  );
}

/**
 * The dashboard's startup migration check, for the terminal: pending database
 * migrations become a persistent warning in :messages (a failed check is a
 * warning too; nothing else changes).
 */
export async function reportPendingMigrations(session: TuiSession): Promise<void> {
  let pending: readonly string[];
  try {
    pending = (await session.client.migrations()).pending;
  } catch (err) {
    session.notify(
      "warn",
      `Could not check for pending database migrations: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  if (pending.length === 0) return;
  session.addProblems([
    { level: "warn", text: `Database migrations pending (${pending.join(", ")}): run cortex init to apply them` },
  ]);
}

// ---------- the task panels and the composer (Task 11, src/tui/activity.ts) ----------

function requireActivity(session: TuiSession): Activity {
  const activity = session.activity;
  if (activity === null) throw new CommandError("The task panels need the terminal workspace");
  return activity;
}

/** :activity / :related / :authors: show the panel with the document focused; a failed read is retried. */
function showPanel(session: TuiSession, panel: Exclude<TaskPanel, "document">): void {
  currentTask(session);
  const activity = requireActivity(session);
  session.closeView();
  session.setPanel(panel);
  session.setFocus("document");
  activity.retry(panel);
}

/** `:heading` without a slug: the outline (indented by level, the section in view marked); Enter jumps. */
function openOutline(session: TuiSession, reader: Reader, task: Task): void {
  const headings = reader.headings();
  if (headings.length === 0) {
    session.notify("info", `@${task.id} has no headings`);
    return;
  }
  const current = reader.section()?.heading?.id ?? headings[0]?.id;
  showDialog(session, {
    kind: "list",
    title: `OUTLINE OF @${task.id}`,
    label: "outline",
    pickLabel: "jumps there",
    initial: current,
    rows: () =>
      headings.map(h => ({
        key: h.id,
        label: `${"  ".repeat(Math.max(0, h.level - 1))}${h.text}`,
        detail: `#${h.slug}`,
        mark: h.id === current ? "\u25b8" : " ",
        search: `${h.text} ${h.slug}`,
      })),
    pick: (row, dialog: Dialog) => {
      dialog.finish();
      reader.goToHeading(row.key);
    },
  });
}

/** What a link or reference names, for :links. */
function linkRow(session: TuiSession, link: ReaderLink, key: string): DialogRow {
  const target = link.target;
  switch (target.kind) {
    case "task": {
      const task = session.tasks.find(t => t.id === target.id);
      return { key, label: `@${target.id}`, detail: task === undefined ? "no such task" : task.title };
    }
    case "tag":
      return { key, label: `#${target.name}`, detail: "shows only these tasks (the tag filter)" };
    case "heading": {
      const heading = target.id === null ? undefined : session.reader?.headings().find(h => h.id === target.id);
      return {
        key,
        label: link.label || `#${target.fragment}`,
        detail: heading === undefined ? `#${target.fragment}: no such heading` : `\u00a7 ${heading.text}`,
      };
    }
    case "url":
      return { key, label: link.label || target.url, detail: `${target.url} (Enter copies it)` };
    case "inert":
      return {
        key,
        label: link.label || target.destination,
        detail: `${target.destination || "no destination"}: not a web link`,
      };
  }
}

/** `:links`: the document's links and prose references in order; Enter follows one. */
function openLinks(session: TuiSession, reader: Reader, task: Task): void {
  const links = reader.links();
  if (links.length === 0) {
    session.notify("info", `No links or references in @${task.id}`);
    return;
  }
  showDialog(session, {
    kind: "list",
    title: `LINKS IN @${task.id}`,
    label: "links",
    pickLabel: "follows (a web link is copied)",
    rows: () => links.map((link, i) => linkRow(session, link, String(i))),
    pick: (row, dialog: Dialog) => {
      const link = links[Number(row.key)];
      dialog.finish();
      if (link !== undefined) reader.follow(link.target);
    },
  });
}

/** A code block's first line, for completion hints. */
function codeSummary(block: ReaderCodeBlock): string {
  const first = block.text.split("\n").find(l => l.trim() !== "") ?? "";
  const label = block.mermaid ? "mermaid" : (block.language ?? "code");
  return `${label}: ${first.length > 60 ? `${first.slice(0, 59)}\u2026` : first}`;
}

// ---------- the registry ----------

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: "open",
    aliases: [],
    usage: ":open <id|query>",
    description: "Jump to a task by id (also :<id>) or to the best search match; the list filters stay",
    complete: (prefix, session) => taskIdCandidates(prefix, session),
    run: (session, argument) => {
      if (argument === "") throw new CommandError("Usage: :open <id|query> (or :<id>)");
      if (!session.loaded) throw new CommandError("The workspace is still loading");
      const ref = TASK_REF.exec(argument);
      if (ref) {
        const id = Number(ref[1]);
        if (!session.tasks.some(t => t.id === id)) throw new CommandError(`No task @${id}`);
        session.jump(id);
        return;
      }
      const results = searchTasks(session.tasks, argument);
      const best = results[0];
      if (best === undefined) throw new CommandError(`No task matches "${argument}"`);
      session.jump(best.task.id);
      if (results.length > 1) {
        session.notify(
          "info",
          `@${best.task.id} is the best of ${results.length} matches (Tab after :open lists them)`,
        );
      }
    },
  },
  {
    name: "filter",
    aliases: [],
    usage: ":filter [status|lane|tags] <value>",
    description:
      "Narrow the task list: :filter status review, :filter lane later, :filter tags bug untagged (+tag adds, -tag removes); a bare slot clears it",
    complete: completeFilter,
    run: runFilter,
  },
  {
    name: "clear",
    aliases: [],
    usage: ":clear",
    description: "Clear the search and every filter (include-done is kept)",
    run: (session, argument) => {
      noArgument("clear", argument);
      session.clearFilters();
    },
  },
  {
    name: "sort",
    aliases: [],
    usage: ":sort [order]",
    description:
      "Order the task list: id (the default), -id, title, -title, lane, status, priority, updated or -updated (- reverses; ties by id; a search ranks by relevance); bare opens the sort and group picker",
    complete: prefix => TASK_SORTS.filter(v => v.startsWith(prefix)),
    describe: argument => (isSort(argument) ? SORT_HELP[argument] : undefined),
    run: runSort,
  },
  {
    name: "group",
    aliases: [],
    usage: ":group [none|lane|status]",
    description:
      "Group the task list under a header per lane or status, each with its count (j/k skip the headers); bare opens the sort and group picker",
    complete: prefix => TASK_GROUPS.filter(v => v.startsWith(prefix)),
    describe: argument => (isGroup(argument) ? GROUP_HELP[argument] : undefined),
    run: runGroup,
  },
  {
    name: "set",
    aliases: [],
    usage: ":set <option>",
    description:
      "Options: done (show done tasks), tasks (show the task list), number (source line numbers in Read and the Split preview); name, noname, name! toggles, name? shows",
    complete: (prefix, _session) => lastWord(prefix, OPTION_WORDS),
    run: runSet,
  },
  {
    name: "new",
    aliases: [],
    usage: ":new [title]",
    description:
      "Create a task in the filtered lane (else now) and select it; without a title it is named untitled-<id> (:title renames it)",
    run: (session, argument) => {
      if (!session.loaded) throw new CommandError("The workspace is still loading");
      // Captured when submitted: a filter change while an earlier write finishes never moves it.
      const lane = session.filter.lane ?? "now";
      return session.mutate(async client => {
        // ONE atomic create: an untitled task gets its untitled-<id> name in the same transaction.
        const request: CreateTaskRequest = argument === "" ? { untitled: true, lane } : { title: argument, lane };
        let created: Task;
        try {
          created = (await client.versioned.addTask(request, { mutationId: newMutationId() })).task;
        } catch (err) {
          throw writeFailure(err, `create a task in ${lane}`);
        }
        const shown = await session.revealTask(created.id);
        const hint = argument === "" ? " (:title <text> names it)" : "";
        const later = shown ? "" : "; it shows once the live update arrives";
        session.notify("info", `Created @${created.id} ${created.title}${hint}${later}`);
      });
    },
  },
  {
    name: "title",
    aliases: [],
    usage: ":title [text]",
    description: "Rename the current task; without text, edit its full title in place (Enter or Esc saves)",
    run: async (session, argument) => {
      const shown = currentTask(session);
      if (argument === "") {
        session.editTitle();
        return;
      }
      // The same draft controller as in-place editing: ONE write guarded by the title token.
      const document = await session.openDocument(shown.id);
      const draft = document?.draft ?? null;
      if (draft === null) throw new CommandError(`Could not rename @${shown.id}: its document did not load`);
      if (draft.text("title") === argument && draft.state("title") === "saved") {
        session.notify("info", `@${shown.id} already has that title`);
        return;
      }
      draft.set("title", argument);
      await draft.flush();
      const state = draft.state("title");
      if (state === "saved") session.notify("info", `Renamed @${shown.id}`);
      else if (state === "conflict") {
        throw new CommandError(
          `Conflict: @${shown.id}'s title changed (now ${JSON.stringify(draft.incoming("title"))}) before :title applied. Yours is kept: :keep title saves it over theirs, :apply title takes theirs`,
        );
      } else throw new CommandError(`Could not rename @${shown.id}: ${draft.error("title") ?? "not saved yet"}`);
    },
  },
  {
    name: "status",
    aliases: [],
    usage: ":status <draft|open|review|blocked|done>",
    description: "Set the current task's status (a human change, never attributed to an agent)",
    complete: prefix => STATUS.filter(s => s.startsWith(prefix)),
    run: (session, argument) => {
      if (argument === "") throw new CommandError("Usage: :status <draft|open|review|blocked|done>");
      const status = STATUS.find(s => s === argument);
      if (status === undefined) {
        throw new CommandError(`Unknown status "${argument}": draft, open, review, blocked or done`);
      }
      return setStatus(session, status, `:status ${status}`);
    },
  },
  {
    name: "next",
    aliases: [],
    usage: ":next",
    description:
      "Move the current task one step on, like the web's next-step button: draft→open, open→review, review→done, blocked→open, done→open",
    run: (session, argument) => {
      noArgument("next", argument);
      return setStatus(session, "next", ":next");
    },
  },
  {
    name: "priority",
    aliases: [],
    usage: ":priority <n|none>",
    description: "Set the current task's priority: any whole number from 0 (the highest) up, or none",
    complete: prefix => ["none", "0", "1", "2", "3"].filter(c => c.startsWith(prefix)),
    run: (session, argument) => {
      const priority = parsePriority(argument);
      const submitted = submittedTask(session, `:priority ${argument}`);
      return session.mutate(async client => {
        const shown = submitted();
        const label = priority === null ? "none" : `P${priority}`;
        if (shown.priority === priority) {
          session.notify("info", `@${shown.id}'s priority is already ${label}`);
          return;
        }
        await writeField(client, shown, "priority", `:priority ${argument}`, expected =>
          client.versioned.editTask(shown.id, { priority }, { expected, mutationId: newMutationId() }),
        );
        session.notify("info", `@${shown.id}: priority ${label}`);
      });
    },
  },
  {
    name: "lane",
    aliases: [],
    usage: ":lane <name>",
    description: "Move the current task to another lane (:lanes manages the lanes)",
    complete: (prefix, session) => session.lanes.map(l => l.name).filter(n => n.startsWith(prefix)),
    run: (session, argument) => {
      const names = session.lanes.map(l => l.name).join(", ") || "none";
      if (argument === "") throw new CommandError(`Usage: :lane <name> (lanes: ${names})`);
      if (!session.lanes.some(l => l.name === argument)) {
        throw new CommandError(`No lane "${argument}" (lanes: ${names}); :lanes creates lanes`);
      }
      const submitted = submittedTask(session, `:lane ${argument}`);
      return session.mutate(async client => {
        const shown = submitted();
        if (shown.lane === argument) {
          session.notify("info", `@${shown.id} is already in ${argument}`);
          return;
        }
        await writeField(client, shown, "lane", `:lane ${argument}`, expected =>
          client.versioned.moveTask(shown.id, argument, { expected, mutationId: newMutationId() }),
        );
        session.notify("info", `Moved @${shown.id} to ${argument}`);
      });
    },
  },
  {
    name: "tag",
    aliases: [],
    usage: ":tag [+name -name]",
    description:
      "Add (+name, or a bare name) and remove (-name) the current task's tags; without names, pick them in a list",
    complete: (prefix, session) =>
      lastWord(
        prefix,
        session.tags.map(t => t.name),
        true,
      ),
    run: (session, argument) => {
      if (argument === "") {
        openTagPicker(session, currentTask(session));
        return;
      }
      const { add, remove } = parseTagDelta(argument);
      const submitted = submittedTask(session, `:tag ${argument}`);
      return session.mutate(client => changeTags(session, client, submitted(), add, remove));
    },
  },
  {
    name: "delete",
    aliases: [],
    usage: ":delete",
    description: "Delete the current task after a y/n confirmation (its updates go with it)",
    run: (session, argument) => {
      noArgument("delete", argument);
      return confirmDelete(session);
    },
  },
  {
    name: "lanes",
    aliases: [],
    usage: ":lanes",
    description:
      "Manage the lanes: create, rename, recolor, re-sort, and delete empty ones (the now lane is protected)",
    run: (session, argument) => {
      noArgument("lanes", argument);
      openLanes(session);
    },
  },
  {
    name: "tags",
    aliases: [],
    usage: ":tags",
    description:
      "Manage the tag definitions: create, rename, recolor, and delete (showing how many tasks lose the tag)",
    run: (session, argument) => {
      noArgument("tags", argument);
      openTags(session);
    },
  },
  {
    name: "focus",
    aliases: [],
    usage: ":focus <list|document>",
    description: "Move the keyboard focus to the task list or the document",
    complete: prefix => ["document", "list"].filter(c => c.startsWith(prefix)),
    run: (session, argument) => {
      const target =
        argument === "list" || argument === "tasks" ? "tasks" : argument === "document" ? "document" : null;
      if (target === null) throw new CommandError("Usage: :focus <list|document>");
      session.closeView();
      session.setFocus(target);
    },
  },
  {
    name: "back",
    aliases: [],
    usage: ":back",
    description: "Go back to the task shown before the last jump (task history)",
    run: (session, argument) => {
      noArgument("back", argument);
      session.back();
    },
  },
  {
    name: "forward",
    aliases: [],
    usage: ":forward",
    description: "Go forward again in the task history",
    run: (session, argument) => {
      noArgument("forward", argument);
      session.forward();
    },
  },
  {
    name: "theme",
    aliases: [],
    usage: ":theme [name|auto]",
    description:
      "Pick a color theme with a live preview (Esc restores, Enter applies and saves it); auto follows the terminal again",
    complete: (prefix, session) => ["auto", ...themeNames(session)].filter(n => n.startsWith(prefix)),
    run: (session, argument) => {
      const control = requireThemes(session);
      if (argument === "") {
        openThemePicker(session, control);
        return;
      }
      if (argument !== "auto" && !control.choices().some(c => c.name === argument)) {
        const names = control
          .choices()
          .map(c => c.name)
          .join(", ");
        throw new CommandError(`No theme "${argument}" (themes: ${names}; auto follows the terminal)`);
      }
      session.notify("info", themeSourceText(control.apply(argument === "auto" ? null : argument)));
    },
  },
  {
    name: "density",
    aliases: [],
    usage: ":density [compact|comfortable]",
    description:
      "Set the spacing, saved for the profile (over tui.toml's density): comfortable (the default) adds blank rows under the headers and above the status line; compact fits more rows; bare toggles. A terminal cannot set its font size: use its zoom keys",
    complete: prefix => DENSITIES.filter(d => d.startsWith(prefix)),
    describe: argument => (isDensity(argument) ? DENSITY_HELP[argument] : undefined),
    run: (session, argument) => {
      const density = argument !== "" ? argument : session.density === "compact" ? "comfortable" : "compact";
      if (!isDensity(density))
        throw new CommandError("Usage: :density [compact|comfortable] (a bare :density toggles)");
      if (session.setDensity(density)) session.notify("info", `Density: ${density} (saved)`);
      else session.notify("warn", `Density: ${density} (this session only: it could not be saved, see :messages)`);
    },
  },
  {
    name: "help",
    aliases: ["h"],
    usage: ":help",
    description: "Modes, commands and the configured keys",
    run: (session, argument) => {
      noArgument("help", argument);
      session.openView("help");
    },
  },
  {
    name: "commands",
    aliases: [],
    usage: ":commands [search]",
    description: "Searchable command reference: / searches it, Enter picks a command",
    run: (session, argument) => session.openCommands(argument),
  },
  {
    name: "messages",
    aliases: ["mes"],
    usage: ":messages",
    description: "Configuration problems, errors and notices",
    run: (session, argument) => {
      noArgument("messages", argument);
      session.openView("messages");
    },
  },
  {
    name: "notifications",
    aliases: [],
    usage: ":notifications",
    description:
      "The notifications (read state shared with every client) and this session's errors, unread first: Enter opens the task and marks it read; r read, u unread, a all read, x dismiss, X clear all",
    run: (session, argument) => {
      noArgument("notifications", argument);
      const feed = session.notificationFeed;
      if (feed === null) throw new CommandError("Notifications are not available in this session");
      feed.show();
    },
  },
  {
    name: "suspend",
    aliases: [],
    usage: ":suspend",
    description: "Suspend to the shell; fg resumes (the daemon keeps running)",
    run: (session, argument) => {
      noArgument("suspend", argument);
      session.requestSuspend();
    },
  },
  {
    name: "read",
    aliases: ["r"],
    usage: ":read",
    description: "Read mode: the rendered document (saved as your preferred mode)",
    run: (session, argument) => {
      noArgument("read", argument);
      session.setDocumentMode("read");
      session.notify("info", "Read mode (your preferred mode now)");
    },
  },
  {
    name: "edit",
    aliases: ["e"],
    usage: ":edit",
    description: "Edit mode: the document editor, i types in it (saved as your preferred mode)",
    run: (session, argument) => {
      noArgument("edit", argument);
      session.setDocumentMode("edit");
      session.notify("info", "Edit mode (your preferred mode now): i types in the editor");
    },
  },
  {
    name: "split",
    aliases: ["sp"],
    usage: ":split",
    description:
      "Split mode: the editor beside a preview; a narrow terminal shows one half at a time, Tab switches (saved as your preferred mode)",
    run: (session, argument) => {
      noArgument("split", argument);
      session.setDocumentMode("split");
      session.notify("info", "Split mode (your preferred mode now): Tab moves between the halves");
    },
  },
  {
    name: "heading",
    aliases: [],
    usage: ":heading [slug]",
    description:
      "Jump to a heading of this document by its web anchor slug (Tab completes; repeats are slug-2, slug-3); without one, pick it from the outline",
    complete: (prefix, session) => {
      const wanted = prefix.toLowerCase();
      return (session.reader?.headings() ?? []).map(h => h.slug).filter(slug => slug.startsWith(wanted));
    },
    describe: (argument, session) => {
      const wanted = argument.replace(/^#/, "").toLowerCase();
      return session.reader?.headings().find(h => h.slug === wanted || h.id === wanted)?.text;
    },
    run: (session, argument) => {
      const reader = requireReader(session);
      const shown = currentTask(session);
      if (argument === "") {
        openOutline(session, reader, shown);
        return;
      }
      if (!reader.goToHeading(argument)) {
        throw new CommandError(
          `No heading #${argument.replace(/^#/, "")} in @${shown.id} (Tab after :heading lists them)`,
        );
      }
    },
  },
  {
    name: "links",
    aliases: [],
    usage: ":links",
    description:
      "The links and @id/#tag references of this document: Enter follows one (@id jumps and clears the filters, #tag filters, a heading link jumps, a web link is copied)",
    run: (session, argument) => {
      noArgument("links", argument);
      openLinks(session, requireReader(session), currentTask(session));
    },
  },
  {
    name: "copy",
    aliases: [],
    usage: ":copy [n]",
    description:
      "Copy code block n (its caption shows the number; without one, the block in view) with OSC 52; terminals never confirm it",
    complete: (prefix, session) =>
      (session.reader?.codeBlocks() ?? []).map(b => String(b.index)).filter(n => n.startsWith(prefix)),
    describe: (argument, session) => {
      const block = session.reader?.codeBlocks().find(b => String(b.index) === argument);
      return block === undefined ? undefined : codeSummary(block);
    },
    run: (session, argument) => {
      const reader = requireReader(session);
      const shown = currentTask(session);
      const blocks = reader.codeBlocks();
      if (blocks.length === 0) throw new CommandError(`@${shown.id} has no code blocks`);
      let block: ReaderCodeBlock | null | undefined;
      if (argument === "") {
        block = reader.codeBlockInView();
        if (block === null) {
          throw new CommandError(`No code block in view: :copy <n> picks one of the ${blocks.length} in @${shown.id}`);
        }
      } else {
        block = /^\d+$/.test(argument) ? blocks.find(b => b.index === Number(argument)) : undefined;
        if (block === undefined) {
          throw new CommandError(
            `No code block ${argument} in @${shown.id}: it has ${blocks.length} (their captions show the numbers)`,
          );
        }
      }
      session.copyText(block.text, `code block ${block.index}`);
    },
  },
  {
    name: "source",
    aliases: [],
    usage: ":source",
    description:
      "Show the raw Markdown source in Read and the preview (escaped), or the rendered document again; in the Activity panel, the highlighted update's source",
    run: (session, argument) => {
      noArgument("source", argument);
      if (session.panel === "activity") {
        requireActivity(session).toggleSource();
        return;
      }
      const reader = requireReader(session);
      reader.toggleSource();
      session.notify(
        "info",
        reader.sourceView ? "Showing the raw source (:source renders it again)" : "Showing the rendered document",
      );
    },
  },
  {
    name: "preview",
    aliases: [],
    usage: ":preview",
    description:
      "Open this task's current text (unsaved edits included) in the browser, rendered in full: the dashboard's sanitizer and Mermaid diagrams. Starts this daemon's dashboard if needed; the private link (also in the message log) expires in 10 minutes and nothing is saved",
    run: async (session, argument) => {
      noArgument("preview", argument);
      await openRichPreview(session);
    },
  },
  {
    name: "activity",
    aliases: [],
    usage: ":activity",
    description:
      "The Activity panel: this task's updates, newest first; Enter expands one (its body; :source shows its Markdown); c posts an update. Retries a failed read",
    run: (session, argument) => {
      noArgument("activity", argument);
      showPanel(session, "activity");
    },
  },
  {
    name: "related",
    aliases: [],
    usage: ":related",
    description:
      "The Related panel: the tasks that reference this one, that it references and that share its tags; Enter opens one (the list filters clear). Retries a failed read",
    run: (session, argument) => {
      noArgument("related", argument);
      showPanel(session, "related");
    },
  },
  {
    name: "authors",
    aliases: [],
    usage: ":authors",
    description: "The Authors panel: who posted on this task, latest first, with their post counts",
    run: (session, argument) => {
      noArgument("authors", argument);
      showPanel(session, "authors");
    },
  },
  {
    name: "post",
    aliases: [],
    usage: ":post [text]",
    description:
      "Post an update to this task as yourself: without text, open its composer (also c: :w posts it, closing it keeps the draft); with text, post it now",
    run: async (session, argument) => {
      const shown = currentTask(session);
      const activity = requireActivity(session);
      if (argument === "") activity.openComposer(shown.id);
      else await activity.postText(shown.id, argument);
    },
  },
  {
    name: "backup",
    aliases: [],
    usage: ":backup",
    description:
      "Write a data-only backup now through the daemon (the dashboard's backup button) and report its path and counts; cortex restore restores one",
    run: async (session, argument) => {
      noArgument("backup", argument);
      await runBackup(session);
    },
  },
  {
    name: "resume",
    aliases: [],
    usage: ":resume",
    description:
      "Resume the pi session that posted on this task (cortex resume, which asks when there are several): it gets the terminal until it exits; the daemon keeps running",
    run: async (session, argument) => {
      noArgument("resume", argument);
      await resumeTask(session, currentTask(session).id);
    },
  },
  {
    name: "write",
    aliases: ["w"],
    usage: ":w [[@id] path]",
    dialog: true,
    description:
      "Save every unsaved title/body draft now (a failed save is retried); in a form, save the form; with a path, export to a new private file this task's body draft if it has unsaved changes, else the one kept draft (of a deleted task or a replaced database; with several, give its @id), else this task's body; with @id, @id's kept draft, else task @id's",
    run: async (session, argument) => {
      if (argument !== "") {
        session.notify("info", await session.exportDraft(argument, false));
        return;
      }
      const dialog = session.dialog;
      if (dialog?.write()) return;
      await session.writeDrafts();
    },
  },
  {
    name: "write!",
    aliases: ["w!"],
    usage: ":w! [@id] <path>",
    dialog: true,
    description: "Export like :w [@id] <path>, replacing the file if it exists",
    run: async (session, argument) => {
      if (argument === "") throw new CommandError("Usage: :w! [@id] <path> (it replaces the file)");
      session.notify("info", await session.exportDraft(argument, true));
    },
  },
  {
    name: "wq",
    aliases: ["x"],
    usage: ":wq",
    dialog: true,
    description: "Save every draft and quit once the saves are acknowledged; in a form, save it and close it",
    run: async (session, argument) => {
      noArgument("wq", argument);
      const dialog = session.dialog;
      if (dialog !== null) {
        if (!dialog.write()) dialog.quit(false);
        return;
      }
      await session.writeAndQuit();
    },
  },
  {
    name: "apply",
    aliases: [],
    usage: ":apply [title|body]",
    description: "Resolve a save conflict of the current task by taking the incoming version (theirs)",
    complete: prefix => ["title", "body"].filter(f => f.startsWith(prefix)),
    run: (session, argument) => session.resolveConflict("apply", argument),
  },
  {
    name: "keep",
    aliases: [],
    usage: ":keep [title|body]",
    description:
      "Resolve a save conflict of the current task by keeping your version: it is saved over the incoming one, guarded, so it can conflict again",
    complete: prefix => ["title", "body"].filter(f => f.startsWith(prefix)),
    run: (session, argument) => session.resolveConflict("keep", argument),
  },
  {
    name: "quit",
    aliases: ["q"],
    usage: ":q",
    dialog: true,
    description:
      "Quit this terminal workspace (the shared daemon keeps running); refused while a draft is unsaved; in a dialog, close it (a form with input refuses)",
    run: (session, argument) => {
      noArgument("q", argument);
      const dialog = session.dialog;
      if (dialog === null) session.quit(false);
      else dialog.quit(false);
    },
  },
  {
    name: "quit!",
    aliases: ["q!"],
    usage: ":q!",
    dialog: true,
    description: "Quit, discarding the local drafts and anything unsaved; in a dialog, close it and discard its input",
    run: (session, argument) => {
      noArgument("q!", argument);
      const dialog = session.dialog;
      if (dialog === null) session.quit(true);
      else dialog.quit(true);
    },
  },
];
