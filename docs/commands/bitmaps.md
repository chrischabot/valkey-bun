# Bitmap Commands

Bitmaps are operations over the bits of a regular **string** value (binary
safe). A wrong-type access returns `WRONGTYPE`.

---

## SETBIT

`SETBIT key offset value` · Arity 4

Set the bit at `offset` (0-based, MSB-first within each byte) to `0`/`1`,
growing the string with zero bytes as needed. `offset` must be a
non-negative integer; `value` must be `0` or `1`. **Reply:** the previous
bit value.

## GETBIT

`GETBIT key offset` · Arity 3 → the bit at `offset` (`0` if beyond the
current length or the key is absent).

## BITCOUNT

`BITCOUNT key [start end [BYTE|BIT]]` · Arity ≥ 2

Count set bits, optionally within a `[start,end]` range interpreted as
**byte** (default) or **bit** indices (negatives count from the end).
**Reply:** integer.

## BITPOS

`BITPOS key bit [start [end [BYTE|BIT]]]` · Arity ≥ 3

First position of `bit` (`0`/`1`), with the same `BYTE|BIT` range semantics.
**Reply:** integer position, or `-1` if not found.

## BITOP

`BITOP AND|OR|XOR|NOT destkey key [key ...]` · Arity ≥ 4

Bitwise op across source strings (shorter strings zero-extended) stored into
`destkey`. `NOT` requires exactly one source. **Reply:** the length in bytes
of the stored result.

## BITFIELD / BITFIELD_RO

`BITFIELD key [GET type offset] [SET type offset value] [INCRBY type offset increment] [OVERFLOW WRAP|SAT|FAIL]`
· Arity ≥ 2

Operate on arbitrary-width signed (`i1`–`i64`) / unsigned (`u1`–`u63`)
integer fields at a bit `offset` (or `#n` for the n-th field of that width).
`OVERFLOW` sets wrap/saturate/fail behavior for subsequent `SET`/`INCRBY`
(`FAIL` yields a nil element). `GET` on bits past the end reads as zero
without growing. `BITFIELD_RO` allows only `GET`. **Reply:** array of
per-operation results.

```bash
SETBIT bm 7 1        # (integer) 0
GETBIT bm 7          # (integer) 1
BITCOUNT bm          # (integer) 1
BITFIELD bf SET u8 0 255 GET u8 0   # 1) 0  2) 255
```