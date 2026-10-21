#!/bin/sh
# install.sh — install cortex on macOS or Linux: the CLI and the desktop app, both of one version.
#
#   curl -fsSL https://github.com/kalindudc/cortex/releases/latest/download/install.sh | sh
#
# Settings, all optional:
#   CORTEX_VERSION=0.99.0   the version to install (default: the latest release)
#   CORTEX_BIN_DIR=<dir>    where the cortex CLI goes (default: ~/.local/bin)
#   CORTEX_NO_APP=1         install the CLI only
#   CORTEX_NO_CLI=1         install the desktop app only, for example when Homebrew provides the CLI
#   CORTEX_INSTALL_FROM=<dir>  read the release files from a folder instead of GitHub (needs
#                           CORTEX_VERSION); `pnpm run deploy` installs a local build this way
#
# Every file is checked against the release's SHA256SUMS before anything is installed. The
# desktop app goes to /Applications (or ~/Applications) on macOS, is installed with apt on
# Debian and Ubuntu, and goes to ~/Applications as an AppImage on other Linux systems.

set -eu

REPO="https://github.com/kalindudc/cortex"

say() { printf '%s\n' "$*"; }
fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "cortex supports macOS and Linux, not $(uname -s)" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) fail "cortex supports x64 and arm64 processors, not $(uname -m)" ;;
esac
# A shell running under Rosetta reports x86_64 on an Apple silicon Mac.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  arch=arm64
fi

from="${CORTEX_INSTALL_FROM:-}"
version="${CORTEX_VERSION:-}"
if [ -z "$version" ]; then
  [ -z "$from" ] || fail "CORTEX_INSTALL_FROM needs CORTEX_VERSION"
  # The latest release's page redirects to its tag, which avoids GitHub's API and its rate limit.
  latest="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$REPO/releases/latest")" || fail "could not reach $REPO"
  version="${latest##*/tag/v}"
  [ "$version" != "$latest" ] || fail "found no release at $REPO/releases"
fi
bin_dir="${CORTEX_BIN_DIR:-$HOME/.local/bin}"
want_cli=1
want_app=1
[ "${CORTEX_NO_CLI:-}" != 1 ] || want_cli=""
[ "${CORTEX_NO_APP:-}" != 1 ] || want_app=""
[ -n "$want_cli$want_app" ] || fail "CORTEX_NO_CLI and CORTEX_NO_APP together leave nothing to install"

tmp="$(mktemp -d)"
mnt=""
cleanup() {
  if [ -n "$mnt" ]; then hdiutil detach "$mnt" -quiet >/dev/null 2>&1 || true; fi
  rm -rf "$tmp"
}
trap cleanup EXIT
trap 'exit 1' INT TERM

if command -v sha256sum >/dev/null 2>&1; then
  hash_of() { sha256sum "$1" | awk '{ print $1 }'; }
else
  hash_of() { shasum -a 256 "$1" | awk '{ print $1 }'; }
fi

# fetch NAME copies the release file NAME into $tmp; it returns 1 when the local folder lacks it.
fetch() {
  if [ -n "$from" ]; then
    [ -f "$from/$1" ] || return 1
    cp "$from/$1" "$tmp/$1"
  else
    curl -fsSL -o "$tmp/$1" "$REPO/releases/download/v$version/$1" || fail "could not download $1 of cortex $version"
  fi
}

verify() {
  expected="$(awk -v f="$1" '$2 == f || $2 == "*" f { print $1 }' "$tmp/SHA256SUMS")"
  if [ -z "$expected" ] || [ "$expected" != "$(hash_of "$tmp/$1")" ]; then fail "checksum mismatch for $1"; fi
}

fetch SHA256SUMS || fail "$from has no SHA256SUMS"

if [ -n "$want_cli" ]; then
  cli="cortex-$version-$os-$arch.tar.gz"
  fetch "$cli" || fail "$from has no $cli"
  verify "$cli"
  mkdir "$tmp/cli"
  tar -xzf "$tmp/$cli" -C "$tmp/cli"
fi

app=""
if [ -n "$want_app" ]; then
  if [ "$os" = darwin ]; then
    app="Cortex-$version-mac-$arch.dmg"
  elif command -v apt-get >/dev/null 2>&1; then
    # The deb also installs the AppArmor profile Ubuntu needs to run Electron's sandbox.
    if [ "$arch" = x64 ]; then app="Cortex-$version-linux-amd64.deb"; else app="Cortex-$version-linux-arm64.deb"; fi
  else
    if [ "$arch" = x64 ]; then app="Cortex-$version-linux-x86_64.AppImage"; else app="Cortex-$version-linux-arm64.AppImage"; fi
  fi
  if fetch "$app"; then
    verify "$app"
  else
    say "note: no desktop package for cortex $version in $from; run pnpm run desktop:dist to build one"
    app=""
  fi
fi

if [ -n "$want_cli" ]; then
  mkdir -p "$bin_dir"
  # A new file, then a rename: macOS kills a signed binary that was overwritten in place.
  cp "$tmp/cli/cortex" "$bin_dir/.cortex.new"
  chmod 755 "$bin_dir/.cortex.new"
  mv -f "$bin_dir/.cortex.new" "$bin_dir/cortex"
  say "✓ Installed cortex $version to $bin_dir/cortex"
  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) say "  $bin_dir is not on your PATH; add it, for example: export PATH=\"$bin_dir:\$PATH\"" ;;
  esac
fi

case "$app" in
  *.dmg)
    mnt="$tmp/mnt"
    mkdir "$mnt"
    hdiutil attach -nobrowse -readonly -mountpoint "$mnt" "$tmp/$app" >/dev/null
    [ -d "$mnt/Cortex.app" ] || fail "$app does not contain Cortex.app"
    if [ -w /Applications ]; then
      dest=/Applications
    else
      dest="$HOME/Applications"
      mkdir -p "$dest"
    fi
    rm -rf "$dest/Cortex.app"
    ditto "$mnt/Cortex.app" "$dest/Cortex.app"
    hdiutil detach "$mnt" -quiet
    mnt=""
    say "✓ Installed the desktop app to $dest/Cortex.app"
    ;;
  *.deb)
    # apt reads the package as its own unprivileged user.
    chmod 755 "$tmp"
    chmod 644 "$tmp/$app"
    if [ "$(id -u)" = 0 ]; then apt-get install -y "$tmp/$app"; else sudo apt-get install -y "$tmp/$app"; fi
    say "✓ Installed the desktop app (cortex-desktop) with apt"
    ;;
  *.AppImage)
    mkdir -p "$HOME/Applications"
    cp "$tmp/$app" "$HOME/Applications/$app"
    chmod 755 "$HOME/Applications/$app"
    say "✓ Installed the desktop app to $HOME/Applications/$app"
    ;;
esac

# A daemon left over from an older cortex keeps serving it; it starts again on the new version when next needed.
# Without the CLI from this script, the cortex on PATH (Homebrew's, say) stops it.
if [ -n "$want_cli" ]; then
  "$bin_dir/cortex" stop || true
elif command -v cortex >/dev/null 2>&1; then
  cortex stop || true
fi

say ""
say "Next: cortex init creates (or updates) your database, and cortex agents install sets up your agents."
