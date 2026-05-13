// state.js — Pure data layer for the cortex dashboard.
//
// Owns: signals, computed values, the API object, all pure helpers, and the
// reactive effects that mirror "active task" -> "loaded updates". Has no DOM
// side effects (no querySelector, no addEventListener, no render). Bootstrap
// (mounting, EventSource subscribe, /api/me fetch, window listeners) lives in
// app.js, which imports from here.
//
// Why a single state.js instead of finer-grained modules: the signals and
// helpers are densely cross-referenced, and splitting further would force
// every component import to grow without reducing real coupling.

import { signal, computed, effect } from "https://esm.sh/@preact/signals@1.3?deps=preact@10.24";

// ---------- signals ----------
export const tasks         = signal([]);
export const lanes         = signal([]);
// Tag rollups: { name, color, created, task_count } from /api/tags. Refreshed
// in the same Promise.all as tasks/lanes so chip colors stay in sync after
// any tag.changed / task.updated SSE event.
export const tags          = signal([]);
// Sidebar mode: "lanes" (default LanesPane) or "tags" (TagsPane). The home
// button + a tag-mode button live in the sidebar's .pane-system strip.
// Switching is mostly non-destructive: it does NOT clear selectedLane or
// selectedId so the right-hand active task pane keeps its context. Exception:
// switching tags → lanes (Home button or "Switch to lane mode" palette entry)
// resets selectedTag to null so the lanes view never inherits stale tag-mode
// filter state. The reverse direction (lanes → tags) leaves selectedTag
// alone — entering tags mode with the previous filter restored is desired.
export const sidebarView   = signal("lanes");
// Optional single-tag filter applied to the visible task list. Combined with
// selectedLane via AND. Set by clicking a tag row in TagsPane (or via the
// command palette's "Filter by tag…" entry); cleared by clicking the same
// tag again or by the "All tags" entry.
export const selectedTag   = signal(null);
// New-tag inline form open/closed (mirrors newLaneOpen).
export const newTagOpen    = signal(false);
export const updates       = signal({});
export const selectedLane  = signal(null);
export const selectedId    = signal(null);
export const editing       = signal(false);
export const statusPopover = signal(false);
export const newLaneOpen   = signal(false);
// Active-task tags-chip popover. Mirrors statusPopover: click chip to toggle,
// outside-click closes via app.js's global handler + closeAllPopovers().
export const tagsPopover   = signal(false);
export const paletteOpen   = signal(false);
// modal kinds: 'confirm-delete' | 'lane-edit' | 'confirm-lane-delete'
export const modal         = signal(null);
export const errorMsg      = signal(null);
// Resolved on boot from /api/me (gh hosts.yml -> git user.name -> hostname -> "me").
export const meAuthor      = signal("me");
// Inbox tab: "updates" (default, shows the active task's update thread) or
// "authors" (shows recent author activity from /api/authors).
export const tab           = signal("updates");
// Author rollups loaded lazily when the Authors tab is opened. Each entry
// is { author, last_seen, posts } from /api/authors.
export const authors       = signal([]);

// ---------- platform-aware keyboard hint ----------
// macOS gets the ⌘ glyph; everyone else gets the literal word "Ctrl". Used by
// every keyboard hint in the UI so we never make a Linux user squint at a
// Mac key icon. Always include "+" between modifier and key for visual
// parity across platforms.
export const IS_MAC = typeof navigator !== "undefined"
  && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");
export const MOD = IS_MAC ? "\u2318" : "Ctrl";
export const kbd = (key) => `${MOD} + ${key}`;

// ---------- theme ----------
// Two-state theme model: "light" or "dark". CSS handles both via
// :root[data-theme="light"|"dark"] selectors. JS is responsible for reading
// the persisted choice on boot, writing the dataset attribute, and
// persisting on toggle.
//
// First-load default: matchMedia(prefers-color-scheme: dark). After that,
// the user's choice always wins and is persisted forever — no "system"
// option that changes under them.
const THEME_KEY = "cortex-theme";
const THEME_VALUES = ["light", "dark"];

