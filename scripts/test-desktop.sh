#!/usr/bin/env bash
# test-desktop.sh — `pnpm run test:desktop`: build the daemon binary, the
# renderer and the Electron bundles, then typecheck and run the real-Chromium
# tests in integrations/desktop/test/. Every test makes its own temporary
# database, config, runtime and Electron profile directories.
# On Linux without a display, run it under xvfb-run.

set -euo pipefail

cd "$(dirname "$0")/.."
pnpm run build
pnpm run ui:build
pnpm run desktop:build
if [ ! -x integrations/desktop/node_modules/.bin/vitest ]; then
  npm --prefix integrations/desktop ci
fi
npm --prefix integrations/desktop run typecheck
npm --prefix integrations/desktop test
