import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Redis } from "ioredis";
import { startTcpServer } from "../src/tcp-server";

const PORT = 16483;
let server: ReturnType<typeof startTcpServer>;
let r: Redis;

beforeAll(async () => {
  server = startTcpServer({
    host: "127.0.0.1",
    port: PORT,
    password: null,
    maxClients: 1000,
    dbCount: 16,
    clusterSize: 1,
    adminPort: 0,
  });
  r = new Redis({ host: "127.0.0.1", port: PORT, maxRetriesPerRequest: 1 });
  await r.ping();
});

afterAll(async () => {
  r.disconnect();
  server.server.stop(true);
});

beforeEach(async () => {
  await r.flushall();
  await r.config("SET", "notify-keyspace-events", "");
  await r.call("FUNCTION", "FLUSH");
});

describe("scripting: EVAL / EVALSHA / SCRIPT", () => {
  test("arithmetic + KEYS/ARGV", async () => {
    expect(await r.eval("return 1+2", 0)).toBe(3);
    expect(await r.eval("return {KEYS[1], ARGV[1]}", 1, "k", "a")).toEqual(["k", "a"]);
  });
  test("redis.call read/write, status/error/pcall", async () => {
    await r.eval("redis.call('set', KEYS[1], ARGV[1])", 1, "sk", "sv");
    expect(await r.get("sk")).toBe("sv");
    expect(await r.eval("return redis.call('get', KEYS[1])", 1, "sk")).toBe("sv");
    expect(await r.eval("return redis.status_reply('DONE')", 0)).toBe("DONE");
    await expect(r.eval("return redis.error_reply('boom')", 0)).rejects.toThrow(/boom/);
    expect(await r.eval(
      "local v=redis.pcall('incr','sk'); if v.err then return 'caught' end return 'no'", 0,
    )).toBe("caught");
  });
  test("cjson + sha1hex", async () => {
    expect(await r.eval("return cjson.encode({1,2,3})", 0)).toBe("[1,2,3]");
    expect(await r.eval("return cjson.decode(ARGV[1])[2]", 0, "[10,20,30]")).toBe(20);
    expect(await r.eval("return redis.sha1hex('')", 0))
      .toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
  });
  test("SCRIPT LOAD/EXISTS + EVALSHA + NOSCRIPT", async () => {
    const sha = (await r.script("LOAD", "return 'cached'")) as string;
    expect(sha).toHaveLength(40);
    expect(await r.evalsha(sha, 0)).toBe("cached");
    expect(await r.script("EXISTS", sha, "0".repeat(40))).toEqual([1, 0]);
    await expect(r.evalsha("0".repeat(40), 0)).rejects.toThrow(/NOSCRIPT/);
  });
  test("EVAL_RO blocks writes", async () => {
    await expect(r.call("EVAL_RO", "return redis.call('set','x','1')", 0))
      .rejects.toThrow(/read-only/);
  });
});

describe("scripting: FUNCTION / FCALL", () => {
  const lib = "#!lua name=tlib\n"
    + "redis.register_function('tset', function(keys, args) return redis.call('set', keys[1], args[1]) end)\n"
    + "redis.register_function('tget', function(keys, args) return redis.call('get', keys[1]) end)";
  test("LOAD/FCALL/FCALL_RO/LIST/DELETE", async () => {
    expect(await r.call("FUNCTION", "LOAD", "REPLACE", lib)).toBe("tlib");
    expect(await r.call("FCALL", "tset", 1, "fk", "fv")).toBe("OK");
    expect(await r.call("FCALL", "tget", 1, "fk")).toBe("fv");
    expect(await r.call("FCALL_RO", "tget", 1, "fk")).toBe("fv");
    expect(JSON.stringify(await r.call("FUNCTION", "LIST"))).toContain("tlib");
    expect(await r.call("FUNCTION", "DELETE", "tlib")).toBe("OK");
    await expect(r.call("FCALL", "tget", 1, "fk")).rejects.toThrow(/not found/i);
  });
  test("duplicate LOAD rejected without REPLACE", async () => {
    await r.call("FUNCTION", "LOAD", "REPLACE", lib);
    await expect(r.call("FUNCTION", "LOAD", lib)).rejects.toThrow(/already exists/);
    await r.call("FUNCTION", "FLUSH");
  });
});

