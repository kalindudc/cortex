// index.tsx — Bundler entry + bootstrap for the cortex dashboard.
//
// Wires DOM concerns to the data layer: mounts the Preact tree, subscribes
// to the daemon's SSE stream, fetches the resolved /api/me identity, and
// installs the two global event listeners (outside-click for popovers,
// keydown for global shortcuts). Imports App from ./components/App.tsx and
// the state/helpers it needs from state/. No business logic lives here.
//
// CSS is NOT imported here — out/bundle.css is built directly by
// scripts/build-css.sh from src/ui/styles/*.css (run as a prebuild step in
// package.json:ui:build / ui:watch). The server embeds out/bundle.css via
// `with { type: "file" }` in src/server.ts, so the file just needs to exist
// on disk; nothing requires it to flow through the JS bundler.

import { render } from "preact";

// Side-effect import: opens an EventSource to /api/dev-reload. The endpoint
// only exists when the server is started with CORTEX_DEV=1 (i.e. via
// `pnpm run serve:dev`); in production it 404s and the EventSource quietly
// no-ops. See src/ui/dev-reload.ts.
import "./dev-reload.ts";
// Side-effect import: seeds selectedId from localStorage and registers an
// effect that persists activeTask.id back. Must come before refresh() below
// so the seed beats the first task fetch.
import "./state/lastTask.ts";
// Side-effect import: seeds the showAllTasks toggle from localStorage and
// registers an effect that persists subsequent toggles. Must come before
// refresh() so the seed beats the first paint of the sidebar.
import "./state/showAllTasks.ts";
import App from "./components/App.tsx";
import { refresh } from "./state/refresh.ts";
import { meAuthor, paletteOpen, paletteQuery, modal, migrationsPending } from "./state/signals.ts";
import { closeAllPopovers } from "./state/popovers.ts";
import { notifications } from "./state/notifications.ts";
import type { Notification } from "./api/types.ts";

// PostUpdateForm publishes its submit closure to window.__cortexPostUpdate
// so the global Cmd/Ctrl+Enter handler below can flush it. Re-declared here
// so the global keydown handler below typechecks under strict mode (the
// PostUpdateForm.tsx side carries the same declaration).
declare global {
  interface Window {
    __cortexPostUpdate?: () => void;
  }
}

// ---------- mount + initial data ----------
const mountPoint = document.querySelector("main#app");
if (!mountPoint) throw new Error("#main#app not found in document — cannot mount cortex UI");
render(<App />, mountPoint);

// One-shot bootstrap of the default post-update author + migration status.
fetch("/api/me")
  .then(r => r.json())
  .then(d => {
    if (d?.author) meAuthor.value = d.author;
  })
  .catch(() => {
    /* fall back to "me" — non-fatal */
  });
fetch("/api/migrations")
  .then(r => r.json())
  .then(d => {
    if (Array.isArray(d?.pending)) migrationsPending.value = d.pending;
  })
  .catch(() => {
    /* non-fatal — banner simply won't show */
  });

// Ask for browser-notification permission once on first load if the user
// hasn't decided yet. We *only* prompt on "default" — never re-prompt after
// the user has explicitly denied. Notifications are used downstream to
// surface task transitions into blocked status.
if (typeof Notification !== "undefined" && Notification.permission === "default") {
  Notification.requestPermission().catch(() => {
    /* user dismissed — fine */
  });
}

// Initial state load. The SSE handler below will keep us in sync after this.
refresh();

// ---------- SSE: server-side change notifications ----------
// Debounce because multiple events can fire in close succession (e.g. a
// task.added immediately followed by an update.posted). A single 50ms window
// collapses these into one refresh.
let pending: ReturnType<typeof setTimeout> | null = null;
const debounceRefresh = () => {
  if (pending) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = null;
    refresh();
  }, 50);
};
const ev = new EventSource("/events");
// Each kind here MUST also be present in src/events.ts EventKind union and
// emitted by some write handler in src/server.ts. New event kinds added to
// the server but missing here are silently ignored — the dashboard goes
// stale until a manual reload. (Last instance: tag.changed shipped from the
// server but was forgotten here, so TagsPane didn't refresh on tag CRUD.)
// notification.added is intentionally NOT in this list. Refreshing
// tasks/lanes/tags/updates on a notification event would be wasteful;
// the notification handler below prepends the payload directly to the
// local signal because the SSE event IS the canonical row.
["task.added", "task.updated", "task.removed", "update.posted", "lane.changed", "tag.changed"].forEach(k => {
  ev.addEventListener(k, debounceRefresh);
});

