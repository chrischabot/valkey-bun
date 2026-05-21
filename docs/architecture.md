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
  errors, structured startup/shutdown, logging, the HTTP/3 admin server, and
  the persistence lifecycle. This is where Effect's composition, typed
  errors, and `Layer` wiring add value.
- **Data plane (raw TS):** TCP read → RESP parse → command dispatch → reply
  encode → coalesced TCP write. No Effect, no Promise unless a handler is
  genuinely asynchronous (the blocking family and a few others — see below).

## Module map

```
src/
  index.ts            Effect v4 entry point: Config layer, startup/shutdown,
                       optional SO_REUSEPORT cluster forking
  config.ts           Effect Config service + Layer (env-driven, incl.
                       persistence + notify-keyspace-events)
  errors.ts           Schema.TaggedErrorClass domain errors (ConfigError, …)
  server-context.ts   Shared runtime state: Store, PubSub, connections,
                       key-version map (WATCH), config, generalized
                       blocking-waiter registry, keyspace-notification +
                       CLIENT TRACKING registries, persistence handle
  tcp-server.ts       Raw Bun.listen data plane: parse → dispatch → flush;
                       per-connection async deferral queue; persistence init
  connection.ts       Per-connection state (incl. tracking) + write
                       coalescing (OutWriter); invalidation push
  resp.ts             RESP2/RESP3 codec: parser, encoder, parseCommand
                       fast-path, RESP value model, reply constructors
  store.ts            In-memory multi-DB store; String/List/Hash/Set/ZSet/
                       Stream types; per-hash-field TTL map; latin1
                       binary-safe keys; lazy + 1 Hz expiry
  pubsub.ts           Channel/pattern registry + glob matcher
  persistence.ts      AOF append/fsync/load/rewrite + RDB save/bgsave +
                       save-rule fibers
  rdb.ts              Versioned CRC32 snapshot codec + DUMP/RESTORE payload
  lua.ts              Embedded fengari Lua VM bridge (EVAL/FUNCTION)
  fengari.d.ts        Ambient module declaration for the untyped Lua VM
  admin.ts            Bun.serve HTTP/3 (QUIC) admin: /health /info /metrics
  commands/
    index.ts          Registry + preDispatch (auth/arity/subscribe/MULTI)
                       + dispatchSync / dispatch + postWrite hooks
                       (AOF feed, keyspace notify, tracking invalidation,
                       read-capture)
    connection.ts     PING ECHO AUTH HELLO SELECT CLIENT(+TRACKING) RESET QUIT
    keys.ts           DEL EXPIRE(NX|XX|GT|LT) TTL KEYS SCAN TYPE RENAME COPY
                       MOVE OBJECT DUMP RESTORE …
    strings.ts        GET SET INCR APPEND GETRANGE SETRANGE LCS …
    hashes.ts         HSET HGET HGETALL HSCAN HRANDFIELD …
    hash-ttl.ts       HEXPIRE HPEXPIRE H(P)EXPIREAT HTTL HPTTL H(P)EXPIRETIME
                       HPERSIST HGETEX HGETDEL (Redis 7.4 field TTL)
    lists.ts          LPUSH RPUSH LRANGE LMOVE LPOS BLPOP BRPOP BLMOVE
                       BRPOPLPUSH LMPOP BLMPOP …
    sets.ts           SADD SMEMBERS SINTER SUNIONSTORE SINTERCARD …
    zsets.ts          ZADD ZRANGE(BYSCORE/BYLEX/REV) ZRANGESTORE ZINTERCARD
                       ZREMRANGEBY* ZMPOP BZMPOP BZPOPMIN BZPOPMAX …
    streams.ts        XADD XRANGE XREAD(BLOCK) XGROUP XREADGROUP XACK XCLAIM
                       XAUTOCLAIM XSETID XINFO …
    transactions.ts   MULTI EXEC DISCARD WATCH UNWATCH
    pubsub.ts         (S)SUBSCRIBE (S)PUBLISH PUBSUB …
    server.ts         INFO CONFIG COMMAND DEBUG CLUSTER SWAPDB SAVE/BGSAVE …
    sort.ts           SORT SORT_RO
    bitmaps.ts        SETBIT GETBIT BITCOUNT BITPOS BITOP BITFIELD …
    hll.ts            PFADD PFCOUNT PFMERGE PFDEBUG PFSELFTEST
    geo.ts            GEOADD GEOPOS GEODIST GEOHASH GEOSEARCH(STORE) …
    scripting.ts      EVAL/EVALSHA/SCRIPT/FUNCTION/FCALL (embedded Lua)
```

