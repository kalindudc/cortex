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

export interface TaskSearchResult {
  task: Task;
  score: number;
}

export function searchTasks(tasks: Task[], query: string): TaskSearchResult[] {
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
      .map(task => ({ task, score: 1_000_000 }))
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

      return { task, score };
    })
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score);
}
