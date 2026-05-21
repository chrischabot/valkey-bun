// Arity convention: dispatcher computes got = 1 + args.length vs spec.arity,
// so arity counts command name + args; handler `args` excludes the command
// name. LINSERT key BEFORE|AFTER pivot value -> arity 5, args length 4.

import type { CommandSpec } from "./index";
import { RESP, type RespValue } from "../resp";
import { bytesToKey, type Database } from "../store";

const dec = (b: Uint8Array) => new TextDecoder().decode(b);

function db(ctx: any, conn: any): Database { return ctx.store.db(conn.selectedDb); }

function getList(d: Database, key: string): Uint8Array[] | null {
  const v = d.getRaw(key);
  if (!v) return null;
  if (v.type !== "list") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
  return v.value;
}

function getOrCreateList(d: Database, key: string): Uint8Array[] {
  const v = d.getRaw(key);
  if (v) {
    if (v.type !== "list") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
    return v.value;
  }
  const arr: Uint8Array[] = [];
  d.set(key, { type: "list", value: arr });
  return arr;
}

function eqBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export const listCommands: CommandSpec[] = [
  {
    name: "LPUSH",
    arity: -3,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const k = bytesToKey(args[0]!);
      const list = getOrCreateList(d, k);
      for (let i = 1; i < args.length; i++) list.unshift(new Uint8Array(args[i]!));
      ctx.bumpKey(conn.selectedDb, k);
      ctx.notifyListPush(conn.selectedDb, k);
      return RESP.int(list.length);
    },
  },
  {
    name: "RPUSH",
    arity: -3,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const k = bytesToKey(args[0]!);
      const list = getOrCreateList(d, k);
      for (let i = 1; i < args.length; i++) list.push(new Uint8Array(args[i]!));
      ctx.bumpKey(conn.selectedDb, k);
      ctx.notifyListPush(conn.selectedDb, k);
      return RESP.int(list.length);
    },
  },
  {
    name: "LPUSHX",
    arity: -3,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const k = bytesToKey(args[0]!);
      const list = getList(d, k);
      if (!list) return RESP.int(0);
      for (let i = 1; i < args.length; i++) list.unshift(new Uint8Array(args[i]!));
      ctx.bumpKey(conn.selectedDb, k);
      ctx.notifyListPush(conn.selectedDb, k);
      return RESP.int(list.length);
    },
  },
  {
    name: "RPUSHX",
    arity: -3,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const k = bytesToKey(args[0]!);
      const list = getList(d, k);
      if (!list) return RESP.int(0);
      for (let i = 1; i < args.length; i++) list.push(new Uint8Array(args[i]!));
      ctx.bumpKey(conn.selectedDb, k);
      ctx.notifyListPush(conn.selectedDb, k);
      return RESP.int(list.length);
    },
  },
  { name: "LPOP", arity: -2, handler: (ctx, conn, args) => popN(ctx, conn, args, "left") },
  { name: "RPOP", arity: -2, handler: (ctx, conn, args) => popN(ctx, conn, args, "right") },
  {
    name: "LLEN",
    arity: 2,
    handler: (ctx, conn, args) => RESP.int(getList(db(ctx, conn), bytesToKey(args[0]!))?.length ?? 0),
  },
  {
    name: "LRANGE",
    arity: 4,
    handler: (ctx, conn, args) => {
      const list = getList(db(ctx, conn), bytesToKey(args[0]!));
      if (!list) return RESP.arr([]);
      let start = Number(dec(args[1]!));
      let stop = Number(dec(args[2]!));
      const len = list.length;
      if (start < 0) start = Math.max(0, len + start);
      if (stop < 0) stop = len + stop;
      if (start >= len || start > stop) return RESP.arr([]);
      stop = Math.min(stop, len - 1);
      const out: RespValue[] = [];
      for (let i = start; i <= stop; i++) out.push({ type: "bulk", value: list[i]! });
      return RESP.arr(out);
    },
  },
  {
    name: "LINDEX",
    arity: 3,
    handler: (ctx, conn, args) => {
      const list = getList(db(ctx, conn), bytesToKey(args[0]!));
      if (!list) return RESP.nil();
      let idx = Number(dec(args[1]!));
      if (idx < 0) idx = list.length + idx;
      if (idx < 0 || idx >= list.length) return RESP.nil();
      return { type: "bulk", value: list[idx]! };
    },
  },
  {
    name: "LSET",
    arity: 4,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const k = bytesToKey(args[0]!);
      const list = getList(d, k);
      if (!list) return RESP.err("ERR no such key");
      let idx = Number(dec(args[1]!));
      if (idx < 0) idx = list.length + idx;
      if (idx < 0 || idx >= list.length) return RESP.err("ERR index out of range");
      list[idx] = new Uint8Array(args[2]!);
      ctx.bumpKey(conn.selectedDb, k);
      return RESP.ok();
    },
  },
  {
    name: "LREM",
    arity: 4,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const k = bytesToKey(args[0]!);
      const list = getList(d, k);
      if (!list) return RESP.int(0);
      const count = Number(dec(args[1]!));
      const target = args[2]!;
      let removed = 0;
      if (count >= 0) {
        for (let i = 0; i < list.length; ) {
          if (eqBytes(list[i]!, target)) {
            list.splice(i, 1);
            removed++;
            if (count > 0 && removed >= count) break;
          } else i++;
        }
      } else {
        const max = -count;
        for (let i = list.length - 1; i >= 0; ) {
          if (eqBytes(list[i]!, target)) {
            list.splice(i, 1);
            removed++;
            if (removed >= max) break;
          }
          i--;
        }
      }
      if (list.length === 0) d.delete(k);
      if (removed > 0) ctx.bumpKey(conn.selectedDb, k);
      return RESP.int(removed);
    },
  },
  {
    name: "LTRIM",
    arity: 4,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const k = bytesToKey(args[0]!);
      const list = getList(d, k);
      if (!list) return RESP.ok();
      let start = Number(dec(args[1]!));
      let stop = Number(dec(args[2]!));
      const len = list.length;
      if (start < 0) start = Math.max(0, len + start);
      if (stop < 0) stop = len + stop;
      if (start >= len || start > stop) { d.delete(k); return RESP.ok(); }
      stop = Math.min(stop, len - 1);
      list.splice(stop + 1);
      list.splice(0, start);
      if (list.length === 0) d.delete(k);
      ctx.bumpKey(conn.selectedDb, k);
      return RESP.ok();
    },
  },
  {
    // LINSERT key BEFORE|AFTER pivot value -> arity 5 (command + 4 args).
    name: "LINSERT",
    arity: 5,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const k = bytesToKey(args[0]!);
      const list = getList(d, k);
      if (!list) return RESP.int(0);
      const where = dec(args[1]!).toUpperCase();
      if (where !== "BEFORE" && where !== "AFTER") return RESP.err("ERR syntax error");
      const pivot = args[2]!;
      const value = args[3]!;
      const idx = list.findIndex((b) => eqBytes(b, pivot));
      if (idx === -1) return RESP.int(-1);
      list.splice(where === "BEFORE" ? idx : idx + 1, 0, new Uint8Array(value));
      ctx.bumpKey(conn.selectedDb, k);
      return RESP.int(list.length);
    },
  },
  {
    name: "LMOVE",
    arity: 5,
    handler: (ctx, conn, args) => {
      const from = dec(args[2]!).toUpperCase();
      const to = dec(args[3]!).toUpperCase();
      if ((from !== "LEFT" && from !== "RIGHT") || (to !== "LEFT" && to !== "RIGHT")) {
        return RESP.err("ERR syntax error");
      }
      const d = db(ctx, conn);
      const sk = bytesToKey(args[0]!);
      const dk = bytesToKey(args[1]!);
      const src = getList(d, sk);
      if (!src || src.length === 0) return RESP.nil();
      const item = from === "LEFT" ? src.shift()! : src.pop()!;
      if (src.length === 0) d.delete(sk);
      const dst = getOrCreateList(d, dk);
      if (to === "LEFT") dst.unshift(item); else dst.push(item);
      ctx.bumpKey(conn.selectedDb, sk);
      ctx.bumpKey(conn.selectedDb, dk);
      ctx.notifyListPush(conn.selectedDb, dk);
      return { type: "bulk", value: item };
    },
  },
  {
    name: "RPOPLPUSH",
    arity: 3,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const sk = bytesToKey(args[0]!);
      const src = getList(d, sk);
      if (!src || src.length === 0) return RESP.nil();
      const item = src.pop()!;
      if (src.length === 0) d.delete(sk);
      const dk = bytesToKey(args[1]!);
      const dst = getOrCreateList(d, dk);
      dst.unshift(item);
      ctx.bumpKey(conn.selectedDb, sk);
      ctx.bumpKey(conn.selectedDb, dk);
      ctx.notifyListPush(conn.selectedDb, dk);
      return { type: "bulk", value: item };
    },
  },
  {
    name: "LPOS",
    arity: -3,
    handler: (ctx, conn, args) => {
      const list = getList(db(ctx, conn), bytesToKey(args[0]!));
      if (!list) return RESP.nil();
      const target = args[1]!;
      let rank = 1;
      let count = -1;
      let maxlen = 0;
      for (let i = 2; i < args.length; i++) {
        const opt = dec(args[i]!).toUpperCase();
        if (opt === "RANK") rank = Number(dec(args[++i]!));
        else if (opt === "COUNT") count = Number(dec(args[++i]!));
        else if (opt === "MAXLEN") maxlen = Number(dec(args[++i]!));
      }
      const out: number[] = [];
      const reverse = rank < 0;
      const start = reverse ? list.length - 1 : 0;
      const step = reverse ? -1 : 1;
      const limit = maxlen > 0 ? maxlen : list.length;
      let scanned = 0, matched = 0;
      const skip = Math.abs(rank) - 1;
      for (let i = start; reverse ? i >= 0 : i < list.length; i += step) {
        if (scanned >= limit) break;
        scanned++;
        if (eqBytes(list[i]!, target)) {
          if (matched < skip) { matched++; continue; }
          out.push(i);
          if (count === -1) return RESP.int(i);
          if (count > 0 && out.length >= count) break;
        }
      }
      if (count === -1) return RESP.nil();
      return RESP.arr(out.map((n) => RESP.int(n)));
    },
  },
  { name: "BLPOP", arity: -3, handler: (ctx, conn, args) => blockingPop(ctx, conn, args, "left") },
  { name: "BRPOP", arity: -3, handler: (ctx, conn, args) => blockingPop(ctx, conn, args, "right") },
];

