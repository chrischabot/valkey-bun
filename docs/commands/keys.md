# Generic Key Commands

Operate on keys regardless of value type: existence, expiry, iteration,
renaming, cross-database moves, serialization, and sorting.

---

## DEL / UNLINK

`DEL key [key ...]` · `UNLINK key [key ...]` · Arity ≥ 2

Delete keys. `UNLINK` is a synonym (no separate reclaim thread here).
**Reply:** integer count of keys actually removed.

## EXISTS

`EXISTS key [key ...]` · Arity ≥ 2 → integer; counts each existing key
**with multiplicity** (`EXISTS k k` → `2` if `k` exists).

## TOUCH

`TOUCH key [key ...]` · Arity ≥ 2 → integer count of existing keys (no
idletime tracked).

## EXPIRE / PEXPIRE / EXPIREAT / PEXPIREAT

- `EXPIRE key seconds [NX|XX|GT|LT]` · `PEXPIRE key millis [NX|XX|GT|LT]`
  (relative)
- `EXPIREAT key ts-seconds [NX|XX|GT|LT]` ·
  `PEXPIREAT key ts-millis [NX|XX|GT|LT]` (absolute UNIX)
- Arity ≥ 3

Set a key's TTL. Non-numeric time → `ERR value is not an integer or out of
range`. The optional Redis 7.x condition flag:

- `NX` — only if the key has **no** TTL.
- `XX` — only if the key **already** has a TTL.
- `GT` — only if the new expiry is **greater** than the current one.
- `LT` — only if the new expiry is **less** than the current one.

A key with no TTL is treated as **+infinity** for `GT`/`LT`: so `GT` never
sets a persistent key, and `LT` always does. `NX` is incompatible with
`XX`/`GT`/`LT`, and `GT` with `LT` (→ `ERR ... not compatible`); an unknown
flag → `ERR Unsupported option <X>`.

**Reply:** `:1` if the timeout was set, `:0` if not (key missing or the
condition was not met).

```bash
SET k v
EXPIRE k 100        # (integer) 1
EXPIRE k 50 GT      # (integer) 0   (50 < 100)
EXPIRE k 200 GT     # (integer) 1
EXPIRE k 10 NX      # (integer) 0   (already has a TTL)
TTL k               # (integer) ~200  (unchanged by the failed NX)
```

## EXPIRETIME / PEXPIRETIME

`EXPIRETIME key` / `PEXPIRETIME key` · Arity 2

Absolute expiry as UNIX seconds / milliseconds. **Reply:** the timestamp;
`-1` if the key has no TTL; `-2` if the key does not exist.

## TTL / PTTL

`TTL key` / `PTTL key` · Arity 2 → remaining time in seconds / milliseconds;
`-1` if no TTL; `-2` if the key is absent.

## PERSIST

`PERSIST key` · Arity 2 → `:1` if a TTL was removed, `:0` otherwise.

## KEYS

`KEYS pattern` · Arity 2

Return all keys matching a glob `pattern` (`*`, `?`, `[...]`, `\` escape).
**Reply:** array of keys. O(N) over the keyspace — avoid on large datasets in
hot paths; prefer `SCAN`.

```bash
MSET user:1 a user:2 b post:1 c
KEYS user:*    # 1) "user:1" 2) "user:2"
```

## SCAN

`SCAN cursor [MATCH pattern] [COUNT n] [TYPE t]` · Arity ≥ 2

Incrementally iterate keys. valkey2's cursor is a **numeric offset**: pass `0`
to start; the reply's next-cursor is `0` when iteration is complete.
`COUNT` (default 10) bounds the slice scanned per call; `MATCH` filters by
glob; `TYPE` filters by value type (`string|list|hash|set|zset|stream`).
**Reply:** 2-element array `[next-cursor, [keys...]]`.

```bash
SCAN 0 MATCH user:* COUNT 100
# 1) "0"
# 2) 1) "user:1" 2) "user:2"
```

## TYPE

`TYPE key` · Arity 2 → simple string:
`string|list|hash|set|zset|stream`, or `none` if absent.

## RENAME / RENAMENX

`RENAME key newkey` · `RENAMENX key newkey` · Arity 3

Rename, carrying the TTL. `RENAME` errors `ERR no such key` if the source is
missing; `+OK` otherwise (overwrites the destination). `RENAMENX` returns
`ERR no such key` if source missing, `:0` if the destination exists, `:1` on
success.

## RANDOMKEY

`RANDOMKEY` · Arity 1 → a random key (bulk), or nil if the DB is empty.

## DBSIZE

`DBSIZE` · Arity 1 → integer number of keys in the selected DB (expired keys
swept first).

## FLUSHDB / FLUSHALL

`FLUSHDB [ASYNC|SYNC]` · `FLUSHALL [ASYNC|SYNC]` · Arity ≥ 1

Clear the selected DB / all DBs (and reset `WATCH` key-versions). The
`ASYNC`/`SYNC` argument is accepted and ignored. **Reply:** `+OK`. Also emits
a client-cache flush invalidation to `CLIENT TRACKING` clients.

## OBJECT

`OBJECT ENCODING|REFCOUNT|IDLETIME|FREQ|HELP key` · Arity ≥ 2

- `ENCODING key` → `raw` (string), `listpack` (list/hash/set/zset), `stream`;
  nil if the key is absent.
- `REFCOUNT` → `:1`, `IDLETIME` → `:0`, `FREQ` → `:0` (compatibility values).
- `HELP` → usage array.

## COPY

`COPY source destination [DB dest-db] [REPLACE]` · Arity ≥ 3

Deep-copy `source` to `destination` (optionally into another DB). Without
`REPLACE`, fails (`:0`) if the destination exists. The source TTL is carried
over; if the source has no TTL the destination TTL is cleared. Complex values
are deep-copied (no shared mutable backing, including streams). Invalid
`DB` index → `ERR DB index is out of range`. **Reply:** `:1` on copy, `:0`
otherwise.

## MOVE

`MOVE key db` · Arity 3

Move `key` to another database (deep-copied, TTL carried over). Errors:
out-of-range DB → `ERR DB index is out of range`; same DB →
`ERR source and destination objects are the same`. **Reply:** `:1` moved,
`:0` if the source is missing or the destination already has the key.

## DUMP

`DUMP key` · Arity 2

Serialize the value at `key` into a portable, versioned, CRC-checked payload
(valkey2's own internal format — see [persistence.md](../persistence.md) — not
the binary redis-server RDB layout, so it round-trips within valkey2 but not
across to redis-server). **Reply:** the serialized bulk string, or nil if the
key is absent.

## RESTORE

`RESTORE key ttl serialized-value [REPLACE] [ABSTTL] [IDLETIME seconds] [FREQ frequency]`
· Arity ≥ 4

Recreate `key` from a `DUMP` payload. `ttl` is milliseconds (`0` = no
expiry); with `ABSTTL` it is an absolute UNIX-ms timestamp. `REPLACE`
overwrites an existing key (otherwise `BUSYKEY Target key name already
exists.`). `IDLETIME`/`FREQ` are accepted and ignored. A negative/invalid
`ttl` → `ERR Invalid TTL value, must be >= 0`; a corrupt payload →
`ERR DUMP payload version or checksum are wrong`. **Reply:** `+OK`.

```bash
SET k hello
DUMP k                       # "<binary payload>"
RESTORE k2 0 "<payload>"     # OK
GET k2                       # "hello"
```

## SORT / SORT_RO

`SORT key [BY pattern] [LIMIT offset count] [GET pattern [GET pattern ...]] [ASC|DESC] [ALPHA] [STORE destination]`
· Arity ≥ 2
`SORT_RO key [BY pattern] [LIMIT offset count] [GET pattern ...] [ASC|DESC] [ALPHA]`
· Arity ≥ 2

Sort the elements of a `list`, `set`, or `zset`.

- Default: **numeric** sort — every element (or `BY` value) must parse as a
  double, else `ERR One or more scores can't be converted into double`.
