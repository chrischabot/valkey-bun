# Configuration

valkey2 is configured entirely through **environment variables**, resolved and
validated at startup by the Effect `Config` layer (`src/config.ts`). Invalid
values fail fast with a `ConfigError` describing the offending field.

## Environment variables

### Core

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

### Persistence & notifications

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `VALKEY_DIR` | string | `.` | Data directory for the AOF/RDB files |
| `VALKEY_DBFILENAME` | string | `dump.rdb` | RDB snapshot filename |
| `VALKEY_APPENDONLY` | bool | `no` | Enable the append-only file |
| `VALKEY_APPENDFILENAME` | string | `appendonly.aof` | AOF filename |
| `VALKEY_APPENDFSYNC` | enum | `everysec` | `always` \| `everysec` \| `no` |
| `VALKEY_SAVE` | string | `3600 1 300 100 60 10000` | RDB save rules: space-separated `<seconds> <changes>` integer pairs |
| `VALKEY_AOF_USE_RDB_PREAMBLE` | bool | `yes` | Accepted (compatibility) |
| `VALKEY_NOTIFY_KEYSPACE_EVENTS` | string | _(empty)_ | Keyspace-notification flags, e.g. `KEA` |

Booleans accept `yes\|no\|true\|false\|1\|0`. See
[persistence.md](./persistence.md) and
[client-side-caching.md](./client-side-caching.md) for behavior.

`VALKEY_PASSWORD` is read as an Effect `Config.redacted` secret so it is not
printed in logs or error messages.

### Validation rules

- `VALKEY_PORT` and `VALKEY_ADMIN_PORT` must be integers in `1..65535`.
- `VALKEY_DBCOUNT`, `VALKEY_CLUSTER_SIZE`, `VALKEY_MAXCLIENTS` must be
  integers ≥ 1.
- `VALKEY_APPENDFSYNC` must be `always`, `everysec`, or `no`.
- `VALKEY_SAVE` must be space-separated `<seconds> <changes>` integer pairs.
- `VALKEY_NOTIFY_KEYSPACE_EVENTS` may only contain the flag characters
  `K E g $ l s h z x e t m d n A`.
- Any violation aborts startup with, e.g.:
  `invalid configuration for 'VALKEY_PORT': out of range: 70000`.

### Examples

```bash
# Custom port + password
VALKEY_PORT=6400 VALKEY_PASSWORD=s3cret bun run start

# Durable: AOF every second + RDB into /data
VALKEY_DIR=/data VALKEY_APPENDONLY=yes VALKEY_APPENDFSYNC=everysec bun run start

# Keyspace notifications (keyspace + keyevent + all classes)
VALKEY_NOTIFY_KEYSPACE_EVENTS=KEA bun run start

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
| `save` | `<VALKEY_SAVE>` |
| `appendonly` | `<VALKEY_APPENDONLY>` |
| `appendfsync` | `<VALKEY_APPENDFSYNC>` |
| `appendfilename` | `<VALKEY_APPENDFILENAME>` |
| `dbfilename` | `<VALKEY_DBFILENAME>` |
| `dir` | `<VALKEY_DIR>` |
| `aof-use-rdb-preamble` | `<VALKEY_AOF_USE_RDB_PREAMBLE>` |
| `notify-keyspace-events` | `<VALKEY_NOTIFY_KEYSPACE_EVENTS>` |
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
CONFIG SET appendonly yes        # OK — toggles AOF at runtime
CONFIG SET notify-keyspace-events KEA   # OK — applies immediately
CONFIG RESETSTAT                 # OK
CONFIG REWRITE                   # OK (no-op; valkey2 has no config file)
```

`CONFIG SET` updates the in-memory map. Two keys have **runtime side
effects**: `appendonly` enables/disables the AOF (enabling snapshots the
current dataset as the new AOF base), and `notify-keyspace-events` changes
keyspace-notification delivery immediately. Other keys are stored for
client/tooling compatibility (there is no config file and no `maxmemory`
eviction).

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