## Startup (control plane)

`src/index.ts`:

1. If `VALKEY_CLUSTER_SIZE > 1` and this is the master process, fork N worker
   processes that share the TCP port via `SO_REUSEPORT`, then supervise them.
2. Otherwise run the Effect program:
   - `ServerConfig` is resolved by the `Config` layer (`src/config.ts`) from
     environment variables, validated; failures surface as a
     `ConfigError` (`Schema.TaggedErrorClass`).
   - `startTcpServer(cfg)` binds the raw RESP listener and, when a data
     directory is configured, instantiates the `Persistence` service and
     **loads the AOF (or RDB) on boot** before serving.
   - On worker 0 (or single process) `startAdminServer(ctx, adminPort)`
     starts the HTTP/3 admin endpoint.
   - `Effect.log` reports readiness; `SIGTERM`/`SIGINT` trigger graceful
     shutdown (flush persistence, `admin.stop()`, then `process.exit(0)`).

The Effect layer is provided exactly once at the top:
`Effect.runPromise(Effect.provide(program, AppLayer))`.

## Request lifecycle (data plane)

For each TCP connection (`Bun.listen` `socket` handlers in `tcp-server.ts`):

1. **Read.** Incoming bytes are appended to the connection's growable buffer
   (`Connection.appendData`).
2. **Parse.** A loop tries the **fast path** `parseCommand` first — it parses
   the common `*N\r\n$len\r\n…` array-of-bulk frame with **no intermediate
   `RespValue` allocation**. If the frame is an inline command or a RESP3
   mixed type, it falls back to the general `parse`.
3. **Dispatch.** `preDispatch` enforces, in order: NOAUTH (if `requirepass`
   set), unknown-command, arity, subscribe-mode restrictions, and `MULTI`
   queuing. Then:
   - `dispatchSync` runs the handler synchronously (the overwhelming common
     case) and writes the reply into the connection's `OutWriter`.
   - If a handler returns a thenable — the blocking family
     (`BLPOP`/`BRPOP`/`BLMOVE`/`BRPOPLPUSH`/`BLMPOP`/`BZPOPMIN`/`BZPOPMAX`/
     `BZMPOP`, and `XREAD`/`XREADGROUP BLOCK`), `EXEC`, and `DEBUG SLEEP` — it
     is chained onto a **per-connection async queue** (`deferAsync`) so
     subsequent commands preserve reply order.
4. **Post-write hooks.** After a successful write the dispatcher feeds the
   AOF, emits keyspace notifications, and fires `CLIENT TRACKING`
   invalidations; tracked reads are captured for default-mode tracking.
5. **Encode & flush.** `encodeInto` writes RESP bytes into the `OutWriter`
   cursor buffer; one **single `socket.write()`** emits the snapshot per read
   drain (write coalescing).

## Store model (`store.ts`)

- `Store` holds `dbCount` `Database` instances (default 16). `SELECT` picks
  the per-connection DB index.
- A `Database` is `data: Map<string, StoredValue>`,
  `expires: Map<string, number>` (absolute ms), and
  `hashTtls: Map<string, Map<string, number>>` (Redis 7.4 per-field TTL).
- **Binary-safe keys:** bytes are mapped to strings via a latin1 bijection
  (byte *n* ↔ codepoint *n*). Always use `bytesToKey`/`keyToBytes`.
- `StoredValue` is a tagged union: `string`, `list`, `hash`, `set`, `zset`,
  `stream`.
- **Expiry** is lazy (checked in `getRaw`, including per-hash-field TTL) plus
  a 1 Hz background sweep (`sweepLazy`).
- `ZSet` keeps a **cached sorted-entries array** invalidated only on writes.

## Connection model (`connection.ts`)

