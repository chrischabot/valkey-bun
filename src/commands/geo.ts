import type { CommandSpec } from "./index";
import { RESP, type RespValue } from "../resp";
import { bytesToKey, keyToBytes, ZSet, type Database } from "../store";

const dec = (b: Uint8Array) => new TextDecoder().decode(b);
function db(ctx: any, conn: any): Database { return ctx.store.db(conn.selectedDb); }

const LON_MIN = -180, LON_MAX = 180;
const LAT_MIN = -85.05112878, LAT_MAX = 85.05112878;
const STEP = 26;
const EARTH_R = 6372797.560856;
const DEG2RAD = Math.PI / 180;

function interleave(xlo: number, ylo: number): bigint {
  let x = BigInt(xlo);
  let y = BigInt(ylo);
  const B = [0x5555555555555555n, 0x3333333333333333n, 0x0f0f0f0f0f0f0f0fn,
    0x00ff00ff00ff00ffn, 0x0000ffff0000ffffn];
  const S = [1n, 2n, 4n, 8n, 16n];
  for (let i = 4; i >= 0; i--) {
    x = (x | (x << S[i]!)) & B[i]!;
    y = (y | (y << S[i]!)) & B[i]!;
  }
  return x | (y << 1n);
}

function deinterleave(bits: bigint): { x: number; y: number } {
  const B = [0x5555555555555555n, 0x3333333333333333n, 0x0f0f0f0f0f0f0f0fn,
    0x00ff00ff00ff00ffn, 0x0000ffff0000ffffn, 0x00000000ffffffffn];
  const S = [0n, 1n, 2n, 4n, 8n, 16n];
  let x = bits & 0x5555555555555555n;
  let y = (bits >> 1n) & 0x5555555555555555n;
  for (let i = 1; i <= 5; i++) { x = (x | (x >> S[i]!)) & B[i]!; }
  for (let i = 1; i <= 5; i++) { y = (y | (y >> S[i]!)) & B[i]!; }
  return { x: Number(x & 0xffffffffn), y: Number(y & 0xffffffffn) };
}

// Score layout matches Redis: interleave64(ilat, ilon) places the latitude
// index in the even/low bit lane and the longitude index in the odd/high
// lane; decode() reverses exactly this, so encode/decode are exact inverses.
function encode(lon: number, lat: number): number {
  const latOff = (lat - LAT_MIN) / (LAT_MAX - LAT_MIN);
  const lonOff = (lon - LON_MIN) / (LON_MAX - LON_MIN);
  const cap = (1 << STEP) - 1;
  const ilat = Math.min(cap, Math.max(0, Math.floor(latOff * (1 << STEP))));
  const ilon = Math.min(cap, Math.max(0, Math.floor(lonOff * (1 << STEP))));
  return Number(interleave(ilat, ilon));
}

function decode(score: number): { lon: number; lat: number } {
  const { x: ilat, y: ilon } = deinterleave(BigInt(Math.trunc(score)));
  const latMinR = LAT_MIN + (ilat / (1 << STEP)) * (LAT_MAX - LAT_MIN);
  const latMaxR = LAT_MIN + ((ilat + 1) / (1 << STEP)) * (LAT_MAX - LAT_MIN);
  const lonMinR = LON_MIN + (ilon / (1 << STEP)) * (LON_MAX - LON_MIN);
  const lonMaxR = LON_MIN + ((ilon + 1) / (1 << STEP)) * (LON_MAX - LON_MIN);
  return { lon: (lonMinR + lonMaxR) / 2, lat: (latMinR + latMaxR) / 2 };
}

function haversine(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const la1 = lat1 * DEG2RAD, la2 = lat2 * DEG2RAD;
  const u = Math.sin((la2 - la1) / 2);
  const v = Math.sin(((lon2 - lon1) * DEG2RAD) / 2);
  const a = u * u + Math.cos(la1) * Math.cos(la2) * v * v;
  return 2.0 * EARTH_R * Math.asin(Math.sqrt(a));
}

function unitToMeters(u: string): number | null {
  switch (u.toLowerCase()) {
    case "m": return 1;
    case "km": return 1000;
    case "mi": return 1609.34;
    case "ft": return 0.3048;
    default: return null;
  }
}

const GEO_ALPHABET = "0123456789bcdefghjkmnpqrstuvwxyz";
function standardGeohash(lon: number, lat: number): string {
  const latR = [-90, 90], lonR = [-180, 180];
  let hash = "";
  let bits = 0, bit = 0, even = true;
  while (hash.length < 11) {
    if (even) {
      const mid = (lonR[0]! + lonR[1]!) / 2;
      if (lon >= mid) { bits = (bits << 1) | 1; lonR[0] = mid; }
      else { bits = bits << 1; lonR[1] = mid; }
    } else {
      const mid = (latR[0]! + latR[1]!) / 2;
      if (lat >= mid) { bits = (bits << 1) | 1; latR[0] = mid; }
      else { bits = bits << 1; latR[1] = mid; }
    }
    even = !even;
    if (++bit === 5) { hash += GEO_ALPHABET[bits]!; bits = 0; bit = 0; }
  }
  return hash;
}

