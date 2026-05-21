# List Commands

Lists are ordered sequences of binary-safe elements. Empty lists are deleted
automatically. A wrong-type access returns `WRONGTYPE`.

---

## LPUSH / RPUSH

`LPUSH key element [element ...]` · `RPUSH key element [element ...]` ·
Arity ≥ 3

Prepend (`LPUSH`) or append (`RPUSH`) elements, creating the list if absent.
Multiple elements are inserted in order. **Reply:** integer new length. A push
also wakes a blocked `BLPOP`/`BRPOP` waiter (see below).

## LPUSHX / RPUSHX

`LPUSHX key element [element ...]` · `RPUSHX key element [element ...]` ·
Arity ≥ 3 → like push but only if the list **already exists**; `:0` if absent.

## LPOP / RPOP

`LPOP key [count]` · `RPOP key [count]` · Arity ≥ 2

Remove and return from the head (`LPOP`) / tail (`RPOP`).
- No `count`: a single element (bulk), or nil if absent.
- With `count`: an array of up to `count` elements; `*-1` (null array) if the
  key is absent.
The list is deleted when emptied.

```bash
RPUSH q a b c d
LPOP q       # "a"
RPOP q 2     # 1) "d" 2) "c"
```

## LLEN

`LLEN key` · Arity 2 → integer length (`0` if absent).

## LRANGE

`LRANGE key start stop` · Arity 4

Return the inclusive range; negative indices count from the end. **Reply:**
array (empty if out of range/absent).

```bash
RPUSH l a b c
LRANGE l 0 -1   # 1) "a" 2) "b" 3) "c"
```

## LINDEX

`LINDEX key index` · Arity 3 → the element at `index` (negative = from end),
or nil if out of range/absent.

## LSET

`LSET key index element` · Arity 4 → `+OK`; `ERR no such key` if absent;
`ERR index out of range` if the index is invalid.

## LREM

`LREM key count element` · Arity 4

Remove occurrences of `element`:
- `count > 0`: from head, up to `count`.
- `count < 0`: from tail, up to `|count|`.
- `count = 0`: all.
**Reply:** integer removed count. Empty list is deleted.

## LTRIM

`LTRIM key start stop` · Arity 4 → `+OK`; trims the list to the inclusive
range (negatives from end). An empty result deletes the key.

## LINSERT

`LINSERT key BEFORE|AFTER pivot element` · Arity 5

Insert `element` before/after the first `pivot`. **Reply:** integer new
length; `-1` if `pivot` not found; `0` if the key is absent; `ERR syntax
error` if the direction is not `BEFORE`/`AFTER`.

## LMOVE

`LMOVE source destination LEFT|RIGHT LEFT|RIGHT` · Arity 5

Atomically pop from one end of `source` and push to one end of `destination`.
Invalid direction → `ERR syntax error`. **Reply:** the moved element, or nil
if `source` is empty/absent. `source` is deleted when emptied; a push to
`destination` wakes blocked waiters.

## RPOPLPUSH

`RPOPLPUSH source destination` · Arity 3 → equivalent to
`LMOVE source destination RIGHT LEFT`. Reply: moved element or nil.

## LPOS

`LPOS key element [RANK rank] [COUNT count] [MAXLEN maxlen]` · Arity ≥ 3

Find positions of `element`:
- `RANK` (default 1): which match to start from; negative searches from the
  tail.
- `COUNT` (default returns first match only): `0` means "all matches"; with
  `COUNT` the reply is an array of indices.
- `MAXLEN`: limit comparisons.

**Reply:** without `COUNT`, an integer index or nil; with `COUNT`, an array of
indices (possibly empty).

```bash
RPUSH l a b c a b c a
LPOS l a            # (integer) 0
LPOS l a RANK -1    # (integer) 6   (search from tail)
LPOS l a COUNT 0    # 1) 0 2) 3 3) 6
```

## BLPOP / BRPOP — genuine blocking

`BLPOP key [key ...] timeout` · `BRPOP key [key ...] timeout` · Arity ≥ 3

Pop from the head (`BLPOP`) / tail (`BRPOP`) of the first non-empty key. If
all keys are empty the client **truly blocks** until an element is pushed to
any of the keys or `timeout` (seconds; `0` = block forever) elapses.

- Available immediately → returns at once.
- Negative/invalid timeout → `ERR timeout is not a float or out of range`.
- A push (`LPUSH`/`RPUSH`/`LPUSHX`/`RPUSHX`/`LMOVE`/`RPOPLPUSH`) wakes exactly
  one waiter, FIFO.
- The blocked connection correctly defers its subsequent commands until it
  unblocks (per-connection ordering preserved).

**Reply:** 2-element array `[key, element]`, or `*-1` (null array) on timeout.

```ts
import { Redis } from "ioredis";
const worker = new Redis({ port: 6379 });
const boss = new Redis({ port: 6379 });

const pending = worker.brpop("jobs", 0);   // blocks (forever) until a job
await boss.rpush("jobs", "task-1");
console.log(await pending);                 // ["jobs", "task-1"]

console.log(await worker.blpop("none", 1)); // null after ~1s timeout
worker.disconnect(); boss.disconnect();
```