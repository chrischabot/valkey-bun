// Embedded Lua scripting (EVAL/EVALSHA/FUNCTION/FCALL).
//
// fengari is a pure-JS Lua 5.3 VM (no native code), so it runs unchanged on
// Bun. It ships no TypeScript types, so the module object is accessed through
// a single localized structural cast at this one boundary (the same accepted
// pattern used for Bun.serve({http3})/Bun.listen({reusePort})). All Lua <->
// RESP conversion below follows the exact rules redis-server uses in
// scripting.c (script_call / luaReplyToRedisReply / redisProtocolToLuaType).

import fengari from "fengari";
import type { ServerContext } from "./server-context";
import type { Connection } from "./connection";
import { RESP, type RespValue } from "./resp";
import { bytesToKey } from "./store";
import { postWrite, WRITE_COMMANDS } from "./commands/index";

// Single structural cast at the untyped-dependency boundary.
const F = fengari as unknown as {
  lua: any;
  lauxlib: any;
  lualib: any;
  to_luastring: (s: string) => Uint8Array;
  to_jsstring: (a: Uint8Array) => string;
};
const { lua, lauxlib, lualib, to_luastring } = F;

const ENC = new TextEncoder();
const LATIN1 = new TextDecoder("latin1" as unknown as undefined);

function jsstr(a: Uint8Array): string { return F.to_jsstring(a); }
function bytesOf(a: Uint8Array | number[]): Uint8Array {
  return a instanceof Uint8Array ? a : Uint8Array.from(a);
}

export function sha1hex(src: string): string {
  return new Bun.CryptoHasher("sha1").update(src).digest("hex");
}

// ---- RESP -> Lua ----------------------------------------------------------

function pushErrTable(L: any, msg: string): void {
  lua.lua_createtable(L, 0, 1);
  lua.lua_pushstring(L, to_luastring(msg));
  lua.lua_setfield(L, -2, to_luastring("err"));
}

function respToLua(L: any, v: RespValue): void {
  switch (v.type) {
    case "simple":
      lua.lua_createtable(L, 0, 1);
      lua.lua_pushstring(L, to_luastring(v.value));
      lua.lua_setfield(L, -2, to_luastring("ok"));
      return;
    case "error":
      pushErrTable(L, v.value);
      return;
    case "integer":
      lua.lua_pushinteger(L, Number(v.value));
      return;
    case "double":
      // Redis (RESP2 script context) surfaces a double as a Lua number.
      lua.lua_pushnumber(L, v.value);
      return;
    case "boolean":
      lua.lua_pushboolean(L, v.value ? 1 : 0);
      return;
    case "bulk":
      if (v.value === null) lua.lua_pushboolean(L, 0);
      else lua.lua_pushlstring(L, v.value, v.value.length);
      return;
    case "null":
      lua.lua_pushboolean(L, 0);
      return;
    case "bignum":
      lua.lua_pushstring(L, to_luastring(v.value.toString()));
      return;
    case "verbatim":
      lua.lua_pushstring(L, to_luastring(v.value));
      return;
    case "blob_error":
      pushErrTable(L, LATIN1.decode(v.value));
      return;
    case "array":
    case "set":
    case "push": {
      const items = v.type === "array" ? (v.value ?? []) : v.value;
      lua.lua_createtable(L, items.length, 0);
      for (let i = 0; i < items.length; i++) {
        respToLua(L, items[i]!);
        lua.lua_seti(L, -2, i + 1);
      }
      return;
    }
    case "map": {
      // RESP2 script context: a map is delivered as a flat [k,v,...] array.
      lua.lua_createtable(L, v.value.length * 2, 0);
      let n = 1;
      for (const [k, val] of v.value) {
        respToLua(L, k); lua.lua_seti(L, -2, n++);
        respToLua(L, val); lua.lua_seti(L, -2, n++);
      }
      return;
    }
    case "attribute":
      respToLua(L, v.value);
      return;
  }
}

// ---- Lua -> RESP ----------------------------------------------------------

