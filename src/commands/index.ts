import type { Connection } from "../connection";
import type { ServerContext } from "../server-context";
import { RESP, type RespValue } from "../resp";
import { bytesToKey } from "../store";
import { connectionCommands } from "./connection";
import { keyCommands } from "./keys";
import { stringCommands } from "./strings";
import { hashCommands } from "./hashes";
import { listCommands } from "./lists";
import { setCommands } from "./sets";
import { zsetCommands } from "./zsets";
import { serverCommands } from "./server";
import { pubsubCommands } from "./pubsub";
import { transactionCommands } from "./transactions";
import { streamCommands } from "./streams";
import { scriptingCommands } from "./scripting";
import { bitmapCommands } from "./bitmaps";
import { hllCommands } from "./hll";
import { geoCommands } from "./geo";
import { sortCommands } from "./sort";
import { hashTtlCommands } from "./hash-ttl";

export type CommandHandler = (
  ctx: ServerContext,
  conn: Connection,
  args: Uint8Array[],
) => RespValue | Promise<RespValue> | void | Promise<void>;

export interface CommandSpec {
  name: string;
  arity: number; // counts command name + args; negative => "at least |n|"
  handler: CommandHandler;
  noQueue?: boolean;
  subscribeOk?: boolean;
}

export class Registry {
  private map = new Map<string, CommandSpec>();
  register(spec: CommandSpec): void {
    const upper = spec.name.toUpperCase();
    const lower = spec.name.toLowerCase();
    this.map.set(upper, spec);
    if (lower !== upper) this.map.set(lower, spec);
  }
  get(name: string): CommandSpec | undefined {
    const direct = this.map.get(name);
    if (direct) return direct;
    return this.map.get(name.toUpperCase());
  }
  list(): CommandSpec[] {
    return Array.from(new Set(this.map.values()));
  }
}

export function buildRegistry(): Registry {
  const r = new Registry();
  for (const group of [
    connectionCommands, keyCommands, stringCommands, hashCommands,
    listCommands, setCommands, zsetCommands, serverCommands,
    pubsubCommands, transactionCommands, streamCommands, scriptingCommands,
    bitmapCommands, hllCommands, geoCommands, sortCommands, hashTtlCommands,
  ]) {
    for (const c of group) r.register(c);
  }
  return r;
}

// Commands whose successful execution mutates the keyspace and must be
// appended to the AOF (verbatim RESP frame). Read-only and pure-introspection
// commands are intentionally excluded.
export const WRITE_COMMANDS = new Set([
  // strings
  "SET", "SETNX", "SETEX", "PSETEX", "GETSET", "GETDEL", "GETEX", "APPEND",
  "SETRANGE", "INCR", "DECR", "INCRBY", "DECRBY", "INCRBYFLOAT", "MSET", "MSETNX",
  // keys
  "DEL", "UNLINK", "EXPIRE", "PEXPIRE", "EXPIREAT", "PEXPIREAT", "PERSIST",
  "RENAME", "RENAMENX", "MOVE", "COPY", "FLUSHDB", "FLUSHALL", "RESTORE",
  "SORT",
  // hashes
  "HSET", "HMSET", "HSETNX", "HDEL", "HINCRBY", "HINCRBYFLOAT",
  "HEXPIRE", "HPEXPIRE", "HEXPIREAT", "HPEXPIREAT", "HPERSIST", "HGETDEL", "HGETEX",
  // lists
  "LPUSH", "RPUSH", "LPUSHX", "RPUSHX", "LPOP", "RPOP", "LSET", "LREM",
  "LTRIM", "LINSERT", "LMOVE", "RPOPLPUSH", "BLPOP", "BRPOP", "BLMOVE",
  "BRPOPLPUSH", "LMPOP", "BLMPOP",
  // sets
  "SADD", "SREM", "SPOP", "SMOVE", "SUNIONSTORE", "SINTERSTORE", "SDIFFSTORE",
  // zsets
  "ZADD", "ZREM", "ZINCRBY", "ZPOPMIN", "ZPOPMAX", "ZUNIONSTORE",
  "ZINTERSTORE", "ZDIFFSTORE", "ZRANGESTORE", "ZMPOP", "BZMPOP",
  "BZPOPMIN", "BZPOPMAX", "ZREMRANGEBYRANK", "ZREMRANGEBYSCORE", "ZREMRANGEBYLEX",
  // streams
  "XADD", "XDEL", "XTRIM", "XSETID", "XGROUP", "XREADGROUP", "XACK",
  "XCLAIM", "XAUTOCLAIM",
  // bitmaps / hll / geo
  "SETBIT", "BITOP", "BITFIELD", "PFADD", "PFMERGE", "GEOADD", "GEOSEARCHSTORE",
  // server
  "SWAPDB",
]);

