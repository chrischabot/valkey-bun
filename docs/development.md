# Development

## Project layout

```
src/                 server source (see docs/architecture.md for the map)
tests/
  basic.test.ts       ioredis (RESP2) integration tests
  node-redis.test.ts  node-redis (RESP3) integration tests
  sample-app.test.ts  realistic scenarios incl. genuine blocking BRPOP
  scripting.test.ts   Lua EVAL/EVALSHA/SCRIPT, FUNCTION/FCALL, hash-field
                       TTL, EXPIRE flags, SORT, bitmaps, LCS, keyspace
                       notifications, RESP3 CLIENT TRACKING (raw socket)
bench/
  bench.ts            RESP data-plane benchmark
  http-bench.ts       admin HTTP/1.1 vs HTTP/2 vs HTTP/3 benchmark
docs/                 this documentation set
```

## Scripts (`package.json`)

| Command | Purpose |
|---------|---------|
| `bun run start` | Start the server |
| `bun run dev` | Start with `--watch` auto-reload |
| `bun run cluster` | Start with `VALKEY_CLUSTER_SIZE=2` |
| `bun test` | Run all integration tests (60) |
| `bun run bench` | RESP benchmark |
| `bun run http-bench` | Admin HTTP protocol benchmark |
| `bun run typecheck` | `tsc --noEmit` (strict) |

## Testing

```bash
bun test                        # everything (60 across 4 files)
bun test tests/basic.test.ts    # one suite
bun test tests/scripting.test.ts
```

Tests boot the server in-process on dedicated ports (16480/16481/16482/16483)
and drive it through real client SDKs (and raw sockets for RESP3-only
features such as `CLIENT TRACKING`), so they validate true wire
compatibility. `scripting.test.ts` uses a per-test `FLUSHALL` + config/FUNCTION
reset so it is order-independent alongside the other suites.

The full suite must stay green. If a test fails, determine whether the test,
the implementation, or the docs (the spec) is wrong, and fix the real root
cause — never weaken a test to pass.

## Typecheck

Strict TypeScript: `exactOptionalPropertyTypes`, `verbatimModuleSyntax`,
`noUnusedLocals`, `noImplicitOverride`, etc. `tsconfig.json` uses
`module: preserve` + `moduleResolution: bundler` (correct for a Bun-runtime
project). `vendor/` and `node_modules/` are excluded.

`bun run typecheck` must exit 0. Where bun-types lags the Bun runtime (e.g.
`Bun.serve({ http3 })`, `Bun.listen({ reusePort })`) a single narrow
structural cast at that boundary is the accepted pattern — do not scatter
`@ts-ignore`. The embedded Lua VM (`fengari`) ships no types: it is declared
ambiently in `src/fengari.d.ts` and narrowed through one structural cast in
`src/lua.ts` (the same single-boundary convention).

## Conventions

- **Arity** counts the command name + args; handler `args` excludes the
  command name. Negative = "at least |n|". Enforced by the dispatcher.
- **Binary safety:** always go through `bytesToKey`/`keyToBytes`.
- **Version bump on real mutation only** (`ctx.bumpKey`) — no-ops must not
  bump or `WATCH` breaks.
- **Write side effects** (AOF feed, keyspace notify, tracking invalidation)
  are centralized in the `commands/index.ts` `postWrite` hook — add a new
  mutating command to `WRITE_COMMANDS` so it participates.
- **RESP3-sensitive replies:** see the table in
  [AGENTS.md](../AGENTS.md#5-resp3-sensitive-replies-keep-these-exact) and the
  per-command pages.

## Worked example: add a command

Add a `GETLEN`-style command returning a string's length (illustrative —
`STRLEN` already exists):

1. Open `src/commands/strings.ts`, add to `stringCommands`:

```ts
{
  name: "GETLEN",
  arity: 2,                       // GETLEN key
  handler: (ctx, conn, args) => {
    const d = ctx.store.db(conn.selectedDb);
    const v = d.getRaw(bytesToKey(args[0]!));
    if (!v) return RESP.int(0);
    if (v.type !== "string") {
      return RESP.err("WRONGTYPE Operation against a key holding the wrong kind of value");
    }
    return RESP.int(v.value.length);
  },
},
```

2. It is auto-registered (the module's array is included by
   `buildRegistry()` in `src/commands/index.ts`).
3. If it mutates, add its name to `WRITE_COMMANDS` (and, if it sets a
   relative TTL, `TTL_COMMANDS`) in `src/commands/index.ts`.
4. Add a test in `tests/` and document it in the matching
   `docs/commands/<type>.md` page. **Docs are part of "done".**
5. `bun run typecheck && bun test`.

For an **async** command, return a `Promise<RespValue>`; the dispatcher
detects the thenable and defers it on the per-connection queue (see how the
blocking family uses the server-context waiter registry in
`src/commands/lists.ts`).

## Runtime dependencies

The published `effect@4.0.0-beta.70` (control plane) and `fengari@^0.1.5`
(embedded Lua 5.3 VM for `EVAL`/`FUNCTION`). `ioredis`/`redis` are devDeps
for tests. The full Effect v4 source (`Effect-TS/effect-smol`) is not
committed (gitignored under `vendor/`); clone it on demand to read upstream
implementations:

```bash
git clone https://github.com/Effect-TS/effect-smol vendor/effect
```

See [AGENTS.md](../AGENTS.md) for the operating manual and design invariants.