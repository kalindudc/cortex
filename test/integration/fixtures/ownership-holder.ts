// Child-process driver for test/integration/ownership.test.ts (plan @400 N2/N3).
// Runs from source (`bun ownership-holder.ts ...`) AND as a compiled
// `--compile --bytecode --format=esm` binary, so the lazy bun:ffi load is
// exercised in both shapes. It never opens SQLite.
//
//   argv: <mode> <databasePath>
//   try    acquire, print OWNED or BUSY, release; exit 0 (owned) / 3 (busy)
//   hold   acquire, print OWNED or BUSY (exit 3); keep the lease until stdin closes
//   spawn  acquire, then while holding start two `sleep` children (Bun.spawn and
//          node:child_process), print `OWNED <pid> <pid>`; keep holding until
//          stdin closes (children are killed then) or the test SIGKILLs us
import { spawn } from "node:child_process";
import { tryAcquireOwnership } from "../../../src/ownership.ts";

const BUSY_EXIT = 3;
const [mode, databasePath] = process.argv.slice(2);
if (!mode || !databasePath) {
  console.error("usage: ownership-holder <try|hold|spawn> <databasePath>");
  process.exit(2);
}

async function untilStdinCloses(): Promise<void> {
  for await (const _chunk of process.stdin) {
    /* drain until EOF */
  }
}

const lease = tryAcquireOwnership(databasePath);
if (lease === null) {
  console.log("BUSY");
  process.exit(BUSY_EXIT);
}

if (mode === "try") {
  console.log("OWNED");
  lease.release();
  process.exit(0);
}

if (mode === "hold") {
  console.log("OWNED");
  await untilStdinCloses();
  lease.release();
  process.exit(0);
}

if (mode === "spawn") {
  const viaBun = Bun.spawn(["sleep", "10"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const viaNode = spawn("sleep", ["10"], { stdio: "ignore" });
  console.log(`OWNED ${viaBun.pid} ${viaNode.pid}`);
  await untilStdinCloses();
  viaBun.kill("SIGKILL");
  viaNode.kill("SIGKILL");
  lease.release();
  process.exit(0);
}

console.error(`unknown mode: ${mode}`);
lease.release();
process.exit(2);
