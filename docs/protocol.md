# The RESP Protocol (RESP2 & RESP3)

valkey2 speaks **RESP** (REdis Serialization Protocol) over TCP. This page is a
complete, self-contained specification of the wire format as valkey2 parses and
emits it (`src/resp.ts`). With only this page you can implement a fully
compatible client.

## Transport & framing

- Plain TCP. Every protocol token ends with **CRLF** (`\r\n`, bytes
  `0x0D 0x0A`).
- A client sends **requests**; the server sends **replies**. There is one
  reply per command (pub/sub and `MONITOR`-style pushes are out-of-band
  messages, see below).
- Pipelining: a client may send many requests before reading replies; the
  server preserves order. valkey2 coalesces a batch of replies into a single
  TCP write.
- The protocol is **binary-safe**: bulk strings carry an explicit length, so
  keys/values may contain any bytes including CRLF and NUL.

## Two protocol versions

| | RESP2 | RESP3 |
|--|-------|-------|
| Default on connect | ✅ | — |
| Switch | — | `HELLO 3` |
| Extra types | — | null `_`, boolean `#`, double `,`, big number `(`, map `%`, set `~`, attribute `\|`, push `>`, verbatim `=` |

A connection starts in RESP2. `HELLO 3` upgrades it (and `HELLO 2` downgrades).
`HELLO` replies with a map describing the server.

## Requests

### 1. Array-of-bulk-strings (what clients use)

A command is an array of bulk strings: the command name followed by its
arguments.

```
*<numargs+1>\r\n
$<len>\r\n<bytes>\r\n      (command name)
$<len>\r\n<bytes>\r\n      (arg 1)
...
```

Example — `SET foo bar`:

```
*3\r\n$3\r\nSET\r\n$3\r\nfoo\r\n$3\r\nbar\r\n
```

valkey2 has an allocation-free fast path for exactly this frame.

### 2. Inline commands

For interactive/debug use, a single CRLF-terminated line split on whitespace
is accepted:

```
PING\r\n
SET foo bar\r\n
```

Inline parsing is a fallback; real clients should use the array form.

## Reply types

Each reply begins with a one-byte type tag.

### RESP2 core types (also valid in RESP3)

| Tag | Name | Wire format | Example |
|-----|------|-------------|---------|
| `+` | Simple string | `+<text>\r\n` | `+OK\r\n` |
| `-` | Error | `-<message>\r\n` | `-ERR unknown command 'x'\r\n` |
| `:` | Integer | `:<digits>\r\n` | `:1000\r\n` |
| `$` | Bulk string | `$<len>\r\n<bytes>\r\n` | `$5\r\nhello\r\n` |
| `$` | Null bulk (RESP2 nil) | `$-1\r\n` | `$-1\r\n` |
| `*` | Array | `*<count>\r\n<elements…>` | `*2\r\n:1\r\n:2\r\n` |
| `*` | Null array (RESP2) | `*-1\r\n` | `*-1\r\n` |

Integers that overflow a safe JS integer are still parsed (as big integers)
and re-emitted as `:` lines.

### RESP3 additional types

| Tag | Name | Wire format | Notes |
|-----|------|-------------|-------|
| `_` | Null | `_\r\n` | Replaces `$-1`/`*-1` |
| `#` | Boolean | `#t\r\n` / `#f\r\n` | |
| `,` | Double | `,<float>\r\n` | `,inf`, `,-inf`, `,nan` allowed |
| `(` | Big number | `(<digits>\r\n` | Arbitrary precision integer |
| `%` | Map | `%<pairs>\r\n<k><v>…` | `pairs` = number of key/value pairs |
| `~` | Set | `~<count>\r\n<elements…>` | Like array, set semantics |
| `>` | Push | `><count>\r\n<elements…>` | Out-of-band (pub/sub, etc.) |
| `=` | Verbatim string | `=<len>\r\n<fmt>:<text>\r\n` | `fmt` is a 3-char type, e.g. `txt` |
| `\|` | Attribute | `\|<pairs>\r\n<k><v>… <reply>` | Metadata preceding a reply |
| `!` | Blob error | `!<len>\r\n<bytes>\r\n` | Binary-safe error |

### The RESP2 downgrade contract

When a connection is in RESP2, valkey2 emits the canonical Redis downgrades —
**this is intentional server behavior, identical to real redis-server**, not a
serialization round-trip:

