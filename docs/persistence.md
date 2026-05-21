# Persistence (AOF + RDB)

valkey2 persists to disk **by default**. `VALKEY_DIR` defaults to `.` (the
working directory), so a normal `bun run start`:

- runs the `save`-rule fibers, writing CRC32-verified RDB snapshots to
  `<dir>/<dbfilename>` (default `./dump.rdb`);
- **loads an existing RDB on boot** (when AOF is disabled);
- additionally writes the **AOF** when `VALKEY_APPENDONLY=yes` (and replays it
  on boot in preference to the RDB).

The only fully-ephemeral mode is the **in-process test harness**, which
constructs the server without a data directory — no persistence object is
created and nothing is read or written. Set `VALKEY_DIR` to relocate the
files (e.g. a mounted volume).

## Append-Only File (AOF)

When `appendonly` is `yes`, every successful write command is appended to
`<dir>/<appendfilename>` as its **verbatim RESP frame** (the same bytes a
client sent), with a `SELECT <db>` interleaved on DB change and relative
TTLs rewritten to absolute `PEXPIREAT` so replay is time-correct.

- `appendfsync always` — fsync in the write path (durable, slowest).
- `appendfsync everysec` — a 1 Hz fsync fiber (default).
- `appendfsync no` — rely on the OS.

On boot, if `appendonly` is `yes` and an AOF exists, it is replayed through
the dispatcher; a truncated trailing frame (crash mid-write) is detected and
the partial tail dropped (`aof-load-truncated` behavior). `BGREWRITEAOF`
rewrites the file to a minimal `RESTORE`-per-key form (faithful for every
type including stream groups/PEL) via an fsynced temp file + atomic rename.

## RDB snapshot

A compact, versioned, CRC32-verified binary snapshot (valkey2's own format —
not the redis-server RDB binary layout, so it round-trips within valkey2 but
is not loadable by `redis-check-rdb`/real redis-server). `SAVE` writes it
synchronously; `BGSAVE` serializes synchronously then writes/fsyncs off the
hot path (guarded against overlap); the `save "<sec> <changes> ..."` rules
drive an automatic `BGSAVE` fiber. Writes go to a temp file + atomic rename.
On boot, if AOF is disabled but an RDB exists it is loaded (refusing a
checksum-mismatched file).

## DUMP / RESTORE

`DUMP key` returns the value serialized with a version + CRC16 footer;
`RESTORE key ttl payload [REPLACE] [ABSTTL] [IDLETIME n] [FREQ n]` recreates
it. The same codec backs `BGREWRITEAOF`. See
[commands/keys.md](./commands/keys.md#dump).

## Configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `VALKEY_DIR` | `.` | Data directory (default = working dir; persistence active) |
| `VALKEY_DBFILENAME` | `dump.rdb` | RDB filename |
| `VALKEY_APPENDONLY` | `no` | Enable AOF (RDB save-rules are on regardless) |
| `VALKEY_APPENDFILENAME` | `appendonly.aof` | AOF filename |
| `VALKEY_APPENDFSYNC` | `everysec` | `always`/`everysec`/`no` |
| `VALKEY_SAVE` | `3600 1 300 100 60 10000` | RDB save rules (`<sec> <changes>` pairs) |
| `VALKEY_AOF_USE_RDB_PREAMBLE` | `yes` | (accepted) |

`CONFIG SET appendonly yes|no` toggles AOF at runtime (enabling snapshots the
current dataset as the new AOF base). `SAVE`/`BGSAVE`/`BGREWRITEAOF`/
`LASTSAVE`/`WAITAOF`/`SHUTDOWN` are wired to this subsystem on a normal
launch.

> **Multi-worker note:** under `VALKEY_CLUSTER_SIZE > 1` every worker process
> has independent in-memory state but the same `VALKEY_DIR`/filenames —
> running AOF/RDB across workers would contend on the same files. Use
> persistence with a single process (or give each instance its own
> `VALKEY_DIR`).

> Bun has no `fork()` copy-on-write, so `BGSAVE` serializes synchronously and
> only the disk write/fsync is deferred — pause characteristics differ from C
> redis-server but the data is identical. See [roadmap.md](./roadmap.md) §1.