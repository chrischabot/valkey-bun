# valkey2

A fast, single-binary, Valkey/Redis-compatible server — a clean reimplementation
of the original `valkey-bun` with every performance lesson baked in from the
start, built on **Bun 1.3.14** and structured with **Effect v4** following the
[effect.solutions](https://www.effect.solutions/) prescriptive guide.

## Architecture: Effect at the boundary, raw hot path

Effect v4 governs the **control plane**: typed configuration (`Config` service +
`Layer`, `Config.redacted` secrets), dependency injection (`Context.Service`),
domain errors (`Schema.TaggedErrorClass`), structured startup/shutdown, and the
HTTP/3 admin server. The **data plane** — per-command RESP parse → dispatch →
encode — is deliberately raw, allocation-conscious TypeScript. Wrapping every
Redis command in an Effect/Promise was measured (in the predecessor) to cap
throughput, so the hot loop stays synchronous. This split is the idiomatic
approach: Effect for orchestration, bare metal for the inner loop.

The runtime dependency is the published `effect@4.0.0-beta.70` npm package. The
full Effect v4 source (`Effect-TS/effect-smol`) was used as the reference while
building this; clone it into `vendor/effect/` (gitignored, not committed) if you
want to read the real implementations and types — it is intentionally kept out
of the repository to keep it focused on the server itself.

## Performance lessons applied from the start

1. Per-connection write coalescing — one `socket.write()` per read drain
2. Synchronous dispatch fast-path — promise queue only for async handlers
3. Cached pre-encoded replies (`+OK`, `+PONG`, `$-1`, `*0`, small ints, bools)
4. Buffer-cursor encoder (`encodeInto`) — no per-reply concat
5. `parseCommand` fast-path — no intermediate `RespValue` allocation
6. ZSet sorted-entries cache — invalidated only on writes
7. Native latin1 `TextDecoder` for binary-safe keys
8. Dual-case command registry — skip per-call `toUpperCase()`
9. Optional `SO_REUSEPORT` multicore

Additionally, this version implements **genuine blocking `BLPOP`/`BRPOP`** (a
documented limitation in the predecessor) via an async waiter registry that
integrates with the per-connection dispatch queue.

## Quick start

```bash
bun install
bun run start                # RESP TCP 0.0.0.0:6379, admin HTTP/3 on :8080
```

Environment variables:

| Var                    | Default   | Purpose                                  |
|------------------------|-----------|------------------------------------------|
| `VALKEY_HOST`          | `0.0.0.0` | RESP TCP bind address                    |
| `VALKEY_PORT`          | `6379`    | RESP TCP port                            |
| `VALKEY_PASSWORD`      | (none)    | If set, requires `AUTH`                  |
| `VALKEY_MAXCLIENTS`    | `10000`   | Reported in `INFO`/`CLIENT`              |
| `VALKEY_DBCOUNT`       | `16`      | Logical databases                        |
| `VALKEY_ADMIN_PORT`    | `8080`    | HTTP/3 admin endpoint port (TCP+UDP)     |
| `VALKEY_ADMIN_TLS_KEY` | (none)    | PEM private key for the admin endpoint   |
| `VALKEY_ADMIN_TLS_CERT`| (none)    | PEM certificate for the admin endpoint   |
| `VALKEY_CLUSTER_SIZE`  | `1`       | >1 forks N `SO_REUSEPORT` workers        |

## HTTP/3 admin / metrics endpoint

Bun 1.3.14 added **first-class HTTP/3 (QUIC) support to `Bun.serve`**
([release notes](https://bun.com/blog/bun-v1.3.14#http-3-quic-support-in-bun-serve)).
The admin server sets `http3: true` alongside `tls`, so Bun binds **TCP for
HTTP/1.1 + HTTP/2 and UDP for HTTP/3 on the same port**. A single `fetch`
handler serves all three protocols unchanged; HTTP/1.1 and HTTP/2 responses
automatically include an `Alt-Svc` header so clients discover and upgrade to
the QUIC endpoint. HTTP/3 is experimental in Bun 1.3.x.

QUIC mandates TLS. The admin server resolves its certificate as follows:

1. If `VALKEY_ADMIN_TLS_KEY` and `VALKEY_ADMIN_TLS_CERT` are set, those PEM
   files are used.
2. Otherwise a self-signed dev certificate is generated once into `.certs/`
   (gitignored) on first boot via `openssl`.

```bash
# HTTP/3 (QUIC) — requires a curl built with HTTP/3 support
curl --http3-only -sk https://localhost:8080/health
curl --http3-only -sk https://localhost:8080/info
curl --http3-only -sk https://localhost:8080/metrics    # Prometheus text

# The same endpoint also answers HTTP/2 and HTTP/1.1 over TLS on the same port;
# TCP responses advertise the QUIC endpoint via Alt-Svc:
curl -skI https://localhost:8080/health | grep -i alt-svc
```

## Tests

```bash
bun test
```

Three suites run the server in-process and exercise it through the official
`ioredis` SDK, the official `redis` (node-redis, RESP3) SDK, and a realistic
sample-app suite (sessions, leaderboards, a multi-subscriber pub/sub bus, a
WATCH money transfer, a genuinely-blocking work queue, streams).

## Benchmark

```bash
BENCH_SECONDS=300 bun run bench
```

Production-realistic weighted 16-command mix, 32 pipelined clients, with
per-command p50/p90/p99 histograms and `/proc`-sampled server RSS/CPU.

## Multicore

```bash
VALKEY_CLUSTER_SIZE=2 bun run start
```

Forks N workers sharing the RESP TCP port via Linux `SO_REUSEPORT`; the kernel
load-balances connections. Each worker has independent state, so this suits
connection-affinity workloads (per-client caches/counters, sticky sessions).
The HTTP/3 admin endpoint binds only on worker 0 to avoid `EADDRINUSE`.

## Supported commands

Strings, generic keys, hashes, lists (incl. real blocking `BLPOP`/`BRPOP`),
sets, sorted sets, streams (incl. consumer groups), pub/sub (incl. sharded),
transactions (`MULTI`/`EXEC`/`WATCH`), connection
(`PING`/`AUTH`/`HELLO`/`SELECT`/`CLIENT`), and server commands
(`INFO`/`COMMAND`/`CONFIG`/`DEBUG`/`TIME`/`MEMORY`/`LATENCY`/`SLOWLOG`/
`CLUSTER`/`SWAPDB`/...). Both RESP2 and RESP3 are supported; `HELLO 3` upgrades.

## Known limitations

- No on-disk persistence (RDB/AOF); the server is intentionally ephemeral.
- No replication or true cluster sharding (the cluster mode is process-level
  `SO_REUSEPORT` with per-worker state).
- `EVAL` Lua scripting returns an explicit "not supported" error; `SCRIPT`/
  `FUNCTION` subcommands are stubbed for client compatibility.
- HTTP/3 is experimental in Bun 1.3.x (per the release notes); WebSocket over
  HTTP/3 and 0-RTT are not available. The admin endpoint transparently falls
  back to HTTP/2 / HTTP/1.1 over TLS on the same port.