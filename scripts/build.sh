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

# Wipe stale build outputs BEFORE rebuilding. Two cases this protects against:
#
#   1. `pnpm run serve:dev` (or `pnpm run ui:watch`) leaves a NON-MINIFIED
#      out/bundle.{js,css} on disk. If we don't clean, the next `bun build
#      --compile` can end up embedding (or referencing) the dev-mode asset
#      instead of the just-rebuilt minified one — symptom: features added
#      after the last dev session are missing from the deployed binary even
#      though they're present in source.
#   2. Old bin/cortex from a previous build is reused by tools (or by `pnpm
#      run deploy`'s cp) when a fresh build silently fails partway through.
#
# Both directories are .gitignored and fully regenerated below, so removing
# them is always safe.
rm -rf "$ROOT/out" "$ROOT/bin"

# UI bundle MUST exist before the server build embeds it via
# `with { type: "file" }` imports of out/bundle.{js,css}.
pnpm run ui:build

TARGET="bun-$(uname | tr '[:upper:]' '[:lower:]')-$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')"

pnpm exec bun build index.ts --compile --minify --bytecode --format=esm \
  --target="$TARGET" --outfile bin/cortex

chmod +x bin/cortex
echo "✓ Built bin/cortex"
