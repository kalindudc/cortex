// lib/constants.ts — Pure data + tiny pure functions shared by the TUI and CLI.
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

// Client-side mirror of TAG_NAME_RE in src/store.ts. Used to reject a tag
// name before sending a request the server would just 400 anyway. Keep the
// regex in lockstep with the server-side one — if you change one, change both.
export const TAG_NAME_RE = /^[a-z0-9_@-]{1,32}$/;
export const isValidTagName = (s: unknown): boolean => typeof s === "string" && TAG_NAME_RE.test(s.trim());