function luaToResp(L: any, idx: number): RespValue {
  const ai = lua.lua_absindex(L, idx);
  const t = lua.lua_type(L, ai);
  if (t === lua.LUA_TNIL || t === lua.LUA_TNONE) return { type: "bulk", value: null };
  if (t === lua.LUA_TBOOLEAN) {
    return lua.lua_toboolean(L, ai)
      ? { type: "integer", value: 1 }
      : { type: "bulk", value: null };
  }
  if (t === lua.LUA_TNUMBER) {
    return { type: "integer", value: Math.trunc(lua.lua_tonumberx(L, ai, null)) };
  }
  if (t === lua.LUA_TSTRING) {
    return { type: "bulk", value: bytesOf(lua.lua_tolstring(L, ai)) };
  }
  if (t === lua.LUA_TTABLE) {
    lua.lua_getfield(L, ai, to_luastring("err"));
    if (lua.lua_type(L, -1) === lua.LUA_TSTRING) {
      const s = jsstr(bytesOf(lua.lua_tolstring(L, -1)));
      lua.lua_pop(L, 1);
      return { type: "error", value: s };
    }
    lua.lua_pop(L, 1);
    lua.lua_getfield(L, ai, to_luastring("ok"));
    if (lua.lua_type(L, -1) === lua.LUA_TSTRING) {
      const s = jsstr(bytesOf(lua.lua_tolstring(L, -1)));
      lua.lua_pop(L, 1);
      return { type: "simple", value: s };
    }
    lua.lua_pop(L, 1);
    const arr: RespValue[] = [];
    let i = 1;
    // Sequence: stop at the first nil hole (exact redis-server behavior).
    while (true) {
      lua.lua_geti(L, ai, i);
      if (lua.lua_type(L, -1) === lua.LUA_TNIL) { lua.lua_pop(L, 1); break; }
      arr.push(luaToResp(L, lua.lua_gettop(L)));
      lua.lua_pop(L, 1);
      i++;
    }
    return { type: "array", value: arr };
  }
  return { type: "bulk", value: null };
}

// ---- cjson (minimal, JSON-bridge) ----------------------------------------

function luaToJs(L: any, idx: number): unknown {
  const ai = lua.lua_absindex(L, idx);
  const t = lua.lua_type(L, ai);
  if (t === lua.LUA_TNIL || t === lua.LUA_TNONE) return null;
  if (t === lua.LUA_TBOOLEAN) return !!lua.lua_toboolean(L, ai);
  if (t === lua.LUA_TNUMBER) return lua.lua_tonumberx(L, ai, null);
  if (t === lua.LUA_TSTRING) return jsstr(bytesOf(lua.lua_tolstring(L, ai)));
  if (t === lua.LUA_TTABLE) {
    // Sequence => array, else object.
    const len = lua.lua_rawlen(L, ai);
    if (len > 0) {
      const out: unknown[] = [];
      for (let i = 1; i <= len; i++) {
        lua.lua_geti(L, ai, i);
        out.push(luaToJs(L, lua.lua_gettop(L)));
        lua.lua_pop(L, 1);
      }
      return out;
    }
    const obj: Record<string, unknown> = {};
    lua.lua_pushnil(L);
    while (lua.lua_next(L, ai) !== 0) {
      const key = lua.lua_type(L, -2) === lua.LUA_TSTRING
        ? jsstr(bytesOf(lua.lua_tolstring(L, -2)))
        : String(lua.lua_tonumberx(L, -2, null));
      obj[key] = luaToJs(L, lua.lua_gettop(L));
      lua.lua_pop(L, 1);
    }
    return obj;
  }
  return null;
}

function jsToLua(L: any, value: unknown): void {
  if (value === null || value === undefined) { lua.lua_pushnil(L); return; }
  if (typeof value === "boolean") { lua.lua_pushboolean(L, value ? 1 : 0); return; }
  if (typeof value === "number") { lua.lua_pushnumber(L, value); return; }
  if (typeof value === "string") { lua.lua_pushstring(L, to_luastring(value)); return; }
  if (Array.isArray(value)) {
    lua.lua_createtable(L, value.length, 0);
    for (let i = 0; i < value.length; i++) {
      jsToLua(L, value[i]);
      lua.lua_seti(L, -2, i + 1);
    }
    return;
  }
  const obj = value as Record<string, unknown>;
  lua.lua_createtable(L, 0, 0);
  for (const k of Object.keys(obj)) {
    jsToLua(L, obj[k]);
    lua.lua_setfield(L, -2, to_luastring(k));
  }
}

// ---- redis.* table --------------------------------------------------------

function redisifyErr(e: unknown): string {
  const msg = (e as { message?: string })?.message ?? String(e);
  return msg.startsWith("ERR ") || msg.startsWith("WRONGTYPE")
    || msg.startsWith("NOSCRIPT") || msg.startsWith("NOAUTH")
    ? msg : `ERR ${msg}`;
}