function systemPrefersDark() {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function readStoredTheme() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (THEME_VALUES.includes(v)) return v;
  } catch { /* private mode — fall through */ }
  return systemPrefersDark() ? "dark" : "light";
}

export const theme = signal(readStoredTheme());

// Apply a theme to the DOM and persist it.
export function setTheme(mode) {
  if (!THEME_VALUES.includes(mode)) mode = "light";
  theme.value = mode;
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-theme", mode);
  }
  try { localStorage.setItem(THEME_KEY, mode); } catch { /* ignore */ }
}

// Flip light ↔ dark.
export function toggleTheme() {
  setTheme(theme.value === "dark" ? "light" : "dark");
}

// Apply the resolved theme to the DOM at module load (before first paint),
// so a hard refresh never flashes the wrong palette.
if (typeof document !== "undefined") setTheme(theme.value);

// ---------- computed ----------
// Sentinel value for "filter to untagged tasks". Picked to be collision-free
// against TAG_NAME_RE (/^[a-z0-9_@-]{1,32}$/, src/store.ts:55) — the null
// byte cannot appear in a real tag name, so equality checks are safe.
export const UNTAGGED = "\u0000untagged";

export const tasksInLane = computed(() => {
  const lane = selectedLane.value;
  const tag  = selectedTag.value;
  let out = tasks.value;
  if (lane) out = out.filter(t => t.lane === lane);
  if (tag === UNTAGGED) {
    out = out.filter(t => !Array.isArray(t.tags) || t.tags.length === 0);
  } else if (tag) {
    out = out.filter(t => Array.isArray(t.tags) && t.tags.includes(tag));
  }
  return out;
});
export const activeTask = computed(() => {
  const list = tasksInLane.value;
  if (selectedId.value != null) {
    const t = list.find(x => x.id === selectedId.value);
    if (t) return t;
  }
  // Fall back to the highest-priority open task in the current view.
  return list.find(t => t.status !== "done") ?? list[0] ?? null;
});
export const inboxList = computed(() => {
  const at = activeTask.value;
  if (!at) return [];
  return [...(updates.value[at.id] ?? [])].reverse();
});
// Tasks currently in the blocked status. Drives the sticky red top-bar in
// App() and the click-to-jump behaviour (selects the first one).
export const blockedTasks = computed(() => tasks.value.filter(t => t.status === "blocked"));

// ---------- API ----------
const j = (p, init) => fetch(p, init).then(async r => {
  const txt = await r.text();
  const body = txt ? JSON.parse(txt) : null;
  if (!r.ok) throw new Error(body?.error ?? r.statusText);
  return body;
});
export const api = {
  tasks:    ()                => j("/api/tasks"),
  lanes:    ()                => j("/api/lanes"),
  updates:  (id)              => j(`/api/tasks/${id}/updates`),
  addTask:  (b)               => j("/api/tasks",            { method:"POST",   headers:{"content-type":"application/json"}, body: JSON.stringify(b) }),
  editTask: (id, b)           => j(`/api/tasks/${id}`,      { method:"PATCH",  headers:{"content-type":"application/json"}, body: JSON.stringify(b) }),
  setStat:  (id, status)      => j(`/api/tasks/${id}/status`,{ method:"PATCH", headers:{"content-type":"application/json"}, body: JSON.stringify({status}) }),
  moveLane: (id, lane)        => j(`/api/tasks/${id}/lane`, { method:"PATCH",  headers:{"content-type":"application/json"}, body: JSON.stringify({lane}) }),
  delTask:  (id)              => j(`/api/tasks/${id}`,      { method:"DELETE" }),
  postUpd:  (id, b)           => j(`/api/tasks/${id}/updates`, { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify(b) }),
  addLane:  (b)               => j("/api/lanes",            { method:"POST",   headers:{"content-type":"application/json"}, body: JSON.stringify(b) }),
  editLane: (n, b)            => j(`/api/lanes/${encodeURIComponent(n)}`, { method:"PATCH",  headers:{"content-type":"application/json"}, body: JSON.stringify(b) }),
  delLane:  (n)               => j(`/api/lanes/${encodeURIComponent(n)}`, { method:"DELETE" }),
  // ---- tags ----
  tags:     ()                => j("/api/tags"),
  setTags:  (id, ns)          => j(`/api/tasks/${id}/tags`, { method:"PATCH", headers:{"content-type":"application/json"}, body: JSON.stringify({ set: ns }) }),
  addTag:   (b)               => j("/api/tags",            { method:"POST",   headers:{"content-type":"application/json"}, body: JSON.stringify(b) }),
  editTag:  (n, b)            => j(`/api/tags/${encodeURIComponent(n)}`, { method:"PATCH",  headers:{"content-type":"application/json"}, body: JSON.stringify(b) }),
  // `force` cascades the join rows. Mirrors the CLI's `cortex tag rm -f`.
  delTag:   (n, force)        => j(`/api/tags/${encodeURIComponent(n)}${force ? "?force=1" : ""}`, { method:"DELETE" }),
};

