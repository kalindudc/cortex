// fuzzy.ts — Lightweight client-side task fuzzy scorer.
//
// No external dependency. Token-split substring match with weighted scoring:
// title > tags > body. @prefix forces title-only; #prefix forces tag-only.

import type { Task } from "../api/types.ts";

export interface TaskSearchResult {
  task: Task;
  score: number;
}

export function searchTasks(tasks: Task[], query: string): TaskSearchResult[] {
  const raw = query.trim();
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