function execCommand(
  ctx: ServerContext, sconn: Connection, name: string,
  args: Uint8Array[], readonly: boolean,
): RespValue {
  const upper = name.toUpperCase();
  const spec = ctx.registry?.get(name);
  if (!spec) return RESP.err(`ERR Unknown Redis command called from script`);
  const got = 1 + args.length;
  if (spec.arity >= 0 ? got !== spec.arity : got < -spec.arity) {
    return RESP.err(`ERR Wrong number of args calling Redis command from script`);
  }
  if (readonly && WRITE_COMMANDS.has(upper)) {
    return RESP.err("ERR Write commands are not allowed from read-only scripts.");
  }
  let out: unknown;
  try {
    out = spec.handler(ctx, sconn, args);
  } catch (e) {
    return RESP.err(redisifyErr(e));
  }
  if (out && typeof (out as { then?: unknown }).then === "function") {
    return RESP.err("ERR This Redis command is not allowed from scripts");
  }
  const rv = (out ?? { type: "null" }) as RespValue;
  postWrite(ctx, sconn, name, args, rv);
  return rv;
}

function collectArgs(L: any): Uint8Array[] | string {
  const n = lua.lua_gettop(L);
  if (n === 0) return "Please specify at least one argument for this redis lib call";
  const argv: Uint8Array[] = [];
  for (let i = 1; i <= n; i++) {
    const t = lua.lua_type(L, i);
    if (t === lua.LUA_TSTRING) {
      argv.push(bytesOf(lua.lua_tolstring(L, i)));
    } else if (t === lua.LUA_TNUMBER) {
      const num = lua.lua_tonumberx(L, i, null);
      argv.push(ENC.encode(Number.isInteger(num) ? String(num) : String(num)));
    } else {
      return "Lua redis lib command arguments must be strings or integers";
    }
  }
  return argv;
}

function installRedisTable(
  ctx: ServerContext, sconn: Connection, L: any, readonly: boolean,
): void {
  lua.lua_createtable(L, 0, 0);

  const callImpl = (raise: boolean) => (Ls: any): number => {
    const argv = collectArgs(Ls);
    if (typeof argv === "string") {
      pushErrTable(Ls, argv);
      if (raise) return lua.lua_error(Ls);
      return 1;
    }
    const name = LATIN1.decode(argv[0]!);
    const reply = execCommand(ctx, sconn, name, argv.slice(1), readonly);
    if (reply.type === "error") {
      if (raise) { pushErrTable(Ls, reply.value); return lua.lua_error(Ls); }
      respToLua(Ls, reply);
      return 1;
    }
    respToLua(Ls, reply);
    return 1;
  };

  lua.lua_pushcfunction(L, callImpl(true));
  lua.lua_setfield(L, -2, to_luastring("call"));
  lua.lua_pushcfunction(L, callImpl(false));
  lua.lua_setfield(L, -2, to_luastring("pcall"));

  lua.lua_pushcfunction(L, (Ls: any): number => {
    const msg = lua.lua_type(Ls, 1) === lua.LUA_TSTRING
      ? jsstr(bytesOf(lua.lua_tolstring(Ls, 1))) : "error";
    lua.lua_createtable(Ls, 0, 1);
    lua.lua_pushstring(Ls, to_luastring(msg));
    lua.lua_setfield(Ls, -2, to_luastring("err"));
    return 1;
  });
  lua.lua_setfield(L, -2, to_luastring("error_reply"));

  lua.lua_pushcfunction(L, (Ls: any): number => {
    const msg = lua.lua_type(Ls, 1) === lua.LUA_TSTRING
      ? jsstr(bytesOf(lua.lua_tolstring(Ls, 1))) : "OK";
    lua.lua_createtable(Ls, 0, 1);
    lua.lua_pushstring(Ls, to_luastring(msg));
    lua.lua_setfield(Ls, -2, to_luastring("ok"));
    return 1;
  });
  lua.lua_setfield(L, -2, to_luastring("status_reply"));

  lua.lua_pushcfunction(L, (Ls: any): number => {
    const s = lua.lua_type(Ls, 1) === lua.LUA_TSTRING
      ? jsstr(bytesOf(lua.lua_tolstring(Ls, 1))) : "";
    lua.lua_pushstring(Ls, to_luastring(sha1hex(s)));
    return 1;
  });
  lua.lua_setfield(L, -2, to_luastring("sha1hex"));

  // log / setresp / replicate_commands / breakpoint / debug — accepted no-ops
  // (replicate_commands returns true as real Redis does).
  for (const noop of ["log", "breakpoint", "debug", "setresp"]) {
    lua.lua_pushcfunction(L, (): number => 0);
    lua.lua_setfield(L, -2, to_luastring(noop));
  }
  lua.lua_pushcfunction(L, (Ls: any): number => { lua.lua_pushboolean(Ls, 1); return 1; });
  lua.lua_setfield(L, -2, to_luastring("replicate_commands"));

  for (const [k, val] of [
    ["LOG_DEBUG", 0], ["LOG_VERBOSE", 1], ["LOG_NOTICE", 2], ["LOG_WARNING", 3],
    ["REPL_NONE", 0], ["REPL_AOF", 1], ["REPL_SLAVE", 2], ["REPL_REPLICA", 2],
    ["REPL_ALL", 3],
  ] as Array<[string, number]>) {
    lua.lua_pushinteger(L, val);
    lua.lua_setfield(L, -2, to_luastring(k));
  }

  // Duplicate the table reference for both `redis` and the `server` alias.
  lua.lua_pushvalue(L, -1);
  lua.lua_setglobal(L, to_luastring("redis"));
  lua.lua_setglobal(L, to_luastring("server"));
}

