# valkey2

A fast, single-binary, **Redis/Valkey-compatible** in-memory data structure
server, written in TypeScript for **[Bun](https://bun.com) 1.3.14** and
architected with **[Effect v4](https://effect.website)** following the
[effect.solutions](https://www.effect.solutions/) prescriptive guide.

valkey2 speaks the **RESP2 and RESP3** wire protocol, implements **~200
commands** across strings, generic keys, hashes, lists (with *genuine* blocking
`BLPOP`/`BRPOP`), sets, sorted sets, streams (with consumer groups), pub/sub
(including sharded), and `MULTI`/`EXEC`/`WATCH` transactions — and ships a
native **HTTP/3 (QUIC)** admin/metrics endpoint.

> It is wire-compatible with the official `redis-cli`, `ioredis`, and
> `node-redis` clients. Point any Redis client at it and it just works.

```bash
bun install
bun run start          # RESP on tcp/6379, admin HTTP/3 on udp+tcp/8080
redis-cli -p 6379 ping # PONG
```

---

## Documentation

This repository is **fully self-documented** — you do not need any external
site to use, operate, or implement against valkey2. Everything is under
[`docs/`](./docs/README.md):

| Doc | What it covers |
|-----|----------------|
| [docs/README.md](./docs/README.md) | Documentation index |
| [Architecture](./docs/architecture.md) | How it is built: Effect control plane, raw data plane, modules, request lifecycle |
| [Getting Started](./docs/getting-started.md) | Install, run, first commands, client quick-starts |
| [Configuration](./docs/configuration.md) | Every environment variable, `CONFIG GET/SET`, runtime knobs |
| [RESP Protocol](./docs/protocol.md) | Complete RESP2 + RESP3 wire format, every type, byte-level examples |
| [Clients](./docs/clients.md) | `redis-cli`, `ioredis`, `node-redis`, raw TCP — runnable samples |
| [Admin / HTTP](./docs/admin-http.md) | The HTTP/3 (QUIC) `/health` `/info` `/metrics` endpoint + TLS |
| [Benchmarking](./docs/benchmarking.md) | `bun run bench` (RESP) and `bun run http-bench` (H1/H2/H3) |
| [Deployment](./docs/deployment.md) | Multicore (`SO_REUSEPORT`), production notes, limitations |
| [Development](./docs/development.md) | Project layout, tests, how to add a command |
| **[Command Reference](./docs/commands/README.md)** | **Every command, with syntax, replies, RESP2/RESP3 differences, and sample code** |

The [Command Reference](./docs/commands/README.md) is organized exactly like
the canonical Redis docs, by data type:
[strings](./docs/commands/strings.md) ·
[keys](./docs/commands/keys.md) ·
[hashes](./docs/commands/hashes.md) ·
[lists](./docs/commands/lists.md) ·
[sets](./docs/commands/sets.md) ·
[sorted sets](./docs/commands/sorted-sets.md) ·
[streams](./docs/commands/streams.md) ·
[pub/sub](./docs/commands/pubsub.md) ·
[transactions](./docs/commands/transactions.md) ·
[connection](./docs/commands/connection.md) ·
[server](./docs/commands/server.md) ·
[scripting](./docs/commands/scripting.md).

---

## Architecture in one paragraph

**Effect v4 governs the control plane** — typed configuration (`Config`
service + `Layer`, `Config.redacted` secrets), dependency injection
(`Context.Service`), domain errors (`Schema.TaggedErrorClass`), structured
startup/shutdown, and the HTTP/3 admin server. The **data plane** —
per-command RESP parse → dispatch → encode — is deliberately raw,
allocation-conscious TypeScript: wrapping every command in an Effect/Promise
was measured to cap throughput, so the hot loop stays synchronous. Effect for
orchestration, bare metal for the inner loop. See
[docs/architecture.md](./docs/architecture.md).

## Feature matrix

| Area | Status |
|------|--------|
| RESP2 | ✅ |
| RESP3 (`HELLO 3`) | ✅ native null/double/boolean/map/set/push/verbatim |
| Strings / bitcount-free string ops | ✅ |
| Generic keys, TTL/expiry, `SCAN` | ✅ |
| Hashes (incl. `HRANDFIELD`, `HSCAN NOVALUES`) | ✅ |
| Lists (incl. **genuine blocking** `BLPOP`/`BRPOP`) | ✅ |
| Sets (incl. `SINTERCARD`) | ✅ |
| Sorted sets (BYSCORE/BYLEX/REV, `ZRANGESTORE`, `ZINTERCARD`) | ✅ |
| Streams (incl. consumer groups, `XAUTOCLAIM`-style `XCLAIM`) | ✅ |
| Pub/Sub (channels, patterns, **sharded**) | ✅ |
| Transactions (`MULTI`/`EXEC`/`DISCARD`/`WATCH`/`UNWATCH`) | ✅ optimistic-lock `WATCH` |
| Multiple logical databases (`SELECT`/`SWAPDB`/`MOVE`/`COPY`) | ✅ |
| AUTH / `requirepass` | ✅ |
| HTTP/3 admin + Prometheus metrics | ✅ |
| Multicore via `SO_REUSEPORT` | ✅ (per-worker state) |
| Bitmaps / HyperLogLog / Geo | ✅ |
| Keyspace notifications | ✅ `notify-keyspace-events` |
| RESP3 client-side caching (`CLIENT TRACKING`) | ✅ BCAST + default, REDIRECT, OPTIN/OPTOUT, NOLOOP |
| Hash-field TTL (Redis 7.4) | ✅ `HEXPIRE`/`HTTL`/`HPERSIST`/`HGETEX`/`HGETDEL`/… |
| Lua scripting (`EVAL`/`EVALSHA`/`FUNCTION`/`FCALL`) | ✅ embedded fengari VM |
| On-disk persistence (AOF + RDB) | ✅ append-only file + CRC32-verified snapshots |
| Replication / cluster sharding | ⛔ single-node |

## Quick client example

```ts
import { Redis } from "ioredis";
const r = new Redis({ port: 6379 });

await r.set("user:1", "alice", "EX", 60);
await r.hset("user:1:meta", { age: "30", city: "NYC" });
await r.zadd("leaderboard", 100, "alice", 80, "bob");

console.log(await r.get("user:1"));                 // "alice"
console.log(await r.hgetall("user:1:meta"));        // { age: "30", city: "NYC" }
console.log(await r.zrevrange("leaderboard", 0, -1, "WITHSCORES"));
r.disconnect();
```

More, including `node-redis` (RESP3) and raw-socket examples, in
[docs/clients.md](./docs/clients.md).

## Tests & benchmarks

```bash
bun test               # 46 integration tests (ioredis + node-redis + sample app)
bun run bench          # production-realistic RESP benchmark
bun run http-bench     # admin endpoint HTTP/1.1 vs HTTP/2 vs HTTP/3
bun run typecheck      # strict tsc --noEmit
```

## Known limitations

- No replication or true cluster sharding (the cluster mode is process-level
  `SO_REUSEPORT` with per-worker state).
- `FUNCTION DUMP`/`RESTORE` use a portable internal payload, not the binary
  redis-server format (round-trips within valkey2, not cross-server).
- HTTP/3 is experimental in Bun 1.3.x (per the release notes); WebSocket over
  HTTP/3 and 0-RTT are not available. The admin endpoint transparently falls
  back to HTTP/2 / HTTP/1.1 over TLS on the same port.

## Implemented beyond the original predecessor

- **Persistence**: append-only file (RESP command log, `appendfsync`
  always/everysec/no, load-on-boot with truncated-tail recovery, minimal
  rewrite) plus a CRC32-verified custom RDB snapshot (`SAVE`/`BGSAVE`,
  `save`-rule fibers, atomic temp-file rename) and `DUMP`/`RESTORE`.
- **Bitmaps** (`SETBIT`/`GETBIT`/`BITCOUNT`/`BITPOS`/`BITOP`/`BITFIELD`),
  **HyperLogLog** (`PFADD`/`PFCOUNT`/`PFMERGE`, MurmurHash3 + loglog-beta),
  **Geo** (`GEOADD`/`GEOSEARCH`/`GEODIST`/...).
- **Genuine blocking family**: `BLPOP`/`BRPOP`, `BLMOVE`/`BRPOPLPUSH`,
  `LMPOP`/`BLMPOP`, `BZPOPMIN`/`BZPOPMAX`/`ZMPOP`/`BZMPOP`, and real
  `XREAD`/`XREADGROUP BLOCK`.
- **Keyspace notifications** (`notify-keyspace-events`,
  `__keyspace@/__keyevent@`), **RESP3 client-side caching**
  (`CLIENT TRACKING` BCAST + default mode, REDIRECT, OPTIN/OPTOUT, NOLOOP).
- **Redis 7.4 hash-field TTL** (`HEXPIRE`/`HTTL`/`HPERSIST`/`HGETEX`/
  `HGETDEL`/...), `SORT`/`SORT_RO`, `LCS`, `EXPIRE ... NX|XX|GT|LT`.
- **Lua scripting & Functions** via an embedded fengari VM:
  `EVAL`/`EVALSHA`(`_RO`), `SCRIPT`, `FUNCTION`, `FCALL`(`_RO`).

Runtime dependencies: `effect@4.0.0-beta.70` (control plane) and
`fengari@^0.1.5` (embedded Lua VM). `ioredis`/`redis` are dev-only (tests).

## License

See [LICENSE](./LICENSE).