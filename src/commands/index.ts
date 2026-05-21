import type { Connection } from "../connection";
import type { ServerContext } from "../server-context";
import { RESP, type RespValue } from "../resp";
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
  ]) {
    for (const c of group) r.register(c);
  }
  return r;
}

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
      (v) => { if (v !== undefined && v !== null) conn.reply(v); },
      (e: any) => handleErr(conn, e),
    );
  }
  if (out !== undefined && out !== null) conn.reply(out as RespValue);
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
}

const DEC = new TextDecoder();
export function decode(b: Uint8Array): string { return DEC.decode(b); }