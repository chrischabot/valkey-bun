# Roadmap: Persistence, Pub/Sub Completeness, and Full Command Coverage

> **STATUS — IMPLEMENTED.** The P0–P3 program described below has landed:
> persistence (AOF + custom RDB + `DUMP`/`RESTORE`), the full blocking
> command family, keyspace notifications, RESP3 `CLIENT TRACKING`, bitmaps /
> HyperLogLog / geo, Redis 7.4 hash-field TTL, `SORT`/`LCS`/`EXPIRE` flags,
> accurate `COMMAND`, and embedded Lua scripting & Functions (fengari). The
> remaining intentional omissions are the multi-node features
> (replication/cluster/`MIGRATE`) and bug-for-bug-exact RDB/Lua edge
> semantics, as called out per-section. This document is retained as the
> design rationale and a record of the engineering analysis.

> **Research & design document.** This is an engineering analysis of how to
> evolve valkey2 toward feature parity with a real **single-node** Redis 7.4 /
> Valkey 8.x server. **Clustering, replication, and `MIGRATE` are explicitly
> out of scope.** Every integration point below is named against the actual
> source so the work can be executed directly.

## TL;DR — how close can we get?

Without clustering/replication, a faithful single-node Redis is **entirely
reachable**. The realistic end state:

| Capability | Reachable fidelity (single node) |
|---|---|
| Data-type command surface | **~100%** (everything below is implementable) |
| Persistence (AOF + RDB, crash-safe) | **~95%** — AOF is byte-for-byte RESP-compatible; RDB can be made `redis-check-rdb`-loadable with effort |
| Keyspace notifications | **100%** |
| RESP3 client-side caching (`CLIENT TRACKING`) | **100%** |
| Blocking command family | **100%** (waiter registry already exists) |
| Lua / Functions (`EVAL`/`FCALL`) | **~85%** via an embedded JS Lua VM (semantic edge cases differ) |
| Replication / cluster / `WAIT` real semantics | **out of scope** (by request) |

Bottom line: we can credibly reach a **single-node-faithful** server where the
only deliberate gaps are the multi-node features the user asked to skip.

The single hard constraint that shapes the persistence design: **Bun has no
`fork()` copy-on-write.** Real Redis `BGSAVE`/`BGREWRITEAOF` fork the process
and serialize the COW snapshot in the child. We must emulate that — analyzed in
detail in §1.

---

## 1. Persistent storage

### 1.1 What real Redis does

- **RDB**: a compact point-in-time binary snapshot. `SAVE` (blocking),
  `BGSAVE` (fork + serialize child). Versioned opcode format (`REDIS00 NN`
  magic + type-tagged, length-encoded payloads + CRC64). Triggered by `save
  <sec> <changes>` rules.
- **AOF**: an append-only log. Crucially, **the AOF is literally a RESP
  command stream** — every write command is appended verbatim as the same
  `*N $len ...` frame the client sent. Recovery = replay the log. `appendfsync
  always|everysec|no`. Periodic **AOF rewrite** (`BGREWRITEAOF`) compacts the
  log to the minimal command set (also forked).
- **Hybrid** (`aof-use-rdb-preamble yes`, default since 7.0): an AOF rewrite
  writes an RDB image as the preamble, then continues as a RESP tail. Best of
  both: fast load + durable tail.

### 1.2 The Bun constraint

`Bun.spawn` exists but there is **no `fork()` with copy-on-write address-space
sharing**. So a "background save" cannot cheaply snapshot a live heap. Three
viable strategies, in increasing fidelity:

**A. Synchronous `SAVE` (always available, simplest).**
Serialize the selected structures on the event loop. Blocks the data plane for
the serialization duration (Redis `SAVE` blocks too — semantically correct,
just not concurrent). Use for `SAVE` and as the shutdown flush.

