/**
 * The desktop close guard's decisions, kept free of Electron so they can be
 * tested in-process. Main asks before a window closes, reloads or the app
 * quits while the renderer reports unsaved drafts: Save all, Discard or
 * Cancel. It leaves only when nothing unsaved is left or the user chose to
 * discard it, so an edit is never dropped silently.
 */

import type { DraftExport, DraftReport, GuardRequest, SaveAllAnswer } from "./ipc.ts";

export type { DraftReport } from "./ipc.ts";

/** The largest draft text main writes to a file. */
export const MAX_EXPORT_BYTES = 16 * 1024 * 1024;
/** How long Save all may take before the window stays open. */
export const SAVE_ALL_TIMEOUT_MS = 15_000;
/** How long main waits for the renderer to stop warning before unload. */
export const RELEASE_TIMEOUT_MS = 2_000;

export const GUARD_BUTTONS = ["Save all", "Discard", "Cancel"] as const;
const SAVE_ALL = 0;
const DISCARD = 1;

export interface GuardDialog {
  message: string;
  detail: string;
  buttons: typeof GUARD_BUTTONS;
}

export interface ParsedDraftExport extends DraftExport {
  /** Built here from the id and field, never taken from the renderer. */
  fileName: string;
}

function invalid(what: string, reason: string): never {
  throw new Error(`invalid ${what}: ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function parseDraftReport(value: unknown): DraftReport {
  if (!isRecord(value)) invalid("draft report", "must be an object");
  const { dirty, orphaned } = value;
  if (!isCount(dirty) || !isCount(orphaned)) invalid("draft report", "counts must be non-negative integers");
  return { dirty, orphaned };
}

export function parseSaveAllAnswer(value: unknown): SaveAllAnswer {
  if (!isRecord(value)) invalid("save-all answer", "must be an object");
  if (!isCount(value.id)) invalid("save-all answer", "id must be a non-negative integer");
  return { id: value.id, report: parseDraftReport(value.report) };
}

/** The renderer's answer to a request that carries nothing but its id (release). */
export function parseGuardAnswer(value: unknown): GuardRequest {
  if (!isRecord(value) || !isCount(value.id)) invalid("guard answer", "id must be a non-negative integer");
  return { id: value.id };
}

export function parseDraftExport(value: unknown): ParsedDraftExport {
  if (!isRecord(value)) invalid("draft export", "must be an object");
  const { taskId, field, text } = value;
  if (typeof taskId !== "number" || !Number.isSafeInteger(taskId) || taskId <= 0) {
    invalid("draft export", "taskId must be a positive integer");
  }
  if (field !== "title" && field !== "body") invalid("draft export", "field must be title or body");
  if (typeof text !== "string") invalid("draft export", "text must be a string");
  if (Buffer.byteLength(text, "utf8") > MAX_EXPORT_BYTES) invalid("draft export", "text is larger than 16 MiB");
  return { taskId, field, text, fileName: `cortex-task-${taskId}-${field}-draft.md` };
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function guardDialog(report: DraftReport): GuardDialog {
  const parts: string[] = [];
  if (report.dirty > 0) parts.push(`${plural(report.dirty, "task has", "tasks have")} unsaved changes.`);
  if (report.orphaned > 0) {
    parts.push(
      `${plural(report.orphaned, "draft belongs", "drafts belong")} to a deleted task and cannot be saved; Cancel to export it first.`,
    );
  }
  return { message: "Save your changes before leaving?", detail: parts.join(" "), buttons: GUARD_BUTTONS };
}

export interface GuardOptions {
  report: DraftReport;
  /** Show the dialog; resolves with the index of the chosen button. */
  ask: (dialog: GuardDialog) => Promise<number>;
  /** Save every draft; resolves with what is left unsaved afterwards. */
  saveAll: () => Promise<DraftReport>;
  timeoutMs: number;
}

/** True while the report holds anything leaving would lose. */
export const needsGuard = (report: DraftReport): boolean => report.dirty > 0 || report.orphaned > 0;

export async function runGuard({ report, ask, saveAll, timeoutMs }: GuardOptions): Promise<"leave" | "stay"> {
  if (!needsGuard(report)) return "leave";
  const choice = await ask(guardDialog(report));
  if (choice === DISCARD) return "leave";
  if (choice !== SAVE_ALL) return "stay";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>(resolve => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    const left = await Promise.race([saveAll(), timeout]);
    return left !== null && left.dirty === 0 ? "leave" : "stay";
  } catch {
    return "stay";
  } finally {
    clearTimeout(timer);
  }
}
