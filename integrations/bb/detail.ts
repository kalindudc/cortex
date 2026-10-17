// Pure helpers behind the task detail the Cortex tab shows. No I/O.

export const STATUSES = ["draft", "open", "review", "blocked", "done"] as const;
export type CortexStatus = (typeof STATUSES)[number];

export type CortexUpdateKind = { kind: "note" } | { kind: "created" } | { kind: "status"; to: CortexStatus };

const STATUS_ROW = /^status \u2192 (draft|open|review|blocked|done)$/;

/** A status audit row (`status → x`), cortex's `created` row, or a note. */
export function updateKind(summary: string): CortexUpdateKind {
  const status = STATUS_ROW.exec(summary);
  if (status) return { kind: "status", to: status[1] as CortexStatus };
  return summary === "created" ? { kind: "created" } : { kind: "note" };
}

// Plan progress, by the same rule as the Herdr label (shell repo,
// home/.pi/agent/extensions/herdr-label/labels.ts): numbered lines in the
// plan's `## Low-Level Tasks` section outside code fences, against distinct
// `task N:` updates. Copied, not imported: the plugin depends on no other repo.
const TASK_LINE = /^\d+\.\s/;
const TASK_DONE = /^task (\d+):/;

function countTasks(body: string): number {
  let inSection = false;
  let inFence = false;
  let count = 0;
  for (const line of body.split("\n")) {
    if (line.startsWith("```")) inFence = !inFence;
    if (inFence) continue;
    if (line.startsWith("## ")) {
      if (inSection) break;
      inSection = line.trimEnd() === "## Low-Level Tasks";
    } else if (inSection && TASK_LINE.test(line)) count += 1;
  }
  return count;
}

/** `{ done, total }` for a task tagged `plan` with numbered Low-Level Tasks; null otherwise. */
export function planProgress(
  tags: readonly string[],
  body: string | null,
  summaries: readonly string[],
): { done: number; total: number } | null {
  if (!tags.includes("plan") || typeof body !== "string") return null;
  const total = countTasks(body);
  if (total === 0) return null;
  const done = new Set<number>();
  for (const summary of summaries) {
    const match = TASK_DONE.exec(summary);
    const n = match ? Number(match[1]) : 0;
    if (n >= 1 && n <= total) done.add(n);
  }
  return { done: done.size, total };
}

export type CortexAuthor = { kind: "you" | "thread" | "pi" | "other"; label: string; threadId?: string };

const BB_AUTHOR = /^bb-(thr_[0-9a-z]{6,40})$/;
const PI_AUTHOR = /^pi-([0-9a-f]{8})[0-9a-f-]*$/;

/** Who an author tag is; a bb thread's label is its title, looked up by the caller. */
export function classifyAuthor(
  tag: string,
  userAuthor: string | null,
): { kind: "you" | "pi" | "other"; label: string } | { kind: "thread"; threadId: string } {
  if (userAuthor !== null && tag === userAuthor) return { kind: "you", label: "You" };
  const thread = BB_AUTHOR.exec(tag);
  if (thread) return { kind: "thread", threadId: thread[1] as string };
  const pi = PI_AUTHOR.exec(tag);
  if (pi) return { kind: "pi", label: `pi session ${pi[1]}` };
  return { kind: "other", label: tag };
}

export const NOTE_SUMMARY_MAX = 4096;

/**
 * A note as cortex stores it: the first non-empty line is the summary
 * (`-m`), the trimmed rest the body (`-b`), null when there is none.
 */
export function splitNote(text: string): { summary: string; body: string | null } | { error: string } {
  const lines = text.split(/\r?\n/);
  const first = lines.findIndex(line => line.trim() !== "");
  if (first === -1) return { error: "Write a note first." };
  const summary = (lines[first] as string).trim();
  if (summary.length > NOTE_SUMMARY_MAX) {
    return { error: `The first line is the note's summary: at most ${NOTE_SUMMARY_MAX} characters.` };
  }
  const body = lines
    .slice(first + 1)
    .join("\n")
    .trim();
  return { summary, body: body === "" ? null : body };
}
