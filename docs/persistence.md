# Persistence (AOF + RDB)

valkey2 can persist data to disk. Persistence is **enabled only when a data
directory is configured** (`VALKEY_DIR`); the in-process test harness omits
it and stays purely ephemeral.

## Append-Only File (AOF)

When `appendonly` is `yes`, every successful write command is appended to
`<dir>/<appendfilename>` as its **verbatim RESP frame** (the same bytes a
client sent), with a `SELECT <db>` interleaved on DB change and relative
TTLs rewritten to absolute `PEXPIREAT` so replay is time-correct.

- `appendfsync always` — fsync in the write path (durable, slowest).
- `appendfsync everysec` — a 1 Hz fsync fiber (default).
- `appendfsync no` — rely on the OS.

On boot the AOF is replayed through the dispatcher; a truncated trailing
frame (crash mid-write) is detected and the partial tail dropped
(`aof-load-truncated` behavior). `BGREWRITEAOF` rewrites the file to a
minimal `RESTORE`-per-key form (faithful for every type including stream
groups/PEL) via an fsynced temp file + atomic rename.

## RDB snapshot

A compact, versioned, CRC32-verified binary snapshot (valkey2's own format —
not the redis-server RDB binary layout). `SAVE` writes it synchronously;
`BGSAVE` serializes synchronously then writes/fsyncs off the hot path
(guarded against overlap); the `save "<sec> <changes> ..."` rules drive an
automatic `BGSAVE` fiber. Writes go to a temp file + atomic rename. On boot,
if AOF is disabled but an RDB exists it is loaded (refusing a
checksum-mismatched file).

## DUMP / RESTORE

`DUMP key` returns the value serialized with a version + CRC16 footer;
`RESTORE key ttl payload [REPLACE] [ABSTTL] [IDLETIME n] [FREQ n]` recreates
it. The same codec backs `BGREWRITEAOF`.

## Configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `VALKEY_DIR` | _(unset → persistence off)_ | data directory |
| `VALKEY_DBFILENAME` | `dump.rdb` | RDB filename |
| `VALKEY_APPENDONLY` | `no` | enable AOF |
| `VALKEY_APPENDFILENAME` | `appendonly.aof` | AOF filename |
| `VALKEY_APPENDFSYNC` | `everysec` | `always`/`everysec`/`no` |
| `VALKEY_SAVE` | `3600 1 300 100 60 10000` | RDB save rules |
| `VALKEY_AOF_USE_RDB_PREAMBLE` | `yes` | (accepted) |

`CONFIG SET appendonly yes|no` toggles AOF at runtime (enabling snapshots the
current dataset as the new AOF base). `SAVE`/`BGSAVE`/`BGREWRITEAOF`/
`LASTSAVE`/`WAITAOF`/`SHUTDOWN` are wired to this subsystem.

> Bun has no `fork()` copy-on-write, so `BGSAVE` serializes synchronously and
> only the disk write/fsync is deferred — pause characteristics differ from C
> redis-server but the data is identical. See [roadmap.md](./roadmap.md) §1.