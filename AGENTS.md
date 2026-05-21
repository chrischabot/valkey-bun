# AGENTS.md — operating manual for autonomous agents

This file tells an AI agent (or any new contributor) **how to work in this
repository safely and effectively**. Read it before changing code.

## 1. What this project is

valkey2 is a Redis/Valkey-compatible server: a raw RESP TCP data plane wrapped
in an Effect v4 control plane, running on Bun 1.3.14. Full design rationale is
in [`docs/architecture.md`](./docs/architecture.md); user/API docs are in
[`docs/`](./docs/README.md). Keep all of those in sync with code changes.

## 2. Environment & commands

- Runtime: **Bun 1.3.14+** (`bun --version`). No Node, no npm scripts beyond
  `package.json`.
- Install: `bun install` (only dep is `effect`; `ioredis`/`redis` are devDeps
  for tests).
- Run: `bun run start` (RESP `tcp/6379`, admin HTTP/3 `8080`).
- Test: `bun test` — **46 tests must pass**. Never weaken or skip a test to go
  green; fix the root cause.
- Typecheck: `bun run typecheck` (`tsc --noEmit`, strict). Must exit 0.
- Benchmarks: `bun run bench` (RESP), `bun run http-bench` (HTTP protocols).

Always run **typecheck + full test suite** after any change before considering
work complete.

## 3. Hard design invariants — do NOT break these

1. **Effect at the boundary, raw hot path.** `src/index.ts`, `src/config.ts`,
   `src/errors.ts` and admin lifecycle use Effect v4. The per-command path
   (`src/resp.ts`, `src/tcp-server.ts`, `src/commands/*`) is intentionally
   plain synchronous TypeScript. Do **not** wrap command handlers in
   Effect/Promise — it was measured to cap throughput.
2. **Synchronous dispatch fast-path.** `dispatchSync` handles the common case;
   only handlers that return a thenable defer onto the per-connection queue
   (`deferAsync` in `tcp-server.ts`). Preserve reply ordering.
3. **Binary safety.** Keys/values are bytes. The latin1 bijection
   (`bytesToKey`/`keyToBytes` in `store.ts`) must be used for all map keys —
   never `String`/`utf-8` decode a key for storage.
4. **RESP2 vs RESP3 reply contracts.** Several commands change shape by
   protocol (see §5). The encoder in `resp.ts` performs the canonical RESP2
   downgrades (null→`$-1`, boolean→`:1/:0`, double→bulk, map→flat array,
   set→array, push→array). This is deliberate Redis server behavior, not a
   bug.
5. **Arity convention.** `spec.arity` counts the command name **plus** args;
   the handler `args` array **excludes** the command name. Negative arity =
   "at least |n|". The dispatcher enforces this before the handler runs.
6. **Version bumps gate `WATCH`.** Mutations call `ctx.bumpKey(db, key)`.
   No-op operations must NOT bump (it would break optimistic locking). Keep
   this discipline when adding write commands.
7. **Vendored Effect is not committed.** `vendor/` is gitignored. The runtime
   dependency is the published `effect@4.0.0-beta.70`. For reference, clone
   it on demand (see §7).

## 4. Adding or changing a command

1. Find the right module in `src/commands/` (by data type). The registry is
   assembled in `src/commands/index.ts` (`buildRegistry`).
2. Add a `CommandSpec`: `{ name, arity, handler, noQueue?, subscribeOk? }`.
   - `arity`: command name + args; negative for variadic.
   - `noQueue: true` only for transaction-control verbs (`MULTI`, `EXEC`,
     `WATCH`, …) that must execute even inside `MULTI`.
   - `subscribeOk: true` if it is allowed while the connection is in
     subscribe mode.
3. Use the helpers: `db(ctx, conn)` for the selected `Database`,
   `bytesToKey`/`keyToBytes` for binary-safe keys, `RESP.*` constructors for
   replies. Honor RESP3 where the canonical Redis reply differs (§5).
4. Throw `Error("WRONGTYPE ...")` / `Error("ERR ...")` for command errors —
   `handleErr` formats them. Prefer returning `RESP.err(...)` for validation.
5. Call `ctx.bumpKey(conn.selectedDb, key)` on actual mutation only.
6. Add/extend a test in `tests/` and document it in the matching
   `docs/commands/<type>.md` page. **Docs are part of "done".**

## 5. RESP3-sensitive replies (keep these exact)

| Command(s) | RESP2 | RESP3 |
|---|---|---|
| `HGETALL` | flat array | map |
| `SMEMBERS`/`SUNION`/`SINTER`/`SDIFF` | array | set |
| `SISMEMBER`/`SMISMEMBER` | `:1`/`:0` | `#t`/`#f` |
| `ZSCORE`/`ZINCRBY`/`ZMSCORE`/`ZADD …INCR` | bulk string | double |
| `HELLO` | map | map |
| pub/sub `message`/`pmessage` | array | push |
| `PING` in subscribe mode | `["pong",""]` array | `+PONG` |

## 6. Failure handling protocol

- Test fails → read the full error, decide whether the **test**, the
  **implementation**, or the **docs** is wrong (consult `docs/` as the spec).
  Fix the actual root cause.
- Typecheck fails → fix types; do not `// @ts-ignore`. Bun-types sometimes
  lags Bun runtime (e.g. `Bun.serve({http3})`, `Bun.listen({reusePort})`); a
  narrow structural cast at that single boundary is the accepted pattern
  (already used in `admin.ts`/`tcp-server.ts`).
- Never claim success without re-running typecheck + `bun test`.

## 7. Effect v4 reference source

Not committed (gitignored under `vendor/`). To read real implementations,
types, and migration notes on demand:

```bash
git clone https://github.com/Effect-TS/effect-smol vendor/effect
```

Key v4 facts already applied here (verified against published beta.70):

- Services: `class X extends Context.Service<X, Shape>()("@valkey2/X") {}`
- Layers: `Layer.effect`, `Layer.succeed`, `Layer.mergeAll`; provide once at
  the top via `Effect.provide(program, AppLayer)`.
- Config: `Config.string`/`Config.int`/`Config.redacted` (lowercase),
  `Config.withDefault`, `Redacted.value`.
- Errors: `Schema.TaggedErrorClass` (NOT `Schema.TaggedError` — the
  effect.solutions docs use the older name; the published beta.70 export is
  `TaggedErrorClass`).

## 8. Definition of done

- Code compiles: `bun run typecheck` exits 0.
- `bun test` → 46/46 pass.
- Behavior matches `docs/` (or docs updated in the same change).
- No throwaway/debug code, no dead code, no secrets, `.certs/` & `vendor/`
  remain gitignored.