Each `Connection` tracks: `id`, `resp3`, `selectedDb`, `name`,
`authenticated`, `inMulti`/`multiQueue`/`multiError`, `watched` (per-DB
key→version map for `WATCH`), `subscribedChannels`/`subscribedPatterns`,
`CLIENT TRACKING` state (`tracking`/`bcast`/`prefixes`/`redirect`/`optin`/
`optout`/`noloop`/`trackedKeys`), and its `OutWriter`. `reply()` encodes into
the buffer; `flush()` performs the single coalesced write;
`sendMessage`/`sendPMessage`/`sendInvalidation` push immediately and flush.

## Transactions

`MULTI` sets `inMulti`. Subsequent non-`noQueue` commands are validated for
arity then **queued** (reply `+QUEUED`). `EXEC`:

1. Checks every `WATCH`ed key's version against `ctx.keyVersion`; if any
   changed → reply `*-1` (null array, aborted).
2. If any queued command had an arity error → `EXECABORT`.
3. Otherwise replays the queue through `dispatch`.

`WATCH` snapshots `ctx.keyVersion(db, key)`; every mutating command calls
`ctx.bumpKey(db, key)` — **only on real mutation**.

## Pub/Sub, notifications & client tracking

`PubSub` keeps channel/pattern registries; `PUBLISH` returns the receiver
count. Keyspace notifications publish `__keyspace@<db>__:<key>` and
`__keyevent@<db>__:<event>` (gated by `notify-keyspace-events`).
`CLIENT TRACKING` maintains a per-(db,key) reverse index (default mode) and
prefix matching (BCAST), emitting RESP3 `>2 "invalidation" [keys]` pushes
(or a redirected `__redis__:invalidate` message) on mutation. All three are
driven from the dispatcher post-write hook off the hot path.

## Generalized blocking-waiter registry

Blocking commands truly block: when no data is available the handler returns
a `Promise` registered in the server-context **waiter registry**, keyed by
(db, keys). A later mutation to a waited key re-evaluates parked waiters in
FIFO order; each waiter's `attempt()` consumes from the store so a single
push satisfies the correct number of waiters. The pending `Promise`
integrates with the per-connection deferral queue, so a blocked client
correctly defers subsequent commands and reply order is preserved. A `0`
timeout blocks forever; otherwise the waiter resolves with a null reply on
timeout. This one registry powers `BLPOP`/`BRPOP`, `BLMOVE`/`BRPOPLPUSH`,
`LMPOP`/`BLMPOP`, `BZPOPMIN`/`BZPOPMAX`, `ZMPOP`/`BZMPOP`, and genuine
`XREAD`/`XREADGROUP BLOCK`.

## RESP codec (`resp.ts`)

A single module implements the full RESP2 + RESP3 grammar (see
[protocol.md](./protocol.md)). `parse` handles every RESP type incl. RESP3
`_ # , ( % ~ | >` and inline commands; `parseCommand` is an allocation-free
fast path; `OutWriter`/`encodeInto` write directly into a growable cursor
buffer; common replies are pre-encoded constants. The encoder performs the
**canonical RESP2 downgrades** (`null`→`$-1`, boolean→`:1`/`:0`, double→bulk,
map→flat array, set→array, push→array, verbatim→bulk, bignum→`:`), mirroring
real redis-server.

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

Persistence and notifications stay off the hot path: the AOF append is an
in-memory buffer write (fsync/snapshot happen on Effect fibers), and
notification/invalidation is a `Map`-lookup push.

## What is intentionally not here

- **No replication or true cluster sharding** — cluster mode is process-level
  `SO_REUSEPORT` with per-worker independent state; `CLUSTER` reports a
  standalone node.
- **No bug-for-bug-exact RDB/Lua edge fidelity** — the RDB/`DUMP` format is
  valkey2's own portable, CRC-checked codec (not the binary redis-server
  layout), and Lua runs on fengari (Lua 5.3) so a few numeric/stdlib edges
  differ from redis-server's bundled Lua 5.1. These are documented in
  [persistence.md](./persistence.md) and [commands/scripting.md](./commands/scripting.md).

Persistence (AOF + custom RDB + `DUMP`/`RESTORE`), keyspace notifications,
RESP3 client-side caching, and embedded Lua scripting/Functions **are**
implemented. See [deployment.md](./deployment.md) for operational
consequences.