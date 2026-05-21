# Stream Commands

A stream is an append-only log of entries, each with an ID `ms-seq` and a list
of field/value pairs. Consumer groups provide at-least-once fan-out with
explicit acknowledgement. A wrong-type access returns `WRONGTYPE`.

Entry reply shape everywhere: `[ id, [field, value, field, value, ...] ]`.

---

## XADD

`XADD key [NOMKSTREAM] [MAXLEN|MINID [~|=] threshold [LIMIT n]] <id|*> field value [field value ...]`
· Arity ≥ 5

Append an entry. `*` auto-generates a monotonically increasing ID; an explicit
`ms` or `ms-seq` is validated to be strictly greater than the last
(`ERR The ID specified in XADD is equal or smaller than the target stream top
item`). `NOMKSTREAM` returns nil instead of creating a missing stream.

The `MAXLEN`/`MINID` capping clause is **applied** after the append (the
optional `~`/`=` is accepted; `MAXLEN` must be a positive integer ≥ 1, `MINID`
a valid stream ID, else `ERR ...`; an optional `LIMIT n` is parsed and
must be a non-negative integer). Field/value list must be non-empty and even.

**Reply:** the entry ID (bulk), or nil with `NOMKSTREAM` on a missing stream.

```bash
XADD s '*' temp 21 unit C            # "1700000000000-0"
XADD s MAXLEN 1000 '*' temp 22       # caps the stream at ~1000 entries
XADD s 1700000000001-0 temp 23
```

## XLEN

`XLEN key` · Arity 2 → integer entry count (`0` if absent).

## XRANGE / XREVRANGE

`XRANGE key start end [COUNT n]` · `XREVRANGE key end start [COUNT n]` ·
Arity ≥ 4

Range by ID, inclusive. `-`/`+` are the minimum/maximum IDs; a bare `ms` is
completed to `ms-0` (start) / `ms-<max seq>` (end). **Reply:** array of
entries (reversed for `XREVRANGE`).

```bash
XRANGE s - +              # all entries
XRANGE s - + COUNT 10
XREVRANGE s + - COUNT 1   # newest entry
```

## XDEL

