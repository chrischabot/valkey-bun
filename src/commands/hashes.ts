// Arity/args convention: handler `args` EXCLUDES the command name. For
// `HSETNX key field value` the args array is [key, field, value], so the
// value payload is args[2] (NOT args[3]).

import type { CommandSpec } from "./index";
import { RESP, type RespValue } from "../resp";
import { bytesToKey, keyToBytes, type Database } from "../store";
import { matchPattern } from "../pubsub";

const dec = (b: Uint8Array) => new TextDecoder().decode(b);

function db(ctx: any, conn: any): Database { return ctx.store.db(conn.selectedDb); }

function getOrCreateHash(d: Database, key: string): Map<string, Uint8Array> {
  const v = d.getRaw(key);
  if (v) {
    if (v.type !== "hash") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
    return v.value;
  }
  const m = new Map<string, Uint8Array>();
  d.set(key, { type: "hash", value: m });
  return m;
}

function getHash(d: Database, key: string): Map<string, Uint8Array> | null {
  const v = d.getRaw(key);
  if (!v) return null;
  if (v.type !== "hash") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
  return v.value;
}

export const hashCommands: CommandSpec[] = [
  {
    name: "HSET",
    arity: -4,
    handler: (ctx, conn, args) => {
      if ((args.length - 1) % 2 !== 0) return RESP.err("ERR wrong number of arguments for 'hset'");
      const d = db(ctx, conn);
      const k = bytesToKey(args[0]!);
      const h = getOrCreateHash(d, k);
      let added = 0;
      for (let i = 1; i < args.length; i += 2) {
        const f = bytesToKey(args[i]!);
        if (!h.has(f)) added++;
        h.set(f, new Uint8Array(args[i + 1]!));
      }
      ctx.bumpKey(conn.selectedDb, k);
      return RESP.int(added);
    },
  },
  {
    name: "HGET",
    arity: 3,
    handler: (ctx, conn, args) => {
      const h = getHash(db(ctx, conn), bytesToKey(args[0]!));
      if (!h) return RESP.nil();
      const v = h.get(bytesToKey(args[1]!));
      return v ? { type: "bulk", value: v } : RESP.nil();
    },
  },
  {
    name: "HMSET",
    arity: -4,
    handler: (ctx, conn, args) => {
      if ((args.length - 1) % 2 !== 0) return RESP.err("ERR wrong number of arguments for 'hmset'");
      const d = db(ctx, conn);
      const k = bytesToKey(args[0]!);
      const h = getOrCreateHash(d, k);
      for (let i = 1; i < args.length; i += 2) h.set(bytesToKey(args[i]!), new Uint8Array(args[i + 1]!));
      ctx.bumpKey(conn.selectedDb, k);
      return RESP.ok();
    },
  },
  {
    name: "HMGET",
    arity: -3,
    handler: (ctx, conn, args) => {
      const h = getHash(db(ctx, conn), bytesToKey(args[0]!));
      const out: RespValue[] = [];
      for (let i = 1; i < args.length; i++) {
        if (!h) out.push(RESP.nil());
        else {
          const v = h.get(bytesToKey(args[i]!));
          out.push(v ? { type: "bulk", value: v } : RESP.nil());
        }
      }
      return RESP.arr(out);
    },
  },
  {
    name: "HGETALL",
    arity: 2,
    handler: (ctx, conn, args) => {
      const h = getHash(db(ctx, conn), bytesToKey(args[0]!));
      if (!h) return conn.resp3 ? { type: "map" as const, value: [] } : RESP.arr([]);
      if (conn.resp3) {
        const entries: Array<[RespValue, RespValue]> = [];
        for (const [f, v] of h) entries.push([{ type: "bulk", value: keyToBytes(f) }, { type: "bulk", value: v }]);
        return { type: "map", value: entries };
      }
      const out: RespValue[] = [];
      for (const [f, v] of h) {
        out.push({ type: "bulk", value: keyToBytes(f) });
        out.push({ type: "bulk", value: v });
      }
      return RESP.arr(out);
    },
  },
  {
    name: "HDEL",
    arity: -3,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const k = bytesToKey(args[0]!);
      const h = getHash(d, k);
      if (!h) return RESP.int(0);
      let n = 0;
      for (let i = 1; i < args.length; i++) {
        if (h.delete(bytesToKey(args[i]!))) n++;
      }
      if (h.size === 0) d.delete(k);
      ctx.bumpKey(conn.selectedDb, k);
      return RESP.int(n);
    },
  },
  {
    name: "HEXISTS",
    arity: 3,
    handler: (ctx, conn, args) => {
      const h = getHash(db(ctx, conn), bytesToKey(args[0]!));
      return RESP.int(h && h.has(bytesToKey(args[1]!)) ? 1 : 0);
    },
  },
  {
    name: "HKEYS",
    arity: 2,
    handler: (ctx, conn, args) => {
      const h = getHash(db(ctx, conn), bytesToKey(args[0]!));
      if (!h) return RESP.arr([]);
      return RESP.arr(Array.from(h.keys()).map((f) => ({ type: "bulk" as const, value: keyToBytes(f) })));
    },
  },
  {
    name: "HVALS",
    arity: 2,
    handler: (ctx, conn, args) => {
      const h = getHash(db(ctx, conn), bytesToKey(args[0]!));
      if (!h) return RESP.arr([]);
      return RESP.arr(Array.from(h.values()).map((v) => ({ type: "bulk" as const, value: v })));
    },
  },
  {
    name: "HLEN",
    arity: 2,
    handler: (ctx, conn, args) => {
      const h = getHash(db(ctx, conn), bytesToKey(args[0]!));
      return RESP.int(h?.size ?? 0);
    },
  },
  {
    name: "HINCRBY",
    arity: 4,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const k = bytesToKey(args[0]!);
      const h = getOrCreateHash(d, k);
      const f = bytesToKey(args[1]!);
      const delta = Number(dec(args[2]!));
      if (!Number.isInteger(delta)) return RESP.err("ERR value is not an integer or out of range");
      const cur = h.get(f);
      const curN = cur ? Number(dec(cur)) : 0;
      if (cur && !Number.isInteger(curN)) return RESP.err("ERR hash value is not an integer");
      const n = curN + delta;
      h.set(f, new TextEncoder().encode(String(n)));
      ctx.bumpKey(conn.selectedDb, k);
      return RESP.int(n);
    },
  },
  {
    name: "HINCRBYFLOAT",
    arity: 4,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const k = bytesToKey(args[0]!);
      const h = getOrCreateHash(d, k);
      const f = bytesToKey(args[1]!);
      const delta = Number(dec(args[2]!));
      if (!Number.isFinite(delta)) return RESP.err("ERR value is not a valid float");
      const cur = h.get(f);
      const curN = cur ? Number(dec(cur)) : 0;
      if (cur && !Number.isFinite(curN)) return RESP.err("ERR hash value is not a float");
      const n = curN + delta;
      const s = Number.isInteger(n) ? String(n) : n.toString();
      h.set(f, new TextEncoder().encode(s));
      ctx.bumpKey(conn.selectedDb, k);
      return { type: "bulk", value: new TextEncoder().encode(s) };
    },
  },
  {
    name: "HSETNX",
    arity: 4,
    handler: (ctx, conn, args) => {
      // args = [key, field, value] (command name excluded). Value is args[2].
      const d = db(ctx, conn);
      const k = bytesToKey(args[0]!);
      const h = getOrCreateHash(d, k);
      const f = bytesToKey(args[1]!);
      if (h.has(f)) return RESP.int(0);
      h.set(f, new Uint8Array(args[2]!));
      ctx.bumpKey(conn.selectedDb, k);
      return RESP.int(1);
    },
  },
  {
    name: "HSTRLEN",
    arity: 3,
    handler: (ctx, conn, args) => {
      const h = getHash(db(ctx, conn), bytesToKey(args[0]!));
      if (!h) return RESP.int(0);
      const v = h.get(bytesToKey(args[1]!));
      return RESP.int(v?.length ?? 0);
    },
  },
  {
    name: "HSCAN",
    arity: -3,
    handler: (ctx, conn, args) => {
      const h = getHash(db(ctx, conn), bytesToKey(args[0]!));
      const cursor = Number(dec(args[1]!));
      let pattern: string | null = null;
      let count = 10;
      let novalues = false;
      for (let i = 2; i < args.length; i++) {
        const opt = dec(args[i]!).toUpperCase();
        if (opt === "MATCH") pattern = dec(args[++i]!);
        else if (opt === "COUNT") count = Number(dec(args[++i]!));
        else if (opt === "NOVALUES") novalues = true;
      }
      const entries = h ? Array.from(h.entries()) : [];
      const slice = entries.slice(cursor, cursor + count);
      const next = cursor + count >= entries.length ? 0 : cursor + count;
      const out: RespValue[] = [];
      for (const [f, v] of slice) {
        if (pattern && !matchPattern(pattern, f)) continue;
        out.push({ type: "bulk", value: keyToBytes(f) });
        if (!novalues) out.push({ type: "bulk", value: v });
      }
      return RESP.arr([RESP.str(String(next)), RESP.arr(out)]);
    },
  },
  {
    name: "HRANDFIELD",
    arity: -2,
    handler: (ctx, conn, args) => {
      const h = getHash(db(ctx, conn), bytesToKey(args[0]!));
      if (!h || h.size === 0) return args.length > 1 ? RESP.arr([]) : RESP.nil();
      const fields = Array.from(h.keys());
      if (args.length === 1) {
        return { type: "bulk", value: keyToBytes(fields[Math.floor(Math.random() * fields.length)]!) };
      }
      const count = Number(dec(args[1]!));
      const withValues = args.length > 2 && dec(args[2]!).toUpperCase() === "WITHVALUES";
      const out: RespValue[] = [];
      const push = (f: string) => {
        out.push({ type: "bulk", value: keyToBytes(f) });
        if (withValues) out.push({ type: "bulk", value: h.get(f)! });
      };
      if (count >= 0) {
        // Distinct fields, sampled without replacement (Fisher-Yates partial).
        const pool = fields.slice();
        const n = Math.min(count, pool.length);
        for (let i = 0; i < n; i++) {
          const j = i + Math.floor(Math.random() * (pool.length - i));
          const t = pool[i]!; pool[i] = pool[j]!; pool[j] = t;
          push(pool[i]!);
        }
      } else {
        // Negative count: allow repeats.
        const n = -count;
        for (let i = 0; i < n; i++) push(fields[Math.floor(Math.random() * fields.length)]!);
      }
      return RESP.arr(out);
    },
  },
];