import type { CommandSpec } from "./index";
import { RESP, type RespValue } from "../resp";

const dec = (b: Uint8Array) => new TextDecoder().decode(b);

function subscribeReply(conn: any, kind: string, channel: string, count: number): RespValue {
  const items: RespValue[] = [RESP.str(kind), RESP.str(channel), RESP.int(count)];
  return conn.resp3 ? { type: "push", value: items } : RESP.arr(items);
}

export const pubsubCommands: CommandSpec[] = [
  {
    name: "SUBSCRIBE",
    arity: -2,
    subscribeOk: true,
    handler: (ctx, conn, args) => {
      for (const a of args) {
        const ch = dec(a);
        const n = ctx.pubsub.subscribe(conn, ch);
        conn.reply(subscribeReply(conn, "subscribe", ch, n));
      }
    },
  },
  {
    name: "UNSUBSCRIBE",
    arity: -1,
    subscribeOk: true,
    handler: (ctx, conn, args) => {
      const targets = args.length === 0 ? Array.from(conn.subscribedChannels) : args.map(dec);
      if (targets.length === 0) {
        conn.reply(subscribeReply(conn, "unsubscribe", "", 0));
        return;
      }
      for (const ch of targets) {
        const n = ctx.pubsub.unsubscribe(conn, ch);
        conn.reply(subscribeReply(conn, "unsubscribe", ch, n));
      }
    },
  },
  {
    name: "PSUBSCRIBE",
    arity: -2,
    subscribeOk: true,
    handler: (ctx, conn, args) => {
      for (const a of args) {
        const p = dec(a);
        const n = ctx.pubsub.psubscribe(conn, p);
        conn.reply(subscribeReply(conn, "psubscribe", p, n));
      }
    },
  },
  {
    name: "PUNSUBSCRIBE",
    arity: -1,
    subscribeOk: true,
    handler: (ctx, conn, args) => {
      const targets = args.length === 0 ? Array.from(conn.subscribedPatterns) : args.map(dec);
      if (targets.length === 0) {
        conn.reply(subscribeReply(conn, "punsubscribe", "", 0));
        return;
      }
      for (const p of targets) {
        const n = ctx.pubsub.punsubscribe(conn, p);
        conn.reply(subscribeReply(conn, "punsubscribe", p, n));
      }
    },
  },
  {
    name: "PUBLISH",
    arity: 3,
    handler: (ctx, _conn, args) => RESP.int(ctx.pubsub.publish(dec(args[0]!), args[1]!)),
  },
  {
    name: "SPUBLISH",
    arity: 3,
    handler: (ctx, _conn, args) => RESP.int(ctx.pubsub.publish(dec(args[0]!), args[1]!)),
  },
  {
    name: "PUBSUB",
    arity: -2,
    handler: (ctx, _conn, args) => {
      const sub = dec(args[0]!).toUpperCase();
      if (sub === "CHANNELS") {
        const pat = args[1] ? dec(args[1]!) : undefined;
        return RESP.arr(ctx.pubsub.channelList(pat).map((c: string) => RESP.str(c)));
      }
      if (sub === "NUMSUB") {
        const out: RespValue[] = [];
        for (let i = 1; i < args.length; i++) {
          const ch = dec(args[i]!);
          out.push(RESP.str(ch));
          out.push(RESP.int(ctx.pubsub.numSub(ch)));
        }
        return RESP.arr(out);
      }
      if (sub === "NUMPAT") return RESP.int(ctx.pubsub.numPat());
      if (sub === "SHARDCHANNELS") return RESP.arr([]);
      if (sub === "SHARDNUMSUB") return RESP.arr([]);
      return RESP.err(`ERR Unknown PUBSUB subcommand '${sub}'`);
    },
  },
];