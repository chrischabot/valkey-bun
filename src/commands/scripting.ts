import type { CommandSpec } from "./index";
import { RESP } from "../resp";

const dec = (b: Uint8Array) => new TextDecoder().decode(b);

async function sha1(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const h = await crypto.subtle.digest("SHA-1", buf);
  const bytes = new Uint8Array(h);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

const scripts = new Map<string, string>();

export const scriptingCommands: CommandSpec[] = [
  { name: "EVAL", arity: -3, handler: () => RESP.err("ERR Scripting is not supported in this build") },
  { name: "EVALSHA", arity: -3, handler: () => RESP.err("NOSCRIPT No matching script") },
  { name: "EVAL_RO", arity: -3, handler: () => RESP.err("ERR Scripting is not supported in this build") },
  { name: "EVALSHA_RO", arity: -3, handler: () => RESP.err("NOSCRIPT No matching script") },
  {
    name: "SCRIPT",
    arity: -2,
    handler: async (_ctx, _conn, args) => {
      const sub = dec(args[0]!).toUpperCase();
      if (sub === "LOAD") {
        const src = dec(args[1]!);
        const h = await sha1(src);
        scripts.set(h, src);
        return RESP.str(h);
      }
      if (sub === "EXISTS") {
        const out = [];
        for (let i = 1; i < args.length; i++) out.push(RESP.int(scripts.has(dec(args[i]!)) ? 1 : 0));
        return RESP.arr(out);
      }
      if (sub === "FLUSH") { scripts.clear(); return RESP.ok(); }
      return RESP.ok();
    },
  },
  {
    name: "FUNCTION",
    arity: -2,
    handler: (_ctx, _conn, args) => {
      const sub = dec(args[0]!).toUpperCase();
      if (sub === "LIST" || sub === "DUMP" || sub === "STATS") return RESP.arr([]);
      if (sub === "FLUSH" || sub === "DELETE" || sub === "RESTORE") return RESP.ok();
      return RESP.ok();
    },
  },
  { name: "FCALL", arity: -3, handler: () => RESP.err("ERR functions are not supported in this build") },
  { name: "FCALL_RO", arity: -3, handler: () => RESP.err("ERR functions are not supported in this build") },
];