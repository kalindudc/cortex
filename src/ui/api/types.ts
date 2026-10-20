// api/types.ts — Browser-side DTOs for the cortex dashboard.
//
// `Task`, `Lane`, `Tag`, `Update` are re-exported from src/store.ts as the
// canonical shapes (the server returns rows from those types verbatim). The
// re-export is type-only — Bun's bundler can resolve "../../store.ts" from
// a browser-target file because TypeScript interfaces have zero runtime
// footprint; only runtime imports of node-specific symbols (e.g. `Database`)
// would fail.

export type { Task, Lane, Tag, Update, TaskStatus, Notification, RelatedTasks } from "../../store.ts";
