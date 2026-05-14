// dev-reload.ts — Browser-side live-reload client for `pnpm run serve:dev`.
//
// Connects to the dev-only /api/dev-reload SSE endpoint (registered by
// src/server.ts only when CORTEX_DEV=1). On a `reload` event, calls
// location.reload(). In production the route returns 404 \u2192 the
// EventSource keeps retrying with no effect; the browser's built-in
// backoff is fine, and there's no console-visible error in the steady
// state once 404 is reached. We deliberately do NOT branch on env in the
// bundle: the gate is the SERVER\u00a0\u2014 keeps this module ~15 lines and the
// bundler graph identical between dev and prod.
//
// Wired into src/ui/index.tsx via a side-effect import.

const ev = new EventSource("/api/dev-reload");

ev.addEventListener("reload", () => {
  // Full reload (not location.reload(true) \u2014 deprecated); the server
  // already serves /bundle.js and /bundle.css with Cache-Control: no-store
  // so a soft reload picks up the new bytes.
  location.reload();
});

ev.addEventListener("hello", () => {
  // One-time confirmation in the dev console so devs know the channel is
  // live. Don't log every ping \u2014 too noisy.
  console.info("[cortex] live-reload connected");
});
