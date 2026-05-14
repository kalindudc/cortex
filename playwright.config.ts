// Playwright runner config for cortex e2e tests.
//
// Runs under NODE, not Bun: @playwright/test's subprocess + IPC machinery
// hangs under Bun's runtime (oven-sh/bun#23826 "Playwright Chromium launch
// fails with native Bun runtime"). The pnpm script invokes
//   pnpm exec npx playwright test
// which routes through node, not bun. The cortex binary itself still runs
// under Bun — Playwright only TALKS to the binary over HTTP, never via IPC.
//
// fullyParallel: false / workers: 1 — the cortex daemon is single-user and
// each test owns its own daemon process via the cortex-server fixture. Two
// tests running in parallel would each try to bind ports + spawn binaries
// + tear down tmpdirs, multiplying flake. Single-worker is the simplest
// invariant; we can revisit when the suite is slow enough to need it.

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test/e2e",
  // All runtime artifacts (per-test outputs, traces, screenshots, HTML report)
  // land under tmp/ which is already gitignored. Keeps `git status` clean and
  // avoids needing extra entries in .gitignore for Playwright defaults.
  outputDir: "tmp/test-results",
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI
    ? [["html", { open: "never", outputFolder: "tmp/playwright-report" }], ["github"]]
    : [["list"], ["html", { open: "never", outputFolder: "tmp/playwright-report" }]],
  use: {
    actionTimeout: 5000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
