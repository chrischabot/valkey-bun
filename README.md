# valkey-bun

valkey-bun is a Redis- and Valkey-compatible server written in TypeScript for [Bun](https://bun.com). It is for developers whose applications use Redis for sessions, counters and queues, and who want those semantics during local development, in test suites, in demos and in small internal tools without installing Redis or keeping another container around just to hold a few hashes. You clone the repository, install it and start it with Bun, and `ioredis`, `node-redis` or `redis-cli` connect over the same wire protocol they use with the real thing, so the application keeps its real client library instead of a mock.

A stand-in like this only earns its place if code that works against it behaves the same way in production, which makes semantics matter more than the length of the command list. The first release kept everything in memory, returned immediately from blocking commands and stubbed out scripting, which was fine for a session hash and misleading for a job queue. The current code is a rewrite that closes those gaps: a worker calling `BLPOP` really does park until another client pushes, Lua scripts run against the same keyspace as every other client, and the dataset can survive a restart.

The rewrite calls itself valkey2, which is the name you will see in its logs, metrics and documentation. Compatible here means the documented command surface, with integration tests that run its common paths through `ioredis` and `node-redis`, rather than bug-for-bug parity with Redis or Valkey. It remains an experimental, single-node server rather than a replacement for a production deployment, and [the limits below](#before-you-rely-on-it) say what that rules out.

## How it works

One Bun process keeps the keyspace in memory and answers RESP2 and RESP3 on TCP port 6379, aiming at the single-node surface of Redis 7.4 and Valkey 8. About 240 commands cover strings, keys with TTLs, hashes with per-field TTLs, lists, sets, sorted sets, streams with consumer groups, bitmaps, HyperLogLog and geo, along with pub/sub, keyspace notifications, client-side caching through `CLIENT TRACKING`, `MULTI`/`EXEC`/`WATCH` transactions, and Lua through `EVAL` and `FUNCTION`. Data reaches disk through a checksummed snapshot, an append-only log or both, and a second listener on port 8080 serves health checks, a JSON status document and Prometheus metrics over HTTP/3, HTTP/2 and HTTP/1.1.

## Getting started

You need Bun 1.3.14 or newer and `openssl` on your `PATH`. The admin endpoint starts with the server and requires TLS, so the first boot generates a self-signed certificate into `.certs/` unless `VALKEY_ADMIN_TLS_KEY` and `VALKEY_ADMIN_TLS_CERT` point at your own PEM files.

```bash
git clone https://github.com/chrischabot/valkey-bun
cd valkey-bun
bun install
bun run start
```

Then, from another terminal:

```bash
redis-cli -p 6379 set hello world        # OK
redis-cli -p 6379 get hello              # "world"
curl -sk https://127.0.0.1:8080/health   # OK
```

An application connects the way it would connect to Redis. This `ioredis` example also shows a blocking pop parking one connection until another connection pushes a job:

```ts
import { Redis } from "ioredis";

const redis = new Redis({ host: "127.0.0.1", port: 6379 });
const worker = new Redis({ host: "127.0.0.1", port: 6379 });

await redis.set("session:abc", "alice", "EX", 60);
await redis.hset("user:1", { name: "alice", city: "NYC" });
await redis.zadd("leaderboard", 100, "alice", 80, "bob");
console.log(await redis.zrevrange("leaderboard", 0, -1, "WITHSCORES"));
// ["alice", "100", "bob", "80"]

const job = worker.blpop("jobs", 5);
await redis.rpush("jobs", "task-1");
console.log(await job); // ["jobs", "task-1"]

redis.disconnect();
worker.disconnect();
```

[docs/clients.md](docs/clients.md) has samples for `node-redis` over RESP3, pub/sub, streams and raw sockets.

## Configuration

Everything is configured through environment variables, and an invalid value stops the server at startup. A plain `bun run start` is not ephemeral: `VALKEY_DIR` defaults to the working directory, so the server loads `dump.rdb` there and writes a snapshot when it stops cleanly. With AOF disabled, writes do not advance the counter used by the scheduled save rules; use `SAVE`, `BGSAVE` or a clean shutdown to create a snapshot. A test run that wants an empty dataset should point `VALKEY_DIR` somewhere disposable. Without the append-only log, a crash loses whatever changed since the last snapshot.

```bash
# Start with an empty dataset
VALKEY_DIR=$(mktemp -d) bun run start

# Bind the RESP listener to localhost and require a password
VALKEY_HOST=127.0.0.1 VALKEY_PASSWORD=change-me bun run start

# Keep an append-only log, fsynced once a second, in /data
VALKEY_DIR=/data VALKEY_APPENDONLY=yes VALKEY_APPENDFSYNC=everysec bun run start
```

[docs/configuration.md](docs/configuration.md) lists every variable, and [docs/persistence.md](docs/persistence.md) covers the durability options.

## Before you rely on it

These are the limits most likely to change what you can build on it.

- **One node.** There is no replication or cluster sharding, so `CLUSTER` reports a standalone node and `WAIT` returns `0` immediately. `bun run cluster` forks workers that share the port through `SO_REUSEPORT`, but each worker has its own keyspace, pub/sub does not cross between them, and they all save to the same files in `VALKEY_DIR`, so the mode suits per-connection caches and counters rather than shared data.
- **No eviction.** `maxmemory` exists for compatibility, but nothing is ever evicted, so the host has to fit the whole dataset.
- **One thread per process.** Bun has no copy-on-write `fork()`, so `BGSAVE` serializes and writes the dataset on the thread that serves commands, and a large dataset pauses every client while it runs. [docs/benchmarking.md](docs/benchmarking.md) records about 23,000 to 29,000 commands per second on a 2 vCPU machine that was also running the load generator.
- **Self-contained persistence.** Snapshots and `DUMP` payloads use the server's own checksummed format, so they cannot be exchanged with a real Redis or Valkey server. The integration tests also run without a data directory, so recovery from a snapshot or the append-only log deserves your own test before you trust it with data that matters.
- **Lua 5.3.** Scripts run on the embedded fengari VM rather than Redis's bundled Lua 5.1, so a few numeric and standard-library edge cases differ, and `cmsgpack`, `bit` and `struct` are not available.
- **Placeholder introspection.** `ACL`, `MEMORY`, `LATENCY`, `SLOWLOG`, `MODULE` and `FAILOVER` answer so that clients probing them carry on, but they do no real work, and one password is the only access control.
- **An open default.** The RESP listener binds `0.0.0.0` with no password and has no TLS, so anywhere but a private machine should set `VALKEY_HOST` and `VALKEY_PASSWORD` and put a TLS terminator in front of that port. The admin listener also binds all interfaces and has no authentication; those variables do not protect it, so restrict access to its TCP and UDP port separately.

## How it is built

The code draws a hard line between startup and the per-command path. [Effect v4](https://effect.website), used in the style of the [effect.solutions](https://www.effect.solutions/) guide, loads and validates configuration through a `Layer`, reports failures as typed errors and runs the startup program. Nothing on the per-command path touches it, because measurements on the project's predecessor showed that wrapping each command in an Effect or a Promise capped throughput.

Each socket read is appended to a per-connection buffer and parsed in a loop, with a fast path that recognizes the usual array-of-bulk-strings frame without allocating intermediate RESP values and a general parser for inline commands and other RESP3 types. The dispatcher checks authentication, arity, subscribe mode and `MULTI` queuing, then runs the handler, which is nearly always synchronous. The exceptions are the blocking commands, `EXEC` and `DEBUG SLEEP`, whose promises go onto a per-connection queue so that a parked client's later commands wait their turn and its replies stay in order. Replies accumulate in a buffer and leave in a single `socket.write()` per read. After each successful write command, one `postWrite` hook feeds the append-only log, publishes keyspace notifications and sends `CLIENT TRACKING` invalidations, so individual handlers do not have to know about any of them.

A few other decisions shape the code. The server represents keys as strings in JavaScript `Map`s. `WATCH` compares per-key version counters that are bumped only on a real mutation. Blocked clients wait in one FIFO registry that re-evaluates them whenever a key they are waiting on changes, and that registry serves every blocking command. `redis.call` uses the same command registry and post-write hook as client commands, so script writes reach the log and the notifications like any others. The admin endpoint is a single `Bun.serve` with `http3: true`, which binds UDP for HTTP/3 and TCP for HTTP/2 and HTTP/1.1 on the same port, and HTTP/3 remains experimental in Bun 1.3.

[docs/architecture.md](docs/architecture.md) has the module map and the full request lifecycle.

## Development

```bash
bun test                        # 60 integration tests across four suites
bun run typecheck               # strict tsc --noEmit
bun run dev                     # restart on file changes
BENCH_SECONDS=60 bun run bench  # RESP benchmark, five minutes by default
```

The tests call `startTcpServer` directly on dedicated ports and drive the server through `ioredis`, `node-redis` and, for `CLIENT TRACKING`, a raw socket, so they exercise the real wire protocol rather than internal functions. Started this way, with no data directory, the server reads and writes no files, and neither persistence nor the admin endpoint runs. `bun run http-bench` compares the admin endpoint over HTTP/1.1, HTTP/2 and HTTP/3 against a running server, and [docs/benchmarking.md](docs/benchmarking.md) explains both benchmarks.

[docs/development.md](docs/development.md) walks through adding a command, and [AGENTS.md](AGENTS.md) records the invariants a change has to keep: binary-safe keys, version bumps only on real mutation and exact RESP2 and RESP3 reply shapes.

## Documentation

[docs/README.md](docs/README.md) indexes everything. The [command reference](docs/commands/README.md) gives the syntax, replies and RESP2/RESP3 differences for every command, the [protocol guide](docs/protocol.md) describes the wire format at byte level, and [deployment](docs/deployment.md), the [admin endpoint](docs/admin-http.md), [client-side caching](docs/client-side-caching.md) and the [design roadmap](docs/roadmap.md) each have their own page.

## Project background

- [valkey-bun project overview](https://chabot.dev/projects/#valkey-bun) on Chris Chabot’s site.
- [Local Redis starts at the client](https://chabot.dev/blog/local-redis-starts-at-the-client/): client negotiation, RESP compatibility and ordered replies.

## License and credits

valkey-bun is released under the [MIT License](LICENSE), copyright 2026 Chris Chabot.

Chris Chabot created the project and directed the rewrite, whose commits were authored by Maestro, iGent's coding agent. The protocol and command behavior it implements come from [Redis](https://redis.io) and [Valkey](https://valkey.io), and it is an independent implementation rather than a fork of either. It runs on [Bun](https://bun.com), [fengari](https://fengari.io) provides the Lua VM, [Effect](https://effect.website) handles startup, and [ioredis](https://github.com/redis/ioredis) and [node-redis](https://github.com/redis/node-redis) drive the tests.
