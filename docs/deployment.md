# Deployment & Operations

## Running

```bash
bun install
bun run start                 # single process
VALKEY_CLUSTER_SIZE=2 bun run start   # multicore (SO_REUSEPORT)
```

valkey2 is a single self-contained Bun process (or a master + N workers in
cluster mode). There is no external datastore.

## Multicore via `SO_REUSEPORT`

When `VALKEY_CLUSTER_SIZE > 1`, the master forks N worker processes that all
bind the same RESP TCP port with `SO_REUSEPORT`; the Linux kernel
load-balances incoming connections across workers.

**Critical:** each worker has **independent in-memory state**. There is no
shared keyspace, no replication, no cross-worker pub/sub. This mode therefore
suits **connection-affinity workloads** — per-client caches/counters, sticky
sessions — *not* a shared global keyspace. For a single shared dataset, run a
single process (one core is typically saturated around 23–29k cmd/s; scale by
sharding keys at the application layer across independent instances).

The HTTP/3 admin endpoint binds on **worker 0 only** to avoid `EADDRINUSE`;
its `/info`/`/metrics` therefore reflect worker 0's state.

## Security

- Set `VALKEY_PASSWORD` to require `AUTH`. It is read as a redacted secret and
  never logged.
- Bind `VALKEY_HOST` to a private interface; do not expose `6379` publicly
  without network controls (there is no TLS on the RESP port — front it with a
  TLS terminator/VPN if needed).
- Provide real `VALKEY_ADMIN_TLS_KEY`/`VALKEY_ADMIN_TLS_CERT` in production;
  the auto self-signed dev cert is for local use only. Keep `.certs/`
  gitignored.

## Lifecycle & graceful shutdown

- Startup is logged via Effect (`… ready in N ms`).
- `SIGTERM`/`SIGINT` stop the admin server and `process.exit(0)`. In cluster
  mode the master forwards the signal to all workers and exits when the last
  worker exits.
- `SHUTDOWN` (RESP command) exits the process after ~50 ms.

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
- CPU: the data-plane loop is single-threaded per process; use cluster mode
  (with the affinity caveat above) or multiple sharded instances to use more
  cores.

## Limitations (by design)

- **No persistence** (RDB/AOF). A restart starts empty. `SAVE`/`BGSAVE`/
  `BGREWRITEAOF`/`LASTSAVE` are accepted as no-ops for client compatibility.
- **No replication / no real cluster sharding.** `CLUSTER` reports a
  standalone, non-clustered node.
- **No Lua scripting.** `EVAL`/`EVALSHA`/`FCALL` return explicit errors;
  `SCRIPT`/`FUNCTION` subcommands are stubbed. See
  [commands/scripting.md](./commands/scripting.md).
- `WAIT` returns `0` immediately (no replicas).

These are intentional; valkey2 targets a fast, ephemeral, single-node Redis
API surface.