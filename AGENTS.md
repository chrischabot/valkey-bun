# valkey2 — agent / contributor notes

## Effect v4 reference source

The runtime dependency is the published `effect@4.0.0-beta.70` npm package. The
full Effect v4 source (`Effect-TS/effect-smol`) is **not committed** — it is
gitignored under `vendor/`. To read real implementations/types or the migration
notes while working on this project, clone it on demand:

```bash
git clone https://github.com/Effect-TS/effect-smol vendor/effect
```

Then grep `vendor/effect/packages/effect/src` and read
`vendor/effect/migration/{services,runtime,v3-to-v4}.md`.

Key v4 API facts applied here (verified against the published beta.70):

- Services: `class X extends Context.Service<X, Shape>()("@valkey2/X") {}`
- Constructor effect: `Context.Service<X>()("@valkey2/X", { make })`
- Layers: build explicitly with `Layer.effect(this, this.make)`; name them
  `.layer` (not `.Default`/`.Live`); wire deps with `Layer.provide`
- Provide once at the top (`Effect.provide(program, AppLayer)`)
- Memoize parameterized layers in module-level constants
- Errors: `Schema.TaggedErrorClass` (serializable, `_tag` pattern matching,
  yieldable) — note the published beta.70 export is `TaggedErrorClass`, which
  differs from the `Schema.TaggedError` name in the effect.solutions docs
- Config: `Config` service + `Layer`, `Config.redacted` for secrets
- Renames: `Effect.catch` (was catchAll), `Effect.callback` (was async),
  `Layer.effect` (was Layer.scoped)

## Design rule: Effect at the boundary, raw hot path

Effect v4 governs the **control plane**: configuration, dependency injection,
service lifecycle, structured startup/shutdown, logging, and the HTTP admin
server. The **data plane** — per-command RESP parsing, dispatch, and reply
encoding — is deliberately raw, allocation-conscious TypeScript. Wrapping every
Redis command in an Effect/Promise was measured (in the predecessor) to cap
throughput; the hot loop must stay synchronous. This split is intentional and
idiomatic: Effect for orchestration, bare metal for the 100k-ops/s inner loop.

## Performance lessons carried over (all applied from the start)

1. Per-connection write coalescing — one `socket.write()` per read drain
2. Synchronous dispatch fast-path — promise queue only for async handlers
3. Cached pre-encoded replies (`+OK`, `+PONG`, `$-1`, `*0`, small ints, bools)
4. Buffer-cursor encoder (`encodeInto`) — no per-reply concat
5. `parseCommand` fast-path — no intermediate `RespValue` allocation
6. ZSet sorted-entries cache — invalidated only on writes
7. Native latin1 `TextDecoder` for binary-safe keys
8. Dual-case command registry — skip per-call `toUpperCase()`
9. Optional `SO_REUSEPORT` multicore (connection-affinity workloads)

## Admin server: Bun 1.3.14 native HTTP/3 (QUIC)

`src/admin.ts` uses `Bun.serve({ http3: true, tls: {...} })` — Bun 1.3.14
added first-class HTTP/3 over QUIC
(https://bun.com/blog/bun-v1.3.14#http-3-quic-support-in-bun-serve). With
`http3` set alongside `tls`, Bun binds TCP (HTTP/1.1 + HTTP/2) and UDP
(HTTP/3) on the SAME port; one `fetch` handler serves all three and TCP
responses carry `Alt-Svc` for client upgrade. Do NOT regress this to
`node:http2` — HTTP/3 is the intended transport.

- QUIC requires TLS: operator PEMs via `VALKEY_ADMIN_TLS_KEY` /
  `VALKEY_ADMIN_TLS_CERT`, else a self-signed dev cert is generated once into
  `.certs/` (gitignored) with `openssl`.
- `http3` is runtime-valid but not in the pinned bun-types union, so the
  options pass through a structural cast at the `Bun.serve` boundary (same
  pattern as the `Bun.listen` `reusePort` cast).
- The admin endpoint binds on worker 0 only under `SO_REUSEPORT` clustering.