# Architecture

valkey2 is built on one core principle:

> **Effect at the boundary, raw metal on the hot path.**

Effect v4 governs the *control plane*; the per-command *data plane* is
deliberately plain, allocation-conscious, synchronous TypeScript.

## Why the split

Wrapping every Redis command in an `Effect`/`Promise` was measured (in the
predecessor project) to cap throughput: the inner loop runs 10⁵+ ops/s and
cannot afford a microtask per command. So:

- **Control plane (Effect v4):** configuration, dependency injection, domain
  errors, structured startup/shutdown, logging, the HTTP/3 admin server. This
  is where Effect's composition, typed errors, and `Layer` wiring add value.
- **Data plane (raw TS):** TCP read → RESP parse → command dispatch → reply
  encode → coalesced TCP write. No Effect, no Promise unless a handler is
  genuinely asynchronous (only blocking list ops are).

## Module map

```
src/
  index.ts            Effect v4 entry point: Config layer, startup/shutdown,
                       optional SO_REUSEPORT cluster forking
  config.ts           Effect Config service + Layer (env-driven)
  errors.ts           Schema.TaggedErrorClass domain errors (ConfigError, …)
  server-context.ts   Shared runtime state: Store, PubSub, connections,
                       key-version map (WATCH), config, blocking-waiter registry
  tcp-server.ts       Raw Bun.listen data plane: parse → dispatch → flush;
                       per-connection async deferral queue
  connection.ts       Per-connection state + write coalescing (OutWriter)
  resp.ts             RESP2/RESP3 codec: parser, encoder, parseCommand
                       fast-path, RESP value model, reply constructors
  store.ts            In-memory multi-DB store; String/List/Hash/Set/ZSet/
                       Stream value types; latin1 binary-safe keys; TTLs
  pubsub.ts           Channel/pattern registry + glob matcher
  admin.ts            Bun.serve HTTP/3 (QUIC) admin: /health /info /metrics
  commands/
    index.ts          Registry + preDispatch (auth/arity/subscribe/MULTI)
                       + dispatchSync / dispatch
    connection.ts     PING ECHO AUTH HELLO SELECT CLIENT RESET QUIT
    keys.ts           DEL EXPIRE TTL KEYS SCAN TYPE RENAME COPY MOVE OBJECT …
    strings.ts        GET SET INCR APPEND GETRANGE SETRANGE …
    hashes.ts         HSET HGET HGETALL HSCAN HRANDFIELD …
    lists.ts          LPUSH RPUSH LRANGE LMOVE LPOS BLPOP BRPOP …
    sets.ts           SADD SMEMBERS SINTER SUNIONSTORE SINTERCARD …
    zsets.ts          ZADD ZRANGE(BYSCORE/BYLEX/REV) ZRANGESTORE ZINTERCARD …
    streams.ts        XADD XRANGE XREAD XGROUP XREADGROUP XACK XCLAIM …
    transactions.ts   MULTI EXEC DISCARD WATCH UNWATCH
    pubsub.ts         (S)SUBSCRIBE (S)PUBLISH PUBSUB …
    server.ts         INFO CONFIG COMMAND DEBUG CLUSTER SWAPDB …
    scripting.ts      EVAL/SCRIPT/FUNCTION (stubbed, explicit errors)
```

## Startup (control plane)

`src/index.ts`:

1. If `VALKEY_CLUSTER_SIZE > 1` and this is the master process, fork N worker
   processes that share the TCP port via `SO_REUSEPORT`, then supervise them.
2. Otherwise run the Effect program:
   - `ServerConfig` is resolved by the `Config` layer (`src/config.ts`) from
     environment variables, validated; failures surface as a
     `ConfigError` (`Schema.TaggedErrorClass`).
   - `startTcpServer(cfg)` binds the raw RESP listener.
   - On worker 0 (or single process) `startAdminServer(ctx, adminPort)`
     starts the HTTP/3 admin endpoint.
   - `Effect.log` reports readiness; `SIGTERM`/`SIGINT` trigger graceful
     shutdown (`admin.stop()` then `process.exit(0)`).

The Effect layer is provided exactly once at the top:
`Effect.runPromise(Effect.provide(program, AppLayer))`.

## Request lifecycle (data plane)

For each TCP connection (`Bun.listen` `socket` handlers in `tcp-server.ts`):

1. **Read.** Incoming bytes are appended to the connection's growable buffer
   (`Connection.appendData`).
2. **Parse.** A loop tries the **fast path** `parseCommand` first — it parses
   the common `*N\r\n$len\r\n…` array-of-bulk frame with **no intermediate
   `RespValue` allocation**. If the frame is an inline command or a RESP3
   mixed type, it falls back to the general `parse`. Incomplete data → break
   and wait for more bytes.
3. **Dispatch.** `preDispatch` enforces, in order: NOAUTH (if `requirepass`
   set), unknown-command, arity, subscribe-mode restrictions, and `MULTI`
   queuing. Then:
   - `dispatchSync` runs the handler synchronously (the overwhelming common
     case) and writes the reply into the connection's `OutWriter`.
   - If a handler returns a thenable (only `BLPOP`/`BRPOP`, `EXEC`,
     `DEBUG SLEEP`), it is chained onto a **per-connection async queue**
     (`deferAsync`) so subsequent commands preserve reply order.
