// lib/format.ts — Pure string formatters.

export const fmtTime = (ms: number): string => {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

// Compact age for list rows: "now" under a minute, then 5m, 3h, 2d, and
// weeks from 14 days.
export const fmtAge = (ms: number): string => {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  const days = Math.floor(s / 86400);
  return days < 14 ? `${days}d` : `${Math.floor(days / 7)}w`;
};

// "1 task", "2 tasks": a count with a regular English plural.
export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

export const initial = (s: string | null | undefined): string => (s || "?").trim().charAt(0).toUpperCase();