**B. Structural snapshot + async serialize (the `BGSAVE` emulation).**
At `BGSAVE` time, take a **shallow structural snapshot** of each `Database`:
because our values are either immutable-after-write (`Uint8Array` strings) or
owned containers (`Map`/`Set`/`ZSet`/`Stream`), we can clone the *top-level
key→value map references* synchronously (cheap: one `Map` copy of references)
and then serialize that snapshot incrementally on a yielding loop
(`await Bun.sleep(0)` every N keys) so the data plane keeps serving. The
correctness requirement: **writes must not mutate a value object in place
after it has been handed to a snapshot**. Today some handlers mutate in place
(e.g. `list.push`, `hash.set`). Two options:
  - **Copy-on-write at the value level:** when a write touches a key that is
    "pinned" by an in-flight snapshot, clone that one value first (we already
    have `deepCopy` in `keys.ts` for `COPY`/`MOVE` — reuse it). A `Set<string>`
    of pinned keys on the snapshotting `Database` is enough.
  - **Serialize-to-buffer synchronously, write asynchronously:** cheaper to
    reason about — produce the byte buffer on the loop (cost ≈ A) but only the
    *disk write/fsync* is async. Good middle ground; eliminates the in-place
    mutation hazard entirely.

  Recommendation: ship **B (serialize-sync, write/fsync-async)** first; add
  value-level COW later only if `SAVE` pause time becomes a measured problem.

**C. Worker-thread serialize.** Bun supports `Worker`. Transfer a structured
snapshot to a worker that encodes + writes. Highest concurrency, highest
complexity (every value type must be `postMessage`-serializable or rebuilt).
Defer unless B's pause is unacceptable.

### 1.3 Format choice — fidelity vs effort

| Format | Pros | Cons | Recommendation |
|---|---|---|---|
| **AOF = RESP command log** | *Byte-for-byte Redis-compatible*; trivial to produce (we already have the parsed frame); human-inspectable; replayable by real `redis-server` | Grows until rewrite | **Primary durability. Implement first.** |
| **AOF rewrite (minimal command set)** | Bounded size; emits `SELECT`/`SET`/`RPUSH`/`HSET`/`ZADD`/`SADD`/`XADD`/`PEXPIREAT` per key | Must walk the keyspace | **Implement (child process or sync-with-pause).** |
| **Custom RDB (length-prefixed, our own opcodes + CRC64)** | Simple, fast, versioned | Not loadable by `redis-check-rdb`/real Redis | Acceptable default for `SAVE`/`BGSAVE` |
| **True Redis RDB v11 encoding** | `redis-check-rdb` / real-server loadable; migration story | Large effort (every type's exact encoding incl. listpack/quicklist/intset/ziplist, CRC64, string int/LZF encodings) | **Optional P3** — only if cross-tool migration is a goal |

The pragmatic, high-fidelity path: **RESP AOF as the source of truth**
(perfectly compatible) + a **custom but well-versioned RDB** for fast restart,
with **true-RDB encoding as an optional later milestone**.

### 1.4 Concrete design against this codebase

**Config (`src/config.ts`, `src/server-context.ts` `configMap`).** Add real,
validated keys: `dir` (default `.`), `dbfilename` (`dump.rdb`), `appendonly`
(`no`), `appendfilename` (`appendonly.aof`), `appendfsync`
(`everysec`), `save` (`"3600 1 300 100 60 10000"`),
`aof-use-rdb-preamble` (`yes`). They already exist as inert `configMap`
entries; promote them to typed `ResolvedConfig` fields + a runtime
`CONFIG SET` that actually toggles AOF.

**A `Persistence` Effect service (`src/persistence.ts`, new).** Following the
effect.solutions pattern used by `ServerConfig`: a `Context.Service` with a
`Layer.effect` that owns:
  - the AOF append handle (a buffered writer over `Bun.file(...).writer()` or
    `fs` append fd),
  - the `appendfsync everysec` fiber (an `Effect` repeating every 1s doing
    `fsyncSync`),
  - the `save` rule fiber (dirty-counter driven `BGSAVE`),
  - load-on-boot and flush-on-shutdown.
The data plane stays raw — persistence is control-plane orchestration; the
hot path only does a synchronous in-memory buffer append (see next).

**The write hook (the key integration point).** Two precise options:

  1. **Dispatcher-level (recommended).** In `src/commands/index.ts`,
     `dispatchSync`/`dispatch` already hold the raw `name` + `args:
     Uint8Array[]` and run *after* `preDispatch` validation. Add
     `write?: boolean` to `CommandSpec` (mechanical: tag the ~90 mutating
     specs). After a write handler returns **without error**, append the
     command's RESP frame (re-encode `name`+`args` via the existing
     `OutWriter`/`encodeInto` primitives in `resp.ts`) to the AOF buffer,
     prefixed with a `SELECT <db>` only when the connection's `selectedDb`
     changed since the last appended command. This yields a **real
     redis-server-replayable AOF**.
  2. **Mutation-boundary (finer, more work).** Hook `ctx.bumpKey()` — but that
     loses the original command granularity and would require synthesizing
     commands; only attractive if we ever do effect-style change capture.
     Prefer (1).

