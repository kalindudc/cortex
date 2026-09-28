// fuzzy.ts — Lightweight client-side task fuzzy scorer.
//
// No external dependency. Token-split substring match with weighted scoring:
// title > tags > body. Three special prefixes layer ON TOP of the fuzzy
// scorer:
//   - `@<digits>`       — exact task-id lookup (single result or empty).
//                         Bypasses fuzzy entirely; lets the user jump to a
//                         known task by typing its id.
//   - `@<non-digits>`   — title-only fuzzy search (existing behaviour).
//   - `#<exact-tag>`    — when the input matches a real tag on at least one
//                         task, returns ALL tasks carrying that exact tag
//                         (sorted by priority asc, id asc). Falls through
//                         to the existing tag-substring fuzzy when no exact
//                         tag matches — so partial typing like `#fe` still
//                         finds `feature`.
//   - `#<substring>`    — tag-substring fuzzy search (existing fallback).

import type { Task } from "../api/types.ts";

export interface TaskSearchHighlight {
  field: "title" | "body" | "tag";
  text: string;
  ranges: Array<{ start: number; end: number }>;
}

export interface TaskSearchResult {
  task: Task;
  score: number;
  highlight?: TaskSearchHighlight;
}

const BODY_EXCERPT_CONTEXT = 36;

function mergeRanges(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  const sorted = ranges.filter(r => r.end > r.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of sorted) {
    const prev = merged[merged.length - 1];
    if (!prev || range.start > prev.end) {
      merged.push({ ...range });
    } else {
      prev.end = Math.max(prev.end, range.end);
    }
  }
  return merged;
}

function matchRanges(text: string, query: string, tokens: string[]): Array<{ start: number; end: number }> {
  const haystack = text.toLowerCase();
  const terms = haystack.includes(query) ? [query] : tokens;
  const ranges: Array<{ start: number; end: number }> = [];
  for (const term of terms.filter(Boolean)) {
    let from = 0;
    for (;;) {
      const start = haystack.indexOf(term, from);
      if (start === -1) break;
      ranges.push({ start, end: start + term.length });
      from = start + term.length;
    }
  }
  return mergeRanges(ranges);
}

function textHighlight(
  field: TaskSearchHighlight["field"],
  text: string,
  query: string,
  tokens: string[],
): TaskSearchHighlight | undefined {
  const ranges = matchRanges(text, query, tokens);
  return ranges.length > 0 ? { field, text, ranges } : undefined;
}

function bodyHighlight(text: string, query: string, tokens: string[]): TaskSearchHighlight | undefined {
  const ranges = matchRanges(text, query, tokens);
  if (ranges.length === 0) return undefined;
  const first = ranges[0];
  const start = Math.max(0, first.start - BODY_EXCERPT_CONTEXT);
  const end = Math.min(text.length, first.end + BODY_EXCERPT_CONTEXT);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  const snippet = `${prefix}${text.slice(start, end)}${suffix}`;
  const adjusted = ranges
    .filter(r => r.end > start && r.start < end)
    .map(r => ({
      start: Math.max(r.start, start) - start + prefix.length,
      end: Math.min(r.end, end) - start + prefix.length,
    }));
  return { field: "body", text: snippet, ranges: adjusted };
}

function matchingTag(tags: string[], query: string, tokens: string[]): string | undefined {
  return (
    tags.find(tag => tag.toLowerCase().includes(query)) ??
    tags.find(tag => tokens.some(token => tag.toLowerCase().includes(token)))
  );
}

function taskHighlight(
  task: Task,
  mode: "all" | "title" | "tag",
  query: string,
  tokens: string[],
): TaskSearchHighlight | undefined {
  if (mode === "title" || mode === "all") {
    const highlight = textHighlight("title", task.title, query, tokens);
    if (highlight) return highlight;
  }
  if (mode === "tag" || mode === "all") {
    const tag = matchingTag(task.tags, query, tokens);
    if (tag) return textHighlight("tag", `#${tag}`, query, tokens);
  }
  if (mode === "all") return bodyHighlight(task.body ?? "", query, tokens);
  return undefined;
}

