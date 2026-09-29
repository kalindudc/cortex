#!/usr/bin/env bash
# dev-env.sh — sourced by the dev scripts (dev-cli.sh, dev.sh); defines
# dev_env_setup <repo-root>.
#
# By default, development runs use a sandbox under tmp/dev/ (gitignored), not
# your real ~/.config/cortex:
#   - Unreleased code must not migrate the database your installed cortex uses.
#   - A running daemon from an older installed binary blocks new-binary commands
#     against the same config (the legacy-daemon fence), so dev runs against
#     real data would fail anyway while it is up.
#
# Overrides:
#   CORTEX_DEV_REAL=1       use your real config/database (nothing is redirected)
#   CORTEX_DB=<path>        use this database; config is still sandboxed unless
#                           XDG_CONFIG_HOME is set too
#   CORTEX_DEV_HOME=<dir>   put the sandbox somewhere other than tmp/dev
#
# XDG_CONFIG_HOME alone is NOT treated as an opt-out: many setups export it
# globally (often as ~/.config), which would silently point dev at real data.
# The skill and pi-extension directories are sandboxed too, so `agents install`
# from dev never rewrites ~/.agents/skills or ~/.pi/agent/extensions.

dev_env_setup() {
  local root="$1"
  if [ "${CORTEX_DEV_REAL:-}" = "1" ]; then
    echo "[dev] CORTEX_DEV_REAL=1: using your real cortex config and database" >&2
    return 0
  fi
  local base="${CORTEX_DEV_HOME:-$root/tmp/dev}"
  mkdir -p "$base"
  if [ -n "${CORTEX_DB:-}" ]; then
    export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$base/config}"
  else
    export XDG_CONFIG_HOME="$base/config"
    export CORTEX_DB="$base/cortex.db"
  fi
  export CORTEX_SKILL_DIR="${CORTEX_SKILL_DIR:-$base/skills}"
  export CORTEX_PI_EXTENSION_DIR="${CORTEX_PI_EXTENSION_DIR:-$base/extensions}"
  echo "[dev] sandbox data in $base (CORTEX_DEV_REAL=1 uses your real ~/.config/cortex)" >&2
}
