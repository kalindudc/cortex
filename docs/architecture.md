---
budget: 250
sources: [src/cli.ts, src/daemon.ts, src/commands/serve.ts, src/server.ts, src/api.ts, src/client.ts, src/contracts.ts,
  src/subscription.ts, src/events.ts, src/ownership.ts, src/paths.ts, src/store.ts, src/backup.ts]
---

# How cortex works

How the command line, the desktop app and the background daemon fit together, where your data lives, and what
happens when several agents write at once. The first sections are for anyone using cortex; "Under the hood" and
"Rules to keep" are for engineers changing it. See also [desktop app](desktop.md) and [memory](memory.md).

## The big picture

Cortex is one program, `cortex`, for one person on one machine (no network port, no login; the desktop app in `integrations/desktop` reaches the daemon only through its Unix socket). It has
three roles:

- The CLI (command line): `cortex add`, `cortex ls`, `cortex update` and the rest, used by you and your agents.
- The desktop app (an Electron window): plain `cortex` in an interactive terminal opens it. It reaches the daemon only
  over the Unix socket, from its main process.
- The daemon (a background process): `cortex serve`, or started for you by the desktop app. Each database has at most
  one daemon, and it listens only on a private Unix socket (a file-like endpoint only your user can open).

```
  you and your agents: cortex add / ls / update      you: the desktop app (one or more windows)
            | one request per command                   | requests  ^ live updates
            v                                           v           |
  +---------------------- daemon: one per database, private Unix socket ----------------------+
                                             |
                               ~/.config/cortex/cortex.db (SQLite)
```

## What happens when you run a command?

When you run `cortex add "fix the login bug"`, the command first looks for the daemon that serves your database.

- If one is running, the command sends it one request over the socket and prints the answer. The daemon writes the
  database and tells every open app window about the change.
- If none is running, the command does the work itself: it opens the database, runs the same code the daemon would,
  and closes it again. It does not start a daemon. Two such commands at the same moment take turns.

Either way you get the same result and errors: both paths run the same request handlers. Only `cortex serve` and
the desktop app start a daemon; quitting the app leaves it running for your agents. `cortex stop` stops only
this database's daemon, and open app windows reconnect on their own when it restarts.

## Where does your data live?

- In one SQLite file, `~/.config/cortex/cortex.db` (it follows `XDG_CONFIG_HOME`). `CORTEX_DB` points cortex at
  another file; tests and the dev sandbox use it so they never touch your real data.
- SQLite runs in WAL mode (write-ahead logging: changes go to a `-wal` file first, so readers never block the
  writer). The `-wal` and `-shm` files beside the database are normal.
- `cortex.db.owner.lock` decides which process owns the database (see "One owner at a time"). Never delete it.
- `cortex.db.daemon.json` tells commands where the running daemon is. Its socket lives in a private runtime directory.
- `cortex doctor` shows the path, whether a daemon runs and any pending migrations, and changes nothing.

### How does the schema upgrade?

New tables and indexes appear automatically whenever cortex opens the database for writing. Changes to existing
tables are table rebuilds, applied only by `cortex init`; until you run it, cortex warns that migrations are pending.
For each rebuild init backs up the database, checks the result (row counts, integrity, foreign keys) and drops the
old table only when every check passes. A rebuild needs the database alone, so while a daemon runs, init asks you to
`cortex stop` first. Every past rebuild stays in the code, so a database from any earlier version still upgrades.

## Why a daemon?

So that every open app window shows a change the moment it happens: when an agent posts an update, your screen shows
it now. The daemon sees every write, so it pushes each change to every app window over a live event stream.

Why not let every process open SQLite and poll it for changes? It would be simpler, but an app window would learn about
a change only on its next poll, and instant feedback is the point. It is also why every command goes through a
running daemon instead of writing the file beside it: a write the daemon did not make never reaches the app windows.

## What happens when two writers collide?

Agents and app windows can write the same task at the same time. Cortex treats them differently on purpose:

