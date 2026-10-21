#!/usr/bin/env bash
# cli-dist.sh — `pnpm run cli:dist [-- <arch>...]`: the release files for this OS in out/release/.
#
# Builds the CLI for each architecture (macOS: arm64 and x64; Linux: the host's,
# unless architectures are named) and packs it as
# cortex-<version>-<os>-<arch>.tar.gz with LICENSE and README.md. It copies the
# desktop packages `pnpm run desktop:dist` built for this version, when there
# are any, and writes SHA256SUMS over everything. Release CI uploads the
# folder; `pnpm run deploy` installs from it with scripts/install.sh.

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
    echo "error: cli:dist builds for macOS and Linux only, not $(uname)" >&2
    exit 1
    ;;
esac
# pnpm 10 passes the `--` of `pnpm run cli:dist -- arm64` through.
if [ "${1:-}" = "--" ]; then shift; fi
archs="${*:-$default_archs}"
version="$(node -p "require('./package.json').version")"
out=out/release

rm -rf "$out"
mkdir -p "$out"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

for arch in $archs; do
  CORTEX_BUILD_TARGET="bun-$os-$arch" bash scripts/build.sh
  cp "bin/cortex-$os-$arch" "$stage/cortex"
  cp LICENSE README.md "$stage/"
  # COPYFILE_DISABLE keeps macOS tar from adding ._ metadata files.
  COPYFILE_DISABLE=1 tar -czf "$out/cortex-$version-$os-$arch.tar.gz" -C "$stage" cortex LICENSE README.md
  rm -f "$stage/cortex" "$stage/LICENSE" "$stage/README.md"
done

for package in integrations/desktop/dist/Cortex-"$version"-*; do
  case "$package" in
    *.dmg | *.zip | *.AppImage | *.deb) cp "$package" "$out/" ;;
  esac
done

if command -v sha256sum >/dev/null 2>&1; then
  sum() { sha256sum "$@"; }
else
  sum() { shasum -a 256 "$@"; }
fi
(cd "$out" && sum -- * >"$stage/SHA256SUMS")
mv "$stage/SHA256SUMS" "$out/SHA256SUMS"

echo "✓ Release files for cortex $version in $out/:"
ls -1 "$out"
