---
name: release
description: Release a new cortex version (CHANGELOG section, `pnpm version`, tag push, the release workflow) and update this machine to it. Use when asked to release, cut, tag or publish cortex, or to install the latest release locally.
---

# Release

Repo-local skill for maintaining cortex (not embedded in the binary). The process is already decided; follow it
instead of researching it again. The sources of truth, if a step below stops matching: AGENTS.md (Releasing),
`.github/workflows/release.yml`, `scripts/release.ts`, `scripts/install.sh` and the `preversion`/`version` hooks in
`package.json`.

## Facts

- A release is a tag `vX.Y.Z` pushed to `main`. `release.yml` checks it (`scripts/release.ts check --tag`), reruns
  `test.yml` and `desktop.yml`, then publishes the GitHub Release (14 files: 4 CLI archives, a dmg and a zip per Mac
  architecture, an AppImage and a deb per Linux architecture, `install.sh`, `SHA256SUMS`) and, for a stable version,
  the Homebrew formula in `kalindudc/homebrew-tap`. A run that fails publishes nothing.
- `X.Y.Z-rc.N` publishes a prerelease to rehearse and leaves the tap alone; it uses the `## X.Y.Z` changelog section.
- The version lives in `package.json` and `integrations/desktop/package.json`; `pnpm version` keeps both in step.
- `main` has no branch protection and releases go straight to it, no pull request. Commits are signed (the user's git
  config does it); tags are annotated and unsigned, as `pnpm version` makes them.
- Version: semantic versioning, as CHANGELOG.md promises, read from the changelog section you wrote. Below 1.0,
  any new feature or changed behaviour bumps the minor (0.99.1 to 0.100.0); only fixes bump the patch
  (0.100.0 to 0.100.1). NEVER choose 1.0.0 or a new major on your own.
- This machine gets the CLI from Homebrew (`kalindudc/tap/cortex`, at `/opt/homebrew/bin/cortex`), and it is the only
  `cortex` on PATH; keep it that way, so never install the CLI into `~/bin` or `~/.local/bin` here. The installer puts
  the desktop app in `/Applications/Cortex.app` when that folder is writable (it is here), else in `~/Applications`;
  an older copy in the other folder stays behind.

## Steps

1. Preflight: the work is committed (one commit on the branch, per the user's git rules), rebased on `origin/main`
   (`git fetch origin && git rebase origin/main`), and the gates pass: `pnpm run style:check && pnpm test &&
   pnpm run docs:check`, plus `pnpm run test:bb` when `integrations/bb/` changed.
2. Add `## X.Y.Z - YYYY-MM-DD` at the top of `CHANGELOG.md` (newest first): a few user-facing bullets in the style of
   the existing sections, no task ids. Fold it into the branch's commit (`git commit --amend --no-edit`).
3. Say the version and the one-line reason for its bump. Unless the user named the version, ask them to confirm it
   before going on: the tag push cannot be undone.
4. `pnpm version X.Y.Z` on a clean tree. Its `preversion` hook fails without the changelog section; it then makes a
   commit named `X.Y.Z` and the tag `vX.Y.Z`.
5. `git push --follow-tags origin HEAD:main` (from a feature branch or worktree; it must fast-forward). Pushing is
   the release: do it only when the user asked for one.
6. Watch: `gh run list --workflow release.yml --limit 1`, then `gh run watch <id> --exit-status`. The desktop jobs
   take the longest. Then `gh release view vX.Y.Z --json assets --jq '.assets | length'` prints 14.
7. Update this machine from the published release: the CLI with Homebrew, the app with the installer. A prerelease
   leaves the tap alone, so do this for a stable version only. Quit the desktop app first, since the installer
   replaces its bundle: `osascript -e 'tell application "Cortex" to quit'` (it asks about unsaved drafts; wait until
   `pgrep -f Cortex.app/Contents/MacOS/Cortex` prints nothing). `brew upgrade` refreshes the tap, which the release's
   `homebrew` job updated. With `CORTEX_NO_CLI=1` the installer checks the app against `SHA256SUMS`, installs it, and
   stops the old daemon with Homebrew's `cortex`. Afterwards move any older `~/Applications/Cortex.app` to the Trash
   and `open /Applications/Cortex.app`, which starts the new daemon:

   ```bash
   brew upgrade kalindudc/tap/cortex
   curl -fsSL https://github.com/kalindudc/cortex/releases/download/vX.Y.Z/install.sh \
     | CORTEX_VERSION=X.Y.Z CORTEX_NO_CLI=1 sh
   ```

8. Check `which -a cortex` prints only `/opt/homebrew/bin/cortex`, `cortex --version` prints X.Y.Z and
   `cortex doctor` reports the daemon on X.Y.Z with no pending migrations (run `cortex init` if it has some), then run
   `cortex agents install` with bb running; it reports the bb plugin reloaded or up to date.

## On failure

- A failed check or test job: fix it on `main` with a new commit and release the next patch. NEVER move, delete or
  re-push a tag that was pushed, and never delete a published release, without the user's say-so.
- A failed `homebrew` job after `publish` succeeded: the release is out; rerun the job (`gh run rerun <id> --failed`)
  once the cause is fixed.
- To install a local build without releasing, `pnpm run deploy` uses the same installer. It puts the CLI in `~/bin`,
  which comes after `/opt/homebrew/bin` on this machine's PATH: run that build as `~/bin/cortex`, and delete it when
  done so Homebrew's stays the only `cortex`.