// Write commands that set a *relative* TTL: after logging the verbatim
// command we also log an absolute PEXPIREAT (key is always args[0] for these)
// so AOF replay is time-correct regardless of when it runs. Absolute or
// deterministic TTL commands (EXPIREAT/PEXPIREAT/PERSIST/GETDEL/COPY/RESTORE)
// replay verbatim correctly and need no follow-up.
const TTL_COMMANDS = new Set([
  "EXPIRE", "PEXPIRE", "SETEX", "PSETEX", "GETEX", "SET",
]);

const SUBSCRIBE_ALLOWED = new Set([
  "SUBSCRIBE", "UNSUBSCRIBE", "PSUBSCRIBE", "PUNSUBSCRIBE",
  "SSUBSCRIBE", "SUNSUBSCRIBE", "PING", "QUIT", "RESET",
]);
const AUTH_ALLOWED = new Set(["AUTH", "HELLO", "QUIT", "PING"]);

function preDispatch(
  ctx: ServerContext,
  conn: Connection,
  registry: Registry,
  name: string,
  args: Uint8Array[],
): CommandSpec | null {
  const spec = registry.get(name);
  let upper: string | null = null;
  const getUpper = () => upper ?? (upper = name.toUpperCase());

  if (ctx.config.password && !conn.authenticated && !AUTH_ALLOWED.has(getUpper())) {
    conn.reply(RESP.err("NOAUTH Authentication required."));
    return null;
  }
  if (!spec) {
    conn.reply(RESP.err(`ERR unknown command '${name.toLowerCase()}'`));
    return null;
  }
  const want = spec.arity;
  const got = 1 + args.length;
  if (want >= 0 ? got !== want : got < -want) {
    conn.reply(RESP.err(`ERR wrong number of arguments for '${name.toLowerCase()}' command`));
    if (conn.inMulti) conn.multiError = true;
    return null;
  }
  if (conn.inSubscribeMode() && !SUBSCRIBE_ALLOWED.has(getUpper())) {
    conn.reply(
      RESP.err(
        `ERR Can't execute '${name.toLowerCase()}': only (P|S)SUBSCRIBE / (P|S)UNSUBSCRIBE / PING / QUIT / RESET are allowed in this context`,
      ),
    );
    return null;
  }
  if (conn.inMulti && !spec.noQueue) {
    conn.multiQueue.push({ name: getUpper(), args });
    conn.reply(RESP.simple("QUEUED"));
    return null;
  }
  return spec;
}

function handleErr(conn: Connection, e: any): void {
  const msg = e?.message ?? String(e);
  conn.reply(
    RESP.err(
      msg.startsWith("ERR ") || msg.startsWith("WRONGTYPE") || msg.startsWith("NOAUTH")
        ? msg
        : `ERR ${msg}`,
    ),
  );
  if (conn.inMulti) conn.multiError = true;
}

// AOF append for a successfully-executed write. `out` is the handler reply;
// an error reply means the command did not mutate, so it is not logged.
function maybeFeedAof(
  ctx: ServerContext,
  conn: Connection,
  name: string,
  args: Uint8Array[],
  out: RespValue | undefined,
): void {
  if (!ctx.persist || ctx.aofLoading) return;
  if (out && (out as RespValue).type === "error") return;
  const upper = name.toUpperCase();
  if (!WRITE_COMMANDS.has(upper)) return;
  let ttlKeys: string[] | undefined;
  if (TTL_COMMANDS.has(upper) && args.length > 0) {
    ttlKeys = [bytesToKey(args[0]!)];
  }
  ctx.persist.feed(conn.selectedDb, upper, args, ttlKeys);
}