**Expiry correctness.** Real Redis persists **absolute** expiry. On AOF we
must rewrite relative-expiry commands: append `PEXPIREAT key <ms>` after
`SET ... EX`, or translate at append time. The rewrite path emits
`PEXPIREAT` from `Database.expires`. (Our `store.ts` already stores absolute
ms — this is a clean mapping.)

**Load on boot (`src/index.ts`, before `startTcpServer`).** Order matches
Redis: if `appendonly yes` and an AOF exists → replay it through `dispatch`
against a loopback pseudo-connection; else if an RDB exists → load it. Handle
a **truncated tail** (last command partial after a crash): parse until the
last complete frame, truncate the rest (mirror `aof-load-truncated yes`).

**`BGSAVE`/`BGREWRITEAOF`/`SAVE`/`LASTSAVE`/`WAITAOF` (`src/commands/server.ts`).**
Wire these to the `Persistence` service instead of returning canned strings.
`WAITAOF numlocal numreplicas timeout` → `[fsync'd?1:0, 0]` (no replicas).
`DEBUG SET-ACTIVE-EXPIRE`, `DEBUG JMAP` etc. can stay no-ops.

**Crash-safety.** `appendfsync always` → fsync in the append path (slow, but
correct). `everysec` → the 1s fiber. Document the durability window. RDB
writes go to a temp file + atomic `rename()` (Bun `fs.renameSync`).

**Serialization module (`src/rdb.ts`, new).** A versioned encoder/decoder for
the tagged `StoredValue` union (string/list/hash/set/zset/stream incl. stream
groups + PEL + `lastMs/lastSeq`) and the `expires` map. Start with our own
compact framing + CRC64; keep the type tags isomorphic to Redis so a true-RDB
backend can be slotted in later behind the same interface.

**Effort:** AOF (append + everysec + load + rewrite) is the bulk of the value
and is moderate. Custom RDB is small. True Redis-RDB encoding is the only
large item and is optional.

---

## 2. Pub/Sub — what's missing vs the real thing

Core pub/sub (channels, patterns, sharded, `PUBSUB` introspection, RESP2
array vs RESP3 push) is **already complete and correct** (`src/pubsub.ts`,
`src/commands/pubsub.ts`). Three real-Redis features are missing:

### 2.1 Keyspace notifications (high value, low effort)

Real Redis publishes events to `__keyspace@<db>__:<key>` (key→event) and
`__keyevent@<db>__:<event>` (event→key) controlled by
`notify-keyspace-events` flag classes (`K`,`E`,`g`,`$`,`l`,`s`,`h`,`z`,`x`,
`e`,`t`,`m`,`n`,`d`,`A`).

**Design:** we already have the perfect chokepoint — every mutation calls
`ctx.bumpKey(db, key)`. Add `ctx.notifyKeyspace(db, key, event, typeClass)`
invoked alongside it (or fold into a single `ctx.touched(...)`). It parses the
configured flag string once (cache on `ServerContext`), and when enabled calls
`ctx.pubsub.publish("__keyspace@<db>__:"+key, event)` and
`"__keyevent@<db>__:"+event, key)`. ~1 day; touches each command module only
to pass the event name (or centralize a command→event table in
`commands/index.ts`).

