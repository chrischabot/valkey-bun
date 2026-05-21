# Pub/Sub Commands

Publish/subscribe messaging: subscribers receive messages on channels (exact)
or patterns (glob). valkey2 is a standalone node, so **sharded** pub/sub
(`SSUBSCRIBE`/`SPUBLISH`) shares the same channel registry as regular pub/sub —
correct behavior for a non-clustered server.

## Subscribe mode

While a connection has at least one channel or pattern subscription it is in
**subscribe mode**: only `SUBSCRIBE`, `UNSUBSCRIBE`, `PSUBSCRIBE`,
`PUNSUBSCRIBE`, `SSUBSCRIBE`, `SUNSUBSCRIBE`, `PING`, `QUIT`, `RESET` are
allowed; any other command returns
`ERR Can't execute '<cmd>': only (P|S)SUBSCRIBE / (P|S)UNSUBSCRIBE / PING /
QUIT / RESET are allowed in this context`.

## Reply & message frames

- Subscribe/unsubscribe confirmations: `[kind, channel-or-pattern, count]`
  where `count` is the connection's **total** subscription count
  (channels + patterns). RESP2 → array; RESP3 → **push** frame.
- Channel message: `["message", channel, payload]`.
- Pattern message: `["pmessage", pattern, channel, payload]`.
- RESP2 delivers these as arrays; RESP3 as **push** (`>`) frames.

---

## SUBSCRIBE

`SUBSCRIBE channel [channel ...]` · Arity ≥ 2

Subscribe to channels. Emits one `subscribe` confirmation per channel.

## UNSUBSCRIBE

`UNSUBSCRIBE [channel ...]` · Arity ≥ 1

Unsubscribe from the given channels, or **all** subscribed channels if none
are given. With no current subscriptions it still emits a single
`["unsubscribe", "", 0]` acknowledgement.

## PSUBSCRIBE / PUNSUBSCRIBE

`PSUBSCRIBE pattern [pattern ...]` · Arity ≥ 2
`PUNSUBSCRIBE [pattern ...]` · Arity ≥ 1

Subscribe/unsubscribe to glob patterns (`*`, `?`, `[...]`, `\` escape — the
same glob syntax used by `KEYS`/`SCAN`). Same acknowledgement shape with kinds
`psubscribe`/`punsubscribe`.

## SSUBSCRIBE / SUNSUBSCRIBE

`SSUBSCRIBE shardchannel [shardchannel ...]` · Arity ≥ 2
`SUNSUBSCRIBE [shardchannel ...]` · Arity ≥ 1

Sharded variants. On this standalone node they operate on the same channel
registry as `SUBSCRIBE`/`UNSUBSCRIBE`; acknowledgement kinds are
`ssubscribe`/`sunsubscribe`.

## PUBLISH / SPUBLISH

`PUBLISH channel message` · `SPUBLISH shardchannel message` · Arity 3

Deliver `message` to all subscribers of `channel` **and** to every connection
whose subscribed pattern matches `channel`. **Reply:** integer number of
clients that received the message (channel subscribers + matching pattern
subscribers). `SPUBLISH` behaves identically (single-node).

## PUBSUB

`PUBSUB CHANNELS [pattern]` · `PUBSUB SHARDCHANNELS [pattern]` ·
`PUBSUB NUMSUB [channel ...]` · `PUBSUB SHARDNUMSUB [channel ...]` ·
`PUBSUB NUMPAT` · Arity ≥ 2

- `CHANNELS`/`SHARDCHANNELS [pattern]` → array of active channels (optionally
  filtered by glob).
- `NUMSUB`/`SHARDNUMSUB channel ...` → flat array `[channel, count, ...]`.
- `NUMPAT` → integer number of distinct subscribed patterns.
- Unknown subcommand → `ERR Unknown PUBSUB subcommand '<sub>'`.

---

## Worked example (ioredis)

```ts
import { Redis } from "ioredis";
const sub = new Redis({ port: 6379 });
const pub = new Redis({ port: 6379 });

sub.on("message",  (ch, msg)        => console.log("msg", ch, msg));
sub.on("pmessage", (pat, ch, msg)   => console.log("pmsg", pat, ch, msg));

await sub.subscribe("news");
await sub.psubscribe("user.*");

await pub.publish("news", "hello");        // -> msg  news hello
await pub.publish("user.42", "login");     // -> pmsg user.* user.42 login

// Introspection (use a non-subscribed connection)
console.log(await pub.pubsub("CHANNELS"));     // ["news"]
console.log(await pub.pubsub("NUMSUB", "news")); // ["news", 1]
console.log(await pub.pubsub("NUMPAT"));        // 1

await sub.unsubscribe();                    // leaves subscribe mode
sub.disconnect(); pub.disconnect();
```

### Raw RESP (RESP2)

```
C: *2\r\n$9\r\nSUBSCRIBE\r\n$4\r\nnews\r\n
S: *3\r\n$9\r\nsubscribe\r\n$4\r\nnews\r\n:1\r\n
   (later, when someone PUBLISHes)
S: *3\r\n$7\r\nmessage\r\n$4\r\nnews\r\n$5\r\nhello\r\n
```

Under RESP3 (`HELLO 3`) the same frames arrive as push (`>3 ...`) instead of
arrays. See [protocol.md](../protocol.md) for the full wire format.