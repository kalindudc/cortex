#!/usr/bin/env bash
# dev-desktop.sh — `pnpm run desktop:dev [-- <electron args>]`: build the
# daemon binary, the renderer and the Electron bundles, then open the desktop
# app on the dev sandbox (tmp/dev/), exactly as `pnpm run dev` does for the
# CLI; see scripts/dev-env.sh for CORTEX_DEV_REAL=1 and the other overrides.
# Unless CORTEX_DEV_REAL=1, Electron's own profile lives in the sandbox too.

set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/dev-env.sh
. "$DIR/scripts/dev-env.sh"
dev_env_setup "$DIR"

cd "$DIR"
if [ ! -x bin/cortex ] || [ -n "$(find src index.ts -newer bin/cortex -print -quit)" ]; then
  pnpm run build
fi
pnpm run ui:build
pnpm run desktop:build
if [ ! -x integrations/desktop/node_modules/.bin/electron ]; then
  npm --prefix integrations/desktop ci
fi

profile=()
if [ "${CORTEX_DEV_REAL:-}" != "1" ]; then
  data_dir="${CORTEX_DEV_HOME:-$DIR/tmp/dev}/electron"
  mkdir -p "$data_dir"
  profile=("--user-data-dir=$data_dir")
fi

export CORTEX_DESKTOP_CORTEX_BIN="$DIR/bin/cortex"
export CORTEX_UI_DIR="$DIR/out/ui"
exec integrations/desktop/node_modules/.bin/electron "$DIR/integrations/desktop" ${profile[@]+"${profile[@]}"} "$@"
