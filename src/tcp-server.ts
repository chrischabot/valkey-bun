import type { Socket } from "bun";
import { Connection } from "./connection";
import { parse, parseCommand, RESP, toStr } from "./resp";
import { ServerContext } from "./server-context";
import type { ResolvedConfig } from "./config";
import { buildRegistry, dispatch, dispatchSync } from "./commands";
import { setTransactionRegistry } from "./commands/transactions";
import { Persistence } from "./persistence";

const ENCODER = new TextEncoder();
const EMPTY = new Uint8Array(0);

// The Bun TCP listener exposes stop(); callers only need that on the data
// plane. Narrowing here avoids depending on the Bun TCP|Unix listener union.
export interface RunningServer {
  server: { stop: (closeActiveConnections?: boolean) => void };
  ctx: ServerContext;
}

export function startTcpServer(config: ResolvedConfig & { reusePort?: boolean }): RunningServer {
  const ctx = new ServerContext(config);
  const registry = buildRegistry();
  setTransactionRegistry(registry);
  ctx.registry = registry;

  const cfgMaybe = config as Partial<ResolvedConfig>;
  if (cfgMaybe.dir !== undefined) {
    const persist = new Persistence(ctx, config);
    ctx.persist = persist;
    persist.load();
    persist.start();
  }

  // Per-connection async tail. When set, subsequent commands MUST defer to
  // preserve reply order; the value is the chained promise of pending work.
  const queues = new WeakMap<Connection, Promise<unknown>>();

  function deferAsync(conn: Connection, work: () => Promise<unknown>): void {
    const prev = queues.get(conn) ?? Promise.resolve();
    const next = prev
      .then(() => work())
      .then(() => conn.flush())
      .catch((e) => {
        console.error("[valkey2] async dispatch error:", e);
      });
    queues.set(conn, next);
    next.finally(() => {
      if (queues.get(conn) === next) queues.delete(conn);
    });
  }

  // Bun supports `reusePort` on Bun.listen at runtime, but the bundled
  // bun-types narrows the listen-options union and omits it. Build the
  // options object first, then pass it through a single localized boundary
  // cast so the runtime-valid flag is accepted without weakening anything
  // else. Behavior is identical to a direct typed call.
  const listenOptions = {
    hostname: config.host,
    port: config.port,
    reusePort: config.reusePort ?? false,
    socket: {
      open(socket: Socket<{ conn: Connection }>) {
        const conn = new Connection(socket as unknown as Socket<unknown>);
        socket.data = { conn };
        ctx.connections.add(conn);
      },
      data(socket: Socket<{ conn: Connection }>, data: Uint8Array) {
        const conn = socket.data.conn;
        conn.appendData(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        while (true) {
          // Fast path: typical "*N\r\n($L\r\nbytes\r\n)+" command frame.
          const fast = parseCommand(conn.buffer);
          let name: string;
          let args: Uint8Array[];
          let consumed: number;
          if (fast === null) break; // incomplete
          if (fast === false) {
            // Unusual frame (inline command / RESP3 mixed) - general parser.
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
      close(socket: Socket<{ conn: Connection }>) {
        const conn = socket.data?.conn;
        if (conn) {
          ctx.pubsub.removeConnection(conn);
          ctx.untrackConnection(conn);
          ctx.connections.delete(conn);
          conn.closed = true;
        }
      },
      error(socket: Socket<{ conn: Connection }>) {
        const conn = socket.data?.conn;
        if (conn) {
          ctx.pubsub.removeConnection(conn);
          ctx.untrackConnection(conn);
          ctx.connections.delete(conn);
          conn.closed = true;
        }
      },
    },
  };

  const server = Bun.listen(
    listenOptions as unknown as Parameters<typeof Bun.listen>[0],
  ) as unknown as { stop: (closeActiveConnections?: boolean) => void };

  const sweepTimer = setInterval(() => {
    for (const d of ctx.store.dbs) d.sweepLazy();
  }, 1000);
  (sweepTimer as any).unref?.();

  return { server, ctx };
}