# Server & Administrative Commands

Introspection and administration. Persistence commands are functional on a
normal server launch (the data directory defaults to `.`, so RDB save-rules
and — when `appendonly=yes` — the AOF are active); they are accepted no-ops
only in the embedded/in-process mode used by the test harness. Cluster/
replication commands report a standalone node — see
[deployment.md](../deployment.md) and [persistence.md](../persistence.md).

---

## INFO

`INFO [section]` · Arity ≥ 1

**Reply:** a bulk string of `# Section` blocks with `key:value` lines. Sections
include `Server` (`redis_version` `7.4.0`, `redis_mode` `standalone`, pid,
uptime, tcp_port…), `Clients` (`connected_clients`, `maxclients`), `Memory`
(`used_memory`, `maxmemory` `0`, `maxmemory_policy` `noeviction`),
`Persistence`, `Stats` (`total_commands_processed`…), `Replication`
(`role:master`), `CPU`, and `Keyspace` (`dbN:keys=…,expires=…`). The optional
section argument is accepted; the full document is returned.

## COMMAND

`COMMAND [subcommand]` · Arity ≥ 1

- No args → empty array.
- `COUNT` → the **actual** number of registered commands.
- `LIST` → an array of every registered command name (lowercased).
- `GETKEYS cmd arg [arg ...]` → a **compatibility-oriented, partial**
  implementation that returns the best-effort first key (`args[2]`); it does
  not perform full Redis key-spec parsing for multi-key/variadic commands.
  Fewer than 3 tokens → `ERR Invalid command specified`.
- `DOCS` → empty map (RESP3) / array (RESP2). `INFO name [...]` → array of
  nils.

```bash
COMMAND COUNT          # (integer) <registry size>
COMMAND GETKEYS set k v # 1) "k"
```

## CONFIG

`CONFIG GET pattern [pattern ...]` · `CONFIG SET key value [key value ...]` ·
`CONFIG RESETSTAT` · `CONFIG REWRITE` · Arity ≥ 2

In-memory config map (see [configuration.md](../configuration.md)). `GET`
supports glob patterns; `SET` updates the map; `RESETSTAT`/`REWRITE` →
`+OK` (no config file exists). Two `SET` keys have **runtime side effects**:

- `CONFIG SET appendonly yes|no` — enables/disables AOF at runtime (enabling
  snapshots the current dataset as the new AOF base).
- `CONFIG SET notify-keyspace-events <flags>` — changes keyspace-notification
  delivery immediately.

```bash
CONFIG GET maxmemory                 # 1) "maxmemory" 2) "0"
CONFIG SET maxmemory 100mb           # OK
CONFIG SET appendonly yes        # OK — enables the AOF at runtime
CONFIG SET notify-keyspace-events KEA   # OK — applies immediately
```

## DEBUG

`DEBUG subcommand [args]` · Arity ≥ 2

- `DEBUG SLEEP seconds` → blocks this connection's handler for `seconds`,
  then `+OK` (useful to test client timeouts; runs as an async handler).
- `DEBUG OBJECT key` → a fake object description string.
- Anything else → `+OK`.

## TIME

`TIME` · Arity 1 → `[unix-seconds, microseconds]` (array of two bulk strings).

## SWAPDB

`SWAPDB index1 index2` · Arity 3 → `+OK`; atomically swaps two databases.
Out-of-range → `ERR DB index is out of range`.

## Persistence

On a normal launch these are wired to the AOF/RDB subsystem (see
[persistence.md](../persistence.md)); only in the embedded/in-process test
mode (no data directory) are they accepted no-ops so tooling clients do not
error.

| Command | Behavior |
|---------|----------|
| `SAVE` | Synchronous RDB snapshot → `+OK` |
| `BGSAVE` | Snapshot serialized then written/fsynced off the hot path → `+Background saving started` |
| `BGREWRITEAOF` | Rewrite the AOF to a minimal `RESTORE`-per-key form → `+Background append only file rewriting started` |
| `LASTSAVE` | Integer UNIX seconds of the last successful save |
| `WAITAOF numlocal numreplicas timeout` | `[aof-enabled?1:0, 0]` (no replicas) |

## SHUTDOWN

`SHUTDOWN [NOSAVE|SAVE] [NOW] [FORCE] [ABORT]` · Arity ≥ 1

Stop the server. Optional arguments are accepted. If persistence is
configured the AOF is flushed and an RDB written before exit. **Reply:**
`+OK`, then the process exits (`process.exit(0)`) after ~50 ms so the reply
flushes first. In cluster mode this terminates the worker that handled the
command; send `SIGTERM`/`SIGINT` to the master for a full graceful shutdown
(see [deployment.md](../deployment.md)).

## MEMORY

`MEMORY USAGE key` → `:0` · `MEMORY STATS` → empty array ·
`MEMORY PURGE` → `+OK` · `MEMORY DOCTOR` → status string · Arity ≥ 2.

## LATENCY

`LATENCY RESET` → `:0` · `LATENCY HISTORY|LATEST` → empty array ·
`LATENCY GRAPH` → `""` · `LATENCY DOCTOR` → status string · Arity ≥ 2.

## SLOWLOG

`SLOWLOG GET` → empty array · `SLOWLOG LEN` → `:0` · `SLOWLOG RESET` → `+OK` ·
`SLOWLOG HELP` → usage array · Arity ≥ 2.

## ACL

`ACL WHOAMI` → `default` · `ACL LIST` →
`["user default on nopass ~* &* +@all"]` · `ACL USERS` → `["default"]` ·
`ACL GETUSER|CAT` → empty array · others → `+OK` · Arity ≥ 2.

## CLUSTER

`CLUSTER subcommand` · Arity ≥ 2 — reports a standalone, non-clustered node:

| Sub | Reply |
|-----|-------|
| `INFO` | `cluster_enabled:0\r\ncluster_state:ok\r\n...` |
| `MYID` | 40 zeros |
| `NODES` | `""` |
| `SLOTS` / `SHARDS` | empty array |
| `COUNTKEYSINSLOT` / `KEYSLOT` | `:0` |

## WAIT / FAILOVER / MODULE

- `WAIT numreplicas timeout` · Arity 3 → `:0` (no replicas).
- `FAILOVER [..]` · Arity ≥ 1 → `+OK`.
- `MODULE LIST` → empty array; other `MODULE` → `+OK`.

### Sample

```bash
redis-cli -p 6379 INFO Server | head
redis-cli -p 6379 COMMAND COUNT
redis-cli -p 6379 CONFIG GET 'maxmemory*'
redis-cli -p 6379 TIME
redis-cli -p 6379 DEBUG SLEEP 0.2
```