### 2.2 RESP3 client-side caching — `CLIENT TRACKING` (high value, medium)

Today `CLIENT TRACKING`/`TRACKINGINFO` are stubs. Real behavior: the server
remembers which keys a tracking client read and sends an **invalidation push**
(`>2 "invalidation" [keys]`) when they change; modes `BCAST` (prefix-based,
no per-key bookkeeping), `OPTIN`/`OPTOUT`, `REDIRECT <clientid>`, `NOLOOP`.

**Design:** we *already* maintain `ctx.keyVersions` per (db,key) for `WATCH`
— the exact bookkeeping needed. Add a per-`Connection` tracking state
(`tracking: boolean`, `bcastPrefixes`, `redirectTo`, `optin/optout`) and a
`ServerContext` reverse index `key → Set<Connection>` populated on read by
tracking clients (non-BCAST) or matched by prefix (BCAST). On mutation
(same `bumpKey` chokepoint) emit the invalidation push to the tracking (or
redirected) connection via the existing `conn.sendMessage`-style push path in
`connection.ts`. The hard part is read-path key capture for non-BCAST mode;
**BCAST mode is easy and covers the common cache-invalidation use case** —
ship BCAST first.

### 2.3 Sharded pub/sub

Already merged onto the channel registry — correct for a single node. Nothing
to do.

---

## 3. Missing commands — exhaustive single-node gap analysis

Measured against Redis 7.4 / Valkey 8.x, **excluding** cluster/replication
commands. Each row notes the integration module and relative effort (S/M/L).

### 3.1 Whole families currently absent

| Family | Commands | Module | Effort |
|---|---|---|---|
| **Bitmaps** | `SETBIT` `GETBIT` `BITCOUNT` `BITPOS` `BITOP` `BITFIELD` `BITFIELD_RO` | `commands/bitmaps.ts` (new) — operate on the existing `string` `Uint8Array` | M (BITFIELD is the fiddly one) |
| **HyperLogLog** | `PFADD` `PFCOUNT` `PFMERGE` (`PFDEBUG`/`PFSELFTEST` stubs) | `commands/hll.ts` (new) — dense/sparse HLL stored as a `string` value, Redis-compatible representation for `PFMERGE` interop | M |
| **Geo** | `GEOADD` `GEOPOS` `GEODIST` `GEOSEARCH` `GEOSEARCHSTORE` `GEOHASH` (+ legacy `GEORADIUS*`) | `commands/geo.ts` (new) — geohash-encoded scores on a `zset` (exactly how Redis implements it; reuses our `ZSet`) | M |
| **Hash field TTL (Redis 7.4)** | `HEXPIRE` `HPEXPIRE` `HEXPIREAT` `HPEXPIREAT` `HTTL` `HPTTL` `HEXPIRETIME` `HPEXPIRETIME` `HPERSIST` `HGETEX` `HGETDEL` | `commands/hashes.ts` — needs a per-field expiry map on the hash value (extend the `hash` `StoredValue` to `{ value: Map, ttues?: Map<string,number> }`); `OBJECT ENCODING` → `listpackex` | M |
| **Generic** | `SORT` `SORT_RO` `DUMP` `RESTORE` `LCS` `OBJECT FREQ`(real) | `commands/keys.ts`/`strings.ts` | M (`SORT` BY/GET/LIMIT/ALPHA; `DUMP`/`RESTORE` need the §1 serializer) |

### 3.2 Blocking family (the waiter registry already exists)

`src/server-context.ts` already has the generic blocking-waiter registry that
powers `BLPOP`/`BRPOP` and integrates with the per-connection deferral queue.
Generalize it to add, all **S–M**:

`BLMOVE` · `BRPOPLPUSH` · `BLMPOP` · `LMPOP` · `BZPOPMIN` · `BZPOPMAX` ·
`BZMPOP` · `ZMPOP` · `SMPOP`-style via `LMPOP`/`ZMPOP`, and **real
`XREAD`/`XREADGROUP BLOCK`** (today parsed-but-non-blocking — wire it through
the same registry, keyed on stream last-id). `WAIT` → return `0` immediately
(no replicas; honest single-node answer).

