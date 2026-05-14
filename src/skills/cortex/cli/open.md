# `cortex open`

Open the cortex dashboard in your default browser. Reads `~/.config/cortex/cortex.browser-url` if present (written by a running `cortex serve`); falls back to `~/.config/cortex/cortex.url` (upgrading `127.0.0.1` → `cortex.localhost` on the fly so older daemons still benefit); falls back to `http://cortex.localhost:7777` if neither file exists.

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

## Pitfalls

- `cortex open` does NOT start the daemon. If the URL fails to load, run `cortex serve` first.
- On Linux it shells out to `xdg-open`, which is present on essentially every desktop install but may be missing on minimal containers. If it's not on PATH, a single `warn:` line is printed and the command exits 0 — copy the URL from stdout.
- `cortex.localhost` works in modern browsers (Chrome, Firefox, Edge) without any DNS setup per RFC 6761 §6.3. Safari relies on the macOS system resolver, which does NOT auto-resolve `*.localhost` — Safari users may need a `/etc/hosts` entry or the matching `cortex serve --host` override.
