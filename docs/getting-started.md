# Getting Started

## Prerequisites

- **[Bun](https://bun.com) 1.3.14 or newer** (`bun --version`). valkey2 uses
  Bun-native APIs (`Bun.listen`, `Bun.serve` HTTP/3); Node.js is not used.
- `openssl` on `PATH` (only needed for the HTTP/3 admin endpoint's
  auto-generated dev TLS certificate; the RESP server does not need it).
- Optional: `redis-cli` for interactive use.

## Install

```bash
git clone https://github.com/chrischabot/valkey-bun
cd valkey-bun
bun install        # installs the single runtime dep: effect@4.0.0-beta.70
```

## Run

```bash
bun run start
```

You will see something like:

```
[12:00:00.000] INFO (#1): valkey2 single-process listening on 0.0.0.0:6379 (db=16) admin http/3 (quic+h2+h1) on :8080 ready in 3.10ms
```

- RESP server: `tcp/6379` (configurable, see [configuration.md](./configuration.md))
- Admin endpoint: HTTP/3 over `udp/8080` + HTTP/2/1.1 over `tcp/8080`

Development mode with auto-reload:

```bash
bun run dev
```

## First session with redis-cli

```bash
$ redis-cli -p 6379
127.0.0.1:6379> PING
PONG
127.0.0.1:6379> SET hello world
OK
127.0.0.1:6379> GET hello
"world"
127.0.0.1:6379> RPUSH mylist a b c
(integer) 3
127.0.0.1:6379> LRANGE mylist 0 -1
1) "a"
2) "b"
3) "c"
127.0.0.1:6379> HSET user:1 name alice age 30
(integer) 2
127.0.0.1:6379> HGETALL user:1
1) "name"
2) "alice"
3) "age"
4) "30"
127.0.0.1:6379> ZADD board 100 alice 80 bob
(integer) 2
127.0.0.1:6379> ZREVRANGE board 0 -1 WITHSCORES
1) "alice"
2) "100"
3) "bob"
4) "80"
127.0.0.1:6379> EXPIRE hello 30
(integer) 1
127.0.0.1:6379> TTL hello
(integer) 30
```

Switch to RESP3:

```bash
127.0.0.1:6379> HELLO 3
127.0.0.1:6379> HGETALL user:1     # now returned as a RESP3 map
```

## Quick-start: ioredis (RESP2)

```ts
import { Redis } from "ioredis";
const r = new Redis({ port: 6379, host: "127.0.0.1" });

await r.set("k", "v");
console.log(await r.get("k"));        // "v"
await r.del("k");
r.disconnect();
```

## Quick-start: node-redis (RESP3)

```ts
import { createClient } from "redis";
const c = createClient({ url: "redis://127.0.0.1:6379", RESP: 3 });
await c.connect();

await c.hSet("h", { a: "1", b: "2" });
console.log(await c.hGetAll("h"));    // { a: "1", b: "2" }  (RESP3 map)
await c.quit();
```

## Quick-start: raw TCP (no client library)

```ts
const sock = await Bun.connect({
  hostname: "127.0.0.1",
  port: 6379,
  socket: { data(_s, d) { process.stdout.write(d); } },
});
// RESP array: SET foo bar
sock.write("*3\r\n$3\r\nSET\r\n$3\r\nfoo\r\n$3\r\nbar\r\n");
// Inline command also works:
sock.write("GET foo\r\n");
```

valkey2 also accepts **inline commands** (space-separated, `\r\n`-terminated),
so even `printf 'PING\r\n' | nc 127.0.0.1 6379` works.

## Verify the install

```bash
bun test          # 60 integration tests across 4 suites (ioredis, node-redis, sample-app, scripting)
bun run typecheck # strict tsc --noEmit, must exit 0
```

Beyond the core data types, valkey2 also implements persistence
(AOF + RDB, see [persistence.md](./persistence.md)), Lua scripting &
Functions (`EVAL`/`EVALSHA`/`SCRIPT`/`FUNCTION`/`FCALL`, see
[commands/scripting.md](./commands/scripting.md)), keyspace notifications and
RESP3 `CLIENT TRACKING` (see
[client-side-caching.md](./client-side-caching.md)), bitmaps, HyperLogLog,
geo, and Redis 7.4 hash-field TTL.

Check the admin endpoint (HTTP/1.1 over TLS works on the same port; the
self-signed dev cert means `-k`):

```bash
curl -sk https://127.0.0.1:8080/health     # OK
curl -sk https://127.0.0.1:8080/info       # JSON
curl -sk https://127.0.0.1:8080/metrics    # Prometheus text
```

Next: [Configuration](./configuration.md) ·
[Command Reference](./commands/README.md) · [Protocol](./protocol.md).