function popN(ctx: any, conn: any, args: Uint8Array[], side: "left" | "right"): RespValue {
  const d = db(ctx, conn);
  const k = bytesToKey(args[0]!);
  const list = getList(d, k);
  if (!list || list.length === 0) return args.length > 1 ? RESP.arr(null) : RESP.nil();
  if (args.length === 1) {
    const item = side === "left" ? list.shift()! : list.pop()!;
    if (list.length === 0) d.delete(k);
    ctx.bumpKey(conn.selectedDb, k);
    return { type: "bulk", value: item };
  }
  const count = Math.min(Number(dec(args[1]!)), list.length);
  const out: RespValue[] = [];
  for (let i = 0; i < count; i++) {
    const item = side === "left" ? list.shift()! : list.pop()!;
    out.push({ type: "bulk", value: item });
  }
  if (list.length === 0) d.delete(k);
  ctx.bumpKey(conn.selectedDb, k);
  return RESP.arr(out);
}

// Genuine blocking BLPOP/BRPOP. Returns immediately if an element is
// available on any key; rejects an invalid/negative timeout with a Redis
// error; otherwise parks the client via the server-context waiter registry
// until a push arrives or the timeout elapses (0 => block forever). The async
// return integrates with the dispatcher's per-connection async queue, so a
// blocked client correctly defers its subsequent commands.
async function blockingPop(
  ctx: any,
  conn: any,
  args: Uint8Array[],
  side: "left" | "right",
): Promise<RespValue> {
  const timeoutRaw = Number(dec(args[args.length - 1]!));
  if (!Number.isFinite(timeoutRaw) || timeoutRaw < 0) {
    return RESP.err("ERR timeout is not a float or out of range");
  }
  const keyBufs = args.slice(0, -1);
  const keys = keyBufs.map((k) => bytesToKey(k));
  const d = db(ctx, conn);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    const list = getList(d, key);
    if (list && list.length > 0) {
      const item = side === "left" ? list.shift()! : list.pop()!;
      if (list.length === 0) d.delete(key);
      ctx.bumpKey(conn.selectedDb, key);
      return RESP.arr([{ type: "bulk", value: keyBufs[i]! }, { type: "bulk", value: item }]);
    }
  }
  return ctx.registerListWaiter(conn.selectedDb, keys, side, timeoutRaw) as Promise<RespValue>;
}