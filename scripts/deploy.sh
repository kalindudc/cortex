#!/usr/bin/env bash
# deploy.sh — `pnpm run deploy`: local install on this machine.
#
# Installs the CLI binary to ~/bin/cortex, then installs the desktop package
# `pnpm run desktop:dist` built for this tree: the AppImage into
# ~/Applications on Linux, the .app from the dmg into /Applications (or
# ~/Applications when /Applications is not writable) on macOS. Compiling the
# desktop packages is desktop:dist's job — when none is built, deploy says
# so and leaves the CLI-only install complete.

set -euo pipefail

cd "$(dirname "$0")/.."

pnpm run build
rm -f "$HOME/bin/cortex"
cp bin/cortex "$HOME/bin/"
echo "✓ Installed the cortex CLI to $HOME/bin/cortex"

version="$(node -p "require('./package.json').version")"
case "$(uname)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *)
    echo "note: the desktop app packages for macOS and Linux only; installed the CLI alone"
    exit 0
    ;;
esac

case "$os" in
  linux)
    app="integrations/desktop/dist/Cortex-$version.AppImage"
    if [ ! -f "$app" ]; then
      echo "note: no desktop package built yet; run pnpm run desktop:dist, then pnpm run deploy again"
      exit 0
    fi
    mkdir -p "$HOME/Applications"
    cp "$app" "$HOME/Applications/"
    chmod +x "$HOME/Applications/Cortex-$version.AppImage"
    echo "✓ Installed the desktop app to $HOME/Applications/Cortex-$version.AppImage"
    ;;
  darwin)
    # The dist step may have built one or both architectures; take the first dmg.
    dmg="$(ls integrations/desktop/dist/Cortex-$version-*.dmg 2>/dev/null | head -n 1 || true)"
    if [ -z "$dmg" ]; then
      echo "note: no desktop package built yet; run pnpm run desktop:dist, then pnpm run deploy again"
      exit 0
    fi
    mount="$(mktemp -d)"
    trap 'hdiutil detach "$mount" -quiet 2>/dev/null || true' EXIT
    hdiutil attach -nobrowse -readonly -mountpoint "$mount" "$dmg"
    if [ ! -d "$mount/Cortex.app" ]; then
      echo "error: $dmg does not contain Cortex.app" >&2
      exit 1
    fi
    if [ -w /Applications ]; then
      dest=/Applications
    else
      dest="$HOME/Applications"
      mkdir -p "$dest"
    fi
    rm -rf "$dest/Cortex.app"
    cp -R "$mount/Cortex.app" "$dest/"
    hdiutil detach "$mount" -quiet
    echo "✓ Installed the desktop app to $dest/Cortex.app"
    ;;
esac