// ---------- error surfacing ----------
export const showError = (e) => {
  const msg = String(e?.message ?? e);
  errorMsg.value = msg;
  // Clear the toast after 4s — but only if it's still the same message we set.
  // Otherwise a newer error would flash and immediately disappear.
  setTimeout(() => { if (errorMsg.value === msg) errorMsg.value = null; }, 4000);
};
export const tryApi = async (fn) => {
  try { return await fn(); } catch (e) { showError(e); throw e; }
};

// Lazy load of the author rollup. Called when the user opens the Authors
// tab in the inbox pane. Errors surface via the standard toast.
export const fetchAuthors = async () => {
  try {
    authors.value = await fetch("/api/authors").then(r => r.json());
  } catch (e) {
    showError(e);
  }
};

// ---------- refresh ----------
// Re-pulls tasks + lanes (and updates for the active task) from the server.
// Called at boot and on every SSE event from the daemon (debounced in app.js).
export async function refresh() {
  try {
    const [ts, ls, tg] = await Promise.all([api.tasks(), api.lanes(), api.tags()]);
    tasks.value = ts; lanes.value = ls; tags.value = tg;
    const at = activeTask.value;
    if (at) updates.value = { ...updates.value, [at.id]: await api.updates(at.id) };
  } catch (err) {
    showError(err);
  }
}

// Reactive: when activeTask changes id, lazily fetch its updates so the inbox
// pane is populated even if the task was created mid-session.
let lastActive = null;
effect(() => {
  const at = activeTask.value;
  if (at && at.id !== lastActive) {
    lastActive = at.id;
    api.updates(at.id)
      .then(u => { updates.value = { ...updates.value, [at.id]: u }; })
      .catch(() => { /* swallow — listing is non-critical */ });
  }
});

// ---------- pure helpers ----------
export const fmtTime = (ms) => {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s/60) + "m ago";
  if (s < 86400) return Math.floor(s/3600) + "h ago";
  return Math.floor(s/86400) + "d ago";
};
export const initial = (s) => (s || "?").trim().charAt(0).toUpperCase();
export const STATUS = ["open","review","blocked","done"];
export const STATUS_LABEL = { open: "Open", review: "In review", blocked: "Blocked", done: "Done" };
export const nextStatusFor   = (s) => ({ open: "review", review: "done", blocked: "open", done: "open" }[s]);
export const nextActionLabel = (s) => ({ open: "Move to review", review: "Mark done", blocked: "Unblock", done: "Reopen" }[s]);

// Priority: 0 = highest. Render as P0/P1/... with urgent/high/normal styling.
export const priorityClass = (p) => p === 0 ? "urgent" : p === 1 ? "high" : "";

// Lookup a lane's color (or null). Used by lane chip + color dot in lists.
export const laneColor = (name) => lanes.value.find(l => l.name === name)?.color || null;
// Lookup a tag's color (or null). Used by TagPill in the active-task popover
// and TagsPane rows. Returns null when the tag has no color OR is not yet
// present in the rollup (e.g. just-created via SSE round-trip) — the pill
// falls back to the neutral .tag-pill background defined in styles.css.
export const tagColor = (name) => tags.value.find(t => t.name === name)?.color || null;