function installCjson(L: any): void {
  lua.lua_createtable(L, 0, 2);
  lua.lua_pushcfunction(L, (Ls: any): number => {
    const v = luaToJs(Ls, 1);
    lua.lua_pushstring(Ls, to_luastring(JSON.stringify(v)));
    return 1;
  });
  lua.lua_setfield(L, -2, to_luastring("encode"));
  lua.lua_pushcfunction(L, (Ls: any): number => {
    const s = lua.lua_type(Ls, 1) === lua.LUA_TSTRING
      ? jsstr(bytesOf(lua.lua_tolstring(Ls, 1))) : "null";
    let parsed: unknown;
    try { parsed = JSON.parse(s); } catch { parsed = null; }
    jsToLua(Ls, parsed);
    return 1;
  });
  lua.lua_setfield(L, -2, to_luastring("decode"));
  lua.lua_setglobal(L, to_luastring("cjson"));
}

function pushArgTable(L: any, items: Uint8Array[]): void {
  lua.lua_createtable(L, items.length, 0);
  for (let i = 0; i < items.length; i++) {
    lua.lua_pushlstring(L, items[i]!, items[i]!.length);
    lua.lua_seti(L, -2, i + 1);
  }
}

// ---- Public: EVAL ---------------------------------------------------------

export function runScript(
  ctx: ServerContext, conn: Connection, src: string,
  keys: Uint8Array[], argv: Uint8Array[], readonly: boolean,
): RespValue {
  const sconn = ctx.makeLoopbackConnection();
  sconn.selectedDb = conn.selectedDb;
  sconn.resp3 = false;
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  installRedisTable(ctx, sconn, L, readonly);
  installCjson(L);
  pushArgTable(L, keys);
  lua.lua_setglobal(L, to_luastring("KEYS"));
  pushArgTable(L, argv);
  lua.lua_setglobal(L, to_luastring("ARGV"));

  if (lauxlib.luaL_loadstring(L, to_luastring(src)) !== lua.LUA_OK) {
    const msg = jsstr(bytesOf(lua.lua_tolstring(L, -1)));
    return RESP.err(`ERR Error compiling script (new function): ${msg}`);
  }
  if (lua.lua_pcall(L, 0, 1, 0) !== lua.LUA_OK) {
    const top = lua.lua_type(L, -1);
    if (top === lua.LUA_TTABLE) {
      lua.lua_getfield(L, -1, to_luastring("err"));
      if (lua.lua_type(L, -1) === lua.LUA_TSTRING) {
        const m = jsstr(bytesOf(lua.lua_tolstring(L, -1)));
        return RESP.err(m.startsWith("ERR ") || /^[A-Z]+ /.test(m) ? m : `ERR ${m}`);
      }
    }
    const msg = lua.lua_type(L, -1) === lua.LUA_TSTRING
      ? jsstr(bytesOf(lua.lua_tolstring(L, -1))) : "unknown error";
    return RESP.err(`ERR ${msg}`);
  }
  return luaToResp(L, -1);
}

// ---- Public: Redis Functions (FUNCTION / FCALL) ---------------------------

export interface FunctionLib { name: string; source: string; functions: string[]; }

// Parse the `#!lua name=<lib>` shebang and strip it.
export function parseFunctionShebang(code: string): { lib: string; body: string } | null {
  const nl = code.indexOf("\n");
  if (nl < 0) return null;
  const first = code.slice(0, nl).trim();
  const m = /^#!\s*lua\s+name=(\S+)/.exec(first);
  if (!m) return null;
  return { lib: m[1]!, body: code.slice(nl + 1) };
}

// Run a function library body. `capture` receives every registered function
// name; if `invoke` is set, the matching callback is called with (keys,argv).
function runLibrary(
  ctx: ServerContext, conn: Connection, body: string,
  capture: (name: string) => void,
  invoke: { fname: string; keys: Uint8Array[]; argv: Uint8Array[]; readonly: boolean } | null,
): RespValue | null {
  const sconn = ctx.makeLoopbackConnection();
  sconn.selectedDb = conn.selectedDb;
  sconn.resp3 = false;
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  installRedisTable(ctx, sconn, L, invoke ? invoke.readonly : true);
  installCjson(L);

  // Held in an object so values mutated inside the register_function closure
  // are not narrowed to `never` by TS control-flow analysis.
  const box: { result: RespValue | null; err: string | null } = { result: null, err: null };

  lua.lua_getglobal(L, to_luastring("redis"));
  lua.lua_pushcfunction(L, (Ls: any): number => {
    // register_function('name', fn)  OR  register_function{function_name=,callback=}
    let fname = "";
    let cbIndex = 0;
    if (lua.lua_type(Ls, 1) === lua.LUA_TTABLE) {
      lua.lua_getfield(Ls, 1, to_luastring("function_name"));
      fname = jsstr(bytesOf(lua.lua_tolstring(Ls, -1)));
      lua.lua_pop(Ls, 1);
      lua.lua_getfield(Ls, 1, to_luastring("callback"));
      cbIndex = lua.lua_gettop(Ls);
    } else {
      fname = jsstr(bytesOf(lua.lua_tolstring(Ls, 1)));
      cbIndex = 2;
    }
    capture(fname);
    if (invoke && fname === invoke.fname) {
      lua.lua_pushvalue(Ls, cbIndex);
      pushArgTable(Ls, invoke.keys);
      pushArgTable(Ls, invoke.argv);
      if (lua.lua_pcall(Ls, 2, 1, 0) !== lua.LUA_OK) {
        box.err = lua.lua_type(Ls, -1) === lua.LUA_TSTRING
          ? jsstr(bytesOf(lua.lua_tolstring(Ls, -1))) : "function call failed";
        lua.lua_pop(Ls, 1);
      } else {
        box.result = luaToResp(Ls, -1);
        lua.lua_pop(Ls, 1);
      }
    }
    return 0;
  });
  lua.lua_setfield(L, -2, to_luastring("register_function"));
  lua.lua_pop(L, 1);

  if (lauxlib.luaL_loadstring(L, to_luastring(body)) !== lua.LUA_OK) {
    return RESP.err(`ERR Error compiling function: ${jsstr(bytesOf(lua.lua_tolstring(L, -1)))}`);
  }
  if (lua.lua_pcall(L, 0, 0, 0) !== lua.LUA_OK) {
    return RESP.err(`ERR Error registering functions: ${jsstr(bytesOf(lua.lua_tolstring(L, -1)))}`);
  }
  if (box.err !== null) {
    return RESP.err(box.err.startsWith("ERR ") ? box.err : `ERR ${box.err}`);
  }
  return box.result;
}

export function functionLoad(
  ctx: ServerContext, conn: Connection, code: string,
): { lib: FunctionLib } | { err: string } {
  const parsed = parseFunctionShebang(code);
  if (!parsed) {
    return { err: "ERR Missing library name; the library must start with '#!lua name=<libname>'" };
  }
  const names: string[] = [];
  const res = runLibrary(ctx, conn, parsed.body, (n) => names.push(n), null);
  if (res && res.type === "error") return { err: res.value };
  if (names.length === 0) {
    return { err: "ERR No functions registered" };
  }
  return { lib: { name: parsed.lib, source: code, functions: names } };
}

export function functionCall(
  ctx: ServerContext, conn: Connection, lib: FunctionLib, fname: string,
  keys: Uint8Array[], argv: Uint8Array[], readonly: boolean,
): RespValue {
  const parsed = parseFunctionShebang(lib.source);
  if (!parsed) return RESP.err("ERR Corrupt function library");
  const res = runLibrary(ctx, conn, parsed.body, () => {}, { fname, keys, argv, readonly });
  if (res === null) return RESP.err(`ERR Function '${fname}' not found`);
  return res;
}

export { bytesToKey };