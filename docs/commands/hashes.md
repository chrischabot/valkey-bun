# Hash Commands

A hash maps binary-safe fields to binary-safe values. A wrong-type access
returns `WRONGTYPE`. Empty hashes are deleted automatically.

---

## HSET

`HSET key field value [field value ...]` · Arity ≥ 4

Set one or more field/value pairs (creating the hash if absent). Odd
field/value count → `ERR wrong number of arguments for 'hset'`.
**Reply:** integer number of **new** fields added (existing fields updated do
not count).

```bash
HSET user:1 name alice age 30   # (integer) 2
HSET user:1 age 31              # (integer) 0  (updated, not new)
```

## HGET

`HGET key field` · Arity 3 → the value (bulk), or nil if the field/key is
absent.

## HMSET

`HMSET key field value [field value ...]` · Arity ≥ 4 → `+OK` (legacy alias
of `HSET`; same arg rules).

## HMGET

`HMGET key field [field ...]` · Arity ≥ 3 → array; each element is the field
value or nil.

## HGETALL

`HGETALL key` · Arity 2

**Reply:**
- **RESP2:** flat array `[field, value, field, value, ...]`.
- **RESP3:** a **map**.
- Empty/absent: empty array (RESP2) / empty map (RESP3).

```bash
HSET h a 1 b 2
HGETALL h          # RESP2: 1) "a" 2) "1" 3) "b" 4) "2"
```

## HDEL

`HDEL key field [field ...]` · Arity ≥ 3 → integer fields removed. The hash is
deleted if it becomes empty.

## HEXISTS

`HEXISTS key field` · Arity 3 → `:1` / `:0`.

## HKEYS / HVALS

`HKEYS key` / `HVALS key` · Arity 2 → array of fields / values (empty array if
absent).

## HLEN

`HLEN key` · Arity 2 → integer field count (`0` if absent).

## HSTRLEN

`HSTRLEN key field` · Arity 3 → integer length of the field's value (`0` if
field/key absent).

## HINCRBY

`HINCRBY key field delta` · Arity 4

Integer increment of a field (missing field = `0`). Non-integer `delta` →
`ERR value is not an integer or out of range`; non-integer existing value →
`ERR hash value is not an integer`. **Reply:** integer new value.

## HINCRBYFLOAT

`HINCRBYFLOAT key field delta` · Arity 4

Float increment. Non-finite delta → `ERR value is not a valid float`;
non-finite existing value → `ERR hash value is not a float`. **Reply:** bulk
string new value.

## HSETNX

`HSETNX key field value` · Arity 4 → `:1` if the field was set (did not
exist), `:0` if it already existed.

## HSCAN

`HSCAN key cursor [MATCH pattern] [COUNT n] [NOVALUES]` · Arity ≥ 3

Iterate fields. Numeric-offset cursor (start at `0`; `0` returned when
complete). `MATCH` filters fields by glob; `COUNT` (default 10) bounds the
slice; `NOVALUES` returns fields only. **Reply:** `[next-cursor, [field,
value, ...]]` (or `[next-cursor, [field, ...]]` with `NOVALUES`).

## HRANDFIELD

`HRANDFIELD key [count [WITHVALUES]]` · Arity ≥ 2

- No `count`: a single random field (bulk), nil if absent.
- `count >= 0`: up to `count` **distinct** fields (sampled without
  replacement).
- `count < 0`: exactly `|count|` fields **with possible repeats**.
- `WITHVALUES`: interleave values after each field.

**Reply:** array (empty if the key is absent and a count was given).

### TypeScript sample

```ts
import { createClient } from "redis";          // RESP3
const c = createClient({ url: "redis://127.0.0.1:6379", RESP: 3 });
await c.connect();
await c.hSet("user:1", { name: "alice", age: "30" });
console.log(await c.hGetAll("user:1"));         // { name: "alice", age: "30" } (map)
console.log(await c.hRandField("user:1"));      // "name" | "age"
await c.hIncrBy("user:1", "age", 1);            // 31
await c.quit();
```