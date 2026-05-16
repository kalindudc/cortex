// Dedicated entry for the lazy mermaid chunk.
//
// Built separately by `pnpm run ui:build` into `out/mermaid.js`; served at
// `/mermaid.js` by the daemon (src/server.ts UI_ASSETS); imported lazily
// from `src/ui/lib/markdown.ts` via `await import("/mermaid.js")` on first
// modal open per session.
//
// Keep this file to a single re-export so the chunk graph stays trivial.
// The bundler turns this into a self-contained ESM module whose default
// export IS mermaid's default export.

export { default } from "mermaid";
