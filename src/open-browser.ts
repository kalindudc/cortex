/**
 * Cross-platform "open URL in the user's default browser" helper.
 *
 * Single source of truth shared by `cortex serve` (auto-open after the
 * daemon starts), `cortex open` (explicit re-open from the CLI) and the
 * TUI's `:preview` (browserCommand, spawned by src/tui/bridge.ts). Keeps
 * the platform-specific quirks (`open` vs `xdg-open` vs `cmd /c start`) in
 * one place so the call sites stay one-line.
 *
 * Behaviour is best-effort by design: the dashboard is reachable via the
 * loopback URL even when no browser opens. We never throw — a missing
 * `xdg-open` on a minimal Linux container should print a single helpful
 * line and return so the surrounding command can continue. A user can
 * always copy the URL from stdout.
 */

/** The argv that opens a URL on this platform (the URL is ONE element), or why there is none. */
export type BrowserCommand = { argv: string[]; problem?: never } | { problem: string; argv?: never };

/**
 * The platform opener for `url`: `open`, `xdg-open` or `cmd /c start`,
 * with the URL as a single argv element (never a shell string). Pure: the
 * TUI bridge (src/tui/bridge.ts) spawns it detached from its terminal.
 */
export function browserCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
  which: (bin: string) => string | null = bin => Bun.which(bin),
): BrowserCommand {
  if (platform === "darwin") return { argv: ["open", url] };
  if (platform === "linux") {
    // Bun.which() returns null when the binary is not on PATH. Avoid
    // spawning a doomed process so the user sees one warning, not two.
    if (which("xdg-open") === null) return { problem: "xdg-open not on PATH" };
    return { argv: ["xdg-open", url] };
  }
  // The empty quoted string is the window title — a `cmd /c start`
  // quirk that prevents the first quoted argument from being mistaken
  // for the title when the URL itself contains spaces.
  if (platform === "win32") return { argv: ["cmd", "/c", "start", "", url] };
  return { problem: `don't know how to open a browser on ${platform}` };
}

export function openInBrowser(url: string): void {
  try {
    const command = browserCommand(url);
    if (command.problem !== undefined) {
      console.warn(`warn: ${command.problem}; visit ${url} manually`);
      return;
    }
    Bun.spawn(command.argv);
  } catch (err) {
    console.warn(`warn: failed to open browser (${(err as Error).message}); visit ${url} manually`);
  }
}