export function searchTasks(tasks: readonly Task[], query: string): TaskSearchResult[] {
  const raw = query.trim();

  // --- @<digits> shortcut: exact id lookup, bypass fuzzy entirely.
  // Matches `@123` (any positive integer); a bare `@` or `@abc` falls
  // through to the title-fuzzy path below.
  const idMatch = raw.match(/^@(\d+)$/);
  if (idMatch) {
    const id = Number(idMatch[1]);
    const hit = tasks.find(t => t.id === id);
    // Infinity score keeps the row pinned to the top even if a parent
    // caller merges results from multiple searches. Empty array (no hit)
    // is the correct "task not found" UX — the palette already shows a
    // "No matching tasks" empty state.
    return hit ? [{ task: hit, score: Number.POSITIVE_INFINITY }] : [];
  }

  // --- #<exact-tag> shortcut: list every task carrying that exact tag.
  // Validates the tag name against TAG_NAME_RE shape (same char class as
  // the store) before scanning. If no task carries the exact tag we fall
  // through to substring fuzzy so partial typing still works.
  const tagMatch = raw.match(/^#([a-z0-9_@-]{1,32})$/);
  if (tagMatch) {
    const name = tagMatch[1];
    const hits = tasks
      .filter(t => t.tags.includes(name))
      .map(task => {
        const highlight = textHighlight("tag", `#${name}`, name, [name]);
        return highlight ? { task, score: 1_000_000, highlight } : { task, score: 1_000_000 };
      })
      // null priority sorts last — matches `(priority IS NULL)` in Store.listTasks.
      .sort(
        (a, b) =>
          (a.task.priority ?? Number.POSITIVE_INFINITY) - (b.task.priority ?? Number.POSITIVE_INFINITY) ||
          a.task.id - b.task.id,
      );
    if (hits.length > 0) return hits;
    // No exact tag matches — fall through to substring fuzzy below.
  }

  const mode = raw.startsWith("@") ? "title" : raw.startsWith("#") ? "tag" : "all";
  const q = raw.replace(/^[@#]/, "").trim().toLowerCase();
  if (!q) return [];

  const tokens = q.split(/\s+/).filter(Boolean);

  return tasks
    .map(task => {
      let score = 0;
      const title = task.title.toLowerCase();
      const body = (task.body ?? "").toLowerCase();
      const tags = task.tags.map(t => t.toLowerCase());

      // AND semantics: every token must match at least one searched field.
      const allTokensMatch = tokens.every(token => {
        if (mode === "title" || mode === "all") {
          if (title.includes(token)) return true;
        }
        if (mode === "tag" || mode === "all") {
          if (tags.some(tag => tag.includes(token))) return true;
        }
        if (mode === "all") {
          if (body.includes(token)) return true;
        }
        return false;
      });

      if (!allTokensMatch) return { task, score: 0 };

      if (mode === "title" || mode === "all") {
        if (title.includes(q)) score += mode === "title" ? 100 : 50;
        else if (tokens.every(t => title.includes(t))) score += mode === "title" ? 50 : 25;
        else {
          const matched = tokens.filter(t => title.includes(t)).length;
          score += matched * (mode === "title" ? 10 : 5);
        }
      }

      if (mode === "tag" || mode === "all") {
        if (tags.some(t => t.includes(q))) score += mode === "tag" ? 100 : 30;
        else {
          const matched = tokens.filter(t => tags.some(tag => tag.includes(t))).length;
          score += matched * (mode === "tag" ? 15 : 8);
        }
      }

      if (mode === "all") {
        if (body.includes(q)) score += 10;
        else if (tokens.every(t => body.includes(t))) score += 5;
        else {
          const matched = tokens.filter(t => body.includes(t)).length;
          score += matched * 2;
        }
      }

      const highlight = taskHighlight(task, mode, q, tokens);
      return highlight ? { task, score, highlight } : { task, score };
    })
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score);
}
