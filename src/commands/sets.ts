import type { CommandSpec } from "./index";
import { RESP, type RespValue } from "../resp";
import { bytesToKey, keyToBytes, type Database } from "../store";
import { matchPattern } from "../pubsub";

const dec = (b: Uint8Array) => new TextDecoder().decode(b);

function db(ctx: any, conn: any): Database { return ctx.store.db(conn.selectedDb); }

function emptySetReply(conn: any): RespValue {
  return conn.resp3 ? { type: "set", value: [] } : RESP.arr([]);
}

function getSet(d: Database, key: string): Set<string> | null {
  const v = d.getRaw(key);
  if (!v) return null;
  if (v.type !== "set") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
  return v.value;
}

function getOrCreateSet(d: Database, key: string): Set<string> {
  const v = d.getRaw(key);
  if (v) {
    if (v.type !== "set") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
    return v.value;
  }
  const s = new Set<string>();
  d.set(key, { type: "set", value: s });
  return s;
}

function membersToArr(s: Set<string>): RespValue[] {
  const out: RespValue[] = [];
  for (const m of s) out.push({ type: "bulk", value: keyToBytes(m) });
  return out;
}

export const setCommands: CommandSpec[] = [
  {
    name: "SADD",
    arity: -3,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const k = bytesToKey(args[0]!);
      const s = getOrCreateSet(d, k);
      let n = 0;
      for (let i = 1; i < args.length; i++) {
        const m = bytesToKey(args[i]!);
        if (!s.has(m)) { s.add(m); n++; }
      }
      ctx.bumpKey(conn.selectedDb, k);
      return RESP.int(n);
    },
  },
  {
    name: "SREM",
    arity: -3,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const k = bytesToKey(args[0]!);
      const s = getSet(d, k);
      if (!s) return RESP.int(0);
      let n = 0;
      for (let i = 1; i < args.length; i++) if (s.delete(bytesToKey(args[i]!))) n++;
      if (s.size === 0) d.delete(k);
      ctx.bumpKey(conn.selectedDb, k);
      return RESP.int(n);
    },
  },
  {
    name: "SMEMBERS",
    arity: 2,
    handler: (ctx, conn, args) => {
      const s = getSet(db(ctx, conn), bytesToKey(args[0]!));
      if (!s) return emptySetReply(conn);
      const arr = membersToArr(s);
      return conn.resp3 ? { type: "set", value: arr } : RESP.arr(arr);
    },
  },
  {
    name: "SISMEMBER",
    arity: 3,
    handler: (ctx, conn, args) => {
      const s = getSet(db(ctx, conn), bytesToKey(args[0]!));
      const present = !!(s && s.has(bytesToKey(args[1]!)));
      return conn.resp3 ? RESP.bool(present) : RESP.int(present ? 1 : 0);
    },
  },
  {
    name: "SMISMEMBER",
    arity: -3,
    handler: (ctx, conn, args) => {
      const s = getSet(db(ctx, conn), bytesToKey(args[0]!));
      const out: RespValue[] = [];
      for (let i = 1; i < args.length; i++) {
        const present = !!(s && s.has(bytesToKey(args[i]!)));
        out.push(conn.resp3 ? RESP.bool(present) : RESP.int(present ? 1 : 0));
      }
      return RESP.arr(out);
    },
  },
  {
    name: "SCARD",
    arity: 2,
    handler: (ctx, conn, args) => {
      const s = getSet(db(ctx, conn), bytesToKey(args[0]!));
      return RESP.int(s?.size ?? 0);
    },
  },
  {
    name: "SPOP",
    arity: -2,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const k = bytesToKey(args[0]!);
      const s = getSet(d, k);
      if (!s) return args.length > 1 ? RESP.arr([]) : RESP.nil();
      const count = args.length > 1 ? Number(dec(args[1]!)) : 1;
      const arr = Array.from(s);
      const picked: string[] = [];
      for (let i = 0; i < count && arr.length > 0; i++) {
        const idx = Math.floor(Math.random() * arr.length);
        picked.push(arr.splice(idx, 1)[0]!);
      }
      for (const m of picked) s.delete(m);
      if (s.size === 0) d.delete(k);
      ctx.bumpKey(conn.selectedDb, k);
      if (args.length === 1) return picked.length > 0 ? { type: "bulk", value: keyToBytes(picked[0]!) } : RESP.nil();
      return RESP.arr(picked.map((m) => ({ type: "bulk" as const, value: keyToBytes(m) })));
    },
  },
  {
    name: "SRANDMEMBER",
    arity: -2,
    handler: (ctx, conn, args) => {
      const s = getSet(db(ctx, conn), bytesToKey(args[0]!));
      if (!s || s.size === 0) return args.length > 1 ? RESP.arr([]) : RESP.nil();
      const arr = Array.from(s);
      if (args.length === 1) {
        return { type: "bulk", value: keyToBytes(arr[Math.floor(Math.random() * arr.length)]!) };
      }
      const count = Number(dec(args[1]!));
      const out: RespValue[] = [];
      const n = Math.abs(count);
      if (count >= 0) {
        const pool = arr.slice();
        for (let i = 0; i < n && pool.length > 0; i++) {
          const idx = Math.floor(Math.random() * pool.length);
          out.push({ type: "bulk", value: keyToBytes(pool.splice(idx, 1)[0]!) });
        }
      } else {
        for (let i = 0; i < n; i++) {
          out.push({ type: "bulk", value: keyToBytes(arr[Math.floor(Math.random() * arr.length)]!) });
        }
      }
      return RESP.arr(out);
    },
  },
  {
    name: "SUNION",
    arity: -2,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const out = new Set<string>();
      for (const a of args) {
        const s = getSet(d, bytesToKey(a));
        if (s) for (const m of s) out.add(m);
      }
      const arr = membersToArr(out);
      return conn.resp3 ? { type: "set", value: arr } : RESP.arr(arr);
    },
  },
  {
    name: "SINTER",
    arity: -2,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const sets = args.map((a) => getSet(d, bytesToKey(a)));
      if (sets.some((s) => !s)) return emptySetReply(conn);
      let inter = new Set(sets[0]!);
      for (let i = 1; i < sets.length; i++) {
        const next = new Set<string>();
        for (const m of inter) if (sets[i]!.has(m)) next.add(m);
        inter = next;
      }
      const arr = membersToArr(inter);
      return conn.resp3 ? { type: "set", value: arr } : RESP.arr(arr);
    },
  },
  {
    name: "SDIFF",
    arity: -2,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const first = getSet(d, bytesToKey(args[0]!));
      if (!first) return emptySetReply(conn);
      const out = new Set(first);
      for (let i = 1; i < args.length; i++) {
        const s = getSet(d, bytesToKey(args[i]!));
        if (s) for (const m of s) out.delete(m);
      }
      const arr = membersToArr(out);
      return conn.resp3 ? { type: "set", value: arr } : RESP.arr(arr);
    },
  },
  { name: "SUNIONSTORE", arity: -3, handler: (ctx, conn, args) => storeOp(ctx, conn, args, "union") },
  { name: "SINTERSTORE", arity: -3, handler: (ctx, conn, args) => storeOp(ctx, conn, args, "inter") },
  { name: "SDIFFSTORE", arity: -3, handler: (ctx, conn, args) => storeOp(ctx, conn, args, "diff") },
  {
    name: "SMOVE",
    arity: 4,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const src = getSet(d, bytesToKey(args[0]!));
      const m = bytesToKey(args[2]!);
      if (!src || !src.has(m)) return RESP.int(0);
      src.delete(m);
      if (src.size === 0) d.delete(bytesToKey(args[0]!));
      const dst = getOrCreateSet(d, bytesToKey(args[1]!));
      dst.add(m);
      ctx.bumpKey(conn.selectedDb, bytesToKey(args[0]!));
      ctx.bumpKey(conn.selectedDb, bytesToKey(args[1]!));
      return RESP.int(1);
    },
  },
  {
    name: "SSCAN",
    arity: -3,
    handler: (ctx, conn, args) => {
      const s = getSet(db(ctx, conn), bytesToKey(args[0]!));
      const cursor = Number(dec(args[1]!));
      let pattern: string | null = null;
      let count = 10;
      for (let i = 2; i < args.length; i++) {
        const opt = dec(args[i]!).toUpperCase();
        if (opt === "MATCH") pattern = dec(args[++i]!);
        else if (opt === "COUNT") count = Number(dec(args[++i]!));
      }
      const arr = s ? Array.from(s) : [];
      const slice = arr.slice(cursor, cursor + count);
      const next = cursor + count >= arr.length ? 0 : cursor + count;
      const out: RespValue[] = [];
      for (const m of slice) {
        if (pattern && !matchPattern(pattern, m)) continue;
        out.push({ type: "bulk", value: keyToBytes(m) });
      }
      return RESP.arr([RESP.str(String(next)), RESP.arr(out)]);
    },
  },
  {
    name: "SINTERCARD",
    arity: -3,
    handler: (ctx, conn, args) => {
      const numKeys = Number(dec(args[0]!));
      let limit = 0;
      const keyArgs = args.slice(1, 1 + numKeys);
      for (let i = 1 + numKeys; i < args.length; i++) {
        const opt = dec(args[i]!).toUpperCase();
        if (opt === "LIMIT") limit = Number(dec(args[++i]!));
      }
      const d = db(ctx, conn);
      const sets = keyArgs.map((a) => getSet(d, bytesToKey(a)));
      if (sets.some((s) => !s)) return RESP.int(0);
      let inter = new Set(sets[0]!);
      for (let i = 1; i < sets.length; i++) {
        const next = new Set<string>();
        for (const m of inter) if (sets[i]!.has(m)) next.add(m);
        inter = next;
      }
      const c = inter.size;
      return RESP.int(limit > 0 ? Math.min(limit, c) : c);
    },
  },
];

function storeOp(ctx: any, conn: any, args: Uint8Array[], op: "union" | "inter" | "diff"): RespValue {
  const d = db(ctx, conn);
  const dest = bytesToKey(args[0]!);
  const sources = args.slice(1);
  const sets = sources.map((a) => getSet(d, bytesToKey(a)));
  let result = new Set<string>();
  if (op === "union") {
    for (const s of sets) if (s) for (const m of s) result.add(m);
  } else if (op === "inter") {
    if (sets.some((s) => !s)) {
      d.delete(dest);
      ctx.bumpKey(conn.selectedDb, dest);
      return RESP.int(0);
    }
    result = new Set(sets[0]!);
    for (let i = 1; i < sets.length; i++) {
      const next = new Set<string>();
      for (const m of result) if (sets[i]!.has(m)) next.add(m);
      result = next;
    }
  } else {
    result = new Set(sets[0] ?? []);
    for (let i = 1; i < sets.length; i++) {
      if (sets[i]) for (const m of sets[i]!) result.delete(m);
    }
  }
  if (result.size === 0) d.delete(dest);
  else d.set(dest, { type: "set", value: result });
  ctx.bumpKey(conn.selectedDb, dest);
  return RESP.int(result.size);
}