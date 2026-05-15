#!/usr/bin/env bash
# build-repo-map.sh — regenerates `.cortex/repo-map.md` (via `repomix --compress`)
# and the `arch:src` marker block in AGENTS.md (via `scripts/sync-arch-block.ts`).
#
# Run as `pnpm run agents:map`. Idempotent — safe to run repeatedly.
# macOS bash 3.2 compatible (no associative arrays, no `mapfile`).
#
# The marker-block rewrite is delegated to a Bun script because macOS BSD awk
# lacks `gensub` and `-i inplace`; a Bun script is portable + type-checked and
# matches the precedent set by `scripts/watch-css.ts`.

set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

mkdir -p .cortex

pnpm exec repomix \
  --compress --style markdown \
  --output .cortex/repo-map.md \
  --include "src/**,index.ts,scripts/**,test/**" \
  --ignore "out/**,bin/**,tmp/**,node_modules/**,**/*.test.ts,**/*.test.tsx"

pnpm exec bun scripts/sync-arch-block.ts

echo "✓ regenerated .cortex/repo-map.md and AGENTS.md arch:src block"
