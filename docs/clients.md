# Clients

valkey2 is wire-compatible with standard Redis clients. Start the server
(`bun run start`) and point any client at `127.0.0.1:6379`.

## redis-cli

```bash
redis-cli -p 6379                 # interactive
redis-cli -p 6379 PING            # one-shot
redis-cli -p 6379 -a <password>   # with AUTH
redis-cli -3 -p 6379              # negotiate RESP3 (HELLO 3)
redis-cli -p 6379 --scan          # iterate keys via SCAN
```

## ioredis (RESP2)

```ts
import { Redis } from "ioredis";
const r = new Redis({ host: "127.0.0.1", port: 6379 /*, password: "s3cret" */ });

// Strings
await r.set("k", "v", "EX", 60);
await r.get("k");                       // "v"
await r.incrby("counter", 5);           // 5

// Hashes
await r.hset("user:1", { name: "alice", age: "30" });
await r.hgetall("user:1");              // { name: "alice", age: "30" }

// Lists
await r.rpush("q", "a", "b", "c");
await r.lrange("q", 0, -1);             // ["a","b","c"]

// Sorted sets
await r.zadd("board", 100, "alice", 80, "bob");
await r.zrevrange("board", 0, -1, "WITHSCORES"); // ["alice","100","bob","80"]

// Transactions (MULTI/EXEC)
const res = await r.multi().set("a", "1").incr("a").exec();
// res = [[null,"OK"],[null,2]]

// Optimistic locking (WATCH)
await r.watch("bal");
const bal = Number(await r.get("bal"));
const tx = r.multi().set("bal", String(bal - 10));
await tx.exec();                        // null if "bal" changed since WATCH

r.disconnect();
```

### Pub/Sub with ioredis

```ts
import { Redis } from "ioredis";
const sub = new Redis({ port: 6379 });
const pub = new Redis({ port: 6379 });

sub.on("message", (ch, msg) => console.log(ch, msg));
await sub.subscribe("news");
await pub.publish("news", "hello");     // subscriber logs: news hello

// Pattern subscription
await sub.psubscribe("user.*");
sub.on("pmessage", (pat, ch, msg) => console.log(pat, ch, msg));
await pub.publish("user.42", "login");
```

### Blocking list pop (genuine blocking)

```ts
import { Redis } from "ioredis";
const worker = new Redis({ port: 6379 });
const boss = new Redis({ port: 6379 });

// Worker blocks up to 5s waiting for a job; resolves the moment one arrives.
const p = worker.blpop("jobs", 5);
await boss.rpush("jobs", "task-1");
console.log(await p);                    // ["jobs", "task-1"]
```

## node-redis (RESP3)

```ts
import { createClient } from "redis";
const c = createClient({ url: "redis://127.0.0.1:6379", RESP: 3 });
c.on("error", (e) => console.error(e));
await c.connect();

await c.set("k", "v");
console.log(await c.get("k"));          // "v"

// RESP3 returns a real map for HGETALL, a double for ZSCORE, boolean for SISMEMBER
await c.hSet("h", { a: "1", b: "2" });
console.log(await c.hGetAll("h"));      // { a: "1", b: "2" }
await c.zAdd("z", [{ score: 1.5, value: "m" }]);
console.log(await c.zScore("z", "m"));  // 1.5  (number, RESP3 double)
await c.sAdd("s", "x");
console.log(await c.sIsMember("s", "x")); // true (RESP3 boolean)

await c.quit();
```

### Streams with node-redis

```ts
const c = createClient({ url: "redis://127.0.0.1:6379" });
await c.connect();

const id = await c.xAdd("events", "*", { type: "click", x: "10" });
const range = await c.xRange("events", "-", "+");
// consumer groups
await c.xGroupCreate("events", "g1", "0", { MKSTREAM: true });
const msgs = await c.xReadGroup("g1", "c1",
  [{ key: "events", id: ">" }], { COUNT: 10 });
await c.xAck("events", "g1", id);
await c.quit();
```

## Raw TCP (implement-it-yourself)

Everything you need is in [protocol.md](./protocol.md). Minimal example:

```ts
function cmd(...parts: string[]): string {
  return `*${parts.length}\r\n` +
    parts.map((p) => `$${Buffer.byteLength(p)}\r\n${p}\r\n`).join("");
}

const sock = await Bun.connect({
  hostname: "127.0.0.1",
  port: 6379,
  socket: {
    data(_s, chunk) { process.stdout.write(chunk); }, // raw RESP replies
  },
});

sock.write(cmd("HELLO", "3"));
sock.write(cmd("SET", "foo", "bar"));
sock.write(cmd("GET", "foo"));        // -> $3\r\nbar\r\n
sock.write(cmd("SUBSCRIBE", "ch"));   // push frames arrive asynchronously
```

## Connection notes

- A new connection starts on DB 0, RESP2, unauthenticated.
- `SELECT n` changes the per-connection database.
- `HELLO 3` upgrades to RESP3 for that connection only.
- If `VALKEY_PASSWORD` is set, send `AUTH` (or `HELLO 3 AUTH default <pw>`)
  first; until then only `AUTH`/`HELLO`/`PING`/`QUIT` are allowed.
- `RESET` returns the connection to a clean state (DB 0, RESP unchanged,
  no `MULTI`, no subscriptions, name cleared).

See the [Command Reference](./commands/README.md) for every command.