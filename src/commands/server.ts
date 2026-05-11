import type { CommandSpec } from "./index";
import { RESP, type RespValue } from "../resp";
import { matchPattern } from "../pubsub";

const dec = (b: Uint8Array) => new TextDecoder().decode(b);

export const serverCommands: CommandSpec[] = [
  {
    name: "INFO",
    arity: -1,
    handler: (ctx) => {
      const uptime = Math.floor((Date.now() - ctx.startTime) / 1000);
      const sections: Record<string, Record<string, string | number>> = {
        Server: {
          redis_version: "7.4.0",
          redis_git_sha1: "00000000",
          redis_git_dirty: 0,
          redis_build_id: "valkey-bun",
          redis_mode: "standalone",
          os: "Linux",
          arch_bits: 64,
          process_id: process.pid,
          run_id: "valkey-bun-" + ctx.startTime.toString(16),
          tcp_port: ctx.config.port,
          uptime_in_seconds: uptime,
          uptime_in_days: Math.floor(uptime / 86400),
          executable: "bun",
        },
        Clients: {
          connected_clients: ctx.connections.size,
          maxclients: ctx.config.maxClients,
        },
        Memory: {
          used_memory: process.memoryUsage().heapUsed,
          used_memory_human: `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)}M`,
          maxmemory: 0,
          maxmemory_policy: "noeviction",
        },
        Persistence: { loading: 0, rdb_changes_since_last_save: 0, rdb_bgsave_in_progress: 0, aof_enabled: 0 },
        Stats: { total_connections_received: ctx.connections.size, total_commands_processed: 0, instantaneous_ops_per_sec: 0 },
        Replication: { role: "master", connected_slaves: 0, master_replid: "0".repeat(40), master_repl_offset: 0 },
        CPU: { used_cpu_sys: 0, used_cpu_user: 0 },
        Keyspace: {},
      };
      ctx.store.dbs.forEach((d: any, i: number) => {
        const sz = d.size();
        if (sz > 0) sections.Keyspace[`db${i}`] = `keys=${sz},expires=${d.expires.size},avg_ttl=0`;
      });
      const lines: string[] = [];
      for (const [name, kv] of Object.entries(sections)) {
        lines.push(`# ${name}`);
        for (const [k, v] of Object.entries(kv)) lines.push(`${k}:${v}`);
        lines.push("");
      }
      return { type: "bulk", value: new TextEncoder().encode(lines.join("\r\n")) };
    },
  },
  {
    name: "COMMAND",
    arity: -1,
    handler: (_ctx, conn, args) => {
      if (args.length === 0) return RESP.arr([]);
      const sub = dec(args[0]!).toUpperCase();
      switch (sub) {
        case "COUNT": return RESP.int(200);
        case "LIST": return RESP.arr([]);
        case "DOCS": return conn.resp3 ? { type: "map", value: [] } : RESP.arr([]);
        case "INFO": {
          const out: RespValue[] = [];
          for (let i = 1; i < args.length; i++) out.push(RESP.nil());
          return RESP.arr(out);
        }
        case "GETKEYS": return RESP.arr([]);
        default: return RESP.err(`ERR Unknown COMMAND subcommand '${sub}'`);
      }
    },
  },
  {
    name: "CONFIG",
    arity: -2,
    handler: (ctx, _conn, args) => {
      const sub = dec(args[0]!).toUpperCase();
      switch (sub) {
        case "GET": {
          const out: RespValue[] = [];
          for (let i = 1; i < args.length; i++) {
            const pat = dec(args[i]!);
            for (const [k, v] of ctx.configMap) {
              if (matchPattern(pat, k)) { out.push(RESP.str(k)); out.push(RESP.str(v)); }
            }
          }
          return RESP.arr(out);
        }
        case "SET":
          for (let i = 1; i < args.length; i += 2) ctx.configMap.set(dec(args[i]!).toLowerCase(), dec(args[i + 1]!));
          return RESP.ok();
        case "RESETSTAT":
        case "REWRITE": return RESP.ok();
        default: return RESP.err(`ERR Unknown CONFIG subcommand '${sub}'`);
      }
    },
  },
  {
    name: "DEBUG",
    arity: -2,
    handler: async (_ctx, _conn, args) => {
      const sub = dec(args[0]!).toUpperCase();
      if (sub === "SLEEP") {
        const sec = Number(dec(args[1]!));
        await new Promise((r) => setTimeout(r, sec * 1000));
        return RESP.ok();
      }
      if (sub === "OBJECT") return RESP.str("Value at:0x0 refcount:1 encoding:raw serializedlength:0 lru:0 lru_seconds_idle:0");
      return RESP.ok();
    },
  },
  {
    name: "TIME",
    arity: 1,
    handler: () => {
      const ms = Date.now();
      return RESP.arr([RESP.str(String(Math.floor(ms / 1000))), RESP.str(String((ms % 1000) * 1000))]);
    },
  },
  { name: "SHUTDOWN", arity: -1, handler: () => { setTimeout(() => process.exit(0), 50); return RESP.ok(); } },
  { name: "LASTSAVE", arity: 1, handler: (ctx) => RESP.int(Math.floor(ctx.startTime / 1000)) },
  { name: "BGSAVE", arity: -1, handler: () => RESP.simple("Background saving started") },
  { name: "SAVE", arity: 1, handler: () => RESP.ok() },
  { name: "BGREWRITEAOF", arity: 1, handler: () => RESP.simple("Background append only file rewriting started") },
  {
    name: "MEMORY",
    arity: -2,
    handler: (_ctx, _conn, args) => {
      const sub = dec(args[0]!).toUpperCase();
      if (sub === "USAGE") return RESP.int(0);
      if (sub === "STATS") return RESP.arr([]);
      if (sub === "PURGE") return RESP.ok();
      if (sub === "DOCTOR") return RESP.str("Sam, I detected a few issues in this Valkey instance memory implants:\n\n - Nothing detected.\n");
      return RESP.ok();
    },
  },
  {
    name: "LATENCY",
    arity: -2,
    handler: (_ctx, _conn, args) => {
      const sub = dec(args[0]!).toUpperCase();
      if (sub === "RESET") return RESP.int(0);
      if (sub === "HISTORY" || sub === "LATEST") return RESP.arr([]);
      if (sub === "GRAPH") return RESP.str("");
      if (sub === "DOCTOR") return RESP.str("Dave, no latency issues detected.\n");
      return RESP.ok();
    },
  },
  {
    name: "SLOWLOG",
    arity: -2,
    handler: (_ctx, _conn, args) => {
      const sub = dec(args[0]!).toUpperCase();
      if (sub === "GET") return RESP.arr([]);
      if (sub === "RESET") return RESP.ok();
      if (sub === "LEN") return RESP.int(0);
      if (sub === "HELP") return RESP.arr([RESP.str("SLOWLOG GET|RESET|LEN")]);
      return RESP.ok();
    },
  },
  { name: "WAIT", arity: 3, handler: () => RESP.int(0) },
  { name: "FAILOVER", arity: -1, handler: () => RESP.ok() },
  {
    name: "MODULE",
    arity: -2,
    handler: (_ctx, _conn, args) => dec(args[0]!).toUpperCase() === "LIST" ? RESP.arr([]) : RESP.ok(),
  },
  {
    name: "ACL",
    arity: -2,
    handler: (_ctx, _conn, args) => {
      const sub = dec(args[0]!).toUpperCase();
      if (sub === "WHOAMI") return RESP.str("default");
      if (sub === "LIST") return RESP.arr([RESP.str("user default on nopass ~* &* +@all")]);
      if (sub === "GETUSER" || sub === "CAT") return RESP.arr([]);
      if (sub === "USERS") return RESP.arr([RESP.str("default")]);
      return RESP.ok();
    },
  },
  {
    name: "CLUSTER",
    arity: -2,
    handler: (_ctx, _conn, args) => {
      const sub = dec(args[0]!).toUpperCase();
      if (sub === "INFO") return RESP.str("cluster_enabled:0\r\ncluster_state:ok\r\ncluster_slots_assigned:0\r\ncluster_slots_ok:0\r\n");
      if (sub === "NODES") return RESP.str("");
      if (sub === "MYID") return RESP.str("0".repeat(40));
      if (sub === "COUNTKEYSINSLOT") return RESP.int(0);
      if (sub === "SLOTS" || sub === "SHARDS") return RESP.arr([]);
      if (sub === "KEYSLOT") return RESP.int(0);
      return RESP.ok();
    },
  },
  {
    name: "SWAPDB",
    arity: 3,
    handler: (ctx, _conn, args) => {
      const aStr = dec(args[0]!);
      const bStr = dec(args[1]!);
      const a = Number(aStr);
      const b = Number(bStr);
      if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 ||
          a >= ctx.store.dbs.length || b >= ctx.store.dbs.length) {
        return RESP.err("ERR DB index is out of range");
      }
      [ctx.store.dbs[a], ctx.store.dbs[b]] = [ctx.store.dbs[b]!, ctx.store.dbs[a]!];
      return RESP.ok();
    },
  },
  {
    name: "MOVE",
    arity: 3,
    handler: (ctx, conn, args) => {
      const dbIdx = Number(dec(args[1]!));
      if (!Number.isInteger(dbIdx) || dbIdx < 0 || dbIdx >= ctx.store.dbs.length) {
        return RESP.err("ERR DB index is out of range");
      }
      const src = ctx.store.db(conn.selectedDb);
      const dst = ctx.store.db(dbIdx);
      const key = dec(args[0]!);
      const v = src.getRaw(key);
      if (!v) return RESP.int(0);
      if (dst.exists(key)) return RESP.int(0);
      dst.set(key, v);
      src.delete(key);
      return RESP.int(1);
    },
  },
];