// Client-side mirror of TAG_NAME_RE in src/store.ts. Used to gate the
// "Create '<search>' tag" affordance in TagPicker before sending a request
// the server would just 400 anyway. Keep the regex in lockstep with the
// server-side one — if you change one, change both.
export const TAG_NAME_RE = /^[a-z0-9_@-]{1,32}$/;
export const isValidTagName = (s) =>
  typeof s === "string" && TAG_NAME_RE.test(s.trim());

// ---------- color algorithm (GitHub IssueLabelToken-style) ----------
// One hex → readable pill in BOTH themes, no per-pill text-color tuning.
// Mirrors Primer's IssueLabelToken.module.css algorithm: parse hex to RGB +
// HSL, expose them as CSS custom properties on the pill element, let the
// stylesheet derive perceived-lightness, switch text to black/white, and
// pick a border tone. See /tmp/gh-research/IssueLabelToken.module.css for
// the source we mirrored.
//
// Returns null when input is missing/malformed; callers fall through to the
// neutral .tag-pill background.
export function parseHex(hex) {
  if (!hex || typeof hex !== "string" || hex[0] !== "#") return null;
  let h = hex.slice(1);
  // Accept #rgb shorthand by doubling each nibble (#abc → #aabbcc).
  if (h.length === 3) h = h.split("").map(c => c + c).join("");
  if (h.length !== 6) return null;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if ([r, g, b].some(n => Number.isNaN(n))) return null;
  return { r, g, b };
}

// Standard RGB → HSL conversion (W3C / colorjs). Inputs in 0-255, outputs
// h: 0-360, s: 0-100, l: 0-100 — matching Primer's expected variable units.
export function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h, s; const l = (max + min) / 2;
  if (max === min) { h = 0; s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

// Build the inline style object a TagPill applies when a color is present.
// Returns {} when hex is null/invalid so the pill cleanly falls through to
// the neutral CSS rule. The CSS-side rules in styles.css consume these
// six custom properties and derive perceived-lightness / text-color / border.
export function tagPillStyleFromHex(hex) {
  const rgb = parseHex(hex);
  if (!rgb) return {};
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  return {
    "--label-r": String(rgb.r),
    "--label-g": String(rgb.g),
    "--label-b": String(rgb.b),
    "--label-h": String(hsl.h),
    "--label-s": String(hsl.s),
    "--label-l": String(hsl.l),
  };
}

// Curated swatch palette for the lane color picker. null = "no color".
export const LANE_COLORS = [
  null,
  "#fe8019",
  "#dc2626","#d97706","#16a34a","#2563eb","#7c3aed","#db2777",
  "#f87171","#fbbf24","#4ade80","#60a5fa","#a78bfa","#f472b6",
  "#94a3b8","#475569",
];

// ---------- selection navigation ----------
// Cycle the active selection forwards/backwards through tasksInLane. Used by
// the command palette's "Next task"/"Previous task" entries.
export function moveSelection(delta) {
  const list = tasksInLane.value;
  if (list.length === 0) return;
  const at = activeTask.value;
  const i = Math.max(0, list.findIndex(t => at && t.id === at.id));
  const next = list[(i + delta + list.length) % list.length];
  selectedId.value = next.id;
}

// ---------- popover bookkeeping ----------
// Centralised so the outside-click listener (app.js) and Esc handler (app.js)
// don't have to know which popover signals exist. Returns true iff at least
// one signal was actually open (and got closed) so the Esc cascade in app.js
// can branch on "did anything happen?" without enumerating signals at the
// call site — future-proofs against new popovers being added without the
// Esc handler being updated (the bug that hid Esc-closes-tag-picker for one
// release of this feature).
export function closeAllPopovers() {
  let closed = false;
  if (statusPopover.value) { statusPopover.value = false; closed = true; }
  if (newLaneOpen.value)   { newLaneOpen.value   = false; closed = true; }
  if (tagsPopover.value)   { tagsPopover.value   = false; closed = true; }
  if (newTagOpen.value)    { newTagOpen.value    = false; closed = true; }
  return closed;
}
