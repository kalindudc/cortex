# `cortex open`

Open the dashboard of THIS database's daemon in your default browser. It finds the daemon through `<db>.daemon.json` (verified over its private socket) and opens its dashboard URL; if that daemon runs headless (`cortex serve --no-web`, a TUI autostart), it first enables the dashboard on that SAME daemon. With no daemon it falls back to the URL files an older cortex wrote (`~/.config/cortex/cortex.browser-url`, then `cortex.url` with `127.0.0.1` upgraded to `cortex.localhost`), then to `http://cortex.localhost:7777`.

## Usage

```bash
cortex open
```

## Example

```bash
$ cortex open
opening http://cortex.localhost:7777
```

The chosen URL is printed to stdout BEFORE the platform open call fires, so you can copy it manually if your environment has no graphical browser.

From the terminal workspace, `:preview` does the same for one task: it opens that task's current text (unsaved edits included) through this daemon's dashboard at a private link that expires after 10 minutes, and saves nothing.

## Pitfalls

- `cortex open` does NOT start a daemon. If the URL fails to load, run `cortex serve` first.
- On Linux it shells out to `xdg-open`, which is present on essentially every desktop install but may be missing on minimal containers. If it's not on PATH, a single `warn:` line is printed and the command exits 0 — copy the URL from stdout.
- `cortex.localhost` works in modern browsers (Chrome, Firefox, Edge) without any DNS setup per RFC 6761 §6.3. Safari relies on the macOS system resolver, which does NOT auto-resolve `*.localhost` — Safari users may need a `/etc/hosts` entry or the matching `cortex serve --host` override.
