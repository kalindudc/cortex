import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The user's own author name: the attribution of a status change or post the
 * user makes in the desktop app (the daemon's GET /api/me), by `cortex update
 * --as-me`, and reported by `cortex doctor`.
 * Cascade (first hit wins):
 *   1. `gh` CLI hosts file (~/.config/gh/hosts.yml) — the GitHub username
 *   2. `git config --global user.name`
 *   3. `os.hostname()` (without trailing .local)
 *   4. literal "me"
 * Cached per process.
 */
let cachedAuthor: string | null = null;
export function resolveAuthor(): string {
  if (cachedAuthor) return cachedAuthor;
  // 1. gh hosts.yml — simple regex, no yaml parser needed.
  try {
    const ghHosts = path.join(os.homedir(), ".config", "gh", "hosts.yml");
    if (fs.existsSync(ghHosts)) {
      const m = fs.readFileSync(ghHosts, "utf8").match(/^\s+user:\s*(\S+)/m);
      if (m?.[1]) return (cachedAuthor = m[1]);
    }
  } catch {
    /* fall through */
  }
  // 2. git config user.name
  try {
    const r = Bun.spawnSync(["git", "config", "--global", "user.name"]);
    const name = new TextDecoder().decode(r.stdout).trim();
    if (name) return (cachedAuthor = name);
  } catch {
    /* fall through */
  }
  // 3. hostname (strip trailing .local for prettier display)
  try {
    const h = os.hostname().replace(/\.local$/, "");
    if (h) return (cachedAuthor = h);
  } catch {
    /* fall through */
  }
  return (cachedAuthor = "me");
}
