# E2E tests (`test/e2e/`)

Browser-driven Playwright tests against a real, isolated cortex daemon.

## Running

```bash
pnpm run test:e2e
```

That script builds the binary, installs the Chromium browser (first run only),
and runs every cardinal-flow `test()` block. Total runtime is typically under
ten seconds on a developer laptop.

To run a single test or grep by name:

```bash
pnpm exec playwright test test/e2e/cardinal.spec.ts -g "post an update"
```

First-time setup (already wired into `pnpm run test:e2e`):

```bash
pnpm exec playwright install chromium
```

**Arch Linux note:** Playwright's `--with-deps` flag hard-codes `apt-get` and
fails on Arch. The install command above downloads the browser binary only
(which works on every OS). System libraries (NSS, GTK, etc.) are usually
already present on Arch desktops. If the browser fails to launch with a
missing-library error, install the deps via pacman:

```bash
sudo pacman -S nss alsa-lib libxss libxtst gtk3 cups libdrm
```

## Why Playwright runs under Node, not Bun

`@playwright/test`'s subprocess + IPC machinery hangs under Bun's runtime
(see [oven-sh/bun#23826](https://github.com/oven-sh/bun/issues/23826)
"Playwright Chromium launch fails with native Bun runtime"). We invoke
Playwright through `pnpm exec playwright` which routes via Node — the
runner stays on Node, but the cortex binary it talks to is still Bun-built.
There is NO Bun-Playwright crossing in the live code path; the two
processes only ever talk over HTTP.

(On this Shopify machine, `pnpm exec npx ...` is intercepted by an
internal policy that asks you to use `pnpx`. `pnpm exec playwright`
bypasses the hop entirely, runs the same way upstream and in CI, and is
the form embedded in `package.json:scripts.test:e2e`.)

## DB isolation contract

Every test owns a fresh, hermetic cortex daemon. The
`test/e2e/fixtures/cortex-server.ts` Playwright fixture:

1. Creates a per-test `mkdtemp(os.tmpdir() + "/cortex-e2e-")` directory.
2. Builds a sanitized env where **all three** cortex env vars point into
   that tmpdir, AFTER `delete`-ing the inherited values so an empty
   `XDG_CONFIG_HOME=""` from the parent shell cannot leak through:
   - `XDG_CONFIG_HOME=<tmpDir>` — closes the daemon-routing escape hatch
     (closes `configDir()` in `src/paths.ts`).
   - `CORTEX_DB=<tmpDir>/cortex.db` — pins the SQLite file directly
     even on the no-daemon code path. Belt + suspenders.
   - `CORTEX_SKILL_DIR=<tmpDir>/skill` — keeps `init` / `reset` from
     clobbering `~/.agents/skills/`.
3. Picks a random free TCP port on `127.0.0.1` and spawns
   `bin/cortex serve --port <random> --foreground --no-open`.
4. Polls `/api/health` until 200 (10s budget).
5. Yields a `url` fixture to the test.
6. On teardown: SIGTERM the daemon, wait up to 2s for exit, SIGKILL if
   still alive, recursively remove the tmpdir.

The contract is verified by `test/e2e/isolation-smoke.spec.ts`, which
snapshots the user's real `~/.config/cortex/cortex.db` mtime + size,
runs a write against the test daemon, and asserts the real DB is
byte-identical afterwards. If this test ever goes red, the suite is
corrupting the user's tasks — stop the world.

## Rules

- **No `page.waitForTimeout`.** Use auto-waiting locators
  (`expect(locator).toBeVisible()`, `.toHaveText()`, `.toContainText()`)
  with the default 5s `actionTimeout` from `playwright.config.ts`.
- **No persistent fixtures.** Each test seeds its own lane(s) + task(s)
  via the cortex HTTP API before driving the UI. The DB is fresh per
  test so cross-test bleed is impossible.
- **Single worker.** `fullyParallel: false`, `workers: 1` in
  `playwright.config.ts`. Two tests in parallel would each spawn a
  binary + bind a port + manage a tmpdir — single-worker is the cheapest
  invariant. Revisit only if the suite gets long enough to need it.
- **Don't import `test/helpers.ts`.** That file is Bun-only
  (`Bun.spawn`, `import.meta.dir`). The e2e fixture re-implements the
  isolation pattern in Node-compatible APIs.
