#!/usr/bin/env bash
# dev.sh — Live-reload dev orchestrator for `pnpm run serve:dev`.
#
# Runs three watchers and one server, all glued together so that editing
# any UI source file (TS/TSX/CSS) causes the browser tab to refresh:
#
#   1. `bun build src/ui/index.tsx --watch`  → rewrites out/bundle.js on TSX edit
#   2. `bun scripts/watch-css.ts`            → rewrites out/bundle.css on CSS slice edit
#   3. `bun --watch index.ts serve …`        → restarts the daemon on server-side TS edit
#
# The server (CORTEX_DEV=1) exposes /api/dev-reload SSE; src/ui/dev-reload.ts
# subscribes from the browser and calls location.reload() on every event.
# It's a no-op outside dev because the route is unregistered when CORTEX_DEV
# is unset.
#
# Cleanup: bash trap on INT/TERM/EXIT kills the two background PIDs.
# Verified by checking `lsof -iTCP -sTCP:LISTEN -P | grep 7777` is empty
# after Ctrl+C. macOS bash 3.2 compatible (no associative arrays).

set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

PORT="${PORT:-7777}"

# Stop any existing detached daemon. Suppress errors because "no daemon
# running" is the common case and not an error worth surfacing.
pnpm exec bun index.ts stop >/dev/null 2>&1 || true

# 1. Initial CSS build so the first browser load has fresh styles.
bash scripts/build-css.sh

# 2. Background: UI JS bundler in watch mode.
pnpm exec bun build src/ui/index.tsx \
  --target browser \
  --outdir out \
  --sourcemap=external \
  --entry-naming bundle.[ext] \
  --asset-naming bundle.[ext] \
  --watch &
UI_WATCH_PID=$!

# 3. Background: CSS slice watcher.
pnpm exec bun scripts/watch-css.ts &
CSS_WATCH_PID=$!

SERVER_PID=""

# Recursively kill a PID and all its descendants. We can't just signal the
# top-level child because pnpm wraps `pnpm exec bun …` in node → sh → bun.exe,
# and signalling the node wrapper alone leaves the bun.exe grandchild alive
# (port 7777 stays bound). Walk the tree depth-first using `pgrep -P` so the
# leaves die first.
kill_tree() {
  local pid="$1"
  local sig="$2"
  [[ -z "$pid" ]] && return 0
  local child
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    kill_tree "$child" "$sig"
  done
  kill "-$sig" "$pid" 2>/dev/null || true
}

# Cleanup on exit. Kill the server first (so bun --watch stops respawning),
# then the two background watchers. We do NOT `exec` the server below — the
# whole point of running it as a child is so this trap can fire on Ctrl+C.
cleanup() {
  trap - INT TERM EXIT
  for pid in "$SERVER_PID" "$UI_WATCH_PID" "$CSS_WATCH_PID"; do
    kill_tree "$pid" TERM
  done
  # Give them a moment to wind down, then SIGKILL anything still alive.
  sleep 0.3
  for pid in "$SERVER_PID" "$UI_WATCH_PID" "$CSS_WATCH_PID"; do
    kill_tree "$pid" KILL
  done
}
trap cleanup INT TERM EXIT

echo "[dev] watchers up: ui-js=$UI_WATCH_PID css=$CSS_WATCH_PID — starting server on :$PORT"

# 4. Foreground (sort of): the cortex daemon itself with bun --watch, so
# server-side TS edits restart it. CORTEX_DEV=1 unlocks /api/dev-reload.
# Run as a backgrounded child so SIGINT in this terminal still reaches the
# trap above; then `wait` blocks until the server exits.
CORTEX_DEV=1 pnpm exec bun --watch index.ts serve --foreground --no-open --port "$PORT" &
SERVER_PID=$!
wait "$SERVER_PID"
