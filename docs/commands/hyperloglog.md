# HyperLogLog Commands

Probabilistic cardinality estimation stored in a **string** value. valkey2
uses MurmurHash3 x64 with a dense 16384-register layout and the loglog-beta
estimator. A wrong-type / non-HLL access returns `WRONGTYPE`.

---

## PFADD

`PFADD key [element ...]` · Arity ≥ 2

Add elements (creating the HLL if absent). **Reply:** `:1` if the estimated
cardinality changed (or the key was created), else `:0`.

## PFCOUNT

`PFCOUNT key [key ...]` · Arity ≥ 2 → estimated cardinality of the union of
the given HLLs (`0` for missing keys).

## PFMERGE

`PFMERGE destkey [sourcekey ...]` · Arity ≥ 2 → merge source HLLs (and any
existing `destkey`) into `destkey`. **Reply:** `+OK`.

## PFDEBUG / PFSELFTEST

`PFDEBUG GETREG key` returns the raw register array; `PFSELFTEST` → `+OK`.
Other `PFDEBUG` subcommands are accepted for tooling compatibility.

```bash
PFADD hll a b c d        # (integer) 1
PFADD hll a              # (integer) 0
PFCOUNT hll              # (integer) 4
PFADD hll2 c d e
PFMERGE m hll hll2
PFCOUNT m                # (integer) ~5
```

> The estimate is approximate (standard error ≈ 0.81%), exactly like
> redis-server's HLL.