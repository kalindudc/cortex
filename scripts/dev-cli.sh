#!/usr/bin/env bash
# dev-cli.sh — `pnpm run dev [-- <cortex args>]`: run cortex from source with Bun
# (no compile step). With no arguments on an interactive terminal it opens the
# TUI, exactly like the installed `cortex`.
#
# Data goes to the dev sandbox (tmp/dev/) unless you opt out; see
# scripts/dev-env.sh.

set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/dev-env.sh
. "$DIR/scripts/dev-env.sh"
dev_env_setup "$DIR"

exec "$DIR/node_modules/.bin/bun" "$DIR/index.ts" "$@"