describe("hash-field TTL (Redis 7.4)", () => {
  test("HEXPIRE/HTTL/GT/HPERSIST/HGETDEL/HGETEX", async () => {
    await r.del("hh");
    await r.hset("hh", "f1", "v1", "f2", "v2");
    expect(await r.call("HEXPIRE", "hh", 100, "FIELDS", 1, "f1")).toEqual([1]);
    expect(await r.call("HTTL", "hh", "FIELDS", 2, "f1", "f2")).toEqual([100, -1]);
    expect(await r.call("HEXPIRE", "hh", 50, "GT", "FIELDS", 1, "f1")).toEqual([0]);
    expect(await r.call("HPERSIST", "hh", "FIELDS", 1, "f1")).toEqual([1]);
    expect(await r.call("HTTL", "hh", "FIELDS", 1, "f1")).toEqual([-1]);
    expect(await r.call("HGETDEL", "hh", "FIELDS", 1, "f2")).toEqual(["v2"]);
    expect(await r.hget("hh", "f2")).toBeNull();
    expect(await r.call("HGETEX", "hh", "PERSIST", "FIELDS", 1, "f1")).toEqual(["v1"]);
  });
});

describe("EXPIRE flags / SORT / bitmaps / LCS", () => {
  test("EXPIRE NX|XX|GT|LT", async () => {
    await r.set("ek", "v");
    expect(await r.call("EXPIRE", "ek", 100, "NX")).toBe(1);
    expect(await r.call("EXPIRE", "ek", 200, "NX")).toBe(0);
    expect(await r.call("EXPIRE", "ek", 50, "GT")).toBe(0);
    expect(await r.call("EXPIRE", "ek", 500, "GT")).toBe(1);
    expect(await r.call("EXPIRE", "ek", 100, "LT")).toBe(1);
  });
  test("SORT numeric/ALPHA/LIMIT/STORE", async () => {
    await r.del("sl"); await r.rpush("sl", "3", "1", "2");
    expect(await r.sort("sl")).toEqual(["1", "2", "3"]);
    expect(await r.sort("sl", "LIMIT", 0, 2, "DESC")).toEqual(["3", "2"]);
    await r.del("al"); await r.rpush("al", "banana", "apple", "cherry");
    expect(await r.sort("al", "ALPHA")).toEqual(["apple", "banana", "cherry"]);
    await r.del("sl2"); await r.rpush("sl2", "2", "1");
    expect(await r.call("SORT", "sl2", "STORE", "sdst")).toBe(2);
    expect(await r.lrange("sdst", 0, -1)).toEqual(["1", "2"]);
  });
  test("bitmaps SETBIT/GETBIT/BITCOUNT", async () => {
    await r.del("bm");
    expect(await r.setbit("bm", 7, 1)).toBe(0);
    expect(await r.getbit("bm", 7)).toBe(1);
    expect(await r.bitcount("bm")).toBe(1);
  });
  test("LCS", async () => {
    await r.mset("lk1", "ohmytext", "lk2", "mynewtext");
    expect(await r.call("LCS", "lk1", "lk2")).toBe("mytext");
    expect(await r.call("LCS", "lk1", "lk2", "LEN")).toBe(6);
  });
});

describe("keyspace notifications", () => {
  test("__keyspace/__keyevent on set + del", async () => {
    await r.config("SET", "notify-keyspace-events", "KEA");
    const sub = new Redis({ host: "127.0.0.1", port: PORT });
    const ev: string[] = [];
    sub.on("pmessage", (_p, ch, msg) => ev.push(`${ch}=${msg}`));
    await new Promise<void>((res) => sub.psubscribe("__key*@0__:*", () => res()));
    await new Promise((s) => setTimeout(s, 60));
    await r.set("nkk", "1");
    await r.del("nkk");
    await new Promise((s) => setTimeout(s, 180));
    expect(ev).toContain("__keyspace@0__:nkk=set");
    expect(ev).toContain("__keyevent@0__:del=nkk");
    sub.disconnect();
  });
});

describe("CLIENT TRACKING (RESP3, raw socket)", () => {
  test("BCAST prefix invalidation push", async () => {
    const buf: number[] = [];
    const enc = (...p: string[]) =>
      `*${p.length}\r\n` + p.map((x) => `$${Buffer.byteLength(x)}\r\n${x}\r\n`).join("");
    const sock = await Bun.connect({
      hostname: "127.0.0.1",
      port: PORT,
      socket: { data(_s, d) { for (const b of d) buf.push(b); } },
    });
    sock.write(enc("HELLO", "3"));
    sock.write(enc("CLIENT", "TRACKING", "ON", "BCAST", "PREFIX", "ct:"));
    await new Promise((s) => setTimeout(s, 80));
    await r.set("ct:99", "x");
    await new Promise((s) => setTimeout(s, 180));
    const raw = Buffer.from(buf).toString("latin1");
    expect(raw).toContain("invalidation");
    expect(raw).toContain("ct:99");
    sock.end();
  });
});