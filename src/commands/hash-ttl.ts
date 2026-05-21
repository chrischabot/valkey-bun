import type { CommandSpec } from "./index";
import { RESP, type RespValue } from "../resp";
import { bytesToKey, type Database } from "../store";

const dec = (b: Uint8Array) => new TextDecoder().decode(b);

function db(ctx: any, conn: any): Database { return ctx.store.db(conn.selectedDb); }

function getHashMap(d: Database, key: string): Map<string, Uint8Array> | null {
  const v = d.getRaw(key);
  if (!v) return null;
  if (v.type !== "hash") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
  return v.value;
}

// Parse a trailing `FIELDS numfields field [field ...]` clause starting at
// args[start]. Returns the field byte arrays or a RESP error.
function parseFields(args: Uint8Array[], start: number): Uint8Array[] | RespValue {
  if (start >= args.length || dec(args[start]!).toUpperCase() !== "FIELDS") {
    return RESP.err("ERR Mandatory keyword FIELDS is missing or not at the right position");
  }
  if (start + 1 >= args.length) return RESP.err("ERR wrong number of arguments");
  const numFields = Number(dec(args[start + 1]!));
  if (!Number.isInteger(numFields) || numFields <= 0) {
    return RESP.err("ERR Parameter `numFields` should be greater than 0");
  }
  const fields = args.slice(start + 2);
  if (fields.length !== numFields) {
    return RESP.err("ERR The `numfields` parameter must match the number of arguments");
  }
  return fields;
}

function fieldTtlMap(d: Database, key: string): Map<string, number> {
  let m = d.hashTtls.get(key);
  if (!m) { m = new Map(); d.hashTtls.set(key, m); }
  return m;
}

type ExpireKind = "EX" | "PX" | "EXAT" | "PXAT";
function toAbsMs(kind: ExpireKind, raw: number, now: number): number {
  switch (kind) {
    case "EX": return now + raw * 1000;
    case "PX": return now + raw;
    case "EXAT": return raw * 1000;
    case "PXAT": return raw;
  }
}

function hexpireImpl(
  ctx: any, conn: any, args: Uint8Array[], kind: ExpireKind,
): RespValue {
  const key = bytesToKey(args[0]!);
  const ttlRaw = Number(dec(args[1]!));
  if (!Number.isInteger(ttlRaw)) {
    return RESP.err("ERR value is not an integer or out of range");
  }
  let idx = 2;
  let nx = false, xx = false, gt = false, lt = false;
  const maybeFlag = idx < args.length ? dec(args[idx]!).toUpperCase() : "";
  if (maybeFlag === "NX") { nx = true; idx++; }
  else if (maybeFlag === "XX") { xx = true; idx++; }
  else if (maybeFlag === "GT") { gt = true; idx++; }
  else if (maybeFlag === "LT") { lt = true; idx++; }
  const fields = parseFields(args, idx);
  if (!Array.isArray(fields)) return fields;
  const d = db(ctx, conn);
  const hash = getHashMap(d, key);
  if (!hash) return RESP.arr(fields.map(() => RESP.int(-2)));
  const now = Date.now();
  const absMs = toAbsMs(kind, ttlRaw, now);
  const ttls = fieldTtlMap(d, key);
  const out: RespValue[] = [];
  let mutated = false;
  for (const fb of fields) {
    const f = bytesToKey(fb);
    if (!hash.has(f)) { out.push(RESP.int(-2)); continue; }
    const cur = ttls.get(f); // undefined => field has no TTL (== +infinity)
    if (nx && cur !== undefined) { out.push(RESP.int(0)); continue; }
    if (xx && cur === undefined) { out.push(RESP.int(0)); continue; }
    // GT: new must be > current. A no-TTL field is +infinity, and a finite
    // new value is NOT greater than infinity, so GT never sets it.
    if (gt && (cur === undefined || absMs <= cur)) { out.push(RESP.int(0)); continue; }
    // LT: new must be < current. A no-TTL field is +infinity, and a finite
    // new value IS less than infinity, so LT ALWAYS sets a no-TTL field;
    // only reject when a finite TTL exists and new >= it. (Identical to the
    // committed/approved key-level expireWithFlags() in keys.ts.)
    if (lt && cur !== undefined && absMs >= cur) { out.push(RESP.int(0)); continue; }
    if (absMs <= now) {
      // Past expiry => the field is deleted immediately (reply code 2).
      hash.delete(f);
      ttls.delete(f);
      mutated = true;
      out.push(RESP.int(2));
    } else {
      ttls.set(f, absMs);
      mutated = true;
      out.push(RESP.int(1));
    }
  }
  if (ttls.size === 0) d.hashTtls.delete(key);
  if (hash.size === 0) d.delete(key);
  if (mutated) ctx.bumpKey(conn.selectedDb, key);
  return RESP.arr(out);
}

function httlImpl(
  ctx: any, conn: any, args: Uint8Array[], mode: "TTL" | "PTTL" | "EXPIRETIME" | "PEXPIRETIME",
): RespValue {
  const key = bytesToKey(args[0]!);
  const fields = parseFields(args, 1);
  if (!Array.isArray(fields)) return fields;
  const d = db(ctx, conn);
  const hash = getHashMap(d, key);
  if (!hash) return RESP.arr(fields.map(() => RESP.int(-2)));
  const ttls = d.hashTtls.get(key);
  const now = Date.now();
  return RESP.arr(fields.map((fb) => {
    const f = bytesToKey(fb);
    if (!hash.has(f)) return RESP.int(-2);
    const exp = ttls?.get(f);
    if (exp === undefined) return RESP.int(-1);
    if (mode === "TTL") return RESP.int(Math.max(0, Math.ceil((exp - now) / 1000)));
    if (mode === "PTTL") return RESP.int(Math.max(0, exp - now));
    if (mode === "EXPIRETIME") return RESP.int(Math.floor(exp / 1000));
    return RESP.int(exp);
  }));
}

