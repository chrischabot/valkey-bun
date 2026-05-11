import type { CommandSpec } from "./index";
import { dispatch, type Registry } from "./index";
import { RESP, type RespValue } from "../resp";
import { bytesToKey } from "../store";

let registryRef: Registry | null = null;
export function setTransactionRegistry(r: Registry) { registryRef = r; }

export const transactionCommands: CommandSpec[] = [
  {
    name: "MULTI",
    arity: 1,
    noQueue: true,
    handler: (_ctx, conn) => {
      if (conn.inMulti) return RESP.err("ERR MULTI calls can not be nested");
      conn.inMulti = true;
      conn.multiQueue = [];
      conn.multiError = false;
      return RESP.ok();
    },
  },
  {
    name: "DISCARD",
    arity: 1,
    noQueue: true,
    handler: (_ctx, conn) => {
      if (!conn.inMulti) return RESP.err("ERR DISCARD without MULTI");
      conn.inMulti = false;
      conn.multiQueue = [];
      conn.multiError = false;
      conn.watched.clear();
      return RESP.ok();
    },
  },
  {
    name: "EXEC",
    arity: 1,
    noQueue: true,
    handler: async (ctx, conn) => {
      if (!conn.inMulti) return RESP.err("ERR EXEC without MULTI");
      // Check WATCH versions.
      let aborted = false;
      for (const [dbIdx, watched] of conn.watched) {
        for (const [key, version] of watched) {
          if (ctx.keyVersion(dbIdx, key) !== version) {
            aborted = true;
            break;
          }
        }
        if (aborted) break;
      }
      const queue = conn.multiQueue;
      const hadError = conn.multiError;
      conn.inMulti = false;
      conn.multiQueue = [];
      conn.multiError = false;
      conn.watched.clear();
      if (hadError) return RESP.err("EXECABORT Transaction discarded because of previous errors.");
      if (aborted) return RESP.arr(null);
      if (!registryRef) return RESP.err("ERR registry not initialized");
      // Capture replies during execution.
      const captured: RespValue[] = [];
      const origReply = conn.reply.bind(conn);
      conn.reply = (v: RespValue) => { captured.push(v); };
      try {
        for (const q of queue) {
          await dispatch(ctx, conn, registryRef, q.name, q.args);
        }
      } finally {
        conn.reply = origReply;
      }
      return RESP.arr(captured);
    },
  },
  {
    name: "WATCH",
    arity: -2,
    noQueue: true,
    handler: (ctx, conn, args) => {
      if (conn.inMulti) return RESP.err("ERR WATCH inside MULTI is not allowed");
      let m = conn.watched.get(conn.selectedDb);
      if (!m) {
        m = new Map();
        conn.watched.set(conn.selectedDb, m);
      }
      for (const a of args) {
        const k = bytesToKey(a);
        m.set(k, ctx.keyVersion(conn.selectedDb, k));
      }
      return RESP.ok();
    },
  },
  {
    name: "UNWATCH",
    arity: 1,
    noQueue: true,
    handler: (_ctx, conn) => {
      conn.watched.clear();
      return RESP.ok();
    },
  },
];