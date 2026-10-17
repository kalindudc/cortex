// Times as the Cortex tab shows them. Pure; day boundaries are local time.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function shortDate(ms: number, now: number): string {
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

/** "just now", "4m ago", "3h ago", "2d ago", then a date. */
export function relativeTime(ms: number, now: number = Date.now()): string {
  const age = Math.max(0, now - ms);
  if (age < 45_000) return "just now";
  if (age < HOUR) return `${Math.max(1, Math.round(age / MINUTE))}m ago`;
  if (age < DAY) return `${Math.floor(age / HOUR)}h ago`;
  if (age < 30 * DAY) return `${Math.floor(age / DAY)}d ago`;
  return shortDate(ms, now);
}

export function absoluteTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

function dayStart(ms: number): number {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Today, Yesterday, or the date. */
export function dayLabel(ms: number, now: number = Date.now()): string {
  const today = dayStart(now);
  const day = dayStart(ms);
  if (day === today) return "Today";
  if (day === dayStart(today - 1)) return "Yesterday";
  return shortDate(ms, now);
}

/** Consecutive items on the same local day, in the order given. */
export function groupByDay<T>(items: readonly T[], timeOf: (item: T) => number, now: number = Date.now()) {
  const groups: Array<{ label: string; items: T[] }> = [];
  let last: number | null = null;
  for (const item of items) {
    const day = dayStart(timeOf(item));
    if (day !== last) groups.push({ label: dayLabel(timeOf(item), now), items: [] });
    last = day;
    groups[groups.length - 1]?.items.push(item);
  }
  return groups;
}
