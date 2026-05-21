# Transaction Commands

valkey2 supports Redis transactions: a `MULTI`/`EXEC` block executes queued
commands sequentially, and `WATCH` provides optimistic locking
(check-and-set). There is no rollback — Redis transactions guarantee
*isolation and atomic execution of the batch*, not rollback on logical errors.

---

## MULTI

`MULTI` · Arity 1

Begin a transaction. Subsequent commands are validated for arity and then
**queued** (reply `+QUEUED`) instead of executing. Nested `MULTI` →
`ERR MULTI calls can not be nested`. **Reply:** `+OK`.

Transaction-control commands themselves (`MULTI`, `EXEC`, `DISCARD`, `WATCH`,
`UNWATCH`) are never queued — they act immediately.

## EXEC

`EXEC` · Arity 1

Execute the queued commands and return their replies as an array, in order.

- `EXEC` without `MULTI` → `ERR EXEC without MULTI`.
- If any queued command failed to enqueue (e.g. wrong arity) →
  `EXECABORT Transaction discarded because of previous errors.`
- If any `WATCH`ed key changed since it was watched → the transaction is
  **aborted** and `EXEC` replies `*-1` (null array); nothing runs.
- Otherwise → array of each command's reply.

`WATCH` state and the queue are cleared after `EXEC` regardless of outcome.

## DISCARD

`DISCARD` · Arity 1 → `+OK`; drops the queued commands and clears `WATCH`.
`ERR DISCARD without MULTI` if not in a transaction.

## WATCH

`WATCH key [key ...]` · Arity ≥ 2

Mark keys for optimistic locking: their current versions are snapshotted. If
any watched key is mutated (by any client) before `EXEC`, the transaction
aborts. `WATCH` inside `MULTI` → `ERR WATCH inside MULTI is not allowed`.
**Reply:** `+OK`.

Internally every mutating command bumps a per-key version **only on real
mutation** — a no-op write does not invalidate a `WATCH`.

## UNWATCH

`UNWATCH` · Arity 1 → `+OK`; forget all watched keys.

---

## Semantics summary

| Situation | `EXEC` result |
|-----------|---------------|
| Normal | array of replies |
| A queued command had a queue-time error | `EXECABORT` error |
| A watched key changed | `*-1` (null array) |
| Not in `MULTI` | `ERR EXEC without MULTI` |

A command that errors *at execution time* (e.g. `WRONGTYPE`) does not abort
the rest — its error is simply that element of the result array.

## Worked example: atomic transfer with WATCH (CAS retry)

```ts
import { Redis } from "ioredis";
const r = new Redis({ port: 6379 });
await r.mset("acct:a", "100", "acct:b", "0");

async function transfer(amount: number): Promise<boolean> {
  await r.watch("acct:a", "acct:b");
  const a = Number(await r.get("acct:a"));
  if (a < amount) { await r.unwatch(); return false; }
  const b = Number(await r.get("acct:b"));
  const res = await r
    .multi()
    .set("acct:a", String(a - amount))
    .set("acct:b", String(b + amount))
    .exec();
  return res !== null;           // null => a watched key changed; caller retries
}

console.log(await transfer(30)); // true
console.log(await r.mget("acct:a", "acct:b")); // ["70","30"]
r.disconnect();
```

Plain `MULTI`/`EXEC` (no `WATCH`):

```bash
MULTI
SET a 1
INCR a
EXEC          # 1) OK  2) (integer) 2
```