function getZ(d: Database, key: string): ZSet | null {
  const v = d.getRaw(key);
  if (!v) return null;
  if (v.type !== "zset") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
  return v.value;
}

interface Hit { member: string; dist: number; lon: number; lat: number; score: number; }

function search(z: ZSet, cx: number, cy: number, byBox: boolean, r1: number, r2: number): Hit[] {
  const hits: Hit[] = [];
  for (const [member, score] of z.byMember) {
    const { lon, lat } = decode(score);
    const dist = haversine(cx, cy, lon, lat);
    if (byBox) {
      const dLon = haversine(cx, cy, lon, cy);
      const dLat = haversine(cx, cy, cx, lat);
      if (dLon <= r1 / 2 && dLat <= r2 / 2) hits.push({ member, dist, lon, lat, score });
    } else if (dist <= r1) {
      hits.push({ member, dist, lon, lat, score });
    }
  }
  return hits;
}

function emit(
  hits: Hit[], withCoord: boolean, withDist: boolean, withHash: boolean, unitM: number,
): RespValue {
  if (!withCoord && !withDist && !withHash) {
    return RESP.arr(hits.map((h) => ({ type: "bulk" as const, value: keyToBytes(h.member) })));
  }
  return RESP.arr(hits.map((h) => {
    const row: RespValue[] = [{ type: "bulk", value: keyToBytes(h.member) }];
    if (withDist) row.push(RESP.str((h.dist / unitM).toFixed(4)));
    if (withHash) row.push(RESP.int(h.score));
    if (withCoord) row.push(RESP.arr([RESP.str(h.lon.toFixed(17)), RESP.str(h.lat.toFixed(17))]));
    return RESP.arr(row);
  }));
}

export const geoCommands: CommandSpec[] = [
  {
    name: "GEOADD",
    arity: -5,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const k = bytesToKey(args[0]!);
      let i = 1;
      let nx = false, xx = false, ch = false;
      while (i < args.length) {
        const a = dec(args[i]!).toUpperCase();
        if (a === "NX") { nx = true; i++; }
        else if (a === "XX") { xx = true; i++; }
        else if (a === "CH") { ch = true; i++; }
        else break;
      }
      if (nx && xx) {
        return RESP.err("ERR XX and NX options at the same time are not compatible");
      }
      const remaining = args.length - i;
      if (remaining < 3 || remaining % 3 !== 0) {
        return RESP.err("ERR syntax error");
      }
      const v = d.getRaw(k);
      if (v && v.type !== "zset") return RESP.err("WRONGTYPE Operation against a key holding the wrong kind of value");
      const z = v ? v.value as ZSet : new ZSet();
      let added = 0, changed = 0;
      for (; i + 2 < args.length; i += 3) {
        const lon = Number(dec(args[i]!));
        const lat = Number(dec(args[i + 1]!));
        if (lon < LON_MIN || lon > LON_MAX || lat < LAT_MIN || lat > LAT_MAX) {
          return RESP.err(`ERR invalid longitude,latitude pair ${lon},${lat}`);
        }
        const member = bytesToKey(args[i + 2]!);
        const had = z.byMember.has(member);
        if (nx && had) continue;
        if (xx && !had) continue;
        const sc = encode(lon, lat);
        const prev = z.byMember.get(member);
        if (!had) added++;
        else if (prev !== sc) changed++;
        z.setScore(member, sc);
      }
      if (z.size() > 0) d.set(k, { type: "zset", value: z }, { keepTtl: true });
      ctx.bumpKey(conn.selectedDb, k);
      return RESP.int(ch ? added + changed : added);
    },
  },
  {
    name: "GEOPOS",
    arity: -2,
    handler: (ctx, conn, args) => {
      const z = getZ(db(ctx, conn), bytesToKey(args[0]!));
      const out: RespValue[] = [];
      for (let i = 1; i < args.length; i++) {
        const s = z?.byMember.get(bytesToKey(args[i]!));
        if (s === undefined) out.push(RESP.arr(null));
        else {
          const { lon, lat } = decode(s);
          out.push(RESP.arr([RESP.str(lon.toFixed(17)), RESP.str(lat.toFixed(17))]));
        }
      }
      return RESP.arr(out);
    },
  },
  {
    name: "GEODIST",
    arity: -4,
    handler: (ctx, conn, args) => {
      const z = getZ(db(ctx, conn), bytesToKey(args[0]!));
      if (!z) return RESP.nil();
      const s1 = z.byMember.get(bytesToKey(args[1]!));
      const s2 = z.byMember.get(bytesToKey(args[2]!));
      if (s1 === undefined || s2 === undefined) return RESP.nil();
      const unitM = args.length > 3 ? unitToMeters(dec(args[3]!)) : 1;
      if (unitM === null) return RESP.err("ERR unsupported unit provided. please use M, KM, FT, MI");
      const a = decode(s1), b = decode(s2);
      return RESP.str((haversine(a.lon, a.lat, b.lon, b.lat) / unitM).toFixed(4));
    },
  },
  {
    name: "GEOHASH",
    arity: -2,
    handler: (ctx, conn, args) => {
      const z = getZ(db(ctx, conn), bytesToKey(args[0]!));
      const out: RespValue[] = [];
      for (let i = 1; i < args.length; i++) {
        const s = z?.byMember.get(bytesToKey(args[i]!));
        if (s === undefined) out.push(RESP.nil());
        else { const { lon, lat } = decode(s); out.push(RESP.str(standardGeohash(lon, lat))); }
      }
      return RESP.arr(out);
    },
  },
  { name: "GEOSEARCH", arity: -7, handler: (ctx, conn, args) => geosearch(ctx, conn, args, false) },
  { name: "GEOSEARCHSTORE", arity: -8, handler: (ctx, conn, args) => geosearch(ctx, conn, args, true) },
  {
    name: "GEORADIUS",
    arity: -6,
    handler: (ctx, conn, args) => {
      const rebuilt = [args[0]!, keyToBytes("FROMLONLAT"), args[1]!, args[2]!,
        keyToBytes("BYRADIUS"), args[3]!, args[4]!, ...args.slice(5)];
      return geosearch(ctx, conn, rebuilt, false);
    },
  },
  {
    name: "GEORADIUSBYMEMBER",
    arity: -5,
    handler: (ctx, conn, args) => {
      const rebuilt = [args[0]!, keyToBytes("FROMMEMBER"), args[1]!,
        keyToBytes("BYRADIUS"), args[2]!, args[3]!, ...args.slice(4)];
      return geosearch(ctx, conn, rebuilt, false);
    },
  },
];