- CLI writes, which is what agents use, are last-writer-wins. If two agents change a title, the second one stays.
- Desktop app edits are guarded per field. Each field of a task (title, body, priority, lane, status) carries a
  version, and a save sends the version you last saw. If someone changed that field meanwhile, nothing is written:
  you see a conflict, your input is kept, and you choose to keep yours or take theirs. Lane and tag edits work the
  same way. Different fields never conflict: you can fix a title while an agent changes the status.

```
you open task 12 and start rewriting its body
an agent runs:  cortex edit 12 -b "new plan"
you save        -> conflict: the body changed since you opened it; your draft is kept
```

Why not guard only the title and body by comparing their text? Status, priority, lane and the lane and tag edits
would then have no guard, and one writer could still silently undo another.

## One owner at a time

Only one cortex process owns a database at any moment: the daemon while it runs, or a single command for the length
of its work when none runs. Ownership is a lease: a lock on `cortex.db.owner.lock` that the operating system releases
the moment the owner exits, even if it crashes or is killed. So a crashed daemon never leaves the database locked;
the next command or daemon takes over and cleans up after it. For you, this means:

- While a daemon runs, every command goes through it. `cortex reset` stops it for you; `cortex restore` asks you to
  `cortex stop` first.
- The lease keeps cortex processes from stepping on each other. It does not stop other programs, such as a `sqlite3`
  shell, from opening the file.
- Upgrading from a binary older than the database-scoped daemon? Stop its daemon with the old binary first. This
  cortex no longer looks for one (every current daemon publishes its metadata), so one left running goes unnoticed.

## Under the hood

### The CLI boundary: withClient

- `src/cli.ts` lazily imports one module per verb, routes the console through `src/stdio.ts#routeConsoleThroughStreams`
  and normalizes argv with `src/args.ts#normalizeArgv` ([AGENTS.md](../AGENTS.md) says why both exist). Why not
  upgrade citty to 0.2 and drop the shim? 0.2.2 strips `--no-*` tokens even as a string flag's value (an
  `--body-replace "--no-x"` saved an empty body), keeps the `=` of `-b=value` and colours usage on a pipe.
- `src/daemon.ts#withClient` is the one boundary for normal commands. `src/daemon.ts#claimOrAttach` either attaches
  to the verified daemon (`src/client.ts#createClient` sends `src/api.ts#INSTANCE_HEADER` on every request, so a
  different instance refuses it) or takes the lease and serves the same `src/server.ts#buildApp` in-process through
  `src/api.ts#createApi`, with no identity and no control routes. Store and server load only on that path.
- No offline fallback once a request is dispatched: it may already have committed. The offline lease lasts only while
  `run` runs: never prompt, run fzf or launch a program inside it; call withClient again afterwards.
- Outside it by design: `init`, `reset` and `restore` own the lease; `doctor` and restore's dry run read through
  `src/store.ts#readSnapshot` (readonly, non-creating, no migrate, no lease); `stop` is `src/daemon.ts#stopDaemon`.
  The desktop app never uses withClient: its main process starts or attaches to a daemon (`src/desktop/daemon.ts`).

### Ownership and daemon lifecycle

- `src/commands/serve.ts#hostDaemon` claims the lease, opens the Store with it, binds the socket (owner-only mode),
  and only then calls `src/daemon.ts#publishDaemonMetadata`, so metadata always names a ready listener. Shutdown
  closes the listener, removes its own metadata and socket, closes the Store and releases the lease last.
  `src/daemon.ts#ensureDaemon` starts a detached serve of this binary with `CORTEX_DB` pinned to the canonical path
  (logging to `src/paths.ts#runtimeDir`) and resolves once it publishes.
- The lease is `src/ownership.ts#tryAcquireOwnership`: an advisory flock (not a SQLite transaction) on
  `src/paths.ts#ownerLockPath`, never unlinked or replaced, reset included (a new inode would admit a second owner).
  flock is per open file description, so a second `Store.open` of one file in one process is busy: share the Store
  or pass its `owner` lease. `src/ownership.ts#canonicalDatabasePath` resolves every alias to one realpath and
  rejects hard links (each would get its own lock), dangling symlinks and `:memory:` (which needs no lease).
