import type { Socket } from "bun";
import { Connection } from "./connection";
import { parse, parseCommand, RESP, toStr } from "./resp";
import { ServerContext, type ServerConfig } from "./server-context";
import { buildRegistry, dispatch, dispatchSync } from "./commands";
import { setTransactionRegistry } from "./commands/transactions";

const ENCODER = new TextEncoder();
const EMPTY = new Uint8Array(0);

export function startServer(config: ServerConfig & { reusePort?: boolean } = {} as any) {
  const ctx = new ServerContext(config);
  const registry = buildRegistry();
  setTransactionRegistry(registry);

  const queues = new WeakMap<Connection, Promise<unknown>>();

  function deferAsync(conn: Connection, work: () => Promise<unknown>): void {
    const prev = queues.get(conn) ?? Promise.resolve();
    const next = prev
      .then(() => work())
      .then(() => conn.flush())
      .catch((e) => {
        // Surface unexpected errors so they're not silently lost.
        console.error("[valkey-bun] async dispatch error:", e);
      });
    queues.set(conn, next);
    next.finally(() => {
      if (queues.get(conn) === next) queues.delete(conn);
    });
  }

  const server = Bun.listen<{ conn: Connection }>({
    hostname: config.host,
    port: config.port,
    reusePort: config.reusePort ?? false,
    socket: {
      open(socket) {
        const conn = new Connection(socket as Socket<unknown>);
        socket.data = { conn };
        ctx.connections.add(conn);
      },
      data(socket, data) {
        const conn = socket.data.conn;
        conn.appendData(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        while (true) {
          const fast = parseCommand(conn.buffer);
          let name: string;
          let args: Uint8Array[];
          let consumed: number;
          if (fast === null) break;
          if (fast === false) {
            const r = parse(conn.buffer);
            if (!r) break;
            consumed = r.next;
            const v = r.value;
            if (v.type !== "array" || v.value === null || v.value.length === 0) {
              conn.consume(consumed);
              conn.reply(RESP.err("ERR invalid request"));
              continue;
            }
            name = toStr(v.value[0]!);
            const argc = v.value.length - 1;
            args = new Array(argc);
            for (let i = 0; i < argc; i++) {
              const item = v.value[i + 1]!;
              if (item.type === "bulk" && item.value) args[i] = item.value;
              else if (item.type === "simple") args[i] = ENCODER.encode(item.value);
              else if (item.type === "integer") args[i] = ENCODER.encode(String(item.value));
              else args[i] = EMPTY;
            }
          } else {
            name = fast.cmd;
            args = fast.args;
            consumed = fast.next;
          }
          conn.consume(consumed);

          if (queues.has(conn)) {
            deferAsync(conn, () => dispatch(ctx, conn, registry, name, args));
            continue;
          }

          const maybe = dispatchSync(ctx, conn, registry, name, args);
          if (maybe) deferAsync(conn, () => maybe);
        }
        conn.flush();
      },
      close(socket) {
        const conn = socket.data?.conn;
        if (conn) {
          ctx.pubsub.removeConnection(conn);
          ctx.connections.delete(conn);
          conn.closed = true;
        }
      },
      error(socket, _err) {
        const conn = socket.data?.conn;
        if (conn) {
          ctx.pubsub.removeConnection(conn);
          ctx.connections.delete(conn);
          conn.closed = true;
        }
      },
    },
  });

  const sweepTimer = setInterval(() => {
    for (const d of ctx.store.dbs) d.sweepLazy();
  }, 1000);
  (sweepTimer as any).unref?.();

  return { server, ctx };
}