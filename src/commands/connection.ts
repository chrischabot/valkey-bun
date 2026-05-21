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
            const pass = dec(args[i + 2]!);
            // Behave consistently with the AUTH command: only a configured,
            // matching password authenticates. A passwordless server does not
            // elevate the connection (and rejects an explicit wrong password).
            if (!ctx.config.password) {
              return RESP.err("ERR Client sent AUTH, but no password is set. Did you mean AUTH <username> <password>?");
            }
            if (pass !== ctx.config.password) {
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
          const lines = Array.from(ctx.connections).map(
            (c: any) => `id=${c.id} name=${c.name} db=${c.selectedDb}`,
          );
          return RESP.str(lines.join("\n"));
        }
        case "NO-EVICT": case "NO-TOUCH": case "REPLY": case "PAUSE":
        case "UNPAUSE": case "SETINFO": return RESP.ok();
        case "TRACKING": {
          if (args.length < 2) return RESP.err("ERR wrong number of arguments");
          const mode = dec(args[1]!).toUpperCase();
          if (mode !== "ON" && mode !== "OFF") return RESP.err("ERR syntax error");
          let redirect = 0;
          let bcast = false, optin = false, optout = false, noloop = false;
          const prefixes: string[] = [];
          for (let i = 2; i < args.length; i++) {
            const o = dec(args[i]!).toUpperCase();
            if (o === "REDIRECT") {
              if (i + 1 >= args.length) return RESP.err("ERR syntax error");
              redirect = Number(dec(args[++i]!));
              if (!Number.isInteger(redirect) || redirect < 0) return RESP.err("ERR syntax error");
            } else if (o === "PREFIX") {
              if (i + 1 >= args.length) return RESP.err("ERR syntax error");
              prefixes.push(dec(args[++i]!));
            } else if (o === "BCAST") bcast = true;
            else if (o === "OPTIN") optin = true;
            else if (o === "OPTOUT") optout = true;
            else if (o === "NOLOOP") noloop = true;
            else return RESP.err("ERR syntax error");
          }
          if (mode === "OFF") { ctx.untrackConnection(conn); return RESP.ok(); }
          if (optin && optout) {
            return RESP.err("ERR You can't specify both OPTIN mode and OPTOUT mode");
          }
          if (prefixes.length > 0 && !bcast) {
            return RESP.err("ERR PREFIX option requires BCAST mode to be enabled");
          }
          if ((optin || optout) && bcast) {
            return RESP.err("ERR OPTIN and OPTOUT are not compatible with BCAST");
          }
          if (redirect > 0 && !ctx.findConnection(redirect)) {
            return RESP.err("ERR The client ID you want redirect to does not exist");
          }
          ctx.untrackConnection(conn);
          conn.tracking = true;
          conn.trackingBcast = bcast;
          conn.trackingPrefixes = prefixes;
          conn.trackingRedirect = redirect;
          conn.trackingOptin = optin;
          conn.trackingOptout = optout;
          conn.trackingNoloop = noloop;
          conn.caching = null;
          ctx.trackingClients.add(conn);
          return RESP.ok();
        }
        case "CACHING": {
          if (args.length < 2) return RESP.err("ERR wrong number of arguments");
          if (!conn.tracking || (!conn.trackingOptin && !conn.trackingOptout)) {
            return RESP.err("ERR CLIENT CACHING can be called only when the client is in tracking mode with OPTIN or OPTOUT mode enabled");
          }
          const yn = dec(args[1]!).toUpperCase();
          if (yn === "YES") conn.caching = true;
          else if (yn === "NO") conn.caching = false;
          else return RESP.err("ERR syntax error");
          return RESP.ok();
        }
        case "GETREDIR":
          return RESP.int(conn.tracking ? conn.trackingRedirect : -1);
        case "TRACKINGINFO": {
          const flags: any[] = [];
          if (!conn.tracking) flags.push(RESP.str("off"));
          else {
            flags.push(RESP.str("on"));
            if (conn.trackingBcast) flags.push(RESP.str("bcast"));
            if (conn.trackingOptin) flags.push(RESP.str("optin"));
            if (conn.trackingOptout) flags.push(RESP.str("optout"));
            if (conn.trackingNoloop) flags.push(RESP.str("noloop"));
            if (conn.caching === true) flags.push(RESP.str("caching-yes"));
            if (conn.caching === false) flags.push(RESP.str("caching-no"));
          }
          return {
            type: "map",
            value: [
              [RESP.str("flags"), RESP.arr(flags)],
              [RESP.str("redirect"), RESP.int(conn.tracking ? conn.trackingRedirect : -1)],
              [RESP.str("prefixes"), RESP.arr(conn.trackingPrefixes.map((p) => RESP.str(p)))],
            ],
          };
        }
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
      ctx.untrackConnection(conn);
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