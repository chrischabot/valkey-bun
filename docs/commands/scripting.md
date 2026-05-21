# Scripting & Functions

valkey2 executes **Lua scripts and Redis Functions** via an embedded
[fengari](https://fengari.io) Lua 5.3 VM (pure JavaScript, no native code).
`redis.call`/`redis.pcall` are bridged to the synchronous command dispatcher,
so a script observes and mutates exactly the same keyspace as any other
client, and script writes are AOF-logged, fire keyspace notifications, and
trigger client-side-caching invalidations like normal commands.

---

## EVAL / EVAL_RO

`EVAL script numkeys [key ...] [arg ...]` · Arity ≥ 3
`EVAL_RO script numkeys [key ...] [arg ...]` · Arity ≥ 3

Compile and run `script`. The first `numkeys` arguments are exposed as the
1-based `KEYS` table; the remainder as `ARGV`. `numkeys` must be a
non-negative integer not greater than the number of arguments
(`ERR Number of keys can't be negative` / `... can't be greater than number
of args`).

`EVAL_RO` runs the script in **read-only** mode: any write command issued via
`redis.call`/`redis.pcall` fails with
`ERR Write commands are not allowed from read-only scripts.`

**Reply:** the script's return value, converted by the rules below.

```bash
EVAL "return 1+2" 0                              # (integer) 3
EVAL "return redis.call('set', KEYS[1], ARGV[1])" 1 k v   # OK
EVAL "return {KEYS[1], ARGV[1]}" 1 k a            # 1) "k" 2) "a"
EVAL "return redis.status_reply('DONE')" 0        # DONE
EVAL "return redis.error_reply('boom')" 0         # (error) boom
```

## EVALSHA / EVALSHA_RO

`EVALSHA sha1 numkeys [key ...] [arg ...]` · Arity ≥ 3
`EVALSHA_RO sha1 numkeys [key ...] [arg ...]` · Arity ≥ 3

Run a script previously cached by its SHA-1 (lowercased). Unknown digest →
`NOSCRIPT No matching script. Please use EVAL.` `EVAL`/`SCRIPT LOAD` populate
the cache.

## SCRIPT

`SCRIPT LOAD script` → cache the script, reply its 40-char SHA-1.
`SCRIPT EXISTS sha1 [sha1 ...]` → array of `1`/`0` per digest.
`SCRIPT FLUSH [ASYNC|SYNC]` → `+OK`, clears the cache.
Other subcommands → `+OK`.

## The `redis` / `server` API (inside scripts)

Both the `redis` and `server` global tables are available:

| Function | Behavior |
|----------|----------|
| `redis.call(cmd, ...)` | Run a command; a command error raises a Lua error (`{err=...}`). |
| `redis.pcall(cmd, ...)` | Like `call` but returns the error table instead of raising. |
| `redis.error_reply(s)` | Returns `{err=s}`. |
| `redis.status_reply(s)` | Returns `{ok=s}`. |
| `redis.sha1hex(s)` | SHA-1 hex digest of `s`. |
| `redis.log(level, ...)` | Accepted no-op. |
| `redis.setresp(n)` | Accepted no-op (scripts see the RESP2 mapping). |
| `redis.replicate_commands()` | Returns `true`. |
| `redis.breakpoint` / `redis.debug` | Accepted no-ops. |
| `redis.LOG_*` / `redis.REPL_*` | Numeric constants. |
| `cjson.encode` / `cjson.decode` | JSON bridge. |
| `KEYS` / `ARGV` | 1-based argument tables. |

### Conversion rules (RESP ⇄ Lua)

Matches redis-server `scripting.c` (RESP2 mapping):

| RESP reply | Lua value |
|------------|-----------|
| integer | number |
| bulk / verbatim | string |
| simple string | `{ ok = "..." }` |
| error | `{ err = "..." }` (raised by `call`) |
| nil / null bulk | `false` |
| array / set / push | table (1-based) |
| map | flat `{k,v,...}` table |

| Lua return | RESP reply |
|------------|-----------|
| number | integer (truncated) |
| string | bulk |
| `true` | `:1` |
| `false` / `nil` | null bulk |
| `{ ok = s }` | simple string |
| `{ err = s }` | error |
| table (sequence) | array (stops at first `nil`) |

## FUNCTION

`FUNCTION LOAD [REPLACE] code` — register a library. `code` must start with
`#!lua name=<libname>` followed by one or more
`redis.register_function('name', function(keys, args) ... end)` (or the
`{function_name=, callback=}` table form). Returns the library name. A
duplicate name without `REPLACE` → `ERR Library '<name>' already exists`; a
library that registers nothing → `ERR No functions registered`.

`FUNCTION DELETE libname` → `+OK` (or `ERR Library not found`).
`FUNCTION FLUSH [ASYNC|SYNC]` → `+OK`, drops all libraries.
`FUNCTION LIST [LIBRARYNAME name] [WITHCODE]` → library metadata (and source
with `WITHCODE`).
`FUNCTION DUMP` → a serialized payload of all libraries.
`FUNCTION RESTORE payload [FLUSH|APPEND|REPLACE]` → restore libraries from a
`DUMP` payload (default policy `APPEND`; `APPEND` rejects name collisions, a
payload with duplicate library names is rejected before any mutation).
`FUNCTION STATS` → engine/library/function counts.

## FCALL / FCALL_RO

`FCALL name numkeys [key ...] [arg ...]` · Arity ≥ 3
`FCALL_RO name numkeys [key ...] [arg ...]` · Arity ≥ 3

Invoke a registered function. `KEYS`/`ARGV` are passed as the callback's
`keys`/`args` arguments. Unknown function → `ERR Function not found`.
`FCALL_RO` enforces read-only (writes raise the read-only error).

```bash
FUNCTION LOAD "#!lua name=lib
redis.register_function('myset', function(keys, args) return redis.call('set', keys[1], args[1]) end)"
FCALL myset 1 k hello        # OK
GET k                        # "hello"
```

## Atomicity & blocking

A script/function runs to completion before any other command on the data
plane (the dispatcher is synchronous). Blocking commands
(`BLPOP`/`BRPOP`/`DEBUG SLEEP`/`EXEC`) are **not allowed** from a script and
return `ERR This Redis command is not allowed from scripts`.

## Known differences from redis-server

- Lua 5.3 (fengari), not Redis's bundled Lua 5.1: integer/float number
  semantics and a few stdlib edges differ.
- `cjson` is a pragmatic JSON bridge (no `cjson.encode_*` tuning knobs);
  `cmsgpack`/`bit`/`struct` are not provided.
- `FUNCTION DUMP`/`RESTORE` use a portable internal payload (not the binary
  redis-server format) — round-trips within valkey2, not across to
  redis-server.

These are intentional, documented limitations; the common
`redis.call`/`pcall`/`status_reply`/`error_reply`/`sha1hex`/`cjson` surface
behaves as scripts expect.