# Deployment & Operations

## Running

```bash
bun install
bun run start                 # single process
VALKEY_CLUSTER_SIZE=2 bun run start   # multicore (SO_REUSEPORT)
```

valkey2 is a single self-contained Bun process (or a master + N workers in
cluster mode). There is no external datastore; durability, when enabled, is
to local AOF/RDB files.

## Multicore via `SO_REUSEPORT`

When `VALKEY_CLUSTER_SIZE > 1`, the master forks N worker processes that all
bind the same RESP TCP port with `SO_REUSEPORT`; the Linux kernel
load-balances incoming connections across workers.

**Critical:** each worker has **independent in-memory state** (and its own
AOF/RDB files if persistence is enabled). There is no shared keyspace, no
replication, no cross-worker pub/sub. This mode therefore suits
**connection-affinity workloads** — per-client caches/counters, sticky
sessions — *not* a shared global keyspace. For a single shared dataset, run a
single process (one core is typically saturated around 23–29k cmd/s; scale by
sharding keys at the application layer across independent instances).

The HTTP/3 admin endpoint binds on **worker 0 only** to avoid `EADDRINUSE`;
its `/info`/`/metrics` therefore reflect worker 0's state.

## Persistence

Persistence is **enabled only when a data directory is configured**
(`VALKEY_DIR`); otherwise valkey2 is purely ephemeral and the
`SAVE`/`BGSAVE`/`BGREWRITEAOF`/`LASTSAVE`/`WAITAOF` commands are accepted
no-ops.

With `VALKEY_DIR` set:

- `VALKEY_APPENDONLY=yes` enables the append-only file (a verbatim RESP
  command log) with `VALKEY_APPENDFSYNC` of `always`/`everysec`/`no`.
- A CRC32-verified RDB snapshot is written by `SAVE`/`BGSAVE` and by the
  `VALKEY_SAVE` rule fibers; it is loaded on boot when AOF is disabled.
- On boot the AOF (if present) is replayed, with truncated-tail recovery.
- `CONFIG SET appendonly yes|no` toggles AOF at runtime.

Full details and the durability matrix: [persistence.md](./persistence.md).

## Security

- Set `VALKEY_PASSWORD` to require `AUTH`. It is read as a redacted secret and
  never logged.
- Bind `VALKEY_HOST` to a private interface; do not expose `6379` publicly
  without network controls (there is no TLS on the RESP port — front it with a
  TLS terminator/VPN if needed).
- Provide real `VALKEY_ADMIN_TLS_KEY`/`VALKEY_ADMIN_TLS_CERT` in production;
  the auto self-signed dev cert is for local use only. Keep `.certs/`
  gitignored.
- The AOF/RDB files contain your dataset in clear form — protect `VALKEY_DIR`
  with appropriate filesystem permissions.

## Lifecycle & graceful shutdown

- Startup is logged via Effect (`… ready in N ms`); persistence (if
  configured) is loaded before the server accepts connections.
- `SIGTERM`/`SIGINT` flush persistence, stop the admin server, and
  `process.exit(0)`. In cluster mode the master forwards the signal to all
  workers and exits when the last worker exits.
- `SHUTDOWN` (RESP command) flushes persistence then exits the process after
  ~50 ms.

## Health & monitoring

- Liveness: `GET /health` → `200 OK` (HTTP/1.1/2/3 on `VALKEY_ADMIN_PORT`).
- Metrics: `GET /metrics` (Prometheus) — see [admin-http.md](./admin-http.md).
- `INFO` (RESP) exposes server/clients/memory/stats/keyspace sections.

Example Kubernetes probe:

```yaml
livenessProbe:
  httpGet: { path: /health, port: 8080, scheme: HTTPS }
  initialDelaySeconds: 2
```

## Resource behavior

- Memory grows with the dataset (everything is in RAM); there is **no
  `maxmemory` eviction** despite the `CONFIG` key existing for compatibility.
  Size the host for your working set plus headroom.
- Expired keys are reclaimed lazily on access and by a 1 Hz background sweep.
- CPU: the data-plane loop is single-threaded per process; AOF fsync and RDB
  serialization run on Effect fibers off the hot path. `BGSAVE` serializes
  synchronously then writes/fsyncs asynchronously (Bun has no `fork()`
  copy-on-write — see [persistence.md](./persistence.md)).

## Limitations (by design)

- **No replication / no real cluster sharding.** `CLUSTER` reports a
  standalone, non-clustered node; cluster mode is process-level
  `SO_REUSEPORT` with per-worker state. `WAIT` returns `0` immediately.
- **Portable, not redis-server-binary, RDB/DUMP.** The snapshot/`DUMP` codec
  round-trips within valkey2 but is not loadable by `redis-check-rdb` or a
  real redis-server.
- **Lua is fengari (5.3), not Redis's bundled 5.1.** A few numeric/stdlib
  edge semantics differ; `cmsgpack`/`bit`/`struct` are not provided. See
  [commands/scripting.md](./commands/scripting.md).
- HTTP/3 is experimental in Bun 1.3.x.

Persistence (AOF + RDB + `DUMP`/`RESTORE`), keyspace notifications, RESP3
`CLIENT TRACKING`, bitmaps/HyperLogLog/geo, Redis 7.4 hash-field TTL, the full
blocking command family, and Lua scripting/Functions are all implemented;
the remaining omissions above are intentional for a fast, single-node
Redis/Valkey API surface.