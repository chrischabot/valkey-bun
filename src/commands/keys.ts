import type { CommandSpec } from "./index";
import { RESP, type RespValue } from "../resp";
import { bytesToKey, keyToBytes, Stream, type Database, type StoredValue, type ValueType } from "../store";
import { matchPattern } from "../pubsub";

const dec = (b: Uint8Array) => new TextDecoder().decode(b);

function db(ctx: any, conn: any): Database { return ctx.store.db(conn.selectedDb); }

function typeName(v: StoredValue | undefined): ValueType {
  if (!v) return "none";
  return v.type;
}

export const keyCommands: CommandSpec[] = [
  {
    name: "DEL",
    arity: -2,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      let n = 0;
      for (const a of args) {
        const k = bytesToKey(a);
        if (d.delete(k)) { n++; ctx.bumpKey(conn.selectedDb, k); }
      }
      return RESP.int(n);
    },
  },
  {
    name: "UNLINK",
    arity: -2,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      let n = 0;
      for (const a of args) {
        const k = bytesToKey(a);
        if (d.delete(k)) { n++; ctx.bumpKey(conn.selectedDb, k); }
      }
      return RESP.int(n);
    },
  },
  {
    name: "EXISTS",
    arity: -2,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      let n = 0;
      for (const a of args) if (d.exists(bytesToKey(a))) n++;
      return RESP.int(n);
    },
  },
  {
    name: "EXPIRE",
    arity: -3,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const k = bytesToKey(args[0]!);
      const seconds = Number(dec(args[1]!));
      if (!d.exists(k)) return RESP.int(0);
      d.setExpiry(k, Date.now() + seconds * 1000);
      ctx.bumpKey(conn.selectedDb, k);
      return RESP.int(1);
    },
  },
  {
    name: "PEXPIRE",
    arity: -3,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const k = bytesToKey(args[0]!);
      const ms = Number(dec(args[1]!));
      if (!d.exists(k)) return RESP.int(0);
      d.setExpiry(k, Date.now() + ms);
      ctx.bumpKey(conn.selectedDb, k);
      return RESP.int(1);
    },
  },
  {
    name: "EXPIREAT",
    arity: -3,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const k = bytesToKey(args[0]!);
      const t = Number(dec(args[1]!));
      if (!d.exists(k)) return RESP.int(0);
      d.setExpiry(k, t * 1000);
      return RESP.int(1);
    },
  },
  {
    name: "PEXPIREAT",
    arity: -3,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const k = bytesToKey(args[0]!);
      const t = Number(dec(args[1]!));
      if (!d.exists(k)) return RESP.int(0);
      d.setExpiry(k, t);
      return RESP.int(1);
    },
  },
  {
    name: "EXPIRETIME",
    arity: 2,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const k = bytesToKey(args[0]!);
      if (!d.exists(k)) return RESP.int(-2);
      const exp = d.expires.get(k);
      if (exp === undefined) return RESP.int(-1);
      return RESP.int(Math.floor(exp / 1000));
    },
  },
  {
    name: "PEXPIRETIME",
    arity: 2,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const k = bytesToKey(args[0]!);
      if (!d.exists(k)) return RESP.int(-2);
      const exp = d.expires.get(k);
      if (exp === undefined) return RESP.int(-1);
      return RESP.int(exp);
    },
  },
  {
    name: "TTL",
    arity: 2,
    handler: (ctx, conn, args) => {
      const t = db(ctx, conn).ttl(bytesToKey(args[0]!));
      if (t.kind === "none") return RESP.int(-2);
      if (t.kind === "no_expire") return RESP.int(-1);
      return RESP.int(Math.max(0, Math.floor(t.ms! / 1000)));
    },
  },
  {
    name: "PTTL",
    arity: 2,
    handler: (ctx, conn, args) => {
      const t = db(ctx, conn).ttl(bytesToKey(args[0]!));
      if (t.kind === "none") return RESP.int(-2);
      if (t.kind === "no_expire") return RESP.int(-1);
      return RESP.int(Math.max(0, t.ms!));
    },
  },
  {
    name: "PERSIST",
    arity: 2,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const k = bytesToKey(args[0]!);
      if (!d.exists(k)) return RESP.int(0);
      return RESP.int(d.removeExpiry(k) ? 1 : 0);
    },
  },
  {
    name: "KEYS",
    arity: 2,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const pattern = dec(args[0]!);
      const out: RespValue[] = [];
      for (const k of d.keys()) {
        const native = bytesToKey(keyToBytes(k));
        if (matchPattern(pattern, native)) out.push({ type: "bulk", value: keyToBytes(k) });
      }
      return RESP.arr(out);
    },
  },
  {
    name: "TYPE",
    arity: 2,
    handler: (ctx, conn, args) => RESP.simple(typeName(db(ctx, conn).getRaw(bytesToKey(args[0]!)))),
  },
  {
    name: "RENAME",
    arity: 3,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const src = bytesToKey(args[0]!);
      const dst = bytesToKey(args[1]!);
      if (!d.exists(src)) return RESP.err("ERR no such key");
      d.rename(src, dst);
      ctx.bumpKey(conn.selectedDb, src);
      ctx.bumpKey(conn.selectedDb, dst);
      return RESP.ok();
    },
  },
  {
    name: "RENAMENX",
    arity: 3,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const src = bytesToKey(args[0]!);
      const dst = bytesToKey(args[1]!);
      if (!d.exists(src)) return RESP.err("ERR no such key");
      if (d.exists(dst)) return RESP.int(0);
      d.rename(src, dst);
      ctx.bumpKey(conn.selectedDb, src);
      ctx.bumpKey(conn.selectedDb, dst);
      return RESP.int(1);
    },
  },
  {
    name: "RANDOMKEY",
    arity: 1,
    handler: (ctx, conn) => {
      const d = db(ctx, conn);
      const ks = d.keys();
      if (ks.length === 0) return RESP.nil();
      return { type: "bulk", value: keyToBytes(ks[Math.floor(Math.random() * ks.length)]!) };
    },
  },
  {
    name: "SCAN",
    arity: -2,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const cursor = Number(dec(args[0]!));
      let pattern: string | null = null;
      let count = 10;
      let typeFilter: string | null = null;
      for (let i = 1; i < args.length; i += 2) {
        const opt = dec(args[i]!).toUpperCase();
        const val = args[i + 1] ? dec(args[i + 1]!) : "";
        if (opt === "MATCH") pattern = val;
        else if (opt === "COUNT") count = Number(val);
        else if (opt === "TYPE") typeFilter = val;
      }
      const ks = d.keys();
      const slice = ks.slice(cursor, cursor + count);
      const next = cursor + count >= ks.length ? 0 : cursor + count;
      const out: RespValue[] = [];
      for (const k of slice) {
        const native = bytesToKey(keyToBytes(k));
        if (pattern && !matchPattern(pattern, native)) continue;
        if (typeFilter) {
          const v = d.getRaw(k);
          if (typeName(v) !== typeFilter) continue;
        }
        out.push({ type: "bulk", value: keyToBytes(k) });
      }
      return RESP.arr([RESP.str(String(next)), RESP.arr(out)]);
    },
  },
  { name: "DBSIZE", arity: 1, handler: (ctx, conn) => RESP.int(db(ctx, conn).size()) },
  {
    name: "FLUSHDB",
    arity: -1,
    handler: (ctx, conn) => { db(ctx, conn).clear(); ctx.keyVersions.set(conn.selectedDb, new Map()); return RESP.ok(); },
  },
  {
    name: "FLUSHALL",
    arity: -1,
    handler: (ctx) => {
      for (const d of ctx.store.dbs) d.clear();
      for (const [k] of ctx.keyVersions) ctx.keyVersions.set(k, new Map());
      return RESP.ok();
    },
  },
  {
    name: "OBJECT",
    arity: -2,
    handler: (ctx, conn, args) => {
      const sub = dec(args[0]!).toUpperCase();
      const d = db(ctx, conn);
      switch (sub) {
        case "ENCODING": {
          const v = d.getRaw(bytesToKey(args[1]!));
          if (!v) return RESP.nil();
          const enc = v.type === "string" ? "raw"
            : v.type === "list" ? "listpack"
            : v.type === "hash" ? "listpack"
            : v.type === "set" ? "listpack"
            : v.type === "zset" ? "listpack"
            : "stream";
          return RESP.str(enc);
        }
        case "REFCOUNT": return RESP.int(1);
        case "IDLETIME": return RESP.int(0);
        case "FREQ": return RESP.int(0);
        case "HELP": return RESP.arr([RESP.str("OBJECT ENCODING|REFCOUNT|IDLETIME|FREQ key")]);
        default: return RESP.err(`ERR Unknown OBJECT subcommand '${sub}'`);
      }
    },
  },
  {
    name: "COPY",
    arity: -3,
    handler: (ctx, conn, args) => {
      const srcDb = db(ctx, conn);
      const src = bytesToKey(args[0]!);
      const dst = bytesToKey(args[1]!);
      let replace = false;
      let destDb = conn.selectedDb;
      for (let i = 2; i < args.length; i++) {
        const opt = dec(args[i]!).toUpperCase();
        if (opt === "REPLACE") replace = true;
        else if (opt === "DB") {
          if (i + 1 >= args.length) return RESP.err("ERR syntax error");
          const parsed = Number(dec(args[++i]!));
          if (!Number.isInteger(parsed) || parsed < 0 || parsed >= ctx.store.dbs.length) {
            return RESP.err("ERR DB index is out of range");
          }
          destDb = parsed;
        } else return RESP.err("ERR syntax error");
      }
      const v = srcDb.getRaw(src);
      if (!v) return RESP.int(0);
      const dd = ctx.store.db(destDb);
      if (!replace && dd.exists(dst)) return RESP.int(0);
      // Propagate source TTL if any; otherwise explicitly clear any stale
      // destination expiry so REPLACE never inherits residual TTL metadata.
      const srcExpiry = srcDb.expires.get(src);
      if (srcExpiry !== undefined) {
        dd.set(dst, deepCopy(v), { expireAt: srcExpiry });
      } else {
        dd.set(dst, deepCopy(v));
        dd.removeExpiry(dst);
      }
      ctx.bumpKey(destDb, dst);
      return RESP.int(1);
    },
  },
  {
    name: "TOUCH",
    arity: -2,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      let n = 0;
      for (const a of args) if (d.exists(bytesToKey(a))) n++;
      return RESP.int(n);
    },
  },
];