4. **Encode.** `encodeInto` writes RESP bytes directly into the `OutWriter`
   cursor buffer (no per-reply concatenation), honoring RESP2/RESP3.
5. **Flush.** After draining all complete frames from the read buffer, a
   **single `socket.write()`** emits the whole `OutWriter` snapshot
   (write coalescing).

## Store model (`store.ts`)

- `Store` holds `dbCount` `Database` instances (default 16). `SELECT` picks
  the per-connection DB index.
- A `Database` is two maps: `data: Map<string, StoredValue>` and
  `expires: Map<string, number>` (absolute ms).
- **Binary-safe keys:** bytes are mapped to strings via a latin1 bijection
  (byte *n* ↔ codepoint *n*) so arbitrary binary keys/members survive as
  `Map` keys. Always use `bytesToKey`/`keyToBytes`.
- `StoredValue` is a tagged union: `string` (`Uint8Array`), `list`
  (`Uint8Array[]`), `hash` (`Map`), `set` (`Set`), `zset` (`ZSet`), `stream`
  (`Stream`).
- **Expiry** is lazy (checked on access in `getRaw`) plus a 1 Hz background
  sweep (`sweepLazy`).
- `ZSet` keeps a **cached sorted-entries array** invalidated only on writes,
  so repeated range queries are cheap. Sort order is by score, then member
  lexicographically.

## Connection model (`connection.ts`)

Each `Connection` tracks: `id`, `resp3`, `selectedDb`, `name`,
`authenticated`, `inMulti`/`multiQueue`/`multiError`, `watched` (per-DB
key→version map for `WATCH`), `subscribedChannels`/`subscribedPatterns`, and
its `OutWriter`. `reply()` encodes into the buffer; `flush()` performs the
single coalesced write; pub/sub `sendMessage`/`sendPMessage` push immediately
and flush.

## Transactions

`MULTI` sets `inMulti`. Subsequent non-`noQueue` commands are validated for
arity then **queued** (reply `+QUEUED`). `EXEC`:

1. Checks every `WATCH`ed key's version against `ctx.keyVersion`; if any
   changed → reply `*-1` (null array, aborted).
2. If any queued command had an arity error → `EXECABORT`.
3. Otherwise replays the queue through `dispatch`, capturing each reply into
   an array returned as the `EXEC` result.

`WATCH` snapshots `ctx.keyVersion(db, key)`; every mutating command calls
`ctx.bumpKey(db, key)` — **only on real mutation**, which is what makes
optimistic locking correct.

## Pub/Sub

`PubSub` keeps `channels: Map<string, Set<Connection>>` and
`patterns: Map<string, Set<Connection>>`. `PUBLISH` delivers to channel
subscribers and to every pattern whose glob matches, returning the receiver
count. Sharded variants (`SSUBSCRIBE`/`SPUBLISH`) share the channel registry —
correct for a standalone (non-clustered) node.

## Genuine blocking `BLPOP`/`BRPOP`

Unlike the predecessor, blocking pops truly block: if no element is available
the handler returns a `Promise` registered in the server-context
**waiter registry**. A later `LPUSH`/`RPUSH`/`LMOVE`/`RPOPLPUSH` to a waited
key wakes exactly one waiter (FIFO). The pending `Promise` integrates with the
per-connection deferral queue, so a blocked client correctly defers its
subsequent commands and reply order is preserved. A `0` timeout blocks
forever; otherwise the waiter is woken with a null reply on timeout.

## RESP codec (`resp.ts`)

A single module implements the full RESP2 + RESP3 grammar (see
[protocol.md](./protocol.md)). Highlights:

- `parse` handles every RESP type incl. RESP3 `_ # , ( % ~ | >` and inline
  commands.
- `parseCommand` is an allocation-free fast path for the standard command
  frame.
- `OutWriter` is a growable cursor buffer; `encodeInto` writes directly into
  it. Common replies (`+OK`, `+PONG`, `$-1`, `*0`, small integers `-1..255`,
  booleans) are pre-encoded constants.
- The encoder performs the **canonical RESP2 downgrades**: `null`→`$-1`,
  boolean→`:1`/`:0`, double→bulk string, map→flat `*2N` array, set→array,
  push→array, verbatim→bulk, bignum→`:`. Under RESP3 the native types are
  emitted. This mirrors real redis-server behavior exactly.

## Performance optimizations (all built in from the start)

1. Per-connection write coalescing (one `socket.write()` per read drain).
2. Synchronous dispatch fast-path; promise queue only for async handlers.
3. Cached pre-encoded replies.
4. Buffer-cursor encoder (no per-reply concat).
5. `parseCommand` fast-path (no intermediate `RespValue`).
6. `ZSet` sorted-entries cache (invalidated only on write).
7. Native latin1 `TextDecoder` for binary-safe keys.
8. Dual-case command registry (skip per-call `toUpperCase()`).
9. Optional `SO_REUSEPORT` multicore.

## What is intentionally not here

- No RDB/AOF persistence — the server is ephemeral by design.
- No replication or true cluster sharding — cluster mode is process-level
  `SO_REUSEPORT` with per-worker state.
- No Lua scripting — `EVAL`/`FCALL` return explicit "not supported" errors;
  `SCRIPT`/`FUNCTION` subcommands are stubbed for client compatibility.

See [deployment.md](./deployment.md) for the operational consequences.