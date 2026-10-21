#!/usr/bin/env bash
# desktop-dist.sh — `pnpm run desktop:dist`: package the desktop app for this
# OS into integrations/desktop/dist/ (macOS: a dmg and a zip for arm64 and
# x64; Linux: an AppImage and a deb for the host architecture). It installs
# nothing; `pnpm run deploy` installs what this produces (the AppImage on
# Linux, the dmg's .app on macOS). CORTEX_DESKTOP_ARCHS (space separated, e.g.
# "arm64") narrows the architectures.
#
# Each package carries the cortex binary built for its own architecture,
# bin/cortex-<os>-<arch>. A native `pnpm run build` (and so `pnpm test`)
# removes those files, so run this after it, never before.

set -euo pipefail

cd "$(dirname "$0")/.."

case "$(uname)" in
  Darwin)
    os=darwin
    default_archs="arm64 x64"
    ;;
  Linux)
    os=linux
    default_archs="$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')"
    ;;
  *)
    echo "error: desktop:dist packages for macOS and Linux only, not $(uname)" >&2
    exit 1
    ;;
esac
archs="${CORTEX_DESKTOP_ARCHS:-$default_archs}"

for arch in $archs; do
  CORTEX_BUILD_TARGET="bun-$os-$arch" bash scripts/build.sh
done
pnpm run ui:build
pnpm run desktop:build
npm --prefix integrations/desktop ci

# electron-builder skips a missing extraResources source without a warning,
# which would ship an app with no cortex binary.
arch_flags=""
for arch in $archs; do
  if [ ! -x "bin/cortex-$os-$arch" ]; then
    echo "error: bin/cortex-$os-$arch is missing or not executable" >&2
    exit 1
  fi
  arch_flags="$arch_flags --$arch"
done

version="$(node -p "require('./package.json').version")"
# shellcheck disable=SC2086 # arch_flags is a list of separate flags
# electron-builder publishes by itself when CI builds a git tag; only release.yml publishes.
npm --prefix integrations/desktop run dist -- --publish never "-c.extraMetadata.version=$version" $arch_flags