`XDEL key id [id ...]` · Arity ≥ 3 → integer entries deleted (also removed
from every group's PEL).

## XTRIM

`XTRIM key MAXLEN|MINID [~|=] threshold [LIMIT n]` · Arity ≥ 4

Trim by length (`MAXLEN`, integer) or minimum ID (`MINID`, valid stream ID).
The optional `~`/`=` and `LIMIT n` (non-negative integer) are validated; a
trailing unexpected argument → `ERR syntax error`. **Reply:** integer entries
removed.

## XREAD — genuine blocking

`XREAD [COUNT n] [BLOCK ms] STREAMS key [key ...] id [id ...]` · Arity ≥ 4

Read entries strictly greater than the given ID per stream. `$` means "only
entries added after this call". `COUNT` (positive integer) bounds entries per
stream. With `BLOCK ms` (non-negative integer; `0` = block forever) the
client **truly blocks** until a matching entry is added to any of the streams
or the timeout elapses; a later `XADD`/`XGROUP CREATE` wakes it.

**Reply:** array of `[key, [entries...]]`, or nil if nothing matches / on
timeout.

```bash
XREAD COUNT 100 STREAMS s 0          # all entries after 0
XREAD BLOCK 0 STREAMS s $            # blocks until the next XADD
```

## XGROUP

`XGROUP CREATE key group <id|$> [MKSTREAM]` · `XGROUP DESTROY key group` ·
`XGROUP CREATECONSUMER key group consumer` ·
`XGROUP DELCONSUMER key group consumer` · `XGROUP SETID key group <id|$>` ·
Arity ≥ 2

- `CREATE`: create a consumer group; `$` = start after the current last ID;
  an explicit ID is validated (`ERR Invalid stream ID ...`); `MKSTREAM`
  creates a missing stream (else `ERR The XGROUP subcommand requires the key
  to exist.`). Existing group →
  `BUSYGROUP Consumer Group name already exists`. Reply `+OK`; also wakes
  blocked `XREAD`/`XREADGROUP` waiters on that key.
- `DESTROY` → `:1`/`:0`. `CREATECONSUMER` → `:1`/`:0`.
  `DELCONSUMER` → number of pending entries that consumer had.
  `SETID` → `+OK` (validated ID; `$` = current last ID; `NOGROUP` if the
  group is missing).

## XSETID

`XSETID key id [ENTRIESADDED n] [MAXDELETEDID id]` · Arity ≥ 3

Set the stream's last-generated ID. The key must exist
(`ERR The XSETID command requires the key to exist.`); `id` must be a valid
stream ID. `ENTRIESADDED`/`MAXDELETEDID` are accepted (each requires a value).
**Reply:** `+OK`.

## XREADGROUP — genuine blocking

`XREADGROUP GROUP group consumer [COUNT n] [BLOCK ms] [NOACK] STREAMS key [key ...] id [id ...]`
· Arity ≥ 7

- `id = >`: deliver **new** undelivered messages, append them to the group's
  Pending Entries List (PEL) unless `NOACK` is given, and advance the group's
  last-delivered ID. `COUNT` bounds the batch. With `BLOCK ms` and a `>` id
  the client **blocks** until new messages arrive or the timeout elapses.
- explicit `id`: **replay** this consumer's pending entries with ID strictly
  greater than `id` (does not mutate the PEL or counters); `COUNT` bounds the
  replayed list.

Unknown group → `NOGROUP No such key or consumer group`. **Reply:** array of
`[key, [entries...]]`, or nil if nothing / on timeout.

## XACK

`XACK key group id [id ...]` · Arity ≥ 4 → integer entries acknowledged
(removed from the PEL; the owning consumer's pending count is decremented).

## XPENDING

**Summary form:** `XPENDING key group` · Arity 3 →
`[ count, min-id, max-id, [[consumer, count], ...] ]` (`[0, nil, nil, nil]`
when the group has no pending entries).

**Extended form:**
`XPENDING key group [IDLE min-idle-ms] start end count [consumer]` ·
Arity ≥ 6 → array of `[id, consumer, idle-ms, delivery-count]` rows, filtered
by ID range, optional minimum idle time, and optional consumer. `count` must
be a positive integer; a trailing unexpected argument → `ERR syntax error`.

```bash
XPENDING events workers                       # summary
XPENDING events workers IDLE 5000 - + 10      # extended, idle >= 5s
XPENDING events workers - + 10 worker-1       # filtered to one consumer
```

## XCLAIM

`XCLAIM key group consumer min-idle-time id [id ...] [IDLE ms] [TIME ms] [RETRYCOUNT n] [FORCE] [LASTID id] [JUSTID]`
· Arity ≥ 6

Reassign the listed pending entries (older than `min-idle-time` ms) to
`consumer`, updating ownership, delivery time and delivery count. `IDLE`,
`TIME`, `RETRYCOUNT` take a non-negative integer; `LASTID` a valid stream ID;
`FORCE` is accepted; malformed IDs/options → `ERR Invalid stream ID ...` /
`ERR syntax error`. **Reply:** array of claimed entries, or — with `JUSTID` —
an array of claimed IDs (and `JUSTID` does not bump the delivery count's
display).

## XAUTOCLAIM

`XAUTOCLAIM key group consumer min-idle-time start [COUNT count] [JUSTID]` ·
Arity ≥ 7

Scan the group PEL from `start`, claiming up to `count` (default 100) entries
idle for at least `min-idle-time` ms to `consumer`. Pending IDs whose entry no
longer exists are dropped and reported as deleted. **Reply:**
`[ next-cursor, [claimed entries|ids], [deleted ids] ]`. The cursor is `0-0`
(single-pass scan over the current PEL).

## XINFO

`XINFO STREAM key [FULL]` · `XINFO GROUPS key` ·
`XINFO CONSUMERS key group` · Arity ≥ 2

- `STREAM`: array of `length`, `radix-tree-keys/nodes`, `last-generated-id`,
  `groups`, `first-entry`, `last-entry`. With `FULL`: `length`,
  `last-generated-id`, the full `entries` array, and `groups` each with
  `name`, `last-delivered-id`, `pel-count`, and the full `pending` PEL
  (`[id, consumer, delivered-at, deliveries]`). Missing key →
  `ERR no such key`.
- `GROUPS`: per-group `name`, `consumers`, `pending`, `last-delivered-id`.
- `CONSUMERS`: per-consumer `name`, `pending`, `idle` (ms). Missing group →
  `NOGROUP No such consumer group`.

### Worked consumer-group example

```ts
import { Redis } from "ioredis";
const r = new Redis({ port: 6379 });

await r.xadd("events", "*", "type", "signup", "user", "42");
await r.xgroup("CREATE", "events", "workers", "0", "MKSTREAM");

// Worker reads new messages for the group (non-blocking: no BLOCK arg)
const batch = await r.xreadgroup(
  "GROUP", "workers", "w1", "COUNT", 10, "STREAMS", "events", ">",
);
// batch = [["events", [["<id>", ["type","signup","user","42"]]]]]

const id = (batch as any)[0][1][0][0];
await r.xack("events", "workers", id);          // 1

console.log(await r.xpending("events", "workers")); // [0, null, null, null]
console.log(await r.xlen("events"));                 // 1
r.disconnect();
```

> `XREAD`/`XREADGROUP` `BLOCK` is **genuinely blocking** in valkey2 (it parks
> the client via the same waiter registry as `BLPOP`); a `0` timeout blocks
> forever and a later `XADD`/`XGROUP CREATE` wakes it.