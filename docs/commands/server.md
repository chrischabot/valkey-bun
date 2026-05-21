# Server & Administrative Commands

Introspection and administration. Many persistence/cluster commands are
accepted as no-ops for client compatibility (valkey2 is ephemeral and
single-node — see [deployment.md](../deployment.md)).

---

## INFO

`INFO [section]` · Arity ≥ 1

**Reply:** a bulk string of `# Section` blocks with `key:value` lines. Sections
include `Server` (`redis_version` `7.4.0`, `redis_mode` `standalone`, pid,
uptime, tcp_port…), `Clients` (`connected_clients`, `maxclients`), `Memory`
(`used_memory`, `maxmemory` `0`, `maxmemory_policy` `noeviction`),
`Persistence` (all zero/disabled), `Stats` (`total_commands_processed`…),
`Replication` (`role:master`), `CPU`, and `Keyspace` (`dbN:keys=…,expires=…`).
The optional section argument is accepted; the full document is returned.

## COMMAND

`COMMAND [subcommand]` · Arity ≥ 1

- No args → empty array.
- `COUNT` → `:200` (approximate). `LIST` → empty array. `GETKEYS` → empty
  array. `DOCS` → empty map (RESP3) / array (RESP2). `INFO name [...]` →
  array of nils.

## CONFIG

`CONFIG GET pattern [pattern ...]` · `CONFIG SET key value [key value ...]` ·
`CONFIG RESETSTAT` · `CONFIG REWRITE` · Arity ≥ 2

In-memory config map (see [configuration.md](../configuration.md)). `GET`
supports glob patterns; `SET` updates the map; `RESETSTAT`/`REWRITE` →
`+OK` (no config file exists).

```bash
CONFIG GET maxmemory          # 1) "maxmemory" 2) "0"
CONFIG SET maxmemory 100mb    # OK
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

## Persistence (no-ops)

| Command | Reply |
|---------|-------|
| `SAVE` | `+OK` |
| `BGSAVE` | `+Background saving started` |
| `BGREWRITEAOF` | `+Background append only file rewriting started` |
| `LASTSAVE` | server start time (integer seconds) |

valkey2 has no on-disk persistence; these exist only so backup/tooling
clients do not error.

## SHUTDOWN

`SHUTDOWN [NOSAVE|SAVE] [NOW] [FORCE] [ABORT]` · Arity ≥ 1

Stop the server. Any optional arguments (`NOSAVE`/`SAVE`/`NOW`/`FORCE`/
`ABORT`) are accepted and ignored — there is nothing to persist. **Reply:**
`+OK`, then the process exits (`process.exit(0)`) after ~50 ms, which lets the
reply flush to the client first. In cluster mode this terminates the worker
that handled the command; send `SIGTERM`/`SIGINT` to the master for a full
graceful shutdown (see [deployment.md](../deployment.md)).

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
redis-cli -p 6379 CONFIG GET 'maxmemory*'
redis-cli -p 6379 TIME
redis-cli -p 6379 DEBUG SLEEP 0.2
```