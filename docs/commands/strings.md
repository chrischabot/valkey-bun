# String Commands

String values are binary-safe byte sequences. A wrong-type access returns
`WRONGTYPE`.

---

## GET

`GET key` · Arity 2

Get the value of `key`. **Reply:** bulk string, or nil if the key is missing.

```bash
SET k hello
GET k        # "hello"
GET missing  # (nil)
```

## SET

`SET key value [EX s|PX ms|EXAT ts|PXAT tms|KEEPTTL] [NX|XX] [GET]` · Arity ≥ 3

Set `key` to `value`.

- `EX s` / `PX ms`: relative expiry (seconds/millis). `EXAT ts` / `PXAT tms`:
  absolute UNIX expiry (seconds/millis). Expire arguments must be positive
  integers else `ERR invalid expire time`.
- `KEEPTTL`: retain the existing TTL.
- `NX`: only set if absent. `XX`: only set if present.
- `GET`: also return the old value (errors with `WRONGTYPE` if the old value
  is not a string).

**Reply:** `+OK`; nil if `NX`/`XX` condition not met; with `GET`, the old
value (or nil).

```bash
SET k v EX 60
SET k v2 XX GET     # "v"  (returns old value, sets new)
SET k v3 NX         # (nil) not set, key exists
```

## GETSET

`GETSET key value` · Arity 3

Set `key` to `value`, return the old value (nil if absent). `WRONGTYPE` if the
existing value is not a string. **Reply:** bulk or nil.

## GETDEL

`GETDEL key` · Arity 2

Return the value and delete the key atomically. **Reply:** bulk, or nil if
absent.

## GETEX

`GETEX key [EX s|PX ms|EXAT ts|PXAT tms|PERSIST]` · Arity ≥ 2

Return the value and optionally adjust its TTL: `EX/PX/EXAT/PXAT` set a new
expiry; `PERSIST` removes the TTL. No option leaves the TTL unchanged.
**Reply:** bulk, or nil if absent.

## MGET

`MGET key [key ...]` · Arity ≥ 2

**Reply:** array; each element is the string value or nil (also nil if the key
holds a non-string).

```bash
MSET a 1 b 2
MGET a b c   # 1) "1" 2) "2" 3) (nil)
```

## MSET / MSETNX

`MSET key value [key value ...]` · Arity ≥ 3 → `+OK`

`MSETNX key value [key value ...]` · Arity ≥ 3 → `:1` if **all** keys were
set, `:0` if **any** key already existed (no keys set). Odd argument count →
`ERR wrong number of arguments`.

## APPEND

`APPEND key value` · Arity 3

Append to the string (creating it if absent), preserving any existing TTL.
**Reply:** integer new length.

## STRLEN

`STRLEN key` · Arity 2 → integer length (`0` if absent; `WRONGTYPE` if not a
string).

## INCR / DECR / INCRBY / DECRBY

- `INCR key` · Arity 2
- `DECR key` · Arity 2
- `INCRBY key delta` · Arity 3
- `DECRBY key delta` · Arity 3

Atomically add/subtract an integer (missing key treated as `0`), TTL
preserved. `delta` must be an integer or `ERR value is not an integer or out
of range`; likewise if the stored value is not an integer. **Reply:** integer
new value.

```bash
INCR n          # 1
INCRBY n 10     # 11
DECR n          # 10
```

## INCRBYFLOAT

`INCRBYFLOAT key delta` · Arity 3

Add a float increment (missing key = `0`), TTL preserved. Non-finite current
or delta → `ERR value is not a valid float`. **Reply:** bulk string of the new
value (integral results have no decimal point).

## SETNX

`SETNX key value` · Arity 3 → `:1` if set (key was absent), `:0` otherwise.

## SETEX / PSETEX

- `SETEX key seconds value` · Arity 4
- `PSETEX key millis value` · Arity 4

Set with an expiry; the time must be a positive integer else
`ERR invalid expire time in '<cmd>' command`. **Reply:** `+OK`.

## SETRANGE

`SETRANGE key offset value` · Arity 4

Overwrite the string starting at `offset` (zero-padded if needed), TTL
preserved. `offset` must be a non-negative integer else
`ERR offset is out of range`. **Reply:** integer new length.

## GETRANGE / SUBSTR

`GETRANGE key start end` · Arity 4 (alias `SUBSTR`)

Return the substring `[start, end]` (inclusive). Negative indices count from
the end. Out-of-range yields an empty string. **Reply:** bulk string.

```bash
SET k "Hello World"
GETRANGE k 0 4    # "Hello"
GETRANGE k -5 -1  # "World"
```

## LCS

`LCS key1 key2 [LEN] [IDX] [MINMATCHLEN minmatchlen] [WITHMATCHLEN]` ·
Arity ≥ 3

Longest Common Subsequence of the **string** values at `key1` and `key2` (a
missing key is treated as the empty string; a non-string value →
`WRONGTYPE The specified keys must contain string values`).

- Default: the LCS itself as a **bulk string**.
- `LEN`: the length of the LCS as an **integer**.
- `IDX`: a map `{ "matches": [...], "len": N }`. Each match is
  `[[a-start, a-end], [b-start, b-end]]` (the contiguous run's index ranges
  in `key1` and `key2`), with a trailing match length when `WITHMATCHLEN` is
  given.
- `MINMATCHLEN n`: only report `IDX` matches at least `n` long.
- `LEN` and `IDX` together → `ERR If you want both the length and indexes,
  please just use IDX.`

**Reply:** bulk string (default), integer (`LEN`), or map (`IDX`).

```bash
MSET key1 ohmytext key2 mynewtext
LCS key1 key2                       # "mytext"
LCS key1 key2 LEN                   # (integer) 6
LCS key1 key2 IDX MINMATCHLEN 4 WITHMATCHLEN
# matches => [[[4,7],[5,8],4]], len => 6
```

### TypeScript sample

```ts
import { Redis } from "ioredis";
const r = new Redis({ port: 6379 });
await r.set("page:1:views", "0");
await r.incr("page:1:views");
await r.incrby("page:1:views", 9);          // 10
await r.set("session:abc", "uid42", "EX", 3600);
console.log(await r.getrange("session:abc", 0, 2)); // "uid"
await r.mset("k1", "ohmytext", "k2", "mynewtext");
console.log(await r.call("LCS", "k1", "k2"));       // "mytext"
console.log(await r.call("LCS", "k1", "k2", "LEN")); // 6
r.disconnect();
```