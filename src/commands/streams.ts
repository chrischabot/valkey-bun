import type { CommandSpec } from "./index";
import { RESP, type RespValue } from "../resp";
import { bytesToKey, Stream, type Database } from "../store";

const dec = (b: Uint8Array) => new TextDecoder().decode(b);

function db(ctx: any, conn: any): Database { return ctx.store.db(conn.selectedDb); }

function getStream(d: Database, key: string): Stream | null {
  const v = d.getRaw(key);
  if (!v) return null;
  if (v.type !== "stream") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
  return v.value;
}

function getOrCreateStream(d: Database, key: string): Stream {
  const v = d.getRaw(key);
  if (v) {
    if (v.type !== "stream") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
    return v.value;
  }
  const s = new Stream();
  d.set(key, { type: "stream", value: s });
  return s;
}

function compareIds(a: string, b: string): number {
  const [am, as] = a.split("-").map(Number);
  const [bm, bs] = b.split("-").map(Number);
  if (am! !== bm!) return am! - bm!;
  return as! - bs!;
}

function entryToReply(e: { id: string; fields: Array<[string, Uint8Array]> }): RespValue {
  const fields: RespValue[] = [];
  for (const [f, v] of e.fields) {
    fields.push(RESP.str(f));
    fields.push({ type: "bulk", value: v });
  }
  return RESP.arr([RESP.str(e.id), RESP.arr(fields)]);
}

