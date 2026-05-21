# Hash Field Expiration (Redis 7.4)

Per-field TTLs on hash fields. Expired fields are removed lazily on access
and by the 1 Hz sweep; a hash with no remaining fields is deleted. A
wrong-type access returns `WRONGTYPE`.

Every command takes a trailing `FIELDS numfields field [field ...]` clause;
`numfields` must equal the number of listed fields. Per-field reply codes:
`-2` field/key absent, `-1` no TTL, `0` condition not met, `1` set/changed,
`2` field deleted because the expiry was already in the past.

---

## HEXPIRE / HPEXPIRE / HEXPIREAT / HPEXPIREAT

`HEXPIRE key seconds [NX|XX|GT|LT] FIELDS numfields field [field ...]`
· Arity ≥ 6 (and the `P*`/`*AT` millisecond/absolute variants)

Set a per-field TTL. `NX` only if the field has no TTL; `XX` only if it has
one; `GT`/`LT` only if the new expiry is greater/less than the current — a
field **with no TTL is treated as +infinity** (so `GT` never sets it and
`LT` always does). **Reply:** array of per-field codes.

## HTTL / HPTTL / HEXPIRETIME / HPEXPIRETIME

`HTTL key FIELDS numfields field [field ...]` · Arity ≥ 5 (and `P*`/`*TIME`
variants) → array of remaining seconds/ms or absolute timestamps (`-1` no
TTL, `-2` no field).

## HPERSIST

`HPERSIST key FIELDS numfields field [field ...]` · Arity ≥ 5 → array
(`1` TTL removed, `-1` field had no TTL, `-2` no field).

## HGETEX

`HGETEX key [EX s|PX ms|EXAT ts|PXAT ms|PERSIST] FIELDS numfields field [field ...]`
· Arity ≥ 5

Return field values and optionally adjust their TTLs (get-then-expire: a
past expiry returns the value then deletes the field). **Reply:** array of
values (nil per missing field).

## HGETDEL

`HGETDEL key FIELDS numfields field [field ...]` · Arity ≥ 5 → return the
field values and delete those fields atomically.

```bash
HSET h f1 v1 f2 v2
HEXPIRE h 100 FIELDS 1 f1     # 1) (integer) 1
HTTL h FIELDS 2 f1 f2         # 1) (integer) 100  2) (integer) -1
HPERSIST h FIELDS 1 f1        # 1) (integer) 1
HGETDEL h FIELDS 1 f2         # 1) "v2"
```

> AOF logs the `HEXPIRE`-family commands verbatim; per-field TTLs are not
> carried in the custom RDB snapshot (a documented single-node limitation).