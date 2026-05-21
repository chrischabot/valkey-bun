# Generic Key Commands

Operate on keys regardless of value type: existence, expiry, iteration,
renaming, and cross-database moves.

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

- `EXPIRE key seconds` · `PEXPIRE key millis` (relative)
- `EXPIREAT key ts-seconds` · `PEXPIREAT key ts-millis` (absolute UNIX)
- Arity ≥ 3

Set a key's TTL. Non-numeric time → `ERR value is not an integer or out of
range`. **Reply:** `:1` if the timeout was set, `:0` if the key does not
exist.

```bash
SET k v
EXPIRE k 100   # 1
TTL k          # 100
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
`ASYNC`/`SYNC` argument is accepted and ignored. **Reply:** `+OK`.

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
r.disconnect();
```