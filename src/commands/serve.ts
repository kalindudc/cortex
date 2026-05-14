import { defineCommand } from "citty";
import fs from "node:fs";
import { Store } from "../store.ts";
import { startServer } from "../server.ts";
import { pidPath, urlPath, browserUrlPath, ensureConfigDir } from "../paths.ts";
import { openInBrowser } from "../open-browser.ts";

/**
 * Validate a user-supplied hostname for the printed/opened dashboard URL.
 *
 * Accepts RFC 1123 label-or-FQDN shape: ASCII letters, digits, dots, and
 * hyphens; first AND last character must be alphanumeric; max length 253.
 * Rejects empty / whitespace-only strings, scheme prefixes, port suffixes,
 * and any character outside the allowed set (e.g. `:`, `/`, spaces).
 *
 * Casing is preserved. DNS itself is case-insensitive, but display layers
 * (CLI stdout, the writeable cortex.browser-url file) should reflect the
 * user's intent.
 *
 * On rejection, prints a single-line error to stderr and exits 1 — same
 * convention as the `--port` validation above this helper.
 */
function validateHost(raw: unknown): string {
  const value = typeof raw === "string" ? raw : "";
  // RFC 1123 label-or-FQDN: A-Z, a-z, 0-9, `.`, `-`; must START AND END
  // with [A-Za-z0-9]. Length cap mirrors the DNS hostname limit.
  const ok = value.length > 0 && value.length <= 253 && /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value);
  if (!ok) {
    console.error("error: --host must be a valid hostname (RFC 1123 form, no port, no scheme)");
    process.exit(1);
  }
  return value;
}

export default defineCommand({
  meta: { name: "serve", description: "run the cortex API server (writes ~/.config/cortex/cortex.{pid,url})" },
  args: {
    port: {
      type: "string",
      alias: "p",
      default: "7777",
      valueHint: "port",
      description: "TCP port on 127.0.0.1 (0 = pick a free port)",
    },
    foreground: {
      type: "boolean",
      default: false,
      description: "run in the current shell instead of detaching as a daemon",
    },
    "no-open": {
      type: "boolean",
      default: false,
      description: "do not auto-open the dashboard in a browser (headless)",
    },
    host: {
      type: "string",
      default: "cortex.localhost",
      valueHint: "name",
      description: "user-facing hostname for the printed URL (server still binds 127.0.0.1)",
    },
  },
  run({ args }) {
    const port = Number.parseInt(args.port, 10);
    if (!Number.isFinite(port) || port < 0 || port > 65535) {
      console.error("error: --port must be a number 0-65535");
      process.exit(1);
    }

    const host = validateHost(args.host);
    if (!args.foreground) {
      ensureConfigDir();
      // In a `bun build --compile` binary, argv[1] is the embedded virtual
      // path (e.g. /$bunfs/root/cli.ts) which only resolves inside the parent
      // process. Drop it when re-spawning so the binary uses its own embedded
      // entrypoint. From source, argv[1] is the .ts script path which IS
      // re-runnable, so keep it.
      const reSpawnArgs = process.argv[1]?.startsWith("/$bunfs/") ? process.argv.slice(2) : process.argv.slice(1);
      const child = Bun.spawn([process.execPath, ...reSpawnArgs, "--foreground"], {
        stdio: ["ignore", "ignore", "ignore"],
        detached: true,
      });
      if (typeof child.unref === "function") child.unref();
      fs.writeFileSync(pidPath(), String(child.pid));
      const apiUrl = `http://127.0.0.1:${port}`;
      const browserUrl = `http://${host}:${port}`;
      fs.writeFileSync(urlPath(), apiUrl);
      fs.writeFileSync(browserUrlPath(), browserUrl);
      console.log(`✓ cortex serving at ${browserUrl} (pid ${child.pid})`);
      if (!args["no-open"]) openInBrowser(browserUrl);
      return;
    }

    const store = Store.open();
    const handle = startServer({ port, host, store });
    ensureConfigDir();
    fs.writeFileSync(pidPath(), String(process.pid));
    fs.writeFileSync(urlPath(), handle.url);
    fs.writeFileSync(browserUrlPath(), handle.browserUrl);
    console.log(`cortex listening on ${handle.browserUrl}`);

    const shutdown = async () => {
      try {
        await handle.stop();
      } catch {
        /* ignore */
      }
      store.close();
      try {
        fs.rmSync(pidPath(), { force: true });
        fs.rmSync(urlPath(), { force: true });
        fs.rmSync(browserUrlPath(), { force: true });
      } catch {
        /* ignore */
      }
      process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  },
});