- Metadata (`src/paths.ts#daemonMetadataPath`) is written to a temp file and renamed, and removed only by the instance
  it names (`src/daemon.ts#removeDaemonMetadata`). Discovery attaches only when the identity in the endpoint's health
  answer matches the published one; a silent endpoint is stale. An owner that has not published yet (a daemon
  starting, an offline command) is retried with backoff until a deadline.
- Only the lease holder recovers stale metadata and sockets (`src/daemon.ts#recoverStaleDaemonState`): every daemon
  holds the lease while it serves, so the holder knows none is alive (and Bun cannot bind over a stale socket).
  No pid read from metadata is ever signalled. Stop is an IPC-only control route (`src/api.ts#CONTROL_PATHS`) bound to
  the verified instance, then a wait for the lease. Control routes exist only when serve passes control to
  `src/server.ts#createRuntime`. There is no TCP listener, not even for tests: in-process route tests call
  `src/server.ts#buildApp` directly. `src/contracts.ts#Endpoint` is the socket only.

### Tables and migrations

- Source tables are exactly `src/backup.ts#TABLES`. The rest are private `_*` tables: database identity, resource
  revisions, mutation receipts, applied migration names, body-edit records, the derived memory index. Concurrency
  metadata lives there, never in source-table columns, so row selects stay clean, whole-row rebuilds keep working
  and the data-only backup never sees it. Only `cortex reset`, which deletes the file, wipes them.
- Additive schema is `CREATE ... IF NOT EXISTS` in `src/store.ts#migrate`, one transaction on every writable open, with
  no schema version number. Rebuilds are named, detected by DDL inspection in `src/store.ts#pendingMigrations` (fresh
  databases are seeded as applied) and run only by `src/store.ts#applyMigrations`, each behind a VACUUM INTO backup.
- `updates` is indexed by task (`idx_updates_task`, in `src/store.ts#migrate`): a task's update list, memory activity
  and the memory index's update log would otherwise scan every update for every task. A rebuild drops the index with
  the old table; the next writable open re-creates it.

### Live sync

- The stream is SSE (server-sent events: one long HTTP response the daemon keeps appending to); only the desktop app
  (through `src/desktop/bridge.ts`) and `cortex watch` subscribe. `src/events.ts#createEventPublisher` numbers events
  (`src/events.ts#EVENT_KINDS`) as epoch:seq cursors; a restarted daemon has a new epoch. Handlers publish only after
  the write commits, in the same synchronous turn, so a snapshot's cursor covers exactly the writes it can see. A
  failing subscriber is logged and skipped; a deduplicated replay publishes nothing.
- The stream subscribes before it sends its ready frame with the current cursor; the client snapshots after ready and
  applies only later events. There is no replay buffer: after every ready and every resync the client re-snapshots.
- Each connection's queue is bounded by `src/server.ts#DEFAULT_STREAM_LIMITS`; past a bound it is dropped for one
  resync frame, so a slow reader never grows memory. Heartbeats are sent only while idle, and their interval MUST stay
  below Bun.serve's default idle timeout, or Bun closes idle streams and every client sees spurious reconnects.
- `src/subscription.ts#subscribeChanges` is the client (Bun has no EventSource): it drops duplicate, stale and
  out-of-order frames, resyncs on a sequence gap, reconnects with backoff and treats long silence as a lost peer.

### Versioned writes and receipts

- Default writes (the CLI, plain API calls) are unguarded. A request with the `src/api.ts#PREFER_VERSIONED`
  preference gets versioned results and may send a guard (`src/contracts.ts#WriteGuard`): `expected` versions and/or
  a `mutationId`.
- Tasks carry a token per scope in `src/store.ts#TASK_SCOPES`, lanes and tags per `src/store.ts#CATALOG_SCOPES`.
  Tokens are opaque, random, equality-only and never deleted, so a reissued id or name never satisfies a stale guard.
  `expected` must name every scope the write changes; a mismatch writes nothing and raises `src/store.ts#ConflictError`
  with every current token, so a client can keep both versions.
