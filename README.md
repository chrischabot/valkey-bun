# valkey-bun

`valkey-bun` is a Valkey/Redis-compatible server written in TypeScript for the
Bun runtime. It exists for the deceptively ordinary case where a local service
stack needs Redis semantics, but does not really need another container, another
daemon, or another five seconds of waiting for infrastructure that is only there
to hold a few session hashes.

The goal is not to pretend that a TypeScript process is a replacement for a
production Valkey cluster. The goal is more specific, and therefore more useful:
an ephemeral, single-binary-ish server that speaks enough Redis protocol for real
clients to talk to it during local development, tests, demos, and small internal
tools where the correct persistence story is "please forget this when I stop the
process."

## What it does

- Runs on Bun's TCP server with no external Valkey or Redis process.
- Speaks RESP2 and RESP3, including `HELLO 3`.
- Stores string, list, hash, set, sorted set, and stream values in memory.
- Keeps keys and values binary-safe by storing protocol bytes directly.
- Supports multiple logical databases, key expiry, pub/sub, transactions, and
  optimistic concurrency with `WATCH`.
- Works with ordinary clients; the test suite exercises both `ioredis` and
  `node-redis`.
- Starts from a small TypeScript codebase that is deliberately easy to inspect,
  which is part of the point.

There is, of course, a catch: this is intentionally ephemeral. There is no RDB,
no AOF, no replication, and no cluster sharding. If you are trying to protect
money, medical records, or a leaderboard your users will riot over, use the real
thing. If you are trying to make a local app boot without dragging half a
production stack behind it, this is the shape.

## Quick start

```bash
bun install
bun run start
```

By default the server listens on `0.0.0.0:6379`.

```ts
import { Redis } from "ioredis";

const redis = new Redis({ host: "127.0.0.1", port: 6379 });

await redis.set("hello", "world");
console.log(await redis.get("hello"));
```

The same server can also be used with `node-redis`:

```ts
import { createClient } from "redis";

const redis = createClient({ url: "redis://127.0.0.1:6379", RESP: 3 });
await redis.connect();

await redis.hSet("session:abc", { user_id: "42", role: "admin" });
console.log(await redis.hGetAll("session:abc"));

await redis.quit();
```

## Configuration

Configuration is intentionally boring. Set environment variables, start the
process, and the server reports the resulting values through compatibility
commands such as `INFO`, `CONFIG`, and `CLIENT`.

| Variable | Default | Purpose |
| --- | ---: | --- |
| `VALKEY_HOST` | `0.0.0.0` | Bind address. |
| `VALKEY_PORT` | `6379` | Bind port. |
| `VALKEY_PASSWORD` | none | Enables `AUTH` when set. |
| `VALKEY_MAXCLIENTS` | `10000` | Reported in compatibility metadata. |
| `VALKEY_DBCOUNT` | `16` | Number of logical databases. |
| `VALKEY_CLUSTER_SIZE` | `1` | Forks multiple Bun workers with `reusePort` when greater than `1`. |

Example:

```bash
VALKEY_HOST=127.0.0.1 VALKEY_PORT=16379 VALKEY_PASSWORD=local bun run start
```

## Command coverage

The server implements the command families that tend to show up in local app
stacks first: strings, keys, hashes, lists, sets, sorted sets, streams, pub/sub,
transactions, connection commands, and server/configuration commands. The tests
cover normal application-shaped use cases such as sessions with TTLs, counters
under contention, leaderboards, pub/sub event delivery, watched transactions,
queues, and stream logs.

The complete command registry is built from `src/commands/`. If you want the
literal list from the current checkout:

```bash
bun -e 'import { buildRegistry } from "./src/commands"; console.log(buildRegistry().list().map(c => c.name).sort().join("\n"))'
```

Some compatibility commands are implemented as stubs because many clients probe
for them even when the local workload does not need the full behavior. That is a
practical compromise, not a secret production roadmap.

## Known limitations

- No persistence: data lives in memory and disappears when the process exits.
- No replication, Sentinel, or cluster sharding.
- `EVAL`, `EVALSHA`, `FCALL`, and related scripting/function commands return an
  explicit unsupported response or compatibility stub.
- Blocking commands such as `BLPOP`, `BRPOP`, and `XREAD BLOCK` currently return
  immediately rather than parking the connection.
- Server introspection commands such as `INFO`, `COMMAND`, `MEMORY`, `LATENCY`,
  `SLOWLOG`, and `CLUSTER` provide the compatibility surface needed by common
  clients, not the full operational universe of Valkey.

In other words, the project is useful precisely because it is small, but the
smallness is a product boundary. It is not an invitation to discover durability
the hard way.

## Architecture

The code is organized around the protocol loop, the in-memory store, and command
groups. Effect is used at the entry point for service composition, while the hot
path stays close to Bun's socket API.

```text
src/
  index.ts          runtime entry point, environment config, optional worker fork
  server.ts         Bun.listen TCP server, parse loop, per-connection async queue
  connection.ts     connection state, write buffering, RESP2/RESP3 reply mode
  resp.ts           RESP2/RESP3 parser and encoder, including a command fast path
  store.ts          binary-safe in-memory store and data structures
  pubsub.ts         channel and pattern subscriptions
  server-context.ts shared store, pub/sub, config, connection set, key versions
  commands/         command handlers grouped by Redis/Valkey family
```

A few details are worth calling out because they explain the shape of the code:

- Values are stored as `Uint8Array` where possible, so protocol bytes are not
  accidentally laundered through JavaScript strings.
- JavaScript `Map` keys are strings, so arbitrary Redis keys use a latin1
  bijection internally and round-trip back to bytes at the protocol boundary.
- Expiry is checked lazily on reads and also swept once per second.
- Each connection has a small async dispatch queue so a command with async work
  does not reorder replies behind later commands on the same socket.
- `WATCH` uses per-database key version counters, which is the simple version of
  the idea and the right one for an in-memory local server.

## Development

```bash
bun install
bun test tests/
bun run dev
```

There is also a benchmark driver:

```bash
bun run bench
```

By default it runs for a while and assumes a Linux-like `/proc` for process
metrics, so treat it as a load tool rather than a universal CI step.

## License

MIT. See [LICENSE](LICENSE).
