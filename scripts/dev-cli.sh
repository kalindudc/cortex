#!/usr/bin/env bash
# dev-cli.sh — `pnpm run dev [-- <cortex args>]`: run cortex from source with Bun
# (no compile step). With no arguments on an interactive terminal it opens the
# TUI, exactly like the installed `cortex`.
#
# Data goes to the dev sandbox (tmp/dev/) unless you opt out; see
# scripts/dev-env.sh. From source, src/server.ts embeds out/bundle.{js,css}
# as file assets, so the dashboard bundle is built once if it is missing.
# `pnpm run ui:build` refreshes it on demand, and `pnpm run serve:dev` keeps
# it rebuilt while you edit.

set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/dev-env.sh
. "$DIR/scripts/dev-env.sh"
dev_env_setup "$DIR"

if [ ! -f "$DIR/out/bundle.js" ] || [ ! -f "$DIR/out/bundle.css" ]; then
  echo "[dev] out/ is missing; building the dashboard bundle once (pnpm run ui:build)" >&2
  (cd "$DIR" && pnpm run ui:build >/dev/null)
fi

exec "$DIR/node_modules/.bin/bun" "$DIR/index.ts" "$@"
