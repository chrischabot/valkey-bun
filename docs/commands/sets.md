# Set Commands

Sets are unordered collections of unique binary-safe members. Empty sets are
deleted automatically. A wrong-type access returns `WRONGTYPE`.

> **RESP3 note:** `SMEMBERS`, `SUNION`, `SINTER`, `SDIFF` return a native
> **set** type under RESP3 (an array under RESP2). `SISMEMBER`/`SMISMEMBER`
> return **booleans** under RESP3 (`:1`/`:0` integers under RESP2). Client
> libraries typically expose both as a JS `Set`/array and boolean/number
> respectively.

---

## SADD

`SADD key member [member ...]` · Arity ≥ 3 → integer number of **new** members
added (creates the set if absent).

## SREM

`SREM key member [member ...]` · Arity ≥ 3 → integer removed. The set is
deleted if emptied.

## SMEMBERS

`SMEMBERS key` · Arity 2 → all members. RESP3 set / RESP2 array (empty if
absent).

## SISMEMBER

`SISMEMBER key member` · Arity 3 → RESP2 `:1`/`:0`; RESP3 `#t`/`#f`.

## SMISMEMBER

`SMISMEMBER key member [member ...]` · Arity ≥ 3 → array of per-member
results (`:1`/`:0` RESP2, booleans RESP3).

## SCARD

`SCARD key` · Arity 2 → integer cardinality (`0` if absent).

## SPOP

`SPOP key [count]` · Arity ≥ 2

Remove and return random member(s). No `count`: a single member (bulk) or
nil. With `count`: an array of up to `count` distinct members (empty array if
absent). The set is deleted when emptied.

## SRANDMEMBER

`SRANDMEMBER key [count]` · Arity ≥ 2

Like `SPOP` but **without** removing. `count >= 0`: up to `count` distinct
members. `count < 0`: exactly `|count|` members with possible repeats. No
`count`: single member or nil.

## SMOVE

`SMOVE source destination member` · Arity 4 → `:1` if moved, `:0` if `member`
not in `source`. `source` is deleted if emptied; `destination` is created if
needed.

## SUNION / SINTER / SDIFF

`SUNION key [key ...]` · `SINTER key [key ...]` · `SDIFF key [key ...]` ·
Arity ≥ 2

Set union / intersection / difference (`SDIFF` = first minus the rest).
A missing key behaves as the empty set; for `SINTER`, any missing key yields
an empty result. **Reply:** RESP3 set / RESP2 array.

```bash
SADD a 1 2 3
SADD b 2 3 4
SINTER a b   # {2,3}
SUNION a b   # {1,2,3,4}
SDIFF a b    # {1}
```

## SUNIONSTORE / SINTERSTORE / SDIFFSTORE

`<OP>STORE destination key [key ...]` · Arity ≥ 3

Compute the operation and store the result in `destination` (overwriting it;
deleting it if the result is empty). **Reply:** integer cardinality of the
result.

## SINTERCARD

`SINTERCARD numkeys key [key ...] [LIMIT limit]` · Arity ≥ 3

Cardinality of the intersection of `numkeys` sets, optionally capped at
`LIMIT` (`0`/absent = no cap). Any missing set → `0`. **Reply:** integer.

## SSCAN

`SSCAN key cursor [MATCH pattern] [COUNT n]` · Arity ≥ 3

Iterate members with a numeric-offset cursor (start `0`; `0` returned when
complete). **Reply:** `[next-cursor, [members...]]`.

### TypeScript sample

```ts
import { Redis } from "ioredis";
const r = new Redis({ port: 6379 });
await r.sadd("tags:post:1", "redis", "bun", "ts");
await r.sadd("tags:post:2", "bun", "effect");
console.log(await r.sinter("tags:post:1", "tags:post:2")); // ["bun"]
console.log(await r.sismember("tags:post:1", "redis"));     // 1 (RESP2)
console.log(await r.scard("tags:post:1"));                  // 3
r.disconnect();
```