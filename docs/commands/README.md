# Command Reference

Every command implemented by valkey2, documented like the canonical Redis
docs. Each category page lists, per command: **Syntax**, **Arity**,
**Behavior**, **Options**, and **Reply** (with RESP2 vs RESP3 differences),
plus sample code.

## Categories

| Page | Commands |
|------|----------|
| [Strings](./strings.md) | `GET` `SET` `GETSET` `GETDEL` `GETEX` `MGET` `MSET` `MSETNX` `APPEND` `STRLEN` `INCR` `DECR` `INCRBY` `DECRBY` `INCRBYFLOAT` `SETNX` `SETEX` `PSETEX` `SETRANGE` `GETRANGE` `SUBSTR` |
| [Keys](./keys.md) | `DEL` `UNLINK` `EXISTS` `EXPIRE` `PEXPIRE` `EXPIREAT` `PEXPIREAT` `EXPIRETIME` `PEXPIRETIME` `TTL` `PTTL` `PERSIST` `KEYS` `TYPE` `RENAME` `RENAMENX` `RANDOMKEY` `SCAN` `DBSIZE` `FLUSHDB` `FLUSHALL` `OBJECT` `COPY` `TOUCH` `MOVE` |
| [Hashes](./hashes.md) | `HSET` `HGET` `HMSET` `HMGET` `HGETALL` `HDEL` `HEXISTS` `HKEYS` `HVALS` `HLEN` `HINCRBY` `HINCRBYFLOAT` `HSETNX` `HSTRLEN` `HSCAN` `HRANDFIELD` |
| [Lists](./lists.md) | `LPUSH` `RPUSH` `LPUSHX` `RPUSHX` `LPOP` `RPOP` `LLEN` `LRANGE` `LINDEX` `LSET` `LREM` `LTRIM` `LINSERT` `LMOVE` `RPOPLPUSH` `LPOS` `BLPOP` `BRPOP` |
| [Sets](./sets.md) | `SADD` `SREM` `SMEMBERS` `SISMEMBER` `SMISMEMBER` `SCARD` `SPOP` `SRANDMEMBER` `SUNION` `SINTER` `SDIFF` `SUNIONSTORE` `SINTERSTORE` `SDIFFSTORE` `SMOVE` `SSCAN` `SINTERCARD` |
| [Sorted sets](./sorted-sets.md) | `ZADD` `ZREM` `ZSCORE` `ZMSCORE` `ZINCRBY` `ZCARD` `ZCOUNT` `ZLEXCOUNT` `ZRANK` `ZREVRANK` `ZRANGE` `ZREVRANGE` `ZRANGEBYSCORE` `ZREVRANGEBYSCORE` `ZRANGEBYLEX` `ZREVRANGEBYLEX` `ZPOPMIN` `ZPOPMAX` `ZRANDMEMBER` `ZUNION` `ZINTER` `ZDIFF` `ZUNIONSTORE` `ZINTERSTORE` `ZDIFFSTORE` `ZRANGESTORE` `ZINTERCARD` `ZSCAN` |
| [Streams](./streams.md) | `XADD` `XLEN` `XRANGE` `XREVRANGE` `XDEL` `XTRIM` `XREAD` `XINFO` `XGROUP` `XREADGROUP` `XACK` `XPENDING` `XCLAIM` |
| [Pub/Sub](./pubsub.md) | `SUBSCRIBE` `UNSUBSCRIBE` `PSUBSCRIBE` `PUNSUBSCRIBE` `SSUBSCRIBE` `SUNSUBSCRIBE` `PUBLISH` `SPUBLISH` `PUBSUB` |
| [Transactions](./transactions.md) | `MULTI` `EXEC` `DISCARD` `WATCH` `UNWATCH` |
| [Connection](./connection.md) | `PING` `ECHO` `AUTH` `HELLO` `SELECT` `CLIENT` `RESET` `QUIT` |
| [Server](./server.md) | `INFO` `COMMAND` `CONFIG` `DEBUG` `TIME` `SHUTDOWN` `LASTSAVE` `BGSAVE` `SAVE` `BGREWRITEAOF` `MEMORY` `LATENCY` `SLOWLOG` `WAIT` `FAILOVER` `MODULE` `ACL` `CLUSTER` `SWAPDB` |
| [Scripting](./scripting.md) | `EVAL` `EVALSHA` `EVAL_RO` `EVALSHA_RO` `SCRIPT` `FUNCTION` `FCALL` `FCALL_RO` (stubbed) |

## How to read these pages

- **Syntax** uses canonical Redis grammar: `UPPERCASE` literals, `lowercase`
  placeholders, `[optional]`, `a|b` alternatives, `x [x ...]` repetition.
- **Arity** is what valkey2 enforces (command name + args; negative = "at
  least"). Wrong arity →
  `ERR wrong number of arguments for '<cmd>' command`.
- **Reply** gives the RESP type; any **RESP2 vs RESP3** difference is called
  out explicitly (see [protocol.md](../protocol.md) for the downgrade rules).
- A wrong-type operation returns
  `WRONGTYPE Operation against a key holding the wrong kind of value`.
- Samples assume `bun run start` and use `redis-cli` and/or
  `ioredis`/`node-redis` (see [clients.md](../clients.md)).

## Global behaviors

- **Keys/values are binary-safe** byte strings.
- **Expiry:** keys with a TTL are removed lazily on access and by a 1 Hz
  sweep; commands that read an expired key behave as if it is absent.
- **Auth:** if a password is configured, only `AUTH`/`HELLO`/`PING`/`QUIT`
  work until authenticated.
- **Transactions:** inside `MULTI`, commands reply `+QUEUED` and run on
  `EXEC`; arity is still validated at queue time.