import type { CommandSpec } from "./index";
import { RESP, type RespValue } from "../resp";
import { bytesToKey, type Database } from "../store";

const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const enc = (s: string) => new TextEncoder().encode(s);

function db(ctx: any, conn: any): Database { return ctx.store.db(conn.selectedDb); }

// Non-throwing strict integer parse. Returns null on invalid input so handlers
// can emit a proper RESP error rather than throwing.
function parseIntArg(b: Uint8Array): number | null {
  const n = Number(dec(b));
  return Number.isInteger(n) ? n : null;
}

// Parse a positive-integer expire argument at args[idx]; returns the number or
// a RespValue error so SET/GETEX never throw on missing/invalid values.
function expireArg(args: Uint8Array[], idx: number): number | RespValue {
  if (idx >= args.length) return RESP.err("ERR syntax error");
  const n = Number(dec(args[idx]!));
  if (!Number.isInteger(n) || n <= 0) {
    return RESP.err("ERR invalid expire time");
  }
  return n;
}

export const stringCommands: CommandSpec[] = [
  {
    name: "GET",
    arity: 2,
    handler: (ctx, conn, args) => {
      const v = db(ctx, conn).getRaw(bytesToKey(args[0]!));
      if (!v) return RESP.nil();
      if (v.type !== "string") return RESP.err("WRONGTYPE Operation against a key holding the wrong kind of value");
      return { type: "bulk", value: v.value };
    },
  },
  {
    name: "SET",
    arity: -3,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const key = bytesToKey(args[0]!);
      const value = args[1]!;
      let expireAt: number | undefined;
      let keepTtl = false;
      let nx = false, xx = false, returnGet = false;
      for (let i = 2; i < args.length; i++) {
        const opt = dec(args[i]!).toUpperCase();
        switch (opt) {
          case "EX": {
            const r = expireArg(args, ++i);
            if (typeof r !== "number") return r;
            expireAt = Date.now() + r * 1000;
            break;
          }
          case "PX": {
            const r = expireArg(args, ++i);
            if (typeof r !== "number") return r;
            expireAt = Date.now() + r;
            break;
          }
          case "EXAT": {
            const r = expireArg(args, ++i);
            if (typeof r !== "number") return r;
            expireAt = r * 1000;
            break;
          }
          case "PXAT": {
            const r = expireArg(args, ++i);
            if (typeof r !== "number") return r;
            expireAt = r;
            break;
          }
          case "KEEPTTL": keepTtl = true; break;
          case "NX": nx = true; break;
          case "XX": xx = true; break;
          case "GET": returnGet = true; break;
          default: return RESP.err(`ERR syntax error`);
        }
      }
      const existing = d.getRaw(key);
      if (existing && existing.type !== "string" && returnGet) {
        return RESP.err("WRONGTYPE Operation against a key holding the wrong kind of value");
      }
      const exists = existing !== undefined;
      if (nx && exists) return returnGet ? { type: "bulk" as const, value: existing!.type === "string" ? existing!.value : null } : RESP.nil();
      if (xx && !exists) return RESP.nil();
      const prev = exists && existing!.type === "string" ? existing!.value : null;
      d.set(key, { type: "string", value: new Uint8Array(value) }, { keepTtl, expireAt });
      ctx.bumpKey(conn.selectedDb, key);
      if (returnGet) return prev ? { type: "bulk" as const, value: prev } : RESP.nil();
      return RESP.ok();
    },
  },
  {
    name: "GETSET",
    arity: 3,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const key = bytesToKey(args[0]!);
      const old = d.getRaw(key);
      if (old && old.type !== "string") return RESP.err("WRONGTYPE Operation against a key holding the wrong kind of value");
      d.set(key, { type: "string", value: new Uint8Array(args[1]!) });
      ctx.bumpKey(conn.selectedDb, key);
      return old ? { type: "bulk" as const, value: old.value as Uint8Array } : RESP.nil();
    },
  },
  {
    name: "GETDEL",
    arity: 2,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const key = bytesToKey(args[0]!);
      const v = d.getRaw(key);
      if (!v) return RESP.nil();
      if (v.type !== "string") return RESP.err("WRONGTYPE Operation against a key holding the wrong kind of value");
      d.delete(key);
      ctx.bumpKey(conn.selectedDb, key);
      return { type: "bulk", value: v.value };
    },
  },
  {
    name: "GETEX",
    arity: -2,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const key = bytesToKey(args[0]!);
      const v = d.getRaw(key);
      if (!v) return RESP.nil();
      if (v.type !== "string") return RESP.err("WRONGTYPE Operation against a key holding the wrong kind of value");
      let expireAt: number | undefined;
      let persist = false;
      for (let i = 1; i < args.length; i++) {
        const opt = dec(args[i]!).toUpperCase();
        switch (opt) {
          case "EX": {
            const r = expireArg(args, ++i);
            if (typeof r !== "number") return r;
            expireAt = Date.now() + r * 1000;
            break;
          }
          case "PX": {
            const r = expireArg(args, ++i);
            if (typeof r !== "number") return r;
            expireAt = Date.now() + r;
            break;
          }
          case "EXAT": {
            const r = expireArg(args, ++i);
            if (typeof r !== "number") return r;
            expireAt = r * 1000;
            break;
          }
          case "PXAT": {
            const r = expireArg(args, ++i);
            if (typeof r !== "number") return r;
            expireAt = r;
            break;
          }
          case "PERSIST": persist = true; break;
          default: return RESP.err("ERR syntax error");
        }
      }
      if (persist) d.removeExpiry(key);
      else if (expireAt !== undefined) d.setExpiry(key, expireAt);
      return { type: "bulk", value: v.value };
    },
  },
  {
    name: "MGET",
    arity: -2,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const out: RespValue[] = [];
      for (const a of args) {
        const v = d.getRaw(bytesToKey(a));
        if (v && v.type === "string") out.push({ type: "bulk", value: v.value });
        else out.push(RESP.nil());
      }
      return RESP.arr(out);
    },
  },
  {
    name: "MSET",
    arity: -3,
    handler: (ctx, conn, args) => {
      if (args.length % 2 !== 0) return RESP.err("ERR wrong number of arguments for MSET");
      const d = db(ctx, conn);
      for (let i = 0; i < args.length; i += 2) {
        const k = bytesToKey(args[i]!);
        d.set(k, { type: "string", value: new Uint8Array(args[i + 1]!) });
        ctx.bumpKey(conn.selectedDb, k);
      }
      return RESP.ok();
    },
  },
  {
    name: "MSETNX",
    arity: -3,
    handler: (ctx, conn, args) => {
      if (args.length % 2 !== 0) return RESP.err("ERR wrong number of arguments for MSETNX");
      const d = db(ctx, conn);
      for (let i = 0; i < args.length; i += 2) if (d.exists(bytesToKey(args[i]!))) return RESP.int(0);
      for (let i = 0; i < args.length; i += 2) {
        const k = bytesToKey(args[i]!);
        d.set(k, { type: "string", value: new Uint8Array(args[i + 1]!) });
        ctx.bumpKey(conn.selectedDb, k);
      }
      return RESP.int(1);
    },
  },
  {
    name: "APPEND",
    arity: 3,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const k = bytesToKey(args[0]!);
      const v = d.getRaw(k);
      if (v && v.type !== "string") return RESP.err("WRONGTYPE Operation against a key holding the wrong kind of value");
      const cur = v?.value ?? new Uint8Array(0);
      const add = args[1]!;
      const merged = new Uint8Array(cur.length + add.length);
      merged.set(cur, 0);
      merged.set(add, cur.length);
      d.set(k, { type: "string", value: merged }, { keepTtl: true });
      ctx.bumpKey(conn.selectedDb, k);
      return RESP.int(merged.length);
    },
  },
  {
    name: "STRLEN",
    arity: 2,
    handler: (ctx, conn, args) => {
      const v = db(ctx, conn).getRaw(bytesToKey(args[0]!));
      if (!v) return RESP.int(0);
      if (v.type !== "string") return RESP.err("WRONGTYPE Operation against a key holding the wrong kind of value");
      return RESP.int(v.value.length);
    },
  },
  { name: "INCR", arity: 2, handler: (ctx, conn, args) => incrBy(ctx, conn, args[0]!, 1) },
  { name: "DECR", arity: 2, handler: (ctx, conn, args) => incrBy(ctx, conn, args[0]!, -1) },
  {
    name: "INCRBY",
    arity: 3,
    handler: (ctx, conn, args) => {
      const delta = parseIntArg(args[1]!);
      if (delta === null) return RESP.err("ERR value is not an integer or out of range");
      return incrBy(ctx, conn, args[0]!, delta);
    },
  },
  {
    name: "DECRBY",
    arity: 3,
    handler: (ctx, conn, args) => {
      const delta = parseIntArg(args[1]!);
      if (delta === null) return RESP.err("ERR value is not an integer or out of range");
      return incrBy(ctx, conn, args[0]!, -delta);
    },
  },
  {
    name: "INCRBYFLOAT",
    arity: 3,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const k = bytesToKey(args[0]!);
      const v = d.getRaw(k);
      if (v && v.type !== "string") return RESP.err("WRONGTYPE Operation against a key holding the wrong kind of value");
      const cur = v ? Number(dec(v.value)) : 0;
      if (!Number.isFinite(cur)) return RESP.err("ERR value is not a valid float");
      const delta = Number(dec(args[1]!));
      if (!Number.isFinite(delta)) return RESP.err("ERR value is not a valid float");
      const next = cur + delta;
      const s = Number.isInteger(next) ? String(next) : next.toString();
      d.set(k, { type: "string", value: enc(s) }, { keepTtl: true });
      ctx.bumpKey(conn.selectedDb, k);
      return { type: "bulk", value: enc(s) };
    },
  },
  {
    name: "SETNX",
    arity: 3,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const k = bytesToKey(args[0]!);
      if (d.exists(k)) return RESP.int(0);
      d.set(k, { type: "string", value: new Uint8Array(args[1]!) });
      ctx.bumpKey(conn.selectedDb, k);
      return RESP.int(1);
    },
  },
  {
    name: "SETEX",
    arity: 4,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const k = bytesToKey(args[0]!);
      const sec = Number(dec(args[1]!));
      if (!Number.isInteger(sec) || sec <= 0) return RESP.err("ERR invalid expire time in 'setex' command");
      d.set(k, { type: "string", value: new Uint8Array(args[2]!) }, { expireAt: Date.now() + sec * 1000 });
      ctx.bumpKey(conn.selectedDb, k);
      return RESP.ok();
    },
  },
  {
    name: "PSETEX",
    arity: 4,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const k = bytesToKey(args[0]!);
      const ms = Number(dec(args[1]!));
      if (!Number.isInteger(ms) || ms <= 0) return RESP.err("ERR invalid expire time in 'psetex' command");
      d.set(k, { type: "string", value: new Uint8Array(args[2]!) }, { expireAt: Date.now() + ms });
      ctx.bumpKey(conn.selectedDb, k);
      return RESP.ok();
    },
  },
  {
    name: "SETRANGE",
    arity: 4,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const k = bytesToKey(args[0]!);
      const offset = Number(dec(args[1]!));
      if (!Number.isInteger(offset) || offset < 0) {
        return RESP.err("ERR offset is out of range");
      }
      const v = d.getRaw(k);
      if (v && v.type !== "string") return RESP.err("WRONGTYPE Operation against a key holding the wrong kind of value");
      const cur = v?.value ?? new Uint8Array(0);
      const data = args[2]!;
      const newLen = Math.max(cur.length, offset + data.length);
      const out = new Uint8Array(newLen);
      out.set(cur, 0);
      out.set(data, offset);
      d.set(k, { type: "string", value: out }, { keepTtl: true });
      ctx.bumpKey(conn.selectedDb, k);
      return RESP.int(out.length);
    },
  },
  { name: "GETRANGE", arity: 4, handler: (ctx, conn, args) => getRange(ctx, conn, args) },
  { name: "SUBSTR", arity: 4, handler: (ctx, conn, args) => getRange(ctx, conn, args) },
];

