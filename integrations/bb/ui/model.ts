import { type DisplayState, ORIENTATION } from "./copy";
import type { Knowledge, ThreadContext } from "./types";

export function isExpired(entry: Knowledge, now: number): boolean {
  return entry.expiresAt !== null && Date.parse(entry.expiresAt) <= now;
}

/** The state a person should read: an approved finding past its expiry is held back as expired. */
export function displayState(entry: Knowledge, now: number): DisplayState {
  return entry.state === "approved" && isExpired(entry, now) ? "expired" : entry.state;
}

export type KnowledgeGroup = { id: "current" | "held" | "waiting" | "history"; label: string; entries: Knowledge[] };

/** Saved knowledge by what it means for threads: current, held back, waiting for review, history. */
export function groupKnowledge(entries: readonly Knowledge[], now: number): KnowledgeGroup[] {
  const groups: KnowledgeGroup[] = [
    { id: "current", label: "In thread context", entries: [] },
    { id: "held", label: "Held back", entries: [] },
    { id: "waiting", label: "Waiting for review", entries: [] },
    { id: "history", label: "History", entries: [] },
  ];
  for (const entry of entries) {
    const state = displayState(entry, now);
    const id =
      state === "approved"
        ? "current"
        : state === "disputed" || state === "recheck" || state === "expired"
          ? "held"
          : state === "candidate"
            ? "waiting"
            : "history";
    groups.find(group => group.id === id)!.entries.push(entry);
  }
  return groups.filter(group => group.entries.length > 0);
}

export function facetsOf(entries: readonly Knowledge[]): string[] {
  const facets = [...new Set(entries.map(entry => entry.facet))];
  return facets.sort((a, b) => (a === ORIENTATION ? -1 : b === ORIENTATION ? 1 : a.localeCompare(b)));
}

/** Oldest first: the longest wait is the first decision. */
export function oldestFirst<T extends { entry: Knowledge }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => Date.parse(a.entry.updatedAt) - Date.parse(b.entry.updatedAt));
}

export type DiffOp = { op: "same" | "add" | "del"; text: string };

/** Longest-common-subsequence diff of two token lists, merged into runs. */
function diffTokens(a: readonly string[], b: readonly string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  const push = (op: DiffOp["op"], text: string) => {
    const last = ops[ops.length - 1];
    if (last && last.op === op) last.text += text;
    else ops.push({ op, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push("same", a[i]!);
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      push("del", a[i++]!);
    } else {
      push("add", b[j++]!);
    }
  }
  while (i < n) push("del", a[i++]!);
  while (j < m) push("add", b[j++]!);
  return ops;
}

/** A word-level diff for edit previews; whitespace stays attached to its word. */
export function wordDiff(before: string, after: string): DiffOp[] {
  const words = (text: string) => text.match(/\S+\s*|\s+/g) ?? [];
  return diffTokens(words(before), words(after));
}

/**
 * A unified patch of one text file, for the host's diff viewer. Large inputs
 * fall back to a whole-file replacement rather than an O(n·m) table.
 */
export function unifiedPatch(before: string, after: string, path: string): string {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  const header = `--- a/${path}\n+++ b/${path}\n`;
  if (a.length * b.length > 400_000) {
    return `${header}@@ -1,${a.length} +1,${b.length} @@\n${a.map(line => `-${line}`).join("\n")}\n${b.map(line => `+${line}`).join("\n")}\n`;
  }
  const lines: string[] = [];
  for (const op of diffTokens(
    a.map(line => `${line}\n`),
    b.map(line => `${line}\n`),
  )) {
    const mark = op.op === "same" ? " " : op.op === "add" ? "+" : "-";
    for (const line of op.text.slice(0, -1).split("\n")) lines.push(`${mark}${line}`);
  }
  return `${header}@@ -1,${a.length} +1,${b.length} @@\n${lines.join("\n")}\n`;
}

export function changedLineCount(before: string, after: string): number {
  const a = before === "" ? [] : before.split("\n").map(line => `${line}\n`);
  const b = after === "" ? [] : after.split("\n").map(line => `${line}\n`);
  return diffTokens(a, b)
    .filter(op => op.op !== "same")
    .reduce((sum, op) => sum + op.text.split("\n").length - 1, 0);
}

export type Visibility = "shown" | "hidden" | "follow";

export function visibilityOf(preference: boolean | null): Visibility {
  return preference === null ? "follow" : preference ? "hidden" : "shown";
}

/** The `dismissed` value `setContextDismissed` takes for a choice: true hides, false shows, null follows the setting. */
export function dismissedFor(choice: Visibility): boolean | null {
  return choice === "follow" ? null : choice === "hidden";
}

/** Whether a thread has anything for the widget to say: a workstream, a task or a failure worth seeing. */
export function contextHasContent(context: ThreadContext): boolean {
  return context.status !== "unbound" || context.grants.some(grant => grant.revokedAt === null);
}

export function activeGrants(context: ThreadContext) {
  return context.grants.filter(grant => grant.revokedAt === null);
}

export function relativeAge(iso: string, now: number): string {
  const ms = Math.max(0, now - Date.parse(iso));
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function waitAge(iso: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function shortTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
