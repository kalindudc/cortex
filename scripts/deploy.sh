#!/usr/bin/env bash
# deploy.sh — `pnpm run deploy`: install this checkout's build on this machine.
#
# Packs the CLI for this machine's architecture with scripts/cli-dist.sh, then
# installs it with scripts/install.sh, the installer users run, into ~/bin
# (keep it on your PATH). When `pnpm run desktop:dist` built this version, the
# desktop app is installed too; otherwise the installer says how to build it.

set -euo pipefail

cd "$(dirname "$0")/.."

arch="$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')"
bash scripts/cli-dist.sh "$arch"
CORTEX_INSTALL_FROM="$PWD/out/release" CORTEX_VERSION="$(node -p "require('./package.json').version")" \
  CORTEX_BIN_DIR="$HOME/bin" sh scripts/install.sh