// Family → keyspace event class char (Redis: g $ l s h z x).
const STRING_CMDS = new Set([
  "SET", "SETNX", "SETEX", "PSETEX", "GETSET", "GETDEL", "GETEX", "APPEND",
  "SETRANGE", "INCR", "DECR", "INCRBY", "DECRBY", "INCRBYFLOAT", "MSET",
  "MSETNX", "SETBIT", "BITFIELD", "BITOP", "PFADD", "PFMERGE",
]);
const LIST_CMDS = new Set([
  "LPUSH", "RPUSH", "LPUSHX", "RPUSHX", "LPOP", "RPOP", "LSET", "LREM",
  "LTRIM", "LINSERT", "LMOVE", "RPOPLPUSH", "BLPOP", "BRPOP", "BLMOVE",
  "BRPOPLPUSH", "LMPOP", "BLMPOP",
]);
const SET_CMDS = new Set([
  "SADD", "SREM", "SPOP", "SMOVE", "SUNIONSTORE", "SINTERSTORE", "SDIFFSTORE",
]);
const HASH_CMDS = new Set([
  "HSET", "HMSET", "HSETNX", "HDEL", "HINCRBY", "HINCRBYFLOAT",
]);
const ZSET_CMDS = new Set([
  "ZADD", "ZREM", "ZINCRBY", "ZPOPMIN", "ZPOPMAX", "ZUNIONSTORE",
  "ZINTERSTORE", "ZDIFFSTORE", "ZRANGESTORE", "ZMPOP", "BZMPOP",
  "BZPOPMIN", "BZPOPMAX", "ZREMRANGEBYRANK", "ZREMRANGEBYSCORE",
  "ZREMRANGEBYLEX", "GEOADD", "GEOSEARCHSTORE",
]);
const STREAM_CMDS = new Set([
  "XADD", "XDEL", "XTRIM", "XSETID", "XGROUP", "XREADGROUP", "XACK",
  "XCLAIM", "XAUTOCLAIM",
]);

function clsFor(upper: string): string {
  if (STRING_CMDS.has(upper)) return "$";
  if (LIST_CMDS.has(upper)) return "l";
  if (SET_CMDS.has(upper)) return "s";
  if (HASH_CMDS.has(upper)) return "h";
  if (ZSET_CMDS.has(upper)) return "z";
  if (STREAM_CMDS.has(upper)) return "x";
  return "g";
}

const EVENT_NAME: Record<string, string> = {
  SETNX: "set", SETEX: "set", PSETEX: "set", GETSET: "set", GETDEL: "del",
  GETEX: "expire", INCR: "incrby", DECR: "decrby", DECRBY: "decrby",
  HMSET: "hset", HSETNX: "hset", LPUSHX: "lpush", RPUSHX: "rpush",
  BLPOP: "lpop", BRPOP: "rpop", LMPOP: "lpop", BLMPOP: "lpop",
  BZPOPMIN: "zpopmin", BZPOPMAX: "zpopmax", ZMPOP: "zpopmin",
  BZMPOP: "zpopmin", ZINCRBY: "zincr", PFADD: "pfadd", PFMERGE: "pfadd",
  GEOADD: "zadd", SETBIT: "setbit", BITFIELD: "setbit",
};

