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
item`). `NOMKSTREAM` returns nil instead of creating a missing stream. The
`MAXLEN`/`MINID` capping clause (with optional `~`/`=` and `LIMIT`) is parsed
and applied. Field/value list must be non-empty and even.

**Reply:** the entry ID (bulk), or nil with `NOMKSTREAM` on a missing stream.

```bash
XADD s '*' temp 21 unit C       # "1700000000000-0"
XADD s 1700000000001-0 temp 22 unit C
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

`XDEL key id [id ...]` · Arity ≥ 3 → integer entries deleted.

## XTRIM

`XTRIM key MAXLEN|MINID [~|=] threshold [LIMIT n]` · Arity ≥ 4

Trim by length (`MAXLEN`) or minimum ID (`MINID`). **Reply:** integer entries
removed.

## XREAD

`XREAD [COUNT n] [BLOCK ms] STREAMS key [key ...] id [id ...]` · Arity ≥ 4

Read entries strictly greater than the given ID per stream. `$` means "only
new entries" (relative to the current last ID at call time). `COUNT`/`BLOCK`
are parsed (this build returns immediately; it does not park the client).
**Reply:** array of `[key, [entries...]]`, or nil if nothing matches.

```bash
XREAD COUNT 100 STREAMS s 0          # all entries after 0
XREAD STREAMS s $                    # nothing yet (only future entries)
```

## XGROUP

`XGROUP CREATE key group <id|$> [MKSTREAM]` · `XGROUP DESTROY key group` ·
`XGROUP CREATECONSUMER key group consumer` ·
`XGROUP DELCONSUMER key group consumer` · `XGROUP SETID key group id` ·
Arity ≥ 2

- `CREATE`: create a consumer group; `$` = start after the current last ID;
  `MKSTREAM` creates a missing stream. Existing group →
  `BUSYGROUP Consumer Group name already exists`; missing stream without
  `MKSTREAM` → error. Reply `+OK`.
- `DESTROY` → `:1`/`:0`. `CREATECONSUMER` → `:1`/`:0`.
  `DELCONSUMER` → number of pending entries that consumer had.
  `SETID` → `+OK` (or `NOGROUP` if the group is missing).

## XREADGROUP

`XREADGROUP GROUP group consumer [COUNT n] [BLOCK ms] [NOACK] STREAMS key [key ...] id [id ...]`
· Arity ≥ 7

- `id = >`: deliver **new** undelivered messages, append them to the group's
  Pending Entries List (PEL), and advance the group's last-delivered ID.
- explicit `id`: **replay** this consumer's pending entries with ID strictly
  greater than `id` (does not mutate the PEL or counters).
Unknown group → `NOGROUP No such key or consumer group`. **Reply:** array of
`[key, [entries...]]`, or nil if nothing.

## XACK

`XACK key group id [id ...]` · Arity ≥ 4 → integer entries acknowledged
(removed from the PEL).

## XPENDING

`XPENDING key group` · Arity ≥ 3

Summary form. **Reply:** `[ count, min-id, max-id, [[consumer, count], ...] ]`
(`count` 0 → `[0, nil, nil, []]`).

## XCLAIM

`XCLAIM key group consumer min-idle-time id [id ...]` · Arity ≥ 6

Reassign the listed pending entries to `consumer` (updates ownership,
delivery time and delivery count). **Reply:** array of claimed entries.

## XINFO

`XINFO STREAM key` · `XINFO GROUPS key` · `XINFO CONSUMERS key group` ·
Arity ≥ 2

- `STREAM`: array of `length`, `radix-tree-keys/nodes`,
  `last-generated-id`, `groups`, `first-entry`, `last-entry`. Missing key →
  `ERR no such key`.
- `GROUPS`: per-group `name`, `consumers`, `pending`, `last-delivered-id`.
- `CONSUMERS`: per-consumer `name`, `pending`, `idle` (ms).

### Worked consumer-group example

```ts
import { Redis } from "ioredis";
const r = new Redis({ port: 6379 });

await r.xadd("events", "*", "type", "signup", "user", "42");
await r.xgroup("CREATE", "events", "workers", "0", "MKSTREAM");

// Worker reads new messages for the group
const batch = await r.xreadgroup(
  "GROUP", "workers", "w1", "COUNT", 10, "STREAMS", "events", ">",
);
// batch = [["events", [["<id>", ["type","signup","user","42"]]]]]

const id = (batch as any)[0][1][0][0];
await r.xack("events", "workers", id);          // 1

console.log(await r.xpending("events", "workers")); // [0, null, null, []]
console.log(await r.xlen("events"));                 // 1
r.disconnect();
```

> Note: `XREAD`/`XREADGROUP` `BLOCK` is parsed but non-blocking in this build
> (the call returns immediately rather than parking the client). Genuine
> blocking is implemented for lists (`BLPOP`/`BRPOP`).