| Logical value | RESP3 wire | RESP2 wire |
|---------------|-----------|------------|
| null | `_\r\n` | `$-1\r\n` |
| boolean true/false | `#t\r\n` / `#f\r\n` | `:1\r\n` / `:0\r\n` |
| double `d` | `,d\r\n` | `$<len>\r\n<d>\r\n` (bulk string; `inf`/`-inf`/`nan`) |
| map of N pairs | `%N\r\n…` | `*2N\r\n…` (flattened array) |
| set | `~N\r\n…` | `*N\r\n…` (array) |
| push | `>N\r\n…` | `*N\r\n…` (array) |
| verbatim | `=…` | `$…` (bulk) |
| big number | `(…` | `:…` (integer line) |

Practical client consequences (RESP2): `SISMEMBER` returns `:1`/`:0`,
`ZSCORE` returns a bulk string, `HGETALL` returns a flat
`[field,value,field,value,…]` array. Under RESP3 the same commands return a
boolean, a double, and a map respectively. Each [command page](./commands/README.md)
states the exact reply for both protocols.

## Errors

Errors are a single line: `-<CODE> <message>\r\n`. valkey2 uses standard
Redis error prefixes:

| Prefix | Meaning |
|--------|---------|
| `ERR` | Generic error (unknown command, syntax, wrong args, bad value) |
| `WRONGTYPE` | Operation against a key holding the wrong value type |
| `NOAUTH` | Authentication required (password set, not yet authenticated) |
| `WRONGPASS` | Invalid password supplied to `AUTH`/`HELLO` |
| `NOPROTO` | Unsupported protocol version in `HELLO` |
| `EXECABORT` | `EXEC` aborted due to a prior queuing error |
| `NOSCRIPT` | No matching script (scripting is stubbed; see scripting docs) |
| `BUSYGROUP` | Consumer group already exists (`XGROUP CREATE`) |
| `NOGROUP` | No such key or consumer group (streams) |

A handler error not already carrying a known prefix is wrapped as `ERR
<message>`.

## Out-of-band push messages (pub/sub)

After `SUBSCRIBE`/`PSUBSCRIBE`, messages arrive asynchronously:

- RESP2: a 3- or 4-element **array**:
  - `*3 "message" <channel> <payload>`
  - `*4 "pmessage" <pattern> <channel> <payload>`
- RESP3: the same elements as a **push** frame (`>3`/`>4`).

Subscribe/unsubscribe confirmations have the form
`["subscribe", <channel>, <count>]` (push in RESP3). While a connection is in
subscribe mode, only `(P|S)SUBSCRIBE`, `(P|S)UNSUBSCRIBE`, `PING`, `QUIT`,
`RESET` are allowed — anything else returns an error.

`PING` while subscribed replies `["pong", ""]` (array) in RESP2 and `+PONG` in
RESP3.

## A complete annotated exchange

Client (`SET foo bar`, then `GET foo`):

```
*3\r\n$3\r\nSET\r\n$3\r\nfoo\r\n$3\r\nbar\r\n
*2\r\n$3\r\nGET\r\n$3\r\nfoo\r\n
```

Server:

```
+OK\r\n
$3\r\nbar\r\n
```

`HELLO 3` reply (RESP3 map, abbreviated):

```
%7\r\n
$6\r\nserver\r\n$6\r\nvalkey\r\n
$7\r\nversion\r\n$5\r\n7.4.0\r\n
$5\r\nproto\r\n:3\r\n
$2\r\nid\r\n:7\r\n
$4\r\nmode\r\n$10\r\nstandalone\r\n
$4\r\nrole\r\n$6\r\nmaster\r\n
$7\r\nmodules\r\n*0\r\n
```

## Implementation checklist for a client

1. Connect TCP; optionally `HELLO 3` for RESP3.
2. Encode requests as arrays of bulk strings.
3. Parse replies by first byte; recurse for aggregates (`*`, `%`, `~`, `>`,
   `|`).
4. Treat `$-1`/`*-1` (RESP2) and `_` (RESP3) as null.
5. Handle `-`/`!` as errors.
6. For pub/sub, read push/array frames out of band.
7. If you requested RESP2, expect the downgrades in the table above.

That is the entire protocol. See [clients.md](./clients.md) for ready-made
client usage and [commands](./commands/README.md) for per-command reply types.