function maybeNotifyKeyspace(
  ctx: ServerContext,
  conn: Connection,
  name: string,
  args: Uint8Array[],
  out: RespValue | undefined,
): void {
  if (ctx.aofLoading || !ctx.notifyEnabled()) return;
  if (out && (out as RespValue).type === "error") return;
  const upper = name.toUpperCase();
  if (!WRITE_COMMANDS.has(upper)) return;
  const db = conn.selectedDb;
  if (upper === "DEL" || upper === "UNLINK") {
    for (const a of args) ctx.notifyKeyspace(db, bytesToKey(a), "del", "g");
    return;
  }
  if (upper === "MSET" || upper === "MSETNX") {
    for (let i = 0; i + 1 < args.length; i += 2) {
      ctx.notifyKeyspace(db, bytesToKey(args[i]!), "set", "$");
    }
    return;
  }
  if (upper === "RENAME" || upper === "RENAMENX") {
    ctx.notifyKeyspace(db, bytesToKey(args[0]!), "rename_from", "g");
    ctx.notifyKeyspace(db, bytesToKey(args[1]!), "rename_to", "g");
    return;
  }
  if (upper === "COPY") { ctx.notifyKeyspace(db, bytesToKey(args[1]!), "copy_to", "g"); return; }
  if (upper === "MOVE") { ctx.notifyKeyspace(db, bytesToKey(args[0]!), "move_from", "g"); return; }
  if (upper === "SMOVE") {
    ctx.notifyKeyspace(db, bytesToKey(args[0]!), "srem", "s");
    ctx.notifyKeyspace(db, bytesToKey(args[1]!), "sadd", "s");
    return;
  }
  if (upper === "LMOVE" || upper === "BLMOVE") {
    const td = new TextDecoder();
    const from = (args[2] ? td.decode(args[2]) : "").toUpperCase();
    const to = (args[3] ? td.decode(args[3]) : "").toUpperCase();
    ctx.notifyKeyspace(db, bytesToKey(args[0]!), from === "LEFT" ? "lpop" : "rpop", "l");
    ctx.notifyKeyspace(db, bytesToKey(args[1]!), to === "LEFT" ? "lpush" : "rpush", "l");
    return;
  }
  if (upper === "RPOPLPUSH" || upper === "BRPOPLPUSH") {
    ctx.notifyKeyspace(db, bytesToKey(args[0]!), "rpop", "l");
    ctx.notifyKeyspace(db, bytesToKey(args[1]!), "lpush", "l");
    return;
  }
  if (upper === "FLUSHDB" || upper === "FLUSHALL" || upper === "SWAPDB") return;
  if (args.length === 0) return;
  ctx.notifyKeyspace(db, bytesToKey(args[0]!), EVENT_NAME[upper] ?? upper.toLowerCase(), clsFor(upper));
}

export function postWrite(
  ctx: ServerContext,
  conn: Connection,
  name: string,
  args: Uint8Array[],
  out: RespValue | undefined,
): void {
  maybeFeedAof(ctx, conn, name, args, out);
  maybeNotifyKeyspace(ctx, conn, name, args, out);
  maybeInvalidate(ctx, conn, name, args, out);
}

const READ_COMMANDS = new Set([
  "GET", "GETRANGE", "SUBSTR", "STRLEN", "MGET", "EXISTS", "TYPE", "TTL",
  "PTTL", "GETBIT", "BITCOUNT", "BITPOS", "DUMP", "OBJECT",
  "HGET", "HMGET", "HGETALL", "HKEYS", "HVALS", "HLEN", "HEXISTS",
  "HSTRLEN", "HRANDFIELD", "HSCAN",
  "LRANGE", "LINDEX", "LLEN", "LPOS",
  "SMEMBERS", "SISMEMBER", "SMISMEMBER", "SCARD", "SRANDMEMBER", "SSCAN",
  "SINTERCARD",
  "ZSCORE", "ZMSCORE", "ZCARD", "ZCOUNT", "ZRANK", "ZREVRANK", "ZRANGE",
  "ZREVRANGE", "ZRANGEBYSCORE", "ZREVRANGEBYSCORE", "ZRANGEBYLEX",
  "ZREVRANGEBYLEX", "ZSCAN", "ZINTERCARD",
  "XRANGE", "XREVRANGE", "XLEN",
  "HTTL", "HPTTL", "HEXPIRETIME", "HPEXPIRETIME",
]);

function maybeTrackRead(
  ctx: ServerContext, conn: Connection, name: string, args: Uint8Array[],
  out: RespValue | undefined,
): void {
  if (!conn.tracking || conn.trackingBcast || args.length === 0) return;
  if (out && (out as RespValue).type === "error") return;
  const upper = name.toUpperCase();
  if (!READ_COMMANDS.has(upper)) return;
  const db = conn.selectedDb;
  if (upper === "MGET" || upper === "EXISTS") {
    for (const a of args) ctx.trackKeyRead(conn, db, bytesToKey(a));
  } else {
    ctx.trackKeyRead(conn, db, bytesToKey(args[0]!));
  }
  conn.caching = null;
}