// Bell-drawer live updates. The server now persists the row and the
// SSE payload IS the row — prepend it directly to the local signal so
// the drawer reflects the new entry without a refetch round-trip. The
// debounced refresh above will reconcile if the SSE event was missed.
// (The browser-native Notification handler below stays — it fires on
// `task.updated` for blocked transitions and is orthogonal to in-app
// drawer persistence.)
ev.addEventListener("notification.added", (e: MessageEvent) => {
  try {
    const n = JSON.parse(e.data) as Notification;
    notifications.value = [n, ...notifications.value];
  } catch {
    /* malformed payload — ignore */
  }
});

// Separate listener (does NOT replace the debounceRefresh above) that fires
// a browser Notification when a task transitions INTO blocked. Wrapped in
// the typeof-Notification guard so non-supporting environments don't crash.
// The `tag` field dedupes if the same task transitions blocked → other →
// blocked: only the latest notification for that task ID stays visible.
if (typeof Notification !== "undefined") {
  ev.addEventListener("task.updated", (e: MessageEvent) => {
    let payload: { id: number; title: string; status: string } | null = null;
    try {
      payload = JSON.parse(e.data);
    } catch {
      return;
    }
    if (!payload || payload.status !== "blocked") return;
    if (Notification.permission === "granted") {
      try {
        new Notification("cortex: task blocked", {
          body: payload.title,
          tag: `task-${payload.id}`,
        });
      } catch {
        /* some browsers throw if the page is not focused / secure */
      }
    } else if (Notification.permission === "default") {
      // Try once more in case the user hasn't seen the prompt yet.
      Notification.requestPermission().catch(() => {});
    }
  });
}

// ---------- outside-click closes any open popover ----------
// Elements that are *part of* a popover (or its trigger) carry data-pop, so a
// click on those is a no-op. Anything else closes everything.
document.addEventListener("click", (e: MouseEvent) => {
  const t = e.target as HTMLElement | null;
  if (!t?.closest?.("[data-pop]")) closeAllPopovers();
});

// ---------- global keyboard shortcuts ----------
// No single-key hotkeys (they hijack typing in inputs). Only meta-modified:
//   ⌘/Ctrl + P  or  ⌘/Ctrl + K   -> toggle command palette
//   ⌘/Ctrl + /                   -> jump cursor into the post-update textarea
//   ⌘/Ctrl + Enter               -> post the update (works while focused in textarea)
//   Esc                          -> close palette -> modal -> popover
window.addEventListener("keydown", (e: KeyboardEvent) => {
  const meta = e.metaKey || e.ctrlKey;

  // Open palette in command mode (mod+p) or search mode (mod+k).
  if (meta && e.key === "p") {
    e.preventDefault();
    if (!paletteQuery.value.startsWith("/")) paletteQuery.value = `/${paletteQuery.value}`;
    paletteOpen.value = true;
    return;
  }
  if (meta && e.key === "k") {
    e.preventDefault();
    if (paletteQuery.value.startsWith("/")) paletteQuery.value = paletteQuery.value.slice(1);
    paletteOpen.value = true;
    return;
  }

  // Focus post-update textarea from anywhere. Match BOTH e.key === "/" (US
  // layouts) and e.code === "Slash" (layout-independent) because non-US
  // keyboard layouts produce different glyphs for the slash key, but e.code
  // is always the physical key.
  if (meta && (e.key === "/" || e.code === "Slash")) {
    e.preventDefault();
    const ta = document.getElementById("post-update-input") as HTMLTextAreaElement | null;
    if (ta) {
      ta.focus();
      ta.setSelectionRange?.(ta.value.length, ta.value.length);
    }
    return;
  }

  // Belt-and-suspenders for ⌘/Ctrl+Enter: catch globally if the textarea
  // handler missed it for any reason. window.__cortexPostUpdate is the
  // submit closure that PostUpdateForm publishes on every render.
  if (meta && e.key === "Enter") {
    const ta = document.getElementById("post-update-input") as HTMLTextAreaElement | null;
    if (ta && document.activeElement === ta && typeof window.__cortexPostUpdate === "function") {
      e.preventDefault();
      window.__cortexPostUpdate();
      return;
    }
  }

  if (e.key === "Escape") {
    // Cascade: palette → modal → popovers. Each step short-circuits
    // if it caught the Esc; the next step only fires if nothing was open at
    // this level. closeAllPopovers() returns true iff it closed at least one
    // popover signal — don't enumerate popover signals here so adding new
    // ones (tagsPopover, lanePopover, etc.) doesn't require touching this
    // handler.
    if (paletteOpen.value) {
      paletteOpen.value = false;
      paletteQuery.value = "";
      return;
    }
    if (modal.value) {
      modal.value = null;
      return;
    }
    if (closeAllPopovers()) return;
  }
});