- `ALPHA`: lexicographic (byte) sort.
- `BY pattern`: sort by the value an external key/hash field yields, where
  the first `*` in `pattern` is replaced by the element (`key->field`
  selects a hash field). A `BY` pattern with **no `*`** disables sorting
  (Redis "dontsort"). A missing `BY` lookup contributes score `0` in numeric
  mode (and sorts first in `ALPHA`), exactly like redis-server.
- `LIMIT offset count`: paginate (offset ≥ 0; integers required).
- `GET pattern`: project each result through the pattern (`#` = the element
  itself); a missing projection is nil (or an empty string in the `STORE`
  list, since a Redis list cannot hold nil).
- `ASC` (default) / `DESC`: order.
- `STORE destination`: store the result as a list and reply the count
  (an empty result deletes `destination`; the destination is created fresh
  with no TTL). `SORT_RO` rejects `STORE` (`ERR SORT_RO is read-only`).

**Reply:** array of (projected) elements; with `STORE`, the integer length of
the stored list.

```bash
RPUSH mylist 3 1 2
SORT mylist                       # 1) "1" 2) "2" 3) "3"
SORT mylist LIMIT 0 2 DESC        # 1) "3" 2) "2"
RPUSH names banana apple cherry
SORT names ALPHA                  # 1) "apple" 2) "banana" 3) "cherry"
SORT mylist STORE sorted          # (integer) 3
LRANGE sorted 0 -1                # 1) "1" 2) "2" 3) "3"
# BY / GET against external keys:
MSET weight_1 10 weight_2 5 weight_3 1 data_1 A data_2 B data_3 C
SORT mylist BY weight_* GET data_* GET #   # projected by ascending weight
```

### TypeScript sample

```ts
import { Redis } from "ioredis";
const r = new Redis({ port: 6379 });
await r.mset("u:1", "a", "u:2", "b");
await r.expire("u:1", 30);
console.log(await r.ttl("u:1"));            // 30
console.log(await r.type("u:1"));           // "string"
let [cursor, keys] = await r.scan(0, "MATCH", "u:*", "COUNT", 100);
console.log(keys);                          // ["u:1","u:2"]
await r.copy("u:1", "u:1:bak");
const payload = await r.callBuffer("DUMP", "u:1");
await r.call("RESTORE", "u:1:restored", "0", payload);
r.disconnect();
```