function deepCopyStream(s: Stream): Stream {
  const out = new Stream();
  out.lastMs = s.lastMs;
  out.lastSeq = s.lastSeq;
  for (const e of s.entries) {
    out.entries.push({
      id: e.id,
      fields: e.fields.map(([f, v]) => [f, new Uint8Array(v)] as [string, Uint8Array]),
    });
  }
  for (const [name, g] of s.groups) {
    out.groups.set(name, {
      name: g.name,
      lastDelivered: g.lastDelivered,
      pending: new Map(Array.from(g.pending, ([id, p]) => [id, { ...p }])),
      consumers: new Map(Array.from(g.consumers, ([n, c]) => [n, { ...c }])),
    });
  }
  return out;
}

function deepCopy(v: StoredValue): StoredValue {
  switch (v.type) {
    case "string": return { type: "string", value: new Uint8Array(v.value) };
    case "list": return { type: "list", value: v.value.map((b) => new Uint8Array(b)) };
    case "hash": {
      const m = new Map<string, Uint8Array>();
      for (const [k, val] of v.value) m.set(k, new Uint8Array(val));
      return { type: "hash", value: m };
    }
    case "set": return { type: "set", value: new Set(v.value) };
    case "zset": {
      const z = new (v.value.constructor as any)();
      for (const [m, s] of v.value.byMember) z.setScore(m, s);
      return { type: "zset", value: z };
    }
    case "stream": return { type: "stream", value: deepCopyStream(v.value) };
  }
}