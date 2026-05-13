#!/usr/bin/env bash
# Compile cortex CLI to a single binary at bin/cortex.
#
# bun is a pinned devDependency (see package.json). pnpm exec resolves it
# from node_modules/.bin, so no global bun install is required.
#
# NOTE: bun is pinned to EXACTLY 1.1.12 (no caret) because newer bun
# (>=1.3) regressed --bytecode on bundles containing CJS deps — the
# produced binary crashes with "Expected CommonJS module to have a
# function wrapper" (oven-sh/bun#25398, #25300, #21137). citty + hono
# both pull transitive CJS, so we hit it. --bytecode itself is required:
# the no-bytecode --compile output produces a different self-extract
# layout that doesn't run cleanly on all macOS setups. When bun fixes the
# bytecode-CJS regression upstream, lift this pin.

set -euo pipefail

pnpm install --frozen-lockfile

TARGET="bun-$(uname | tr '[:upper:]' '[:lower:]')-$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')"

pnpm exec bun build index.ts --compile --minify --bytecode \
  --target="$TARGET" --outfile bin/cortex

chmod +x bin/cortex
echo "✓ Built bin/cortex"