function affectedKeys(upper: string, args: Uint8Array[]): string[] {
  if (upper === "DEL" || upper === "UNLINK") return args.map((a) => bytesToKey(a));
  if (upper === "MSET" || upper === "MSETNX") {
    const ks: string[] = [];
    for (let i = 0; i + 1 < args.length; i += 2) ks.push(bytesToKey(args[i]!));
    return ks;
  }
  if (upper === "RENAME" || upper === "RENAMENX") return [bytesToKey(args[0]!), bytesToKey(args[1]!)];
  if (upper === "COPY") return [bytesToKey(args[1]!)];
  if (upper === "MOVE") return [bytesToKey(args[0]!)];
  if (upper === "SMOVE" || upper === "LMOVE" || upper === "RPOPLPUSH"
    || upper === "BLMOVE" || upper === "BRPOPLPUSH") {
    return [bytesToKey(args[0]!), bytesToKey(args[1]!)];
  }
  if (args.length === 0) return [];
  return [bytesToKey(args[0]!)];
}

function maybeInvalidate(
  ctx: ServerContext, conn: Connection, name: string, args: Uint8Array[],
  out: RespValue | undefined,
): void {
  if (ctx.aofLoading || ctx.trackingClients.size === 0) return;
  if (out && (out as RespValue).type === "error") return;
  const upper = name.toUpperCase();
  if (upper === "FLUSHALL" || upper === "FLUSHDB") { ctx.invalidateAll(conn); return; }
  if (!WRITE_COMMANDS.has(upper)) return;
  const db = conn.selectedDb;
  for (const k of affectedKeys(upper, args)) ctx.invalidateKey(db, k, conn);
}

// Synchronous fast path. Caller must ensure no prior async work is pending for
// this connection (the server loop guards via a per-conn queue). Returns a
// Promise iff the handler returned a thenable; otherwise null.
export function dispatchSync(
  ctx: ServerContext,
  conn: Connection,
  registry: Registry,
  name: string,
  args: Uint8Array[],
): Promise<unknown> | null {
  const spec = preDispatch(ctx, conn, registry, name, args);
  if (!spec) return null;
  ctx.totalCommands++;
  let out: any;
  try {
    out = spec.handler(ctx, conn, args);
  } catch (e: any) {
    handleErr(conn, e);
    return null;
  }
  if (out && typeof out.then === "function") {
    return (out as Promise<RespValue | undefined>).then(
      (v) => {
        if (v !== undefined && v !== null) conn.reply(v);
        postWrite(ctx, conn, name, args, v ?? undefined);
        maybeTrackRead(ctx, conn, name, args, v ?? undefined);
      },
      (e: any) => handleErr(conn, e),
    );
  }
  if (out !== undefined && out !== null) conn.reply(out as RespValue);
  postWrite(ctx, conn, name, args, out ?? undefined);
  maybeTrackRead(ctx, conn, name, args, out ?? undefined);
  return null;
}

// Full async dispatch (used by EXEC replay and the per-conn deferred queue).
export async function dispatch(
  ctx: ServerContext,
  conn: Connection,
  registry: Registry,
  name: string,
  args: Uint8Array[],
): Promise<void> {
  const spec = preDispatch(ctx, conn, registry, name, args);
  if (!spec) return;
  ctx.totalCommands++;
  let out: any;
  try {
    out = await spec.handler(ctx, conn, args);
  } catch (e: any) {
    handleErr(conn, e);
    return;
  }
  if (out !== undefined && out !== null) conn.reply(out as RespValue);
  postWrite(ctx, conn, name, args, out ?? undefined);
  maybeTrackRead(ctx, conn, name, args, out ?? undefined);
}

const DEC = new TextDecoder();
export function decode(b: Uint8Array): string { return DEC.decode(b); }