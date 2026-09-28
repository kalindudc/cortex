// dashboard.tsx — Bootstrap for the cortex dashboard (the workspace).
//
// src/ui/index.tsx (the bundler entry) loads this module for every page
// except the rich draft preview (/preview/<token>), so everything below,
// including the side-effect imports, runs only for the workspace.
//
// Wires DOM concerns to the data layer: mounts the Preact tree, hands the
// daemon's SSE stream to state/refresh.ts (connectLive), fetches the resolved
// /api/me identity, and installs the two global event listeners
// (outside-click for popovers, keydown for global shortcuts). Imports App
// from ./components/App.tsx and the state/helpers it needs from state/. No
// business logic lives here.
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
// effect that persists activeTask.id back. Must come before connectLive()
// below so the seed beats the first task fetch.
import "./state/lastTask.ts";
// Side-effect import: seeds selectedId from /task/:id in the URL and
// drives window.history (pushState/replaceState + popstate) off selectedId.
// MUST come AFTER lastTask.ts so a URL seed wins over the localStorage seed
// (URL > localStorage > priority fallback), and BEFORE connectLive() so the
// seed beats the first task fetch.
import "./state/url.ts";
// Side-effect import: seeds the showAllTasks toggle from localStorage and
// registers an effect that persists subsequent toggles. Must come before
// connectLive() so the seed beats the first paint of the sidebar.
import "./state/showAllTasks.ts";
// Side-effect imports: seed sidebar section-open state, filters, and the
// post-update collapse state from localStorage; effects persist subsequent
// changes. All three must come before connectLive() so seeds beat first paint.
import "./state/sectionOpen.ts";
import "./state/filters.ts";
import "./state/postUpdateOpen.ts";
// Side-effect import: seeds the workspace query preference and registers
// browser body-mode preference and task-entry effect. MUST come after the filter/
// collapse seeds above (its effects read those signals) and BEFORE
// mount/connectLive below so defaults beat the first paint.
import "./state/workspace.ts";
import App from "./components/App.tsx";
import { connectLive } from "./state/refresh.ts";
import { clearWorkspaceTransientState, requestPostUpdate, requestMode } from "./state/workspace.ts";
import { activeTask } from "./state/computed.ts";
import { IS_MAC, matchModeShortcut } from "./lib/keys.ts";
import {
  meAuthor,
  paletteOpen,
  paletteQuery,
  modal,
  migrationsPending,
  navigationOpen,
  sidebarFilter,
  statusPopover,
  lanePopover,
  tagsPopover,
  taskActionsPopover,
} from "./state/signals.ts";
import { closeAllPopovers, closeSidebarFilter } from "./state/popovers.ts";
import { notificationsOpen } from "./state/notifications.ts";
import { setTheme, theme } from "./state/theme.ts";

// The dashboard persists its first-load theme (the system preference when
// nothing is stored yet); from then on the user's choice wins. Loading
// state/theme.ts already applied it before first paint, without persisting
// it, so the rich draft preview stores no theme.
setTheme(theme.value);

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
// surface task transitions into blocked status (the explicit task.blocked
// event; see connectLive in state/refresh.ts).
if (typeof Notification !== "undefined" && Notification.permission === "default") {
  Notification.requestPermission().catch(() => {
    /* user dismissed — fine */
  });
}

// ---------- SSE: live synchronization (plan @400 N12) ----------
// connectLive owns the stream protocol AND the initial load: every `ready`
// (the first connect and each automatic EventSource reconnect) snapshots
// GET /api/workspace; frames are applied only past the snapshot's cursor
// and a burst coalesces into one follow-up snapshot; resync, gaps and new
// epochs resnapshot; notification rows/invalidations update the bell
// drawer; and ONLY the explicit task.blocked transition raises the desktop
// alert, never a task.updated frame whose task happens to be blocked. It
// listens for every name in src/events.ts EVENT_KINDS, so a new server
// event kind cannot be forgotten here.
connectLive(new EventSource("/events"));

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
//   ⌘/Ctrl + /                   -> reveal Activity + focus its inline composer
//   ⌘/Ctrl + Enter               -> post the update (works while focused in textarea)
//   ⌘+Option / Ctrl+Alt + 1/2/3  -> Read / Edit / Split (left Alt on Windows/Linux)
//   Esc                          -> close palette -> modal -> workspace transients
// Modifier tracking is not an animation/state queue. It only distinguishes
// deliberate Ctrl+left-Alt from AltGr, including Firefox's AltGraph behavior.
const heldAlt = new Set<string>();
const trackAlt = (event: KeyboardEvent): void => {
  if (event.code !== "AltLeft" && event.code !== "AltRight") return;
  if (event.type === "keydown") heldAlt.add(event.code);
  else heldAlt.delete(event.code);
};
window.addEventListener("keydown", trackAlt, true);
window.addEventListener("keyup", trackAlt, true);
window.addEventListener("blur", () => heldAlt.clear());
window.addEventListener("keydown", (e: KeyboardEvent) => {
  // Respect handled events and in-flight IME composition — a component
  // that already acted on the key (or an active composition) must not be
  // double-handled by the global layer.
  if (e.defaultPrevented || e.isComposing) return;
  const meta = e.metaKey || e.ctrlKey;
  const mode = matchModeShortcut(e, IS_MAC, heldAlt);
  if (mode != null) {
    // Consume our chord but never mutate content behind an active overlay,
    // repeat a held-key action, or act without a task. AltGr was excluded
    // by the matcher, so international character entry remains untouched.
    e.preventDefault();
    if (
      e.repeat ||
      !activeTask.peek() ||
      paletteOpen.peek() ||
      modal.peek() ||
      navigationOpen.peek() ||
      sidebarFilter.peek() ||
      statusPopover.peek() ||
      lanePopover.peek() ||
      tagsPopover.peek() ||
      taskActionsPopover.peek() ||
      notificationsOpen.peek()
    )
      return;
    requestMode(mode, mode === "read" ? "reader" : "body");
    return;
  }

  // Palette/modal own the top keyboard layer. Except for Escape (which
  // closes the top layer below), global commands must not mutate hidden
  // workspace content behind an overlay.
  if (e.key !== "Escape" && (paletteOpen.peek() || modal.peek() != null)) return;

  // Open palette in command mode (mod+p) or search mode (mod+k). Retarget
  // any lower drawer/popover/drag layer first.
  if (meta && (e.key === "p" || e.key === "k")) clearWorkspaceTransientState();
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

  // Post an update from anywhere (A3): ONE entry point — select Activity,
  // expand the composer disclosure, scroll + focus its textarea. Match BOTH
  // e.key === "/" (US layouts) and e.code === "Slash" (layout-independent)
  // because non-US keyboard layouts produce different glyphs for the slash
  // key, but e.code is always the physical key. No active task → no-op.
  if (meta && (e.key === "/" || e.code === "Slash")) {
    e.preventDefault();
    requestPostUpdate();
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
    // Sidebar filters are nonmodal children of navigation, not task-owned
    // popovers. Escape dismisses only the filter and restores its trigger;
    // preventDefault also prevents the native drawer's cancel action.
    if (closeSidebarFilter(true)) {
      e.preventDefault();
      return;
    }
    // Metadata popovers, navigation and drag state share the full reset.
    if (clearWorkspaceTransientState()) return;
  }
});