- `src/store.ts#runIdempotent` checks a mutation id's receipt first: the same id and request replays the stored result
  and writes nothing; the same id with another request is refused. Receipts commit with the effects and are pruned
  after `src/store.ts#RECEIPT_RETENTION_MS` by `src/store.ts#pruneReceipts` on every open. A
  `src/api.ts#TransportError` on a non-GET is uncertain (the write may have committed): retry only with the same id
  (`src/api.ts#newMutationId`).
- Only a write that may be retried sends an id: a client that re-posts after an uncertain failure reuses the id it
  first sent. The desktop app's own writes send guards without ids, because it never retries them on its own. Why not
  drop receipts? A re-post by any client of the socket would post twice. Why not keep them forever? An unbounded
  table for replays that can only come within seconds.

### Module ownership

- Entry and plumbing: `src/cli.ts`, `src/args.ts`, `src/stdio.ts`, one citty verb per file in `src/commands/`, and
  `src/output.ts` (JSON on stdout; the JSON error code, not the exit code, tells errors apart).
- Client side: `src/daemon.ts` (discovery, withClient, ensureDaemon, stop), `src/client.ts` (the
  socket transport), `src/api.ts` (the typed client and its errors), `src/subscription.ts` (the SSE client).
- Daemon side: `src/server.ts` (the Hono app and SSE stream), `src/events.ts`, `src/store.ts` (schema, migrations,
  guards, receipts, memory index). Shared: `src/contracts.ts` (type-only wire types), `src/ownership.ts`,
  `src/paths.ts`.
- Elsewhere: `src/backup.ts`; `src/memory.ts` and `src/extensions/` in [memory](memory.md); `src/desktop/`, `src/ui/`
  and `src/lib/` in [desktop app](desktop.md); `src/skills.ts` and `src/extensions.ts` embed what `cortex agents
  install` writes.

## Rules to keep

- All SQLite access goes through `src/store.ts#Store`. No test enforces it; the one exception today is
  `src/backup.ts#exportData`, which opens its own readonly connection. Do not copy it.
- Keep the historical migrations so old databases still upgrade: `test/integration/cli/migrate-summary-4096.test.ts`.
  Opening an old database adds the private tables and the `updates` index without touching its data:
  `test/unit/store.test.ts`.
- The lease file is never unlinked and the OS frees the lease when its holder dies: `test/unit/ownership.test.ts`,
  multi-process `test/integration/ownership.test.ts`.
- Metadata is published atomically, only once the listener is ready (`src/commands/serve.ts#hostDaemon`), and removed
  only by its own instance; only the lease holder recovers stale state; no pid from metadata is signalled; no
  fallback after a dispatched request; stop is instance-bound: `test/unit/daemon.test.ts`,
  `test/integration/ownership.test.ts`.
- No control routes without control; requests bind to the verified instance; the heartbeat stays under Bun's idle
  timeout; events publish only after commit, in commit order: `test/unit/server.test.ts`. A failing subscriber
  cannot fail a write: `test/unit/events.test.ts`.
- The CLI stays last-writer-wins and a stale guard on any scope writes nothing: `test/unit/store.test.ts`. A retried
  post with the same id lands once and an idle stream outlives Bun's idle timeout, over the desktop's socket transport
  against a real daemon: `test/integration/desktop/stream-and-retry.test.ts`. Backups never contain private metadata:
  `test/unit/backup.test.ts`.
- `src/contracts.ts` is type-only: `test/unit/contracts.test.ts`. `src/api.ts` imports only contract types and no
  runtime globals: `test/unit/api.test.ts`. Output past a pipe buffer: `test/integration/cli/large-output.test.ts`.
- Unit tests never use the integration helpers or spawn the binary, and no test touches the real config dir:
  `test/unit/_layout.test.ts`, `test/integration/isolation.test.ts`.
- Memory: `test/unit/store-memory.test.ts`,
  `test/unit/extensions-pi.test.ts`, `test/unit/memory-eval.test.ts`. Docs: `scripts/check-docs.ts`.
