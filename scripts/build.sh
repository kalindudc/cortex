#!/usr/bin/env bash
# Compile cortex CLI to a single binary at bin/cortex.
#
# bun is a pinned devDependency (see package.json). pnpm exec resolves it
# from node_modules/.bin, so no global bun install is required.
#
# NOTE: bun is pinned to EXACTLY 1.4.2 (no caret; @types/bun and CI match).
# --bytecode itself is required: the no-bytecode --compile output produces a
# different self-extract layout that doesn't run cleanly on all macOS setups.
# The bytecode MUST be ESM (--format=esm, supported since bun 1.3.9). citty +
# hono pull transitive CJS, and CommonJS bytecode is broken for this module
# graph on newer bun: 1.4.2 panics at build time ("index out of bounds ...
# the index is 18446744073709551615") and 1.3.14 prints "Failed to generate
# bytecode", then ships a binary that dies with "Expected CommonJS module to
# have a function wrapper" (oven-sh/bun#25398, #21137; see plan @400 N25).
# bun 1.1.12's --compile also inlined every process.env.X set at BUILD time;
# 1.4.2 defaults to --env=disable, so env vars are read at runtime.
# Re-verify the compiled binary and the full suite before changing the pin.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

pnpm install --frozen-lockfile

# Wipe the old binary BEFORE rebuilding, so a build that silently fails
# partway through never leaves a stale bin/cortex for tools (or `pnpm run
# deploy`'s cp) to reuse. bin/ is .gitignored and fully regenerated below.
# CORTEX_BUILD_TARGET cross-compiles to bin/cortex-<os>-<arch> and keeps the rest of bin/, so one machine
# can build every binary the desktop packager needs. Unset, nothing changes.
if [ -n "${CORTEX_BUILD_TARGET:-}" ]; then
  case "$CORTEX_BUILD_TARGET" in
    bun-darwin-arm64 | bun-darwin-x64 | bun-linux-x64 | bun-linux-arm64) ;;
    *) echo "error: unsupported CORTEX_BUILD_TARGET=$CORTEX_BUILD_TARGET" >&2; exit 1 ;;
  esac
  TARGET="$CORTEX_BUILD_TARGET"
  OUT="bin/cortex-${TARGET#bun-}"
  mkdir -p "$ROOT/bin"
  rm -f "$ROOT/$OUT"
else
  TARGET="bun-$(uname | tr '[:upper:]' '[:lower:]')-$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')"
  OUT="bin/cortex"
  rm -rf "$ROOT/bin"
fi

pnpm exec bun build index.ts --compile --minify --bytecode --format=esm \
  --target="$TARGET" --outfile "$OUT"

chmod +x "$OUT"
echo "✓ Built $OUT"