function getRange(ctx: any, conn: any, args: Uint8Array[]): RespValue {
  const v = db(ctx, conn).getRaw(bytesToKey(args[0]!));
  if (!v) return { type: "bulk", value: new Uint8Array(0) };
  if (v.type !== "string") return RESP.err("WRONGTYPE Operation against a key holding the wrong kind of value");
  const len = v.value.length;
  let start = Number(dec(args[1]!));
  let end = Number(dec(args[2]!));
  if (start < 0) start = Math.max(0, len + start);
  if (end < 0) end = len + end;
  if (start >= len || start > end) return { type: "bulk", value: new Uint8Array(0) };
  end = Math.min(end, len - 1);
  return { type: "bulk", value: v.value.subarray(start, end + 1) };
}

function incrBy(ctx: any, conn: any, key: Uint8Array, delta: number): RespValue {
  const d = db(ctx, conn);
  const k = bytesToKey(key);
  const v = d.getRaw(k);
  if (v && v.type !== "string") return RESP.err("WRONGTYPE Operation against a key holding the wrong kind of value");
  const cur = v ? Number(dec(v.value)) : 0;
  if (!Number.isInteger(cur)) return RESP.err("ERR value is not an integer or out of range");
  const next = cur + delta;
  d.set(k, { type: "string", value: enc(String(next)) }, { keepTtl: true });
  ctx.bumpKey(conn.selectedDb, k);
  return RESP.int(next);
}