export const hashTtlCommands: CommandSpec[] = [
  { name: "HEXPIRE", arity: -6, handler: (ctx, conn, args) => hexpireImpl(ctx, conn, args, "EX") },
  { name: "HPEXPIRE", arity: -6, handler: (ctx, conn, args) => hexpireImpl(ctx, conn, args, "PX") },
  { name: "HEXPIREAT", arity: -6, handler: (ctx, conn, args) => hexpireImpl(ctx, conn, args, "EXAT") },
  { name: "HPEXPIREAT", arity: -6, handler: (ctx, conn, args) => hexpireImpl(ctx, conn, args, "PXAT") },
  { name: "HTTL", arity: -5, handler: (ctx, conn, args) => httlImpl(ctx, conn, args, "TTL") },
  { name: "HPTTL", arity: -5, handler: (ctx, conn, args) => httlImpl(ctx, conn, args, "PTTL") },
  { name: "HEXPIRETIME", arity: -5, handler: (ctx, conn, args) => httlImpl(ctx, conn, args, "EXPIRETIME") },
  { name: "HPEXPIRETIME", arity: -5, handler: (ctx, conn, args) => httlImpl(ctx, conn, args, "PEXPIRETIME") },
  {
    name: "HPERSIST",
    arity: -5,
    handler: (ctx, conn, args) => {
      const key = bytesToKey(args[0]!);
      const fields = parseFields(args, 1);
      if (!Array.isArray(fields)) return fields;
      const d = db(ctx, conn);
      const hash = getHashMap(d, key);
      if (!hash) return RESP.arr(fields.map(() => RESP.int(-2)));
      const ttls = d.hashTtls.get(key);
      let mutated = false;
      const out = fields.map((fb) => {
        const f = bytesToKey(fb);
        if (!hash.has(f)) return RESP.int(-2);
        if (!ttls || !ttls.has(f)) return RESP.int(-1);
        ttls.delete(f);
        mutated = true;
        return RESP.int(1);
      });
      if (ttls && ttls.size === 0) d.hashTtls.delete(key);
      if (mutated) ctx.bumpKey(conn.selectedDb, key);
      return RESP.arr(out);
    },
  },
  {
    name: "HGETEX",
    arity: -5,
    handler: (ctx, conn, args) => {
      const key = bytesToKey(args[0]!);
      let idx = 1;
      let kind: ExpireKind | null = null;
      let persist = false;
      let ttlRaw = 0;
      const opt = dec(args[idx]!).toUpperCase();
      if (opt === "EX" || opt === "PX" || opt === "EXAT" || opt === "PXAT") {
        if (idx + 1 >= args.length) return RESP.err("ERR syntax error");
        ttlRaw = Number(dec(args[idx + 1]!));
        if (!Number.isInteger(ttlRaw)) return RESP.err("ERR value is not an integer or out of range");
        kind = opt as ExpireKind;
        idx += 2;
      } else if (opt === "PERSIST") {
        persist = true;
        idx += 1;
      }
      const fields = parseFields(args, idx);
      if (!Array.isArray(fields)) return fields;
      const d = db(ctx, conn);
      const hash = getHashMap(d, key);
      if (!hash) return RESP.arr(fields.map(() => RESP.nil()));
      const now = Date.now();
      const ttls = fieldTtlMap(d, key);
      let mutated = false;
      const out = fields.map((fb) => {
        const f = bytesToKey(fb);
        const v = hash.get(f);
        if (v === undefined) return RESP.nil();
        if (persist) { if (ttls.delete(f)) mutated = true; }
        else if (kind !== null) {
          const absMs = toAbsMs(kind, ttlRaw, now);
          if (absMs <= now) { hash.delete(f); ttls.delete(f); mutated = true; }
          else { ttls.set(f, absMs); mutated = true; }
        }
        return { type: "bulk" as const, value: v };
      });
      if (ttls.size === 0) d.hashTtls.delete(key);
      if (hash.size === 0) d.delete(key);
      if (mutated) ctx.bumpKey(conn.selectedDb, key);
      return RESP.arr(out);
    },
  },
  {
    name: "HGETDEL",
    arity: -5,
    handler: (ctx, conn, args) => {
      const key = bytesToKey(args[0]!);
      const fields = parseFields(args, 1);
      if (!Array.isArray(fields)) return fields;
      const d = db(ctx, conn);
      const hash = getHashMap(d, key);
      if (!hash) return RESP.arr(fields.map(() => RESP.nil()));
      const ttls = d.hashTtls.get(key);
      let mutated = false;
      const out = fields.map((fb) => {
        const f = bytesToKey(fb);
        const v = hash.get(f);
        if (v === undefined) return RESP.nil();
        hash.delete(f);
        if (ttls) ttls.delete(f);
        mutated = true;
        return { type: "bulk" as const, value: v };
      });
      if (ttls && ttls.size === 0) d.hashTtls.delete(key);
      if (hash.size === 0) d.delete(key);
      if (mutated) ctx.bumpKey(conn.selectedDb, key);
      return RESP.arr(out);
    },
  },
];