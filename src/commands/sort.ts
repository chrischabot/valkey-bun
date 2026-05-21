import type { CommandSpec } from "./index";
import { RESP, type RespValue } from "../resp";
import { bytesToKey, keyToBytes, type Database } from "../store";

const dec = (b: Uint8Array) => new TextDecoder().decode(b);

function db(ctx: any, conn: any): Database { return ctx.store.db(conn.selectedDb); }

// Substitute the first '*' in `pattern` with `ele`; supports `key->field`
// hash lookups. Returns the looked-up bytes or null (missing).
function patternLookup(d: Database, pattern: string, ele: string): Uint8Array | null {
  const arrow = pattern.indexOf("->");
  if (arrow >= 0) {
    const keyPat = pattern.slice(0, arrow).replace("*", ele);
    const fieldPat = pattern.slice(arrow + 2).replace("*", ele);
    const v = d.getRaw(keyPat);
    if (!v || v.type !== "hash") return null;
    return v.value.get(fieldPat) ?? null;
  }
  const v = d.getRaw(pattern.replace("*", ele));
  if (!v || v.type !== "string") return null;
  return v.value;
}

function sortImpl(ctx: any, conn: any, args: Uint8Array[], readonly: boolean): RespValue {
  const d: Database = db(ctx, conn);
  const k = bytesToKey(args[0]!);
  const v = d.getRaw(k);
  // Each element's display string (latin1 bijection, byte-exact, used only
  // for '*' substitution) plus its raw bytes (byte-exact numeric parsing and
  // GET '#'/no-GET output).
  let items: { e: string; eb: Uint8Array }[] = [];
  if (v) {
    if (v.type === "list") items = v.value.map((b) => ({ e: bytesToKey(b), eb: b }));
    else if (v.type === "set") items = Array.from(v.value).map((m) => ({ e: m, eb: keyToBytes(m) }));
    else if (v.type === "zset") items = v.value.sortedEntries().map((x) => ({ e: x.member, eb: keyToBytes(x.member) }));
    else return RESP.err("WRONGTYPE Operation against a key holding the wrong kind of value");
  }
  let byPattern: string | null = null;
  let limitOff = 0, limitCnt = -1;
  const getPatterns: string[] = [];
  let desc = false, alpha = false;
  let storeDest: string | null = null;
  for (let i = 1; i < args.length; i++) {
    const opt = dec(args[i]!).toUpperCase();
    if (opt === "BY") {
      if (i + 1 >= args.length) return RESP.err("ERR syntax error");
      byPattern = dec(args[++i]!);
    } else if (opt === "LIMIT") {
      if (i + 2 >= args.length) return RESP.err("ERR syntax error");
      limitOff = Number(dec(args[++i]!));
      limitCnt = Number(dec(args[++i]!));
      if (!Number.isInteger(limitOff) || !Number.isInteger(limitCnt) || limitOff < 0) {
        return RESP.err("ERR value is not an integer or out of range");
      }
    } else if (opt === "GET") {
      if (i + 1 >= args.length) return RESP.err("ERR syntax error");
      getPatterns.push(dec(args[++i]!));
    } else if (opt === "ASC") desc = false;
    else if (opt === "DESC") desc = true;
    else if (opt === "ALPHA") alpha = true;
    else if (opt === "STORE") {
      if (readonly) return RESP.err("ERR SORT_RO is read-only");
      if (i + 1 >= args.length) return RESP.err("ERR syntax error");
      storeDest = bytesToKey(args[++i]!);
    } else return RESP.err("ERR syntax error");
  }
  // BY with a pattern containing no '*' => no actual sorting (Redis dontsort).
  const noSort = byPattern !== null && !byPattern.includes("*");
  let arr = items.slice();
  if (!noSort) {
    if (alpha) {
      // Alpha: compare the BY value bytes (missing => empty, sorts first,
      // mirroring redis-server's NULL cmpobj), else the element bytes.
      const dz = arr.map((it) => {
        let w: string;
        if (byPattern === null) w = it.e;
        else { const b = patternLookup(d, byPattern, it.e); w = b === null ? "" : bytesToKey(b); }
        return { it, w };
      });
      dz.sort((x, y) => (x.w < y.w ? -1 : x.w > y.w ? 1 : 0));
      arr = dz.map((x) => x.it);
    } else {
      // Numeric: parse the RAW value bytes via the standard TextDecoder
      // convention (dec(), identical to strings.ts incrBy). redis-server
      // zero-initializes each sort-vector score, so a missing BY lookup
      // contributes score 0. Elements are only parsed when there is no BY;
      // a present-but-non-numeric BY value (or non-numeric element when no
      // BY) is the only error case.
      const dz: { it: { e: string; eb: Uint8Array }; s: number }[] = [];
      for (const it of arr) {
        let s: number;
        if (byPattern === null) {
          s = Number(dec(it.eb));
          if (!Number.isFinite(s)) {
            return RESP.err("ERR One or more scores can't be converted into double");
          }
        } else {
          const b = patternLookup(d, byPattern, it.e);
          if (b === null) {
            s = 0;
          } else {
            s = Number(dec(b));
            if (!Number.isFinite(s)) {
              return RESP.err("ERR One or more scores can't be converted into double");
            }
          }
        }
        dz.push({ it, s });
      }
      dz.sort((x, y) => x.s - y.s);
      arr = dz.map((x) => x.it);
    }
    if (desc) arr.reverse();
  }
  if (limitCnt >= 0 || limitOff > 0) {
    arr = arr.slice(limitOff, limitCnt < 0 ? undefined : limitOff + limitCnt);
  }
  // Single source of truth: raw bytes, or null for a missing GET projection.
  // Non-STORE maps null -> RESP nil; STORE maps null -> empty bulk (a Redis
  // list cannot hold nil; redis-server stores shared.emptybulk).
  const projected: (Uint8Array | null)[] = [];
  for (const it of arr) {
    if (getPatterns.length === 0) {
      projected.push(it.eb);
    } else {
      for (const gp of getPatterns) {
        if (gp === "#") projected.push(it.eb);
        else projected.push(patternLookup(d, gp, it.e));
      }
    }
  }
  if (storeDest !== null) {
    // redis-server sortCommand STORE path: builds the result list, then
    //   if (outputlen) { dbReplace(storekey, listobj); ... }
    //   else { if (dbDelete(storekey)) signalModifiedKey(...); }
    // i.e. an empty result DELETES the destination (Redis keeps no empty
    // collections) and returns 0. Database.set with no opts clears any prior
    // expiry, so a non-empty STORE (re)creates the destination fresh with no
    // TTL. Version is bumped only on an actual mutation. Self-store
    // (SORT key STORE key) is safe: the projection was fully materialized
    // from the captured source contents before any write.
    const list = projected.map((b) => b ?? new Uint8Array(0));
    const existed = d.exists(storeDest);
    if (list.length === 0) {
      if (existed) { d.delete(storeDest); ctx.bumpKey(conn.selectedDb, storeDest); }
    } else {
      d.set(storeDest, { type: "list", value: list });
      ctx.bumpKey(conn.selectedDb, storeDest);
    }
    return RESP.int(list.length);
  }
  return RESP.arr(projected.map((b) => (b === null ? RESP.nil() : { type: "bulk", value: b })));
}

export const sortCommands: CommandSpec[] = [
  { name: "SORT", arity: -2, handler: (ctx, conn, args) => sortImpl(ctx, conn, args, false) },
  { name: "SORT_RO", arity: -2, handler: (ctx, conn, args) => sortImpl(ctx, conn, args, true) },
];