### 3.3 Per-command refinements (parity polish)

| Area | Gap | Module |
|---|---|---|
| `EXPIRE`/`PEXPIRE`/`EXPIREAT`/`PEXPIREAT` | `NX\|XX\|GT\|LT` flag (7.x) | `commands/keys.ts` |
| `SET` | `IDLE`/`KEEPTTL` ok; add `EXAT/PXAT` ok; verify `GET`+`NX` Redis 7 semantics | `commands/strings.ts` |
| `SCAN`/`HSCAN`/`SSCAN`/`ZSCAN` | cursor is a numeric offset, not Redis's reverse-binary cursor — **functionally correct but not resumable across rehashes**; document, or implement the real cursor for bug-for-bug fidelity | `commands/keys.ts` et al. |
| `OBJECT ENCODING` | returns coarse encodings; real clients rarely care, but `int`/`embstr`/`raw`/`listpack`/`quicklist`/`intset`/`hashtable`/`skiplist`/`listpackex` improve fidelity | `commands/keys.ts` |
| Streams | add `XAUTOCLAIM` `XSETID` `XINFO STREAM FULL` `XPENDING` extended form (`IDLE start end count [consumer]`) `XGROUP ... ENTRIESREAD` and Valkey 8.1 `XDELEX`/`XACKDEL` | `commands/streams.ts` |
| `COMMAND` | `DOCS`/`INFO`/`COUNT`/`GETKEYS` return stubs — real `COUNT`/`GETKEYS` are cheap to make accurate from the registry | `commands/server.ts` |
| `LPOS`/`SINTERCARD`/`ZINTERCARD`/`GETDEL`/`COPY`/`ZRANGESTORE`/`SMISMEMBER`/`ZMSCORE` | already implemented ✅ | — |

### 3.4 Scripting — the biggest single gap

`EVAL`/`EVALSHA`/`FCALL` return "not supported". Real fidelity requires a Lua
5.1 VM with the `redis.call`/`redis.pcall`/`redis.error_reply`/`cjson`/
`redis.sha1hex` API.

**Options:**
- **Embed a JS Lua VM** (`fengari`, a Lua 5.3/5.1 interpreter in JS, or
  `wasmoon` Lua-via-WASM). Bridge `redis.call` to our synchronous
  `dispatchSync`. Achieves ~85–90% script compatibility; differences are edge
  cases (Lua 5.1 vs 5.3 numbers, `cmsgpack`, `bit`, determinism rules).
  **Effort: L**, but self-contained in `commands/scripting.ts` + a
  `lua.ts` bridge. `SCRIPT LOAD/EXISTS/FLUSH` already store digests — wire
  `EVALSHA` to the cache.
- **`FUNCTION`/`FCALL`** (Lua function libraries) builds on the same VM.
- Keep returning explicit errors if scripting is deemed out of scope — but it
  is the one feature most "real Redis" apps assume.

### 3.5 ACL, CLIENT, LATENCY/SLOWLOG fidelity (optional polish)

- **ACL**: real users/rules/categories is **L** and rarely needed for
  compatibility; the single-password model already satisfies most clients.
  Implement `ACL SETUSER`/`GETUSER`/`DELUSER`/`CAT`/`GENPASS` only if a
  consumer needs it.
- **`CLIENT KILL/UNPAUSE/NO-EVICT/PAUSE`**: make `KILL` actually close the
  socket (we track `ctx.connections`), `PAUSE` actually defer dispatch — **M**,
  nice-to-have.
- **`SLOWLOG`/`LATENCY`**: wire to a real ring buffer fed from the dispatcher
  timing — **S**, good for observability parity.

---

## 4. Fidelity scorecard (single-node target)