export const streamCommands: CommandSpec[] = [
  {
    name: "XADD",
    arity: -5,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const k = bytesToKey(args[0]!);
      let i = 1;
      let nomkstream = false;
      while (i < args.length) {
        const a = dec(args[i]!).toUpperCase();
        if (a === "NOMKSTREAM") { nomkstream = true; i++; }
        else if (a === "MAXLEN" || a === "MINID") {
          i++;
          if (i < args.length && (dec(args[i]!) === "~" || dec(args[i]!) === "=")) i++;
          if (i >= args.length) return RESP.err("ERR syntax error");
          i++;
          if (i < args.length && dec(args[i]!).toUpperCase() === "LIMIT") {
            if (i + 1 >= args.length) return RESP.err("ERR syntax error");
            i += 2;
          }
        } else break;
      }
      if (i >= args.length) return RESP.err("ERR wrong number of arguments for 'xadd'");
      const idHint = dec(args[i++]!);
      const fvArgs = args.slice(i);
      if (fvArgs.length === 0 || fvArgs.length % 2 !== 0) {
        return RESP.err("ERR wrong number of arguments for 'xadd': field/value pairs must be complete");
      }
      let stream: Stream | null = getStream(d, k);
      if (!stream) {
        if (nomkstream) return RESP.nil();
        stream = getOrCreateStream(d, k);
      }
      const id = stream.nextId(idHint);
      const fields: Array<[string, Uint8Array]> = [];
      for (let j = 0; j < fvArgs.length; j += 2) {
        fields.push([dec(fvArgs[j]!), new Uint8Array(fvArgs[j + 1]!)]);
      }
      stream.add(id, fields);
      ctx.bumpKey(conn.selectedDb, k);
      return RESP.str(id);
    },
  },
  {
    name: "XLEN",
    arity: 2,
    handler: (ctx, conn, args) => RESP.int(getStream(db(ctx, conn), bytesToKey(args[0]!))?.entries.length ?? 0),
  },
  { name: "XRANGE", arity: -4, handler: (ctx, conn, args) => xrange(ctx, conn, args, false) },
  { name: "XREVRANGE", arity: -4, handler: (ctx, conn, args) => xrange(ctx, conn, args, true) },
  {
    name: "XDEL",
    arity: -3,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const s = getStream(d, bytesToKey(args[0]!));
      if (!s) return RESP.int(0);
      let n = 0;
      for (let i = 1; i < args.length; i++) {
        const id = dec(args[i]!);
        const idx = s.entries.findIndex((e) => e.id === id);
        if (idx >= 0) { s.entries.splice(idx, 1); n++; }
      }
      ctx.bumpKey(conn.selectedDb, bytesToKey(args[0]!));
      return RESP.int(n);
    },
  },
  {
    name: "XTRIM",
    arity: -4,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const s = getStream(d, bytesToKey(args[0]!));
      if (!s) return RESP.int(0);
      const mode = dec(args[1]!).toUpperCase();
      let i = 2;
      if (i < args.length && (dec(args[i]!) === "~" || dec(args[i]!) === "=")) i++;
      if (i >= args.length) return RESP.err("ERR syntax error");
      const arg = dec(args[i]!);
      const before = s.entries.length;
      if (mode === "MAXLEN") {
        const max = Number(arg);
        if (s.entries.length > max) s.entries.splice(0, s.entries.length - max);
      } else if (mode === "MINID") {
        s.entries = s.entries.filter((e) => compareIds(e.id, arg) >= 0);
      }
      return RESP.int(before - s.entries.length);
    },
  },
  {
    name: "XREAD",
    arity: -4,
    handler: (ctx, conn, args) => {
      let i = 0;
      while (i < args.length) {
        const a = dec(args[i]!).toUpperCase();
        if (a === "COUNT" || a === "BLOCK") { if (i + 1 >= args.length) return RESP.err("ERR syntax error"); i += 2; }
        else if (a === "STREAMS") { i++; break; }
        else break;
      }
      const remaining = args.slice(i);
      if (remaining.length === 0 || remaining.length % 2 !== 0) return RESP.err("ERR syntax error");
      const half = remaining.length / 2;
      const keys = remaining.slice(0, half).map(dec);
      const ids = remaining.slice(half).map(dec);
      const d = db(ctx, conn);
      const out: RespValue[] = [];
      for (let j = 0; j < keys.length; j++) {
        const s = getStream(d, bytesToKey(new TextEncoder().encode(keys[j]!)));
        if (!s) continue;
        const after = ids[j]! === "$" ? `${s.lastMs}-${s.lastSeq}` : ids[j]!;
        const matches = s.entries.filter((e) => compareIds(e.id, after) > 0);
        if (matches.length > 0) out.push(RESP.arr([RESP.str(keys[j]!), RESP.arr(matches.map(entryToReply))]));
      }
      return out.length === 0 ? RESP.nil() : RESP.arr(out);
    },
  },
  {
    name: "XINFO",
    arity: -2,
    handler: (ctx, conn, args) => {
      const sub = dec(args[0]!).toUpperCase();
      const s = getStream(db(ctx, conn), bytesToKey(args[1]!));
      if (sub === "STREAM") {
        if (!s) return RESP.err("ERR no such key");
        const first = s.entries[0];
        const last = s.entries[s.entries.length - 1];
        return RESP.arr([
          RESP.str("length"), RESP.int(s.entries.length),
          RESP.str("radix-tree-keys"), RESP.int(1),
          RESP.str("radix-tree-nodes"), RESP.int(2),
          RESP.str("last-generated-id"), RESP.str(`${s.lastMs}-${s.lastSeq}`),
          RESP.str("groups"), RESP.int(s.groups.size),
          RESP.str("first-entry"), first ? entryToReply(first) : RESP.nil(),
          RESP.str("last-entry"), last ? entryToReply(last) : RESP.nil(),
        ]);
      }
      if (sub === "GROUPS") {
        if (!s) return RESP.arr([]);
        const out: RespValue[] = [];
        for (const g of s.groups.values()) {
          out.push(RESP.arr([
            RESP.str("name"), RESP.str(g.name),
            RESP.str("consumers"), RESP.int(g.consumers.size),
            RESP.str("pending"), RESP.int(g.pending.size),
            RESP.str("last-delivered-id"), RESP.str(g.lastDelivered),
          ]));
        }
        return RESP.arr(out);
      }
      if (sub === "CONSUMERS") {
        if (!s) return RESP.arr([]);
        const g = s.groups.get(dec(args[2]!));
        if (!g) return RESP.arr([]);
        const out: RespValue[] = [];
        for (const c of g.consumers.values()) {
          out.push(RESP.arr([
            RESP.str("name"), RESP.str(c.name),
            RESP.str("pending"), RESP.int(c.pending),
            RESP.str("idle"), RESP.int(Date.now() - c.lastSeen),
          ]));
        }
        return RESP.arr(out);
      }
      return RESP.arr([]);
    },
  },
  {
    name: "XGROUP",
    arity: -2,
    handler: (ctx, conn, args) => {
      const sub = dec(args[0]!).toUpperCase();
      const d = db(ctx, conn);
      if (sub === "CREATE") {
        const key = bytesToKey(args[1]!);
        const groupName = dec(args[2]!);
        const id = dec(args[3]!);
        let s = getStream(d, key);
        if (!s) {
          if (args.length > 4 && dec(args[4]!).toUpperCase() === "MKSTREAM") s = getOrCreateStream(d, key);
          else return RESP.err("ERR The XGROUP subcommand requires the key to exist.");
        }
        if (s.groups.has(groupName)) return RESP.err("BUSYGROUP Consumer Group name already exists");
        s.groups.set(groupName, {
          name: groupName,
          lastDelivered: id === "$" ? `${s.lastMs}-${s.lastSeq}` : id,
          pending: new Map(),
          consumers: new Map(),
        });
        return RESP.ok();
      }
      if (sub === "DESTROY") {
        const s = getStream(d, bytesToKey(args[1]!));
        if (!s) return RESP.int(0);
        return RESP.int(s.groups.delete(dec(args[2]!)) ? 1 : 0);
      }
      if (sub === "CREATECONSUMER") {
        const s = getStream(d, bytesToKey(args[1]!));
        const g = s?.groups.get(dec(args[2]!));
        if (!g) return RESP.int(0);
        const name = dec(args[3]!);
        if (g.consumers.has(name)) return RESP.int(0);
        g.consumers.set(name, { name, lastSeen: Date.now(), pending: 0 });
        return RESP.int(1);
      }
      if (sub === "DELCONSUMER") {
        const s = getStream(d, bytesToKey(args[1]!));
        const g = s?.groups.get(dec(args[2]!));
        if (!g) return RESP.int(0);
        const name = dec(args[3]!);
        const c = g.consumers.get(name);
        const pending = c?.pending ?? 0;
        g.consumers.delete(name);
        return RESP.int(pending);
      }
      if (sub === "SETID") {
        const s = getStream(d, bytesToKey(args[1]!));
        const g = s?.groups.get(dec(args[2]!));
        if (!g) return RESP.err("NOGROUP");
        g.lastDelivered = dec(args[3]!);
        return RESP.ok();
      }
      return RESP.err(`ERR Unknown XGROUP subcommand '${sub}'`);
    },
  },
  {
    name: "XREADGROUP",
    arity: -7,
    handler: (ctx, conn, args) => {
      let i = 0;
      if (dec(args[i]!).toUpperCase() !== "GROUP") return RESP.err("ERR syntax error");
      i++;
      if (i + 1 >= args.length) return RESP.err("ERR syntax error");
      const groupName = dec(args[i++]!);
      const consumer = dec(args[i++]!);
      while (i < args.length) {
        const a = dec(args[i]!).toUpperCase();
        if (a === "COUNT" || a === "BLOCK") { if (i + 1 >= args.length) return RESP.err("ERR syntax error"); i += 2; }
        else if (a === "NOACK") i++;
        else if (a === "STREAMS") { i++; break; }
        else break;
      }
      const remaining = args.slice(i);
      if (remaining.length === 0 || remaining.length % 2 !== 0) return RESP.err("ERR syntax error");
      const half = remaining.length / 2;
      const keys = remaining.slice(0, half).map(dec);
      const ids = remaining.slice(half).map(dec);
      const d = db(ctx, conn);
      const out: RespValue[] = [];
      for (let j = 0; j < keys.length; j++) {
        const s = getStream(d, bytesToKey(new TextEncoder().encode(keys[j]!)));
        if (!s) continue;
        const g = s.groups.get(groupName);
        if (!g) return RESP.err("NOGROUP No such key or consumer group");
        if (!g.consumers.has(consumer)) g.consumers.set(consumer, { name: consumer, lastSeen: Date.now(), pending: 0 });
        const after = ids[j]! === ">" ? g.lastDelivered : ids[j]!;
        const matches = s.entries.filter((e) => compareIds(e.id, after) > 0);
        if (matches.length > 0) {
          for (const e of matches) {
            g.pending.set(e.id, { consumer, deliveredAt: Date.now(), deliveries: 1 });
            g.consumers.get(consumer)!.pending++;
          }
          g.lastDelivered = matches[matches.length - 1]!.id;
          out.push(RESP.arr([RESP.str(keys[j]!), RESP.arr(matches.map(entryToReply))]));
        }
      }
      return out.length === 0 ? RESP.nil() : RESP.arr(out);
    },
  },
  {
    name: "XACK",
    arity: -4,
    handler: (ctx, conn, args) => {
      const s = getStream(db(ctx, conn), bytesToKey(args[0]!));
      const g = s?.groups.get(dec(args[1]!));
      if (!g) return RESP.int(0);
      let n = 0;
      for (let i = 2; i < args.length; i++) {
        const id = dec(args[i]!);
        const p = g.pending.get(id);
        if (p) {
          g.pending.delete(id);
          const c = g.consumers.get(p.consumer);
          if (c) c.pending = Math.max(0, c.pending - 1);
          n++;
        }
      }
      return RESP.int(n);
    },
  },
  {
    name: "XPENDING",
    arity: -3,
    handler: (ctx, conn, args) => {
      const s = getStream(db(ctx, conn), bytesToKey(args[0]!));
      const g = s?.groups.get(dec(args[1]!));
      if (!g) return RESP.arr([RESP.int(0), RESP.nil(), RESP.nil(), RESP.arr([])]);
      const ids = Array.from(g.pending.keys()).sort(compareIds);
      const consumerArr: RespValue[] = [];
      for (const c of g.consumers.values()) {
        if (c.pending > 0) consumerArr.push(RESP.arr([RESP.str(c.name), RESP.str(String(c.pending))]));
      }
      return RESP.arr([
        RESP.int(g.pending.size),
        ids[0] ? RESP.str(ids[0]) : RESP.nil(),
        ids[ids.length - 1] ? RESP.str(ids[ids.length - 1]!) : RESP.nil(),
        RESP.arr(consumerArr),
      ]);
    },
  },
  {
    name: "XCLAIM",
    arity: -6,
    handler: (ctx, conn, args) => {
      const s = getStream(db(ctx, conn), bytesToKey(args[0]!));
      const g = s?.groups.get(dec(args[1]!));
      if (!g || !s) return RESP.arr([]);
      const consumer = dec(args[2]!);
      const claimed: RespValue[] = [];
      for (let i = 4; i < args.length; i++) {
        const id = dec(args[i]!);
        const p = g.pending.get(id);
        if (p) {
          const old = g.consumers.get(p.consumer);
          if (old) old.pending = Math.max(0, old.pending - 1);
          p.consumer = consumer;
          p.deliveredAt = Date.now();
          p.deliveries++;
          if (!g.consumers.has(consumer)) g.consumers.set(consumer, { name: consumer, lastSeen: Date.now(), pending: 0 });
          g.consumers.get(consumer)!.pending++;
          const e = s.entries.find((x) => x.id === id);
          if (e) claimed.push(entryToReply(e));
        }
      }
      return RESP.arr(claimed);
    },
  },
];

function xrange(ctx: any, conn: any, args: Uint8Array[], reverse: boolean): RespValue {
  const s = getStream(db(ctx, conn), bytesToKey(args[0]!));
  if (!s) return RESP.arr([]);
  let lo = dec(args[1]!);
  let hi = dec(args[2]!);
  if (reverse) [lo, hi] = [hi, lo];
  if (lo === "-") lo = "0-0";
  if (hi === "+") hi = `${Number.MAX_SAFE_INTEGER}-${Number.MAX_SAFE_INTEGER}`;
  if (!lo.includes("-")) lo += "-0";
  if (!hi.includes("-")) hi += `-${Number.MAX_SAFE_INTEGER}`;
  let count = -1;
  for (let i = 3; i < args.length; i++) {
    if (dec(args[i]!).toUpperCase() === "COUNT") count = Number(dec(args[++i]!));
  }
  let entries = s.entries.filter((e) => compareIds(e.id, lo) >= 0 && compareIds(e.id, hi) <= 0);
  if (reverse) entries.reverse();
  if (count > 0) entries = entries.slice(0, count);
  return RESP.arr(entries.map(entryToReply));
}