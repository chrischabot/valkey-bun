import type { CommandSpec } from "./index";
import { RESP, type RespValue } from "../resp";
import {
  runScript, sha1hex, functionLoad, functionCall, type FunctionLib,
} from "../lua";

const dec = (b: Uint8Array) => new TextDecoder().decode(b);

// Server-wide caches (a single process owns one registry, exactly like a
// standalone redis-server). SCRIPT FLUSH / FUNCTION FLUSH clear them.
const scripts = new Map<string, string>();              // sha1 -> source
const funcLibs = new Map<string, FunctionLib>();        // libname -> lib
const funcIndex = new Map<string, string>();            // function -> libname

function reindex(): void {
  funcIndex.clear();
  for (const lib of funcLibs.values()) {
    for (const fn of lib.functions) funcIndex.set(fn, lib.name);
  }
}

function parseNumkeys(args: Uint8Array[]): { keys: Uint8Array[]; argv: Uint8Array[] } | RespValue {
  const numkeys = Number(dec(args[1]!));
  if (!Number.isInteger(numkeys) || numkeys < 0) {
    return RESP.err("ERR Number of keys can't be negative");
  }
  if (numkeys > args.length - 2) {
    return RESP.err("ERR Number of keys can't be greater than number of args");
  }
  return { keys: args.slice(2, 2 + numkeys), argv: args.slice(2 + numkeys) };
}

function evalCmd(readonly: boolean) {
  return (ctx: any, conn: any, args: Uint8Array[]): RespValue => {
    const src = dec(args[0]!);
    const split = parseNumkeys(args);
    if (!Array.isArray((split as any).keys)) return split as RespValue;
    const { keys, argv } = split as { keys: Uint8Array[]; argv: Uint8Array[] };
    scripts.set(sha1hex(src), src);
    return runScript(ctx, conn, src, keys, argv, readonly);
  };
}

function evalShaCmd(readonly: boolean) {
  return (ctx: any, conn: any, args: Uint8Array[]): RespValue => {
    const sha = dec(args[0]!).toLowerCase();
    const src = scripts.get(sha);
    if (src === undefined) return RESP.err("NOSCRIPT No matching script. Please use EVAL.");
    const split = parseNumkeys(args);
    if (!Array.isArray((split as any).keys)) return split as RespValue;
    const { keys, argv } = split as { keys: Uint8Array[]; argv: Uint8Array[] };
    return runScript(ctx, conn, src, keys, argv, readonly);
  };
}

function fcallCmd(readonly: boolean) {
  return (ctx: any, conn: any, args: Uint8Array[]): RespValue => {
    const fname = dec(args[0]!);
    const libName = funcIndex.get(fname);
    if (libName === undefined) return RESP.err("ERR Function not found");
    const lib = funcLibs.get(libName)!;
    const split = parseNumkeys(args);
    if (!Array.isArray((split as any).keys)) return split as RespValue;
    const { keys, argv } = split as { keys: Uint8Array[]; argv: Uint8Array[] };
    return functionCall(ctx, conn, lib, fname, keys, argv, readonly);
  };
}

