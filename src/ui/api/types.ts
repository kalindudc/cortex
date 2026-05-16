// api/types.ts — Browser-side DTOs for the cortex dashboard.
//
// `Task`, `Lane`, `Tag`, `Update` are re-exported from src/store.ts as the
// canonical shapes (the server returns rows from those types verbatim). The
// re-export is type-only — Bun's bundler can resolve "../../store.ts" from
// a browser-target file because TypeScript interfaces have zero runtime
// footprint; only runtime imports of node-specific symbols (e.g. `Database`)
// would fail. `Author` is declared inline here because it's the response
// shape of GET /api/authors, which delegates to `Store.listAuthorsLast24h`
// (returns `AuthorRow` from store.ts).

export type { Task, Lane, Tag, Update, TaskStatus, Notification, RelatedTasks } from "../../store.ts";

// Response shape of GET /api/authors. Mirrors `AuthorRow` from store.ts but
// re-declared here so this module remains the single source of truth for
// the browser data layer.
export interface Author {
  author: string;
  last_seen: number;
  posts: number;
}