function geosearch(ctx: any, conn: any, args: Uint8Array[], store: boolean): RespValue {
  const d = db(ctx, conn);
  let idx = 0;
  const dest = store ? bytesToKey(args[idx++]!) : "";
  const srcKey = bytesToKey(args[idx++]!);
  const z = getZ(d, srcKey);
  let cx = 0, cy = 0;
  let byBox = false, r1 = 0, r2 = 0, unitM = 1;
  let withCoord = false, withDist = false, withHash = false;
  let count = -1, asc = false, desc = false, storeDist = false;
  while (idx < args.length) {
    const opt = dec(args[idx++]!).toUpperCase();
    if (opt === "FROMMEMBER") {
      const m = bytesToKey(args[idx++]!);
      const s = z?.byMember.get(m);
      if (s === undefined) return RESP.err("ERR could not decode requested zset member");
      const p = decode(s); cx = p.lon; cy = p.lat;
    } else if (opt === "FROMLONLAT") {
      cx = Number(dec(args[idx++]!)); cy = Number(dec(args[idx++]!));
    } else if (opt === "BYRADIUS") {
      r1 = Number(dec(args[idx++]!));
      const um = unitToMeters(dec(args[idx++]!));
      if (um === null) return RESP.err("ERR unsupported unit provided. please use M, KM, FT, MI");
      unitM = um; r1 *= um;
    } else if (opt === "BYBOX") {
      byBox = true;
      r1 = Number(dec(args[idx++]!));
      r2 = Number(dec(args[idx++]!));
      const um = unitToMeters(dec(args[idx++]!));
      if (um === null) return RESP.err("ERR unsupported unit provided. please use M, KM, FT, MI");
      unitM = um; r1 *= um; r2 *= um;
    } else if (opt === "ASC") asc = true;
    else if (opt === "DESC") desc = true;
    else if (opt === "COUNT") count = Number(dec(args[idx++]!));
    else if (opt === "WITHCOORD") withCoord = true;
    else if (opt === "WITHDIST") withDist = true;
    else if (opt === "WITHHASH") withHash = true;
    else if (opt === "STOREDIST") storeDist = true;
  }
  if (!z) {
    if (store) { d.delete(dest); ctx.bumpKey(conn.selectedDb, dest); return RESP.int(0); }
    return RESP.arr([]);
  }
  let hits = search(z, cx, cy, byBox, r1, r2);
  if (asc || desc || count >= 0) hits.sort((a, b) => desc ? b.dist - a.dist : a.dist - b.dist);
  if (count >= 0) hits = hits.slice(0, count);
  if (store) {
    if (hits.length === 0) { d.delete(dest); ctx.bumpKey(conn.selectedDb, dest); return RESP.int(0); }
    const out = new ZSet();
    for (const h of hits) out.setScore(h.member, storeDist ? h.dist / unitM : h.score);
    d.set(dest, { type: "zset", value: out });
    ctx.bumpKey(conn.selectedDb, dest);
    return RESP.int(hits.length);
  }
  return emit(hits, withCoord, withDist, withHash, unitM);
}