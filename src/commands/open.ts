import { defineCommand } from "citty";
import fs from "node:fs";
import { urlPath, browserUrlPath } from "../paths.ts";
import { openInBrowser } from "../open-browser.ts";

/**
 * `cortex open` — re-open the dashboard in the user's default browser.
 *
 * Resolution order (first hit wins):
 *   1. `~/.config/cortex/cortex.browser-url` — written by a running
 *      `cortex serve`; contains the friendly URL exactly as printed.
 *   2. `~/.config/cortex/cortex.url` — legacy file from older binaries
 *      that only wrote the loopback URL. We upgrade `127.0.0.1` to
 *      `cortex.localhost` on the fly so the user gets the friendly host
 *      even before they restart the daemon.
 *   3. `http://cortex.localhost:7777` — the documented default. Lets the
 *      command work even when the daemon has never been started; the
 *      browser surfaces its own connection-refused page if the URL is
 *      unreachable, which is the right UX for a "did I leave it
 *      running?" probe.
 *
 * The chosen URL is always echoed to stdout BEFORE the platform open call
 * fires, so users on stripped containers (where `xdg-open` may print a
 * warning instead of opening anything) can copy/paste it manually.
 */
/**
 * Pure URL-resolution function extracted from `run()` so it can be unit
 * tested without spawning a browser. Reads the daemon state files via the
 * same `paths.ts` helpers the rest of the CLI uses, so test fixtures that
 * pin `XDG_CONFIG_HOME` exercise the real resolution logic.
 */
export function resolveOpenUrl(): string {
  if (fs.existsSync(browserUrlPath())) {
    const fromFile = fs.readFileSync(browserUrlPath(), "utf8").trim();
    if (fromFile) return fromFile;
  }
  if (fs.existsSync(urlPath())) {
    const apiUrl = fs.readFileSync(urlPath(), "utf8").trim();
    // Upgrade the legacy loopback URL to the friendly hostname on the
    // fly so old daemons still benefit from the new command without a
    // restart. Match scheme + 127.0.0.1 + optional :port + optional
    // path; replace only the host segment.
    const m = apiUrl.match(/^(https?:\/\/)127\.0\.0\.1(:\d+)?(\/.*)?$/);
    if (m) return `${m[1]}cortex.localhost${m[2] ?? ""}${m[3] ?? ""}`;
  }
  return "http://cortex.localhost:7777";
}

export default defineCommand({
  meta: {
    name: "open",
    description: "open the cortex dashboard in your default browser",
  },
  args: {},
  run() {
    const url = resolveOpenUrl();
    console.log(`opening ${url}`);
    openInBrowser(url);
  },
});
