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
  return (as ?? 0) - (bs ?? 0);
}

function loBound(id: string): string {
  if (id === "-") return "0-0";
  if (id === "+") return `${Number.MAX_SAFE_INTEGER}-${Number.MAX_SAFE_INTEGER}`;
  return id.includes("-") ? id : `${id}-0`;
}
function hiBound(id: string): string {
  if (id === "+") return `${Number.MAX_SAFE_INTEGER}-${Number.MAX_SAFE_INTEGER}`;
  if (id === "-") return "0-0";
  return id.includes("-") ? id : `${id}-${Number.MAX_SAFE_INTEGER}`;
}

const STREAM_ID_RE = /^\d+(-\d+)?$/;

function parsePositiveCount(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}
function parseNonNegInt(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function entryToReply(e: { id: string; fields: Array<[string, Uint8Array]> }): RespValue {
  const fields: RespValue[] = [];
  for (const [f, v] of e.fields) {
    fields.push(RESP.str(f));
    fields.push({ type: "bulk", value: v });
  }
  return RESP.arr([RESP.str(e.id), RESP.arr(fields)]);
}

function purgePending(s: Stream, id: string): void {
  for (const g of s.groups.values()) {
    const p = g.pending.get(id);
    if (p) {
      g.pending.delete(id);
      const c = g.consumers.get(p.consumer);
      if (c) c.pending = Math.max(0, c.pending - 1);
    }
  }
}

function trimMaxlen(s: Stream, max: number): void {
  if (s.entries.length > max) {
    const removed = s.entries.splice(0, s.entries.length - max);
    for (const e of removed) purgePending(s, e.id);
  }
}
function trimMinid(s: Stream, minIdRaw: string): void {
  const minId = loBound(minIdRaw);
  const keep: typeof s.entries = [];
  const removed: typeof s.entries = [];
  for (const e of s.entries) {
    if (compareIds(e.id, minId) >= 0) keep.push(e);
    else removed.push(e);
  }
  s.entries = keep;
  for (const e of removed) purgePending(s, e.id);
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
      let trim: { mode: "MAXLEN" | "MINID"; threshold: string } | null = null;
      while (i < args.length) {
        const a = dec(args[i]!).toUpperCase();
        if (a === "NOMKSTREAM") { nomkstream = true; i++; }
        else if (a === "MAXLEN" || a === "MINID") {
          i++;
          if (i < args.length && (dec(args[i]!) === "~" || dec(args[i]!) === "=")) i++;
          if (i >= args.length) return RESP.err("ERR syntax error");
          const threshold = dec(args[i]!);
          if (a === "MAXLEN") {
            if (!/^\d+$/.test(threshold) || Number(threshold) < 1) {
              return RESP.err("ERR The MAXLEN argument must be a positive integer for XADD");
            }
          } else if (!STREAM_ID_RE.test(threshold)) {
            return RESP.err("ERR Invalid stream ID specified as stream command argument");
          }
          trim = { mode: a as "MAXLEN" | "MINID", threshold };
          i++;
          if (i < args.length && dec(args[i]!).toUpperCase() === "LIMIT") {
            if (i + 1 >= args.length || parseNonNegInt(dec(args[i + 1]!)) === null) {
              return RESP.err("ERR syntax error");
            }
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
      if (trim) {
        if (trim.mode === "MAXLEN") trimMaxlen(stream, Number(trim.threshold));
        else trimMinid(stream, trim.threshold);
      }
      ctx.bumpKey(conn.selectedDb, k);
      ctx.notifyKey(conn.selectedDb, k);
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
        if (idx >= 0) {
          s.entries.splice(idx, 1);
          purgePending(s, id);
          n++;
        }
      }
      if (n > 0) ctx.bumpKey(conn.selectedDb, bytesToKey(args[0]!));
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
      if (mode !== "MAXLEN" && mode !== "MINID") return RESP.err("ERR syntax error");
      let i = 2;
      if (i < args.length && (dec(args[i]!) === "~" || dec(args[i]!) === "=")) i++;
      if (i >= args.length) return RESP.err("ERR syntax error");
      const threshold = dec(args[i]!);
      if (mode === "MAXLEN" && !/^\d+$/.test(threshold)) {
        return RESP.err("ERR value is not an integer or out of range");
      }
      if (mode === "MINID" && !STREAM_ID_RE.test(threshold)) {
        return RESP.err("ERR Invalid stream ID specified as stream command argument");
      }
      i++;
      if (i < args.length) {
        if (dec(args[i]!).toUpperCase() !== "LIMIT" || i + 1 >= args.length
          || parseNonNegInt(dec(args[i + 1]!)) === null) {
          return RESP.err("ERR syntax error");
        }
        i += 2;
      }
      if (i !== args.length) return RESP.err("ERR syntax error");
      const before = s.entries.length;
      if (mode === "MAXLEN") trimMaxlen(s, Number(threshold));
      else trimMinid(s, threshold);
      const removed = before - s.entries.length;
      if (removed > 0) ctx.bumpKey(conn.selectedDb, bytesToKey(args[0]!));
      return RESP.int(removed);
    },
  },
  {
    name: "XREAD",
    arity: -4,
    handler: (ctx, conn, args) => {
      let i = 0;
      let count = -1;
      let blockMs = -1;
      while (i < args.length) {
        const a = dec(args[i]!).toUpperCase();
        if (a === "COUNT") {
          if (i + 1 >= args.length) return RESP.err("ERR syntax error");
          const c = parsePositiveCount(dec(args[i + 1]!));
          if (c === null) return RESP.err("ERR value is not an integer or out of range");
          count = c;
          i += 2;
        } else if (a === "BLOCK") {
          if (i + 1 >= args.length) return RESP.err("ERR syntax error");
          const bm = parseNonNegInt(dec(args[i + 1]!));
          if (bm === null) return RESP.err("ERR timeout is not an integer or out of range");
          blockMs = bm;
          i += 2;
        } else if (a === "STREAMS") { i++; break; }
        else return RESP.err("ERR syntax error");
      }
      const remaining = args.slice(i);
      if (remaining.length === 0 || remaining.length % 2 !== 0) return RESP.err("ERR syntax error");
      const half = remaining.length / 2;
      const keys = remaining.slice(0, half).map(dec);
      const idArgs = remaining.slice(half).map(dec);
      const d = db(ctx, conn);
      const afterIds = keys.map((key, j) => {
        if (idArgs[j] !== "$") return idArgs[j]!;
        const s = getStream(d, key);
        return s ? `${s.lastMs}-${s.lastSeq}` : "0-0";
      });
      const collect = (): RespValue[] => {
        const out: RespValue[] = [];
        for (let j = 0; j < keys.length; j++) {
          const s = getStream(d, keys[j]!);
          if (!s) continue;
          let matches = s.entries.filter((e) => compareIds(e.id, afterIds[j]!) > 0);
          if (count > 0) matches = matches.slice(0, count);
          if (matches.length > 0) out.push(RESP.arr([RESP.str(keys[j]!), RESP.arr(matches.map(entryToReply))]));
        }
        return out;
      };
      const out = collect();
      if (out.length > 0) return RESP.arr(out);
      if (blockMs < 0) return RESP.nil();
      const timeoutSec = blockMs === 0 ? 0 : blockMs / 1000;
      return ctx.registerWaiter(
        conn.selectedDb, keys, timeoutSec,
        () => { const o = collect(); return o.length > 0 ? RESP.arr(o) : null; },
        () => RESP.nil(),
      ) as Promise<RespValue>;
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
        const full = args.length > 2 && dec(args[2]!).toUpperCase() === "FULL";
        const first = s.entries[0];
        const last = s.entries[s.entries.length - 1];
        if (full) {
          const groups: RespValue[] = [];
          for (const g of s.groups.values()) {
            const pel: RespValue[] = [];
            for (const [id, p] of g.pending) {
              pel.push(RESP.arr([RESP.str(id), RESP.str(p.consumer), RESP.int(p.deliveredAt), RESP.int(p.deliveries)]));
            }
            groups.push(RESP.arr([
              RESP.str("name"), RESP.str(g.name),
              RESP.str("last-delivered-id"), RESP.str(g.lastDelivered),
              RESP.str("pel-count"), RESP.int(g.pending.size),
              RESP.str("pending"), RESP.arr(pel),
            ]));
          }
          return RESP.arr([
            RESP.str("length"), RESP.int(s.entries.length),
            RESP.str("last-generated-id"), RESP.str(`${s.lastMs}-${s.lastSeq}`),
            RESP.str("entries"), RESP.arr(s.entries.map(entryToReply)),
            RESP.str("groups"), RESP.arr(groups),
          ]);
        }
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
        if (!s) return RESP.err("ERR no such key");
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
        if (!s) return RESP.err("ERR no such key");
        const g = s.groups.get(dec(args[2]!));
        if (!g) return RESP.err("NOGROUP No such consumer group");
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
      return RESP.err(`ERR Unknown XINFO subcommand '${sub}'`);
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
        if (id !== "$" && !STREAM_ID_RE.test(id)) {
          return RESP.err("ERR Invalid stream ID specified as stream command argument");
        }
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
        ctx.notifyKey(conn.selectedDb, key);
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
        if (!g) return RESP.err("NOGROUP No such consumer group");
        const idArg = dec(args[3]!);
        if (idArg === "$") {
          g.lastDelivered = s ? `${s.lastMs}-${s.lastSeq}` : "0-0";
        } else {
          if (!STREAM_ID_RE.test(idArg)) {
            return RESP.err("ERR Invalid stream ID specified as stream command argument");
          }
          g.lastDelivered = idArg;
        }
        return RESP.ok();
      }
      return RESP.err(`ERR Unknown XGROUP subcommand '${sub}'`);
    },
  },
  {
    name: "XSETID",
    arity: -3,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const k = bytesToKey(args[0]!);
      const s = getStream(d, k);
      if (!s) return RESP.err("ERR The XSETID command requires the key to exist.");
      const idStr = dec(args[1]!);
      if (!STREAM_ID_RE.test(idStr)) {
        return RESP.err("ERR Invalid stream ID specified as stream command argument");
      }
      const parts = idStr.split("-");
      const ms = Number(parts[0]);
      const seq = parts[1] !== undefined ? Number(parts[1]) : 0;
      for (let i = 2; i < args.length; i += 2) {
        const opt = dec(args[i]!).toUpperCase();
        if (opt !== "ENTRIESADDED" && opt !== "MAXDELETEDID") return RESP.err("ERR syntax error");
        if (i + 1 >= args.length) return RESP.err("ERR syntax error");
      }
      s.lastMs = ms;
      s.lastSeq = seq;
      ctx.bumpKey(conn.selectedDb, k);
      return RESP.ok();
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
      let count = -1;
      let blockMs = -1;
      let noack = false;
      while (i < args.length) {
        const a = dec(args[i]!).toUpperCase();
        if (a === "COUNT") {
          if (i + 1 >= args.length) return RESP.err("ERR syntax error");
          const c = parsePositiveCount(dec(args[i + 1]!));
          if (c === null) return RESP.err("ERR value is not an integer or out of range");
          count = c;
          i += 2;
        } else if (a === "BLOCK") {
          if (i + 1 >= args.length) return RESP.err("ERR syntax error");
          const bm = parseNonNegInt(dec(args[i + 1]!));
          if (bm === null) return RESP.err("ERR timeout is not an integer or out of range");
          blockMs = bm;
          i += 2;
        } else if (a === "NOACK") { noack = true; i++; }
        else if (a === "STREAMS") { i++; break; }
        else return RESP.err("ERR syntax error");
      }
      const remaining = args.slice(i);
      if (remaining.length === 0 || remaining.length % 2 !== 0) return RESP.err("ERR syntax error");
      const half = remaining.length / 2;
      const keys = remaining.slice(0, half).map(dec);
      const idArgs = remaining.slice(half).map(dec);
      const d = db(ctx, conn);
      const hasNewRequest = idArgs.some((x) => x === ">");
      const collect = (): RespValue[] | "NOGROUP" => {
        const out: RespValue[] = [];
        for (let j = 0; j < keys.length; j++) {
          const s = getStream(d, keys[j]!);
          if (!s) continue;
          const g = s.groups.get(groupName);
          if (!g) return "NOGROUP";
          if (!g.consumers.has(consumer)) g.consumers.set(consumer, { name: consumer, lastSeen: Date.now(), pending: 0 });
          const requestedId = idArgs[j]!;
          if (requestedId === ">") {
            let matches = s.entries.filter((e) => compareIds(e.id, g.lastDelivered) > 0);
            if (count > 0) matches = matches.slice(0, count);
            if (matches.length > 0) {
              if (!noack) {
                for (const e of matches) {
                  if (!g.pending.has(e.id)) {
                    g.pending.set(e.id, { consumer, deliveredAt: Date.now(), deliveries: 1 });
                    g.consumers.get(consumer)!.pending++;
                  }
                }
              }
              g.lastDelivered = matches[matches.length - 1]!.id;
              out.push(RESP.arr([RESP.str(keys[j]!), RESP.arr(matches.map(entryToReply))]));
            }
          } else {
            let pendingForConsumer = Array.from(g.pending.entries())
              .filter(([id, p]) => p.consumer === consumer && compareIds(id, requestedId) > 0)
              .map(([id]) => id)
              .sort(compareIds);
            if (count > 0) pendingForConsumer = pendingForConsumer.slice(0, count);
            const replay: RespValue[] = [];
            for (const id of pendingForConsumer) {
              const e = s.entries.find((x) => x.id === id);
              replay.push(e ? entryToReply(e) : RESP.arr([RESP.str(id), RESP.nil()]));
            }
            out.push(RESP.arr([RESP.str(keys[j]!), RESP.arr(replay)]));
          }
        }
        return out;
      };
      const firstRes = collect();
      if (firstRes === "NOGROUP") return RESP.err("NOGROUP No such key or consumer group");
      if (firstRes.length > 0) return RESP.arr(firstRes);
      if (blockMs < 0 || !hasNewRequest) return RESP.nil();
      const timeoutSec = blockMs === 0 ? 0 : blockMs / 1000;
      return ctx.registerWaiter(
        conn.selectedDb, keys, timeoutSec,
        () => { const o = collect(); return o !== "NOGROUP" && o.length > 0 ? RESP.arr(o) : null; },
        () => RESP.nil(),
      ) as Promise<RespValue>;
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
      if (args.length === 2) {
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
          consumerArr.length ? RESP.arr(consumerArr) : RESP.nil(),
        ]);
      }
      if (!g) return RESP.err("NOGROUP No such key or consumer group");
      let i = 2;
      let minIdle = 0;
      if (dec(args[i]!).toUpperCase() === "IDLE") {
        if (i + 1 >= args.length) return RESP.err("ERR syntax error");
        const mi = parseNonNegInt(dec(args[i + 1]!));
        if (mi === null) return RESP.err("ERR syntax error");
        minIdle = mi;
        i += 2;
      }
      if (i + 2 >= args.length) return RESP.err("ERR syntax error");
      const lo = loBound(dec(args[i]!));
      const hi = hiBound(dec(args[i + 1]!));
      const cnt = parsePositiveCount(dec(args[i + 2]!));
      if (cnt === null) return RESP.err("ERR value is not an integer or out of range");
      const afterCount = i + 3;
      if (args.length > afterCount + 1) return RESP.err("ERR syntax error");
      const filterConsumer = args.length === afterCount + 1 ? dec(args[afterCount]!) : null;
      const now = Date.now();
      const rows: RespValue[] = [];
      const matched = Array.from(g.pending.entries())
        .filter(([id, p]) =>
          compareIds(id, lo) >= 0 && compareIds(id, hi) <= 0 &&
          (now - p.deliveredAt) >= minIdle &&
          (!filterConsumer || p.consumer === filterConsumer))
        .sort((a, b) => compareIds(a[0], b[0]));
      for (const [id, p] of matched.slice(0, cnt)) {
        rows.push(RESP.arr([RESP.str(id), RESP.str(p.consumer), RESP.int(now - p.deliveredAt), RESP.int(p.deliveries)]));
      }
      return RESP.arr(rows);
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
      const minIdle = parseNonNegInt(dec(args[3]!));
      if (minIdle === null) return RESP.err("ERR Invalid min-idle-time argument for XCLAIM");
      let justid = false;
      const idList: string[] = [];
      for (let i = 4; i < args.length; i++) {
        const a = dec(args[i]!);
        const au = a.toUpperCase();
        if (au === "JUSTID") { justid = true; continue; }
        if (au === "FORCE") continue;
        if (au === "IDLE" || au === "TIME" || au === "RETRYCOUNT") {
          if (i + 1 >= args.length || parseNonNegInt(dec(args[i + 1]!)) === null) {
            return RESP.err("ERR syntax error");
          }
          i++;
          continue;
        }
        if (au === "LASTID") {
          if (i + 1 >= args.length || !STREAM_ID_RE.test(dec(args[i + 1]!))) {
            return RESP.err("ERR Invalid stream ID specified as stream command argument");
          }
          i++;
          continue;
        }
        if (!STREAM_ID_RE.test(a)) {
          return RESP.err("ERR Invalid stream ID specified as stream command argument");
        }
        idList.push(a);
      }
      const now = Date.now();
      const claimed: RespValue[] = [];
      for (const id of idList) {
        const p = g.pending.get(id);
        if (!p) continue;
        if ((now - p.deliveredAt) < minIdle) continue;
        const old = g.consumers.get(p.consumer);
        if (old) old.pending = Math.max(0, old.pending - 1);
        p.consumer = consumer;
        p.deliveredAt = now;
        p.deliveries++;
        if (!g.consumers.has(consumer)) g.consumers.set(consumer, { name: consumer, lastSeen: now, pending: 0 });
        g.consumers.get(consumer)!.pending++;
        if (justid) claimed.push(RESP.str(id));
        else {
          const e = s.entries.find((x) => x.id === id);
          if (e) claimed.push(entryToReply(e));
        }
      }
      return RESP.arr(claimed);
    },
  },
  {
    name: "XAUTOCLAIM",
    arity: -7,
    handler: (ctx, conn, args) => {
      const s = getStream(db(ctx, conn), bytesToKey(args[0]!));
      const g = s?.groups.get(dec(args[1]!));
      if (!g || !s) return RESP.arr([RESP.str("0-0"), RESP.arr([]), RESP.arr([])]);
      const consumer = dec(args[2]!);
      const minIdle = parseNonNegInt(dec(args[3]!));
      if (minIdle === null) return RESP.err("ERR Invalid min-idle-time argument for XAUTOCLAIM");
      const start = loBound(dec(args[4]!));
      let count = 100;
      let justid = false;
      for (let i = 5; i < args.length; i++) {
        const a = dec(args[i]!).toUpperCase();
        if (a === "COUNT") {
          if (i + 1 >= args.length) return RESP.err("ERR syntax error");
          const c = parsePositiveCount(dec(args[i + 1]!));
          if (c === null) return RESP.err("ERR COUNT must be > 0");
          count = c;
          i++;
        } else if (a === "JUSTID") justid = true;
        else return RESP.err("ERR syntax error");
      }
      const now = Date.now();
      const candidates = Array.from(g.pending.entries())
        .filter(([id]) => compareIds(id, start) >= 0)
        .sort((a, b) => compareIds(a[0], b[0]));
      const claimed: RespValue[] = [];
      const deleted: RespValue[] = [];
      let processed = 0;
      for (const [id, p] of candidates) {
        if (processed >= count) break;
        processed++;
        if ((now - p.deliveredAt) < minIdle) continue;
        const e = s.entries.find((x) => x.id === id);
        if (!e) {
          const oldc = g.consumers.get(p.consumer);
          if (oldc) oldc.pending = Math.max(0, oldc.pending - 1);
          g.pending.delete(id);
          deleted.push(RESP.str(id));
          continue;
        }
        const old = g.consumers.get(p.consumer);
        if (old) old.pending = Math.max(0, old.pending - 1);
        p.consumer = consumer;
        p.deliveredAt = now;
        p.deliveries++;
        if (!g.consumers.has(consumer)) g.consumers.set(consumer, { name: consumer, lastSeen: now, pending: 0 });
        g.consumers.get(consumer)!.pending++;
        claimed.push(justid ? RESP.str(id) : entryToReply(e));
      }
      return RESP.arr([RESP.str("0-0"), RESP.arr(claimed), RESP.arr(deleted)]);
    },
  },
];

function xrange(ctx: any, conn: any, args: Uint8Array[], reverse: boolean): RespValue {
  const s = getStream(db(ctx, conn), bytesToKey(args[0]!));
  if (!s) return RESP.arr([]);
  let loRaw = dec(args[1]!);
  let hiRaw = dec(args[2]!);
  if (reverse) { const t = loRaw; loRaw = hiRaw; hiRaw = t; }
  const lo = loBound(loRaw);
  const hi = hiBound(hiRaw);
  let count = -1;
  for (let i = 3; i < args.length; i++) {
    if (dec(args[i]!).toUpperCase() === "COUNT") count = Number(dec(args[++i]!));
  }
  let entries = s.entries.filter((e) => compareIds(e.id, lo) >= 0 && compareIds(e.id, hi) <= 0);
  if (reverse) entries = entries.slice().reverse();
  if (count > 0) entries = entries.slice(0, count);
  return RESP.arr(entries.map(entryToReply));
}