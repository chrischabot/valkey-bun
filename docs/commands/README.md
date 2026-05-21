# Command Reference

Every command implemented by valkey2, documented like the canonical Redis
docs. Each category page lists, per command: **Syntax**, **Arity**,
**Behavior**, **Options**, and **Reply** (with RESP2 vs RESP3 differences),
plus sample code.

## Categories

| Page | Commands |
|------|----------|
| [Strings](./strings.md) | `GET` `SET` `GETSET` `GETDEL` `GETEX` `MGET` `MSET` `MSETNX` `APPEND` `STRLEN` `INCR` `DECR` `INCRBY` `DECRBY` `INCRBYFLOAT` `SETNX` `SETEX` `PSETEX` `SETRANGE` `GETRANGE` `SUBSTR` `LCS` |
| [Keys](./keys.md) | `DEL` `UNLINK` `EXISTS` `EXPIRE` `PEXPIRE` `EXPIREAT` `PEXPIREAT` `EXPIRETIME` `PEXPIRETIME` `TTL` `PTTL` `PERSIST` `KEYS` `TYPE` `RENAME` `RENAMENX` `RANDOMKEY` `SCAN` `DBSIZE` `FLUSHDB` `FLUSHALL` `OBJECT` `COPY` `TOUCH` `MOVE` `DUMP` `RESTORE` `SORT` `SORT_RO` |
| [Hashes](./hashes.md) | `HSET` `HGET` `HMSET` `HMGET` `HGETALL` `HDEL` `HEXISTS` `HKEYS` `HVALS` `HLEN` `HINCRBY` `HINCRBYFLOAT` `HSETNX` `HSTRLEN` `HSCAN` `HRANDFIELD` |
| [Lists](./lists.md) | `LPUSH` `RPUSH` `LPUSHX` `RPUSHX` `LPOP` `RPOP` `LLEN` `LRANGE` `LINDEX` `LSET` `LREM` `LTRIM` `LINSERT` `LMOVE` `RPOPLPUSH` `LPOS` `BLPOP` `BRPOP` `BLMOVE` `BRPOPLPUSH` `LMPOP` `BLMPOP` |
| [Sets](./sets.md) | `SADD` `SREM` `SMEMBERS` `SISMEMBER` `SMISMEMBER` `SCARD` `SPOP` `SRANDMEMBER` `SUNION` `SINTER` `SDIFF` `SUNIONSTORE` `SINTERSTORE` `SDIFFSTORE` `SMOVE` `SSCAN` `SINTERCARD` |
| [Sorted sets](./sorted-sets.md) | `ZADD` `ZREM` `ZSCORE` `ZMSCORE` `ZINCRBY` `ZCARD` `ZCOUNT` `ZLEXCOUNT` `ZRANK` `ZREVRANK` `ZRANGE` `ZREVRANGE` `ZRANGEBYSCORE` `ZREVRANGEBYSCORE` `ZRANGEBYLEX` `ZREVRANGEBYLEX` `ZPOPMIN` `ZPOPMAX` `ZRANDMEMBER` `ZUNION` `ZINTER` `ZDIFF` `ZUNIONSTORE` `ZINTERSTORE` `ZDIFFSTORE` `ZRANGESTORE` `ZINTERCARD` `ZSCAN` `ZREMRANGEBYRANK` `ZREMRANGEBYSCORE` `ZREMRANGEBYLEX` `ZMPOP` `BZMPOP` `BZPOPMIN` `BZPOPMAX` |
| [Streams](./streams.md) | `XADD` `XLEN` `XRANGE` `XREVRANGE` `XDEL` `XTRIM` `XREAD` `XINFO` `XGROUP` `XREADGROUP` `XACK` `XPENDING` `XCLAIM` `XAUTOCLAIM` `XSETID` |
| [Bitmaps](./bitmaps.md) | `SETBIT` `GETBIT` `BITCOUNT` `BITPOS` `BITOP` `BITFIELD` `BITFIELD_RO` |
| [HyperLogLog](./hyperloglog.md) | `PFADD` `PFCOUNT` `PFMERGE` `PFDEBUG` `PFSELFTEST` |
| [Geo](./geo.md) | `GEOADD` `GEOPOS` `GEODIST` `GEOHASH` `GEOSEARCH` `GEOSEARCHSTORE` `GEORADIUS` `GEORADIUSBYMEMBER` |
| [Hash field TTL](./hash-ttl.md) | `HEXPIRE` `HPEXPIRE` `HEXPIREAT` `HPEXPIREAT` `HTTL` `HPTTL` `HEXPIRETIME` `HPEXPIRETIME` `HPERSIST` `HGETEX` `HGETDEL` |
| [Pub/Sub](./pubsub.md) | `SUBSCRIBE` `UNSUBSCRIBE` `PSUBSCRIBE` `PUNSUBSCRIBE` `SSUBSCRIBE` `SUNSUBSCRIBE` `PUBLISH` `SPUBLISH` `PUBSUB` |
| [Transactions](./transactions.md) | `MULTI` `EXEC` `DISCARD` `WATCH` `UNWATCH` |
| [Connection](./connection.md) | `PING` `ECHO` `AUTH` `HELLO` `SELECT` `CLIENT` (incl. `TRACKING`/`CACHING`/`TRACKINGINFO`/`GETREDIR`) `RESET` `QUIT` |
| [Server](./server.md) | `INFO` `COMMAND` `CONFIG` `DEBUG` `TIME` `SHUTDOWN` `LASTSAVE` `BGSAVE` `SAVE` `BGREWRITEAOF` `WAITAOF` `MEMORY` `LATENCY` `SLOWLOG` `WAIT` `FAILOVER` `MODULE` `ACL` `CLUSTER` `SWAPDB` |
| [Scripting](./scripting.md) | `EVAL` `EVALSHA` `EVAL_RO` `EVALSHA_RO` `SCRIPT` `FUNCTION` `FCALL` `FCALL_RO` |

Related guides: [Persistence](../persistence.md) (AOF/RDB, `DUMP`/`RESTORE`),
[Client-side caching & keyspace notifications](../client-side-caching.md).

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
- **Persistence:** with a data directory configured, successful writes are
  appended to the AOF and reflected by RDB snapshots — see
  [persistence.md](../persistence.md).
- **Notifications & caching:** successful mutations emit keyspace
  notifications (when `notify-keyspace-events` is set) and `CLIENT TRACKING`
  invalidations — see
  [client-side-caching.md](../client-side-caching.md).
- **Blocking:** `BLPOP`/`BRPOP`/`BLMOVE`/`BRPOPLPUSH`/`BLMPOP`/`BZPOPMIN`/
  `BZPOPMAX`/`BZMPOP` and `XREAD`/`XREADGROUP BLOCK` genuinely park the client
  until data arrives or the timeout elapses.