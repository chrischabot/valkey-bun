# Geo Commands

Geospatial indexing implemented exactly as redis-server does: members are
stored in a **sorted set** keyed by a 52-bit interleaved geohash score, so
all `Z*` commands also work on a geo key. A wrong-type access returns
`WRONGTYPE`.

---

## GEOADD

`GEOADD key [NX|XX] [CH] longitude latitude member [longitude latitude member ...]`
· Arity ≥ 5

Add/update positions. `NX`/`XX` restrict to new/existing members
(incompatible together); `CH` returns changed instead of only added.
Longitude must be in `[-180,180]`, latitude in `[-85.05112878,85.05112878]`.
**Reply:** integer added (or added+changed with `CH`).

## GEOPOS

`GEOPOS key [member ...]` · Arity ≥ 2 → array of `[lon,lat]` pairs (nil per
missing member).

## GEODIST

`GEODIST key member1 member2 [m|km|mi|ft]` · Arity ≥ 4 → distance (bulk
string) in the requested unit (default metres), nil if a member is missing.

## GEOHASH

`GEOHASH key [member ...]` · Arity ≥ 2 → standard 11-char base-32 geohash
per member (nil if missing).

## GEOSEARCH / GEOSEARCHSTORE

`GEOSEARCH key FROMMEMBER m|FROMLONLAT lon lat BYRADIUS r unit|BYBOX w h unit [ASC|DESC] [COUNT n] [WITHCOORD] [WITHDIST] [WITHHASH]`
· Arity ≥ 7
`GEOSEARCHSTORE dest src ... [STOREDIST]` · Arity ≥ 8

Search a radius or box from a member or a point. `GEOSEARCHSTORE` writes the
matches into `dest` as a sorted set (score = geohash, or distance with
`STOREDIST`). The legacy `GEORADIUS`/`GEORADIUSBYMEMBER` are accepted and
mapped onto `GEOSEARCH`.

```bash
GEOADD sicily 13.361389 38.115556 "Palermo" 15.087269 37.502669 "Catania"
GEODIST sicily Palermo Catania km          # "166.2742"
GEOSEARCH sicily FROMLONLAT 15 37 BYRADIUS 200 km ASC   # 1) "Catania" 2) "Palermo"
```