export const scriptingCommands: CommandSpec[] = [
  { name: "EVAL", arity: -3, handler: evalCmd(false) },
  { name: "EVAL_RO", arity: -3, handler: evalCmd(true) },
  { name: "EVALSHA", arity: -3, handler: evalShaCmd(false) },
  { name: "EVALSHA_RO", arity: -3, handler: evalShaCmd(true) },
  {
    name: "SCRIPT",
    arity: -2,
    handler: (_ctx, _conn, args) => {
      const sub = dec(args[0]!).toUpperCase();
      if (sub === "LOAD") {
        if (args.length !== 2) {
          return RESP.err("ERR wrong number of arguments for 'script|load' command");
        }
        const src = dec(args[1]!);
        const h = sha1hex(src);
        scripts.set(h, src);
        return RESP.str(h);
      }
      if (sub === "EXISTS") {
        if (args.length < 2) {
          return RESP.err("ERR wrong number of arguments for 'script|exists' command");
        }
        const out: RespValue[] = [];
        for (let i = 1; i < args.length; i++) {
          out.push(RESP.int(scripts.has(dec(args[i]!).toLowerCase()) ? 1 : 0));
        }
        return RESP.arr(out);
      }
      if (sub === "FLUSH") { scripts.clear(); return RESP.ok(); }
      return RESP.ok();
    },
  },
  {
    name: "FUNCTION",
    arity: -2,
    handler: (ctx, conn, args) => {
      const sub = dec(args[0]!).toUpperCase();
      if (sub === "LOAD") {
        let i = 1;
        let replace = false;
        if (i < args.length && dec(args[i]!).toUpperCase() === "REPLACE") { replace = true; i++; }
        if (i !== args.length - 1) {
          return RESP.err("ERR wrong number of arguments for 'function|load' command");
        }
        const code = dec(args[i]!);
        const res = functionLoad(ctx, conn, code);
        if ("err" in res) return RESP.err(res.err);
        const lib = res.lib;
        if (funcLibs.has(lib.name) && !replace) {
          return RESP.err(`ERR Library '${lib.name}' already exists`);
        }
        funcLibs.set(lib.name, lib);
        reindex();
        return RESP.str(lib.name);
      }
      if (sub === "DELETE") {
        if (args.length !== 2) {
          return RESP.err("ERR wrong number of arguments for 'function|delete' command");
        }
        const ln = dec(args[1]!);
        if (!funcLibs.delete(ln)) return RESP.err("ERR Library not found");
        reindex();
        return RESP.ok();
      }
      if (sub === "FLUSH") {
        // FUNCTION FLUSH [ASYNC|SYNC] — only that optional token is valid.
        if (args.length > 2) {
          return RESP.err("ERR wrong number of arguments for 'function|flush' command");
        }
        if (args.length === 2) {
          const m = dec(args[1]!).toUpperCase();
          if (m !== "ASYNC" && m !== "SYNC") return RESP.err("ERR syntax error");
        }
        funcLibs.clear();
        funcIndex.clear();
        return RESP.ok();
      }
      if (sub === "LIST") {
        let libFilter: string | null = null;
        let withCode = false;
        for (let i = 1; i < args.length; i++) {
          const o = dec(args[i]!).toUpperCase();
          if (o === "LIBRARYNAME") {
            if (i + 1 >= args.length) {
              return RESP.err("ERR wrong number of arguments for 'function|list' command");
            }
            libFilter = dec(args[++i]!);
          } else if (o === "WITHCODE") {
            withCode = true;
          } else {
            return RESP.err(`ERR Unknown argument ${dec(args[i]!)}`);
          }
        }
        const out: RespValue[] = [];
        for (const lib of funcLibs.values()) {
          if (libFilter !== null && lib.name !== libFilter) continue;
          const entry: Array<[RespValue, RespValue]> = [
            [RESP.str("library_name"), RESP.str(lib.name)],
            [RESP.str("engine"), RESP.str("LUA")],
            [RESP.str("functions"), RESP.arr(lib.functions.map((f) => ({
              type: "map" as const,
              value: [
                [RESP.str("name"), RESP.str(f)],
                [RESP.str("description"), RESP.nil()],
                [RESP.str("flags"), RESP.arr([])],
              ] as Array<[RespValue, RespValue]>,
            })))],
          ];
          if (withCode) entry.push([RESP.str("library_code"), RESP.str(lib.source)]);
          out.push({ type: "map", value: entry });
        }
        return RESP.arr(out);
      }
      if (sub === "DUMP") {
        if (args.length !== 1) {
          return RESP.err("ERR wrong number of arguments for 'function|dump' command");
        }
        return RESP.str(JSON.stringify(Array.from(funcLibs.values())));
      }
      if (sub === "STATS") {
        if (args.length !== 1) {
          return RESP.err("ERR wrong number of arguments for 'function|stats' command");
        }
        return {
          type: "map",
          value: [
            [RESP.str("running_script"), RESP.nil()],
            [RESP.str("engines"), { type: "map", value: [
              [RESP.str("LUA"), { type: "map", value: [
                [RESP.str("libraries_count"), RESP.int(funcLibs.size)],
                [RESP.str("functions_count"), RESP.int(funcIndex.size)],
              ] }],
            ] }],
          ],
        };
      }
      if (sub === "RESTORE") {
        // FUNCTION RESTORE <serialized-payload> [FLUSH|APPEND|REPLACE]
        if (args.length < 2 || args.length > 3) {
          return RESP.err("ERR wrong number of arguments for 'function|restore' command");
        }
        const policy = args.length === 3 ? dec(args[2]!).toUpperCase() : "APPEND";
        if (policy !== "FLUSH" && policy !== "APPEND" && policy !== "REPLACE") {
          return RESP.err("ERR Wrong restore policy. Accepted values: FLUSH, APPEND, REPLACE");
        }
        let libs: FunctionLib[];
        try {
          const parsed = JSON.parse(dec(args[1]!));
          if (!Array.isArray(parsed)) throw new Error("not an array");
          libs = parsed.map((l: any) => {
            if (typeof l?.name !== "string" || typeof l?.source !== "string"
              || !Array.isArray(l?.functions)) {
              throw new Error("bad library shape");
            }
            return { name: l.name, source: l.source, functions: l.functions.map(String) };
          });
        } catch {
          return RESP.err("ERR payload version or checksum are wrong");
        }
        // Reject a malformed dump containing duplicate library names before
        // mutating any state (order-independent, matches Redis rejecting a
        // corrupt payload rather than silent last-write-wins).
        const seen = new Set<string>();
        for (const l of libs) {
          if (seen.has(l.name)) {
            return RESP.err(`ERR Duplicate library name '${l.name}' in payload`);
          }
          seen.add(l.name);
        }
        if (policy === "FLUSH") {
          funcLibs.clear();
        } else if (policy === "APPEND") {
          for (const l of libs) {
            if (funcLibs.has(l.name)) {
              return RESP.err(`ERR Library '${l.name}' already exists`);
            }
          }
        }
        for (const l of libs) funcLibs.set(l.name, l);
        reindex();
        return RESP.ok();
      }
      return RESP.err(`ERR Unknown FUNCTION subcommand or wrong number of arguments for '${sub.toLowerCase()}'`);
    },
  },
  { name: "FCALL", arity: -3, handler: fcallCmd(false) },
  { name: "FCALL_RO", arity: -3, handler: fcallCmd(true) },
];