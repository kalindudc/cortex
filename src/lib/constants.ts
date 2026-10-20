// lib/constants.ts — Pure data + tiny pure functions shared by the CLI and the desktop UI.
//
// No I/O. Safe to import from anywhere without worrying about cycles.

import type { TaskStatus } from "../store.ts";

export const STATUS = ["draft", "open", "review", "blocked", "done"] as const satisfies readonly TaskStatus[];
export const STATUS_LABEL: Record<TaskStatus, string> = {
  draft: "Draft",
  open: "Open",
  review: "In review",
  blocked: "Blocked",
  done: "Done",
};
export const nextStatusFor = (s: TaskStatus): TaskStatus =>
  (({ draft: "open", open: "review", review: "done", blocked: "open", done: "open" }) as const)[s];
export const nextActionLabel = (s: TaskStatus): string =>
  (({ draft: "Publish", open: "Move to review", review: "Mark done", blocked: "Unblock", done: "Reopen" }) as const)[s];

// Priority: 0 = highest. Render as P0/P1/... with urgent/high/normal styling.
// Null (unset) falls through to "" — callers that render the chip at all are
// expected to short-circuit before reaching this function, but the broader
// signature keeps callers from having to narrow at every site.
export const priorityClass = (p: number | null): string => (p === 0 ? "urgent" : p === 1 ? "high" : "");

// Curated swatch palette for the lane color picker. null = "no color".
export const LANE_COLORS: ReadonlyArray<string | null> = [
  null,
  "#fe8019",
  "#dc2626",
  "#d97706",
  "#16a34a",
  "#2563eb",
  "#7c3aed",
  "#db2777",
  "#f87171",
  "#fbbf24",
  "#4ade80",
  "#60a5fa",
  "#a78bfa",
  "#f472b6",
  "#94a3b8",
  "#475569",
];

// Client-side mirror of TAG_NAME_RE in src/store.ts. Used to reject a tag
// name before sending a request the server would just 400 anyway. Keep the
// regex in lockstep with the server-side one — if you change one, change both.
export const TAG_NAME_RE = /^[a-z0-9_@-]{1,32}$/;
export const isValidTagName = (s: unknown): boolean => typeof s === "string" && TAG_NAME_RE.test(s.trim());
