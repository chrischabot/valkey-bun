import type { CommandSpec } from "./index";
import { RESP } from "../resp";

const dec = (b: Uint8Array) => new TextDecoder().decode(b);

export const connectionCommands: CommandSpec[] = [
  {
    name: "PING",
    arity: -1,
    subscribeOk: true,
    handler: (_ctx, conn, args) => {
      if (conn.inSubscribeMode()) {
        if (args.length === 0) {
          if (!conn.resp3) return { type: "array", value: [RESP.str("pong"), RESP.str("")] };
          return RESP.pong();
        }
        return { type: "bulk", value: args[0]! };
      }
      if (args.length === 0) return RESP.pong();
      return { type: "bulk", value: args[0]! };
    },
  },
  {
    name: "ECHO",
    arity: 2,
    handler: (_ctx, _conn, args) => ({ type: "bulk", value: args[0]! }),
  },
  {
    name: "AUTH",
    arity: -2,
    handler: (ctx, conn, args) => {
      const password = args.length === 1 ? dec(args[0]!) : dec(args[1]!);
      if (!ctx.config.password) {
        return RESP.err("ERR Client sent AUTH, but no password is set. Did you mean AUTH <username> <password>?");
      }
      if (password === ctx.config.password) {
        conn.authenticated = true;
        return RESP.ok();
      }
      return RESP.err("WRONGPASS invalid username-password pair or user is disabled.");
    },
  },
  {
    name: "HELLO",
    arity: -1,
    handler: (ctx, conn, args) => {
      let proto = conn.resp3 ? 3 : 2;
      let i = 0;
      if (args.length > 0) {
        proto = Number(dec(args[0]!));
        if (proto !== 2 && proto !== 3) return RESP.err("NOPROTO unsupported protocol version");
        i = 1;
        while (i < args.length) {
          const opt = dec(args[i]!).toUpperCase();
          if (opt === "AUTH") {
            if (i + 2 >= args.length) return RESP.err("ERR Syntax error: AUTH requires username and password");
            const _user = dec(args[i + 1]!);
            const pass = dec(args[i + 2]!);
            if (ctx.config.password && pass !== ctx.config.password) {
              return RESP.err("WRONGPASS invalid username-password pair or user is disabled.");
            }
            conn.authenticated = true;
            i += 3;
          } else if (opt === "SETNAME") {
            if (i + 1 >= args.length) return RESP.err("ERR Syntax error: SETNAME requires a value");
            conn.name = dec(args[i + 1]!);
            i += 2;
          } else {
            return RESP.err(`ERR Syntax error, unknown option '${opt}'`);
          }
        }
      }
      conn.resp3 = proto === 3;
      const entries: Array<[any, any]> = [
        [RESP.str("server"), RESP.str("valkey")],
        [RESP.str("version"), RESP.str("7.4.0")],
        [RESP.str("proto"), RESP.int(proto)],
        [RESP.str("id"), RESP.int(conn.id)],
        [RESP.str("mode"), RESP.str("standalone")],
        [RESP.str("role"), RESP.str("master")],
        [RESP.str("modules"), RESP.arr([])],
      ];
      return { type: "map", value: entries };
    },
  },
  {
    name: "SELECT",
    arity: 2,
    handler: (ctx, conn, args) => {
      const idx = Number(dec(args[0]!));
      if (!Number.isInteger(idx) || idx < 0 || idx >= ctx.store.dbs.length) {
        return RESP.err("ERR DB index is out of range");
      }
      conn.selectedDb = idx;
      return RESP.ok();
    },
  },
  {
    name: "CLIENT",
    arity: -2,
    handler: (ctx, conn, args) => {
      const sub = dec(args[0]!).toUpperCase();
      switch (sub) {
        case "GETNAME": return conn.name ? RESP.str(conn.name) : RESP.nil();
        case "SETNAME":
          if (args.length < 2) return RESP.err("ERR wrong number of arguments");
          conn.name = dec(args[1]!);
          return RESP.ok();
        case "ID": return RESP.int(conn.id);
        case "INFO": return RESP.str(`id=${conn.id} name=${conn.name} db=${conn.selectedDb}`);
        case "LIST": {
          const lines = Array.from(ctx.connections).map((c: any) => `id=${c.id} name=${c.name} db=${c.selectedDb}`);
          return RESP.str(lines.join("\n"));
        }
        case "NO-EVICT": case "NO-TOUCH": case "REPLY": case "PAUSE":
        case "UNPAUSE": case "TRACKING": case "SETINFO": return RESP.ok();
        case "GETREDIR": return RESP.int(-1);
        case "TRACKINGINFO":
          return {
            type: "map",
            value: [
              [RESP.str("flags"), RESP.arr([])],
              [RESP.str("redirect"), RESP.int(-1)],
              [RESP.str("prefixes"), RESP.arr([])],
            ],
          };
        case "KILL": return RESP.ok();
        default: return RESP.err(`ERR Unknown CLIENT subcommand '${sub}'`);
      }
    },
  },
  {
    name: "RESET",
    arity: 1,
    subscribeOk: true,
    handler: (ctx, conn) => {
      ctx.pubsub.removeConnection(conn);
      conn.inMulti = false;
      conn.multiQueue = [];
      conn.multiError = false;
      conn.watched.clear();
      conn.selectedDb = 0;
      conn.name = "";
      return RESP.simple("RESET");
    },
  },
  {
    name: "QUIT",
    arity: 1,
    subscribeOk: true,
    handler: (_ctx, conn) => {
      conn.reply(RESP.ok());
      conn.close();
    },
  },
];