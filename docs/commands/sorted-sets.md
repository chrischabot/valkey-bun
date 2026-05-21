# Sorted Set Commands

A sorted set (zset) maps unique members to floating-point scores, ordered by
score then member lexicographically. A wrong-type access returns `WRONGTYPE`.

> **RESP3 note:** score-returning commands (`ZSCORE`, `ZMSCORE`, `ZINCRBY`,
> `ZADD … INCR`) return a native **double** under RESP3 and a **bulk string**
> under RESP2. `WITHSCORES` replies always use the bulk-string score form.
> Special scores serialize as `inf`, `-inf`, `nan`.

## Range argument syntax

- **Score ranges** (`ZRANGEBYSCORE`, `ZCOUNT`, `ZRANGE … BYSCORE`): `min`/`max`
  are numbers; `-inf`/`+inf` allowed; a leading `(` means exclusive
  (e.g. `(5`).
- **Lex ranges** (`ZRANGEBYLEX`, `ZLEXCOUNT`, `ZRANGE … BYLEX`): `[m`
  inclusive, `(m` exclusive, `-` = minimum, `+` = maximum. Invalid forms →
  `ERR min or max not valid string range item`.

---

## ZADD

`ZADD key [NX|XX] [GT|LT] [CH] [INCR] score member [score member ...]` ·
Arity ≥ 4

- `NX`: only add new members. `XX`: only update existing.
- `GT`/`LT`: only update if the new score is greater/less than the current.
- `CH`: return changed (added + updated) instead of only added.
- `INCR`: increment the member's score by `score` (single pair only, else
  `ERR INCR option supports a single increment-element pair`); replies the new
  score (or nil if `NX`/`XX`/`GT`/`LT` suppressed it).

Bad pair count → `ERR syntax error`. **Reply:** integer added (or
added+changed with `CH`); with `INCR`, the new score (double in RESP3) or nil.

```bash
ZADD board 100 alice 80 bob       # (integer) 2
ZADD board CH 90 alice            # (integer) 1   (changed)
ZADD board INCR 5 alice           # "95"
ZADD board GT 1 alice             # nil-effect (1 < 95, not updated)
```

## ZREM

`ZREM key member [member ...]` · Arity ≥ 3 → integer removed; the zset is
deleted when emptied.

## ZSCORE / ZMSCORE

`ZSCORE key member` · Arity 3 → score or nil.
`ZMSCORE key member [member ...]` · Arity ≥ 3 → array of scores/nils.

## ZINCRBY

`ZINCRBY key increment member` · Arity 4 → the new score (missing member = 0).

## ZCARD / ZCOUNT / ZLEXCOUNT

- `ZCARD key` · Arity 2 → member count.
- `ZCOUNT key min max` · Arity 4 → count within an (inclusive/exclusive)
  score range.
- `ZLEXCOUNT key min max` · Arity 4 → count within a lex range.

## ZRANK / ZREVRANK

`ZRANK key member [WITHSCORE]` · `ZREVRANK key member [WITHSCORE]` ·
Arity ≥ 3

Rank (0-based; `ZREVRANK` from the high end). **Reply:** integer rank, or nil
if absent; with `WITHSCORE`, `[rank, score]` or a null array if absent.

## ZRANGE

`ZRANGE key start stop [BYSCORE|BYLEX] [REV] [LIMIT offset count] [WITHSCORES]`
· Arity ≥ 4

The unified range command:
- Default: index range `[start, stop]` (negatives from the end).
- `BYSCORE`: `start`/`stop` are score bounds.
- `BYLEX`: `start`/`stop` are lex bounds.
- `REV`: reverse ordering (and swap the bound interpretation).
- `LIMIT offset count` (only with `BYSCORE`/`BYLEX`): paginate; `count < 0`
  means "all from offset".
- `WITHSCORES`: interleave scores.

**Reply:** array (members, optionally with scores). Empty/absent → empty
array.

```bash
ZADD z 1 a 2 b 3 c
ZRANGE z 0 -1                       # a b c
ZRANGE z 0 -1 REV                  # c b a
ZRANGE z (1 3 BYSCORE             # b c
ZRANGE z 1 3 BYSCORE WITHSCORES   # a 1 b 2 c 3
ZRANGE z "[a" "(c" BYLEX          # a b
```

