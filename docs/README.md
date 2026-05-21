# valkey2 Documentation

Complete, self-contained documentation for **valkey2** — a
Redis/Valkey-compatible in-memory server on Bun 1.3.14 + Effect v4. You do not
need any external website to use, operate, or implement a client/protocol
against this server.

## Guides

1. [Architecture](./architecture.md) — how valkey2 is built and why.
2. [Getting Started](./getting-started.md) — install, run, first session.
3. [Configuration](./configuration.md) — environment variables and runtime
   `CONFIG`.
4. [RESP Protocol](./protocol.md) — the complete RESP2/RESP3 wire format with
   byte-level examples; everything you need to implement a client from scratch.
5. [Clients](./clients.md) — `redis-cli`, `ioredis`, `node-redis`, and raw
   sockets, with runnable samples.
6. [Admin / HTTP endpoint](./admin-http.md) — HTTP/3 (QUIC) `/health`,
   `/info`, `/metrics`, and TLS.
7. [Benchmarking](./benchmarking.md) — the RESP and HTTP benchmarks.
8. [Deployment](./deployment.md) — multicore, operations, limitations.
9. [Development](./development.md) — project layout, tests, extending it.

## Command reference

The [Command Reference](./commands/README.md) documents **every implemented
command** with syntax, time complexity notes, options, the exact RESP reply
(including RESP2 vs RESP3 differences), and copy-pasteable samples:

- [Strings](./commands/strings.md)
- [Keys / generic / expiration](./commands/keys.md)
- [Hashes](./commands/hashes.md)
- [Lists](./commands/lists.md) (incl. blocking)
- [Sets](./commands/sets.md)
- [Sorted sets](./commands/sorted-sets.md)
- [Streams](./commands/streams.md) (incl. consumer groups)
- [Pub/Sub](./commands/pubsub.md) (incl. sharded)
- [Transactions](./commands/transactions.md)
- [Connection / client](./commands/connection.md)
- [Server / admin commands](./commands/server.md)
- [Scripting](./commands/scripting.md)

## Conventions used throughout these docs

- **Syntax** blocks use the canonical Redis grammar: `UPPERCASE` literals,
  `lowercase` placeholders, `[optional]`, `a|b` alternatives, `value [value ...]`
  repetition.
- **Arity** is given as valkey2 enforces it: it counts the command name plus
  arguments. A negative arity means "at least that many". A wrong arity yields
  `ERR wrong number of arguments for '<cmd>' command`.
- **Reply** lists the RESP type returned, and explicitly calls out any
  RESP2 vs RESP3 difference.
- Samples use `redis-cli` and/or TypeScript (`ioredis`/`node-redis`). Start the
  server first: `bun run start`.
- All keys and values are **binary-safe** byte strings.