| Subsystem | Today | After P0–P2 | Ceiling (no clustering) |
|---|---|---|---|
| Strings/keys/hash/list/set/zset | ~90% | ~99% | 100% |
| Streams | ~85% | ~98% | 100% |
| Pub/Sub | ~90% | 100% (keyspace + tracking) | 100% |
| Transactions | ~95% | ~98% | ~98% (no `WAIT` semantics) |
| Persistence | 0% | ~90% (AOF+custom RDB) | ~95% (true RDB optional) |
| Scripting | 0% | ~85% (embedded Lua) | ~90% |
| Bitmaps/HLL/Geo | 0% | 100% | 100% |
| Replication/cluster | 0% | **out of scope** | n/a |

**Composite single-node fidelity after the roadmap: ~95%.** The residual 5%
is intrinsic: no real `fork()` COW (snapshot pause characteristics differ from
C Redis), Lua edge semantics, and the deliberately-skipped multi-node surface.

---

## 5. Recommended phased roadmap

**P0 — Durability spine (highest value).**
1. `Persistence` Effect service + config promotion (`appendonly`, `dir`,
   `dbfilename`, `appendfsync`, `save`, `appendfilename`).
2. RESP-AOF append at the dispatcher write hook (`CommandSpec.write` tags) +
   `SELECT` interleave + relative→`PEXPIREAT` rewrite.
3. AOF load-on-boot with truncated-tail recovery; flush on shutdown.
4. `appendfsync everysec` fiber; `always` path.
5. `src/rdb.ts` custom serializer; real `SAVE`/`BGSAVE`/`LASTSAVE`;
   `save`-rule fiber; atomic temp-file rename.
6. `BGREWRITEAOF` (minimal-command rewrite) + `aof-use-rdb-preamble`.

**P1 — Pub/Sub completeness + blocking family.**
7. Keyspace notifications (`notify-keyspace-events`).
8. `CLIENT TRACKING` BCAST (then OPTIN/OPTOUT/REDIRECT).
9. Generalize the waiter registry: `BLMOVE`/`BRPOPLPUSH`/`LMPOP`/`BLMPOP`/
   `ZMPOP`/`BZMPOP`/`BZPOPMIN`/`BZPOPMAX`; real `XREAD[GROUP] BLOCK`.

**P2 — Command-surface completion.**
10. Bitmaps, HyperLogLog, Geo modules.
11. Hash-field-TTL family (7.4) + `listpackex` encoding.
12. `SORT`/`SORT_RO`, `DUMP`/`RESTORE` (reuses §1 serializer), `LCS`,
    `EXPIRE … NX|XX|GT|LT`, stream `XAUTOCLAIM`/`XSETID`/`XINFO … FULL`.
13. Accurate `COMMAND COUNT/GETKEYS`, real `SLOWLOG`/`LATENCY`,
    `CLIENT KILL/PAUSE`.

**P3 — Deep fidelity (optional).**
14. Embedded Lua VM → `EVAL`/`EVALSHA`/`FCALL`/`FUNCTION`.
15. True Redis-RDB-v11 encoding behind the `src/rdb.ts` interface
    (`redis-check-rdb`/real-server loadable).
16. Real reverse-binary `SCAN` cursor; full `ACL`.

Each phase is independently shippable, keeps the **Effect-at-the-boundary /
raw-hot-path** invariant (persistence and notifications are control-plane
orchestration; the data plane only does an in-memory buffer append and a
`Map`-lookup push), and never requires clustering.

## 6. Architectural invariants this plan preserves

- The hot path stays synchronous: AOF append is a buffered in-memory write;
  fsync/snapshot serialization happens on Effect fibers, not per command.
- All new persistence/notification lifecycle is an Effect `Layer`
  (`Context.Service`), provided once in `src/index.ts`, matching
  `ServerConfig`.
- Binary safety is retained: the serializer round-trips raw `Uint8Array`
  values and latin1 keys.
- `WATCH` key-versioning is reused (not duplicated) for `CLIENT TRACKING`.
- The existing blocking-waiter registry is generalized, not replaced.

This gets valkey2 to a genuinely production-shaped **single-node** Redis/Valkey
— durable, observable, and command-complete — with clustering the only
intentional omission.