## ZREVRANGE / ZRANGEBYSCORE / ZREVRANGEBYSCORE / ZRANGEBYLEX / ZREVRANGEBYLEX

- `ZREVRANGE key start stop [WITHSCORES]` · Arity ≥ 4 — index range, reversed.
- `ZRANGEBYSCORE key min max [WITHSCORES] [LIMIT offset count]` · Arity ≥ 4.
- `ZREVRANGEBYSCORE key max min [WITHSCORES] [LIMIT offset count]` · Arity ≥ 4
  (note reversed bound order).
- `ZRANGEBYLEX key min max [LIMIT offset count]` · Arity ≥ 4.
- `ZREVRANGEBYLEX key max min [LIMIT offset count]` · Arity ≥ 4.

**Reply:** array (with interleaved scores when `WITHSCORES`).

## ZPOPMIN / ZPOPMAX

`ZPOPMIN key [count]` · `ZPOPMAX key [count]` · Arity ≥ 2

Remove and return the lowest/highest-scored member(s). **Reply:** flat array
`[member, score, ...]` (empty if absent). The zset is deleted when emptied.

## ZRANDMEMBER

`ZRANDMEMBER key [count [WITHSCORES]]` · Arity ≥ 2

No `count`: a single random member or nil. `count >= 0`: up to `count`
distinct members. `count < 0`: `|count|` members with possible repeats.
`WITHSCORES` interleaves scores. **Reply:** array (or single bulk).

## ZUNION / ZINTER / ZDIFF (+ STORE)

- `ZUNION numkeys key [key ...] [WEIGHTS w ...] [AGGREGATE SUM|MIN|MAX] [WITHSCORES]`
  · Arity ≥ 3
- `ZINTER numkeys key [key ...] [WEIGHTS ...] [AGGREGATE ...] [WITHSCORES]`
  · Arity ≥ 3
- `ZDIFF numkeys key [key ...] [WITHSCORES]` · Arity ≥ 3
- `ZUNIONSTORE dest numkeys key [...] [WEIGHTS ...] [AGGREGATE ...]` · Arity ≥ 4
- `ZINTERSTORE dest numkeys key [...] [WEIGHTS ...] [AGGREGATE ...]` · Arity ≥ 4
- `ZDIFFSTORE dest numkeys key [...]` · Arity ≥ 4

Source keys may be sorted sets **or plain sets** (set members count as score
`1`). `WEIGHTS` multiplies each source's scores; `AGGREGATE` (default `SUM`)
combines on overlap. Non-STORE → array (optionally `WITHSCORES`); STORE →
integer result cardinality (destination overwritten/deleted-if-empty).

## ZRANGESTORE

`ZRANGESTORE dest src start stop [BYSCORE|BYLEX] [REV] [LIMIT offset count]` ·
Arity ≥ 5

Like `ZRANGE` but stores the selected range into `dest`. A missing source
deletes `dest` and returns `0`. **Reply:** integer number stored.

## ZINTERCARD

`ZINTERCARD numkeys key [key ...] [LIMIT limit]` · Arity ≥ 3 → intersection
cardinality, optionally capped by `LIMIT` (`0` = no cap); any missing source →
`0`.

## ZSCAN

`ZSCAN key cursor [MATCH pattern] [COUNT n]` · Arity ≥ 3 → `[next-cursor,
[member, score, ...]]` (numeric-offset cursor, step 10).

### TypeScript sample

```ts
import { createClient } from "redis";          // RESP3
const c = createClient({ url: "redis://127.0.0.1:6379", RESP: 3 });
await c.connect();
await c.zAdd("board", [
  { score: 100, value: "alice" },
  { score: 80,  value: "bob" },
]);
console.log(await c.zRangeWithScores("board", 0, -1));      // [{value,score}, ...]
console.log(await c.zScore("board", "alice"));              // 100 (RESP3 double)
await c.zIncrBy("board", 5, "bob");                         // 85
console.log(await c.zRange("board", 0, -1, { REV: true }));  // ["alice","bob"]
await c.quit();
```