/**
 * Cross-platform "open URL in the user's default browser" helper.
 *
 * Single source of truth shared by `cortex serve` (auto-open after the
 * daemon starts) and `cortex open` (explicit re-open from the CLI). Keeps
 * the platform-specific quirks (`open` vs `xdg-open` vs `cmd /c start`) in
 * one place so the call sites stay one-line.
 *
 * Behaviour is best-effort by design: the dashboard is reachable via the
 * loopback URL even when no browser opens. We never throw — a missing
 * `xdg-open` on a minimal Linux container should print a single helpful
 * line and return so the surrounding command can continue. A user can
 * always copy the URL from stdout.
 */
export function openInBrowser(url: string): void {
  try {
    if (process.platform === "darwin") {
      Bun.spawn(["open", url]);
      return;
    }
    if (process.platform === "linux") {
      // Bun.which() returns null when the binary is not on PATH. Avoid
      // spawning a doomed process so the user sees one warning, not two.
      if (Bun.which("xdg-open") === null) {
        console.warn(`warn: xdg-open not on PATH; visit ${url} manually`);
        return;
      }
      Bun.spawn(["xdg-open", url]);
      return;
    }
    if (process.platform === "win32") {
      // The empty quoted string is the window title — a `cmd /c start`
      // quirk that prevents the first quoted argument from being mistaken
      // for the title when the URL itself contains spaces.
      Bun.spawn(["cmd", "/c", "start", "", url]);
      return;
    }
    console.warn(`warn: don't know how to open a browser on ${process.platform}; visit ${url} manually`);
  } catch (err) {
    console.warn(`warn: failed to open browser (${(err as Error).message}); visit ${url} manually`);
  }
}
