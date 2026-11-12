import type { Actor, DeliveryReceipt, Dimension, Knowledge, KnowledgeSource, ThreadContext } from "./types";

// Every user-facing word for workstream state lives here, so the plain-language
// rules (no "packet", "record" or "overlay") are enforced in one place.

export type Tone = "success" | "attention" | "warning" | "destructive" | "muted" | "primary";
export type DisplayState = Knowledge["state"] | "expired";

const DELIVERY_STATUS: Record<Exclude<ThreadContext["status"], "ready">, string> = {
  "over-budget": "over budget",
  "missing-required": "required knowledge missing",
  unavailable: "brief unavailable",
  unbound: "not connected",
};

export function deliverySummary(status: ThreadContext["status"], readyText: string): string {
  return status === "ready" ? readyText : `Sends nothing: ${DELIVERY_STATUS[status]}`;
}

export const STATE_LOOK: Record<DisplayState, { word: string; icon: string; tone: Tone }> = {
  candidate: { word: "Waiting for review", icon: "BellDot", tone: "attention" },
  approved: { word: "Approved", icon: "CircleCheck", tone: "success" },
  disputed: { word: "Disputed", icon: "AlertTriangle", tone: "warning" },
  superseded: { word: "Replaced", icon: "RotateCcw", tone: "muted" },
  recheck: { word: "Needs re-check", icon: "Clock", tone: "warning" },
  expired: { word: "Expired", icon: "Clock", tone: "warning" },
  archived: { word: "Archived", icon: "Archive", tone: "muted" },
  rejected: { word: "Rejected", icon: "CircleX", tone: "muted" },
  forgotten: { word: "Forgotten", icon: "EyeOff", tone: "muted" },
};

export const KIND_LOOK: Record<Knowledge["kind"], { word: string; icon: string }> = {
  directive: { word: "Directive", icon: "ListTodo" },
  finding: { word: "Finding", icon: "Search" },
};

export const BRIEF_STATE_LOOK = {
  ...STATE_LOOK,
  candidate: { ...STATE_LOOK.candidate, word: "Waiting" },
};

export const BRIEF_KIND_LOOK: typeof KIND_LOOK = {
  directive: { word: "Rule", icon: "ListTodo" },
  finding: { ...KIND_LOOK.finding, icon: "Explore" },
};

export const ORIGIN_WORD: Record<ThreadContext["entries"][number]["origin"], string> = {
  canonical: "Saved knowledge",
  "thread-only": "This thread only",
  "human-grant": "Shared with this thread",
};

export const STATUS_LOOK: Record<ThreadContext["status"], { word: string; tone: Tone }> = {
  ready: { word: "Ready", tone: "success" },
  unbound: { word: "Not connected to a workstream", tone: "muted" },
  "over-budget": { word: "Over budget", tone: "destructive" },
  "missing-required": { word: "Required knowledge missing", tone: "destructive" },
  unavailable: { word: "Cortex unavailable", tone: "destructive" },
};

/** What each history route recorded; never a claim that the agent used it. */
export const ROUTE_WORD: Record<DeliveryReceipt["route"], string> = {
  configure: "Prepared for session startup",
  recall: "Returned by recall",
  match: "Reference sent",
};

export const AUTHOR_WORD: Record<KnowledgeSource["authorType"], string> = {
  human: "Person",
  agent: "Agent",
  system: "System",
  unknown: "Unknown author",
};

export const SOURCE_STATUS_WORD: Record<NonNullable<KnowledgeSource["status"]>, string | null> = {
  available: null,
  archived: "Source archived",
  unreachable: "Source unavailable",
};

export function actorWord(actor: Actor): string {
  if (actor.type === "human") return "You";
  if (actor.type === "system") return "Cortex";
  return actor.id.startsWith("bb-") ? `Agent in ${actor.id.slice(3)}` : `Agent ${actor.id}`;
}

/** The storage name of workstream-wide knowledge; people read it as "Shared basics". */
export const ORIENTATION = "orientation";

export function facetWord(facet: string): string {
  return facet === ORIENTATION ? "Shared basics" : facet;
}

const DIMENSION_NAME = { environment: "Environment", host: "Host" } as const;

/** "Environment staging", "Any environment" or "Environment unknown"; unknown is never a wildcard. */
export function dimensionWord(name: keyof typeof DIMENSION_NAME, dimension: Dimension): string {
  const label = DIMENSION_NAME[name];
  if (dimension.mode === "value") return `${label} ${dimension.value}`;
  if (dimension.mode === "not-applicable") return `Any ${label.toLowerCase()}`;
  return `${label} unknown`;
}

export const UNKNOWN_HINT = "Unknown never counts as any environment or host, so it stays out of thread context.";

export function bindingWord(context: ThreadContext, sectionName: string | null): string {
  switch (context.bindingSource) {
    case "manual":
      return "Set for this thread";
    case "section":
      return sectionName ? `From section ${sectionName}` : "From this thread's section";
    case "parent":
      return "From the parent thread";
    default:
      return "Not connected";
  }
}

export const VISIBILITY_WORD = {
  shown: "Show above the composer",
  hidden: "Hide for this thread",
  follow: (defaultShown: boolean) => `Follow the setting (${defaultShown ? "shown" : "hidden"})`,
} as const;

export function tokens(n: number): string {
  if (n < 1000) return `~${n}`;
  return `~${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
