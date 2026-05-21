# Configuration

valkey2 is configured entirely through **environment variables**, resolved and
validated at startup by the Effect `Config` layer (`src/config.ts`). Invalid
values fail fast with a `ConfigError` describing the offending field.

## Environment variables

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `VALKEY_HOST` | string | `0.0.0.0` | RESP TCP bind address |
| `VALKEY_PORT` | int | `6379` | RESP TCP port (validated 1–65535) |
| `VALKEY_PASSWORD` | redacted string | _(none)_ | If set, clients must `AUTH`/`HELLO … AUTH` before other commands |
| `VALKEY_MAXCLIENTS` | int | `10000` | Reported via `INFO`/`CONFIG`; must be ≥ 1 |
| `VALKEY_DBCOUNT` | int | `16` | Number of logical databases (`SELECT 0..N-1`); must be ≥ 1 |
| `VALKEY_CLUSTER_SIZE` | int | `1` | If > 1, fork N `SO_REUSEPORT` workers; must be ≥ 1 |
| `VALKEY_ADMIN_PORT` | int | `8080` | HTTP/3 admin endpoint port (validated 1–65535) |
| `VALKEY_ADMIN_TLS_KEY` | path | _(none)_ | PEM private key for the admin endpoint |
| `VALKEY_ADMIN_TLS_CERT` | path | _(none)_ | PEM certificate for the admin endpoint |
| `VALKEY_WORKER` | (internal) | _(unset)_ | Set automatically on forked cluster workers; do not set manually |

`VALKEY_PASSWORD` is read as an Effect `Config.redacted` secret so it is not
printed in logs or error messages.

### Validation rules

- `VALKEY_PORT` and `VALKEY_ADMIN_PORT` must be integers in `1..65535`.
- `VALKEY_DBCOUNT`, `VALKEY_CLUSTER_SIZE`, `VALKEY_MAXCLIENTS` must be
  integers ≥ 1.
- Any violation aborts startup with, e.g.:
  `invalid configuration for 'VALKEY_PORT': out of range: 70000`.

### Examples

```bash
# Custom port + password
VALKEY_PORT=6400 VALKEY_PASSWORD=s3cret bun run start

# 32 databases, admin on 9090
VALKEY_DBCOUNT=32 VALKEY_ADMIN_PORT=9090 bun run start

# 2-worker SO_REUSEPORT cluster
VALKEY_CLUSTER_SIZE=2 bun run start

# Operator-provided admin TLS material
VALKEY_ADMIN_TLS_KEY=/etc/ssl/admin.key \
VALKEY_ADMIN_TLS_CERT=/etc/ssl/admin.crt \
bun run start
```

## Authentication

If `VALKEY_PASSWORD` is set, a connection may only run `AUTH`, `HELLO`,
`PING`, `QUIT` until authenticated; anything else returns
`NOAUTH Authentication required.`. Authenticate with either:

```bash
redis-cli -p 6379 -a s3cret
# or, on an open connection:
AUTH s3cret
HELLO 3 AUTH default s3cret
```

`AUTH` against a server with **no** password returns an error (matching
Redis). A wrong password returns `WRONGPASS`.

## Runtime `CONFIG`

valkey2 maintains an in-memory config map surfaced via the `CONFIG` command.
It is seeded at startup with:

| Key | Initial value |
|-----|---------------|
| `maxmemory` | `0` |
| `maxmemory-policy` | `noeviction` |
| `save` | `""` |
| `appendonly` | `no` |
| `timeout` | `0` |
| `tcp-keepalive` | `300` |
| `databases` | `<VALKEY_DBCOUNT>` |
| `bind` | `<VALKEY_HOST>` |
| `port` | `<VALKEY_PORT>` |
| `requirepass` | `<VALKEY_PASSWORD or "">` |

```bash
CONFIG GET maxmemory             # 1) "maxmemory" 2) "0"
CONFIG GET 'max*'                # glob match
CONFIG SET maxmemory 100mb       # OK (stored in the in-memory map)
CONFIG RESETSTAT                 # OK
CONFIG REWRITE                   # OK (no-op; valkey2 has no config file)
```

`CONFIG SET` updates the in-memory map only — there is no config file and no
behavioral side effects beyond what `CONFIG GET` reports (valkey2 has no
persistence or maxmemory eviction). It exists for client/tooling
compatibility.

## Multiple databases

`VALKEY_DBCOUNT` (default 16) logical DBs, addressed per-connection with
`SELECT`. `MOVE`/`COPY … DB` transfer keys between DBs (deep-copied — no
shared mutable backing). `SWAPDB a b` swaps two DBs atomically. `FLUSHDB`
clears the selected DB; `FLUSHALL` clears all.

## Admin endpoint TLS

The HTTP/3 (QUIC) admin endpoint requires TLS. Resolution order:

1. If both `VALKEY_ADMIN_TLS_KEY` and `VALKEY_ADMIN_TLS_CERT` are set, those
   PEM files are used.
2. Otherwise a self-signed dev certificate is generated **once** into
   `.certs/` (gitignored) via `openssl` on first boot; the private key is
   `chmod 0o600`.

See [admin-http.md](./admin-http.md) for the endpoint itself.