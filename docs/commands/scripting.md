# Scripting Commands

valkey2 **does not execute Lua scripts or Redis Functions.** This is an
intentional limitation (see [deployment.md](../deployment.md)). The commands
exist so clients that probe for them degrade gracefully rather than seeing
"unknown command".

---

## EVAL / EVALSHA / EVAL_RO / EVALSHA_RO

`EVAL script numkeys [key ...] [arg ...]` · Arity ≥ 3 (and the `_RO` /
`EVALSHA` variants)

- `EVAL` / `EVAL_RO` → `ERR Scripting is not supported in this build`
- `EVALSHA` / `EVALSHA_RO` → `NOSCRIPT No matching script`

## SCRIPT

`SCRIPT LOAD script` · `SCRIPT EXISTS sha1 [sha1 ...]` · `SCRIPT FLUSH` ·
Arity ≥ 2

`SCRIPT` is partially functional for tooling compatibility:
- `LOAD` computes and stores the script's SHA-1, returning the 40-char hex
  digest (the script is **stored but never executed**).
- `EXISTS` → array of `:1`/`:0` for each SHA-1 previously `LOAD`ed.
- `FLUSH` → `+OK`, clears the stored digests.
- Other subcommands → `+OK`.

Because `EVALSHA` always returns `NOSCRIPT`, `SCRIPT LOAD` is only useful for
clients that pre-flight script registration.

## FUNCTION

`FUNCTION subcommand [args]` · Arity ≥ 2

- `LIST` / `DUMP` / `STATS` → empty array
- `FLUSH` / `DELETE` / `RESTORE` → `+OK`
- others → `+OK`

## FCALL / FCALL_RO

`FCALL name numkeys [key ...] [arg ...]` · Arity ≥ 3 →
`ERR functions are not supported in this build`.

---

## What to use instead

Most uses of `EVAL` for atomicity can be replaced with valkey2 features:

| Need | Use instead |
|------|-------------|
| Atomic multi-step write | `MULTI`/`EXEC` ([transactions](./transactions.md)) |
| Check-and-set / optimistic lock | `WATCH` + `MULTI`/`EXEC` |
| Atomic counter | `INCR`/`INCRBY`/`HINCRBY` |
| Conditional set | `SET … NX/XX`, `SETNX`, `HSETNX` |
| Pop-and-process queue | `LMOVE`/`RPOPLPUSH`, blocking `BLPOP`/`BRPOP` |
| Fan-out / event log | streams + consumer groups, pub/sub |

Example — an atomic "transfer" that would often be a Lua script, done with
`WATCH`:

```ts
await r.watch("from", "to");
const from = Number(await r.get("from"));
if (from < amount) { await r.unwatch(); throw new Error("insufficient"); }
const ok = await r.multi()
  .decrby("from", amount)
  .incrby("to", amount)
  .exec();                       // null => retry (a watched key changed)
```

See [transactions.md](./transactions.md) for the full pattern.