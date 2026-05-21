import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Redis } from "ioredis";
import { startTcpServer } from "../src/tcp-server";

const PORT = 16480;
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
  r = new Redis({ host: "127.0.0.1", port: PORT, lazyConnect: false, maxRetriesPerRequest: 1 });
  await r.ping();
});

afterAll(async () => {
  r.disconnect();
  server.server.stop(true);
});

describe("connection", () => {
  test("PING/ECHO", async () => {
    expect(await r.ping()).toBe("PONG");
    expect(await r.ping("hi")).toBe("hi");
    expect(await r.echo("payload")).toBe("payload");
  });
  test("CLIENT ID/NAME", async () => {
    expect(typeof (await r.client("ID"))).toBe("number");
    await r.client("SETNAME", "tester");
    expect(await r.client("GETNAME")).toBe("tester");
  });
});

describe("strings", () => {
  test("SET/GET/DEL/EXISTS", async () => {
    await r.set("k", "v");
    expect(await r.get("k")).toBe("v");
    expect(await r.exists("k")).toBe(1);
    expect(await r.del("k")).toBe(1);
    expect(await r.get("k")).toBeNull();
  });
  test("SET NX/XX/GET", async () => {
    expect(await r.set("k1", "v1", "NX")).toBe("OK");
    expect(await r.set("k1", "v2", "NX")).toBeNull();
    expect(await r.set("k1", "v3", "XX")).toBe("OK");
    expect(await r.set("k1", "v4", "GET")).toBe("v3");
  });
  test("INCR/DECR/INCRBY/INCRBYFLOAT", async () => {
    await r.set("n", "10");
    expect(await r.incr("n")).toBe(11);
    expect(await r.decr("n")).toBe(10);
    expect(await r.incrby("n", 5)).toBe(15);
    expect(await r.incrbyfloat("n", 0.5)).toBe("15.5");
  });
  test("MGET/MSET/APPEND/STRLEN", async () => {
    await r.mset("a", "1", "b", "2", "c", "3");
    expect(await r.mget("a", "b", "c")).toEqual(["1", "2", "3"]);
    expect(await r.append("a", "9")).toBe(2);
    expect(await r.strlen("a")).toBe(2);
  });
  test("EXPIRE/TTL/PERSIST", async () => {
    await r.set("e", "x");
    expect(await r.expire("e", 100)).toBe(1);
    expect(await r.ttl("e")).toBeGreaterThan(0);
    expect(await r.persist("e")).toBe(1);
    expect(await r.ttl("e")).toBe(-1);
  });
  test("GETRANGE/SETRANGE", async () => {
    await r.set("g", "Hello World");
    expect(await r.getrange("g", 0, 4)).toBe("Hello");
    expect(await r.setrange("g", 6, "Redis")).toBe(11);
    expect(await r.get("g")).toBe("Hello Redis");
  });
});

describe("hashes", () => {
  test("HSET/HGET/HGETALL/HDEL", async () => {
    await r.del("h");
    expect(await r.hset("h", "a", "1", "b", "2")).toBe(2);
    expect(await r.hget("h", "a")).toBe("1");
    expect(await r.hgetall("h")).toEqual({ a: "1", b: "2" });
    expect(await r.hdel("h", "a")).toBe(1);
  });
  test("HINCRBY/HKEYS/HVALS/HLEN", async () => {
    await r.del("h");
    expect(await r.hincrby("h", "c", 7)).toBe(7);
    await r.hset("h", "x", "1", "y", "2");
    expect((await r.hkeys("h")).sort()).toEqual(["c", "x", "y"]);
    expect(await r.hlen("h")).toBe(3);
  });
});

describe("lists", () => {
  test("RPUSH/LPUSH/LRANGE/LLEN/LPOP", async () => {
    await r.del("l");
    expect(await r.rpush("l", "a", "b", "c")).toBe(3);
    expect(await r.lrange("l", 0, -1)).toEqual(["a", "b", "c"]);
    expect(await r.lpush("l", "z")).toBe(4);
    expect(await r.lpop("l")).toBe("z");
    expect(await r.llen("l")).toBe(3);
  });
  test("LREM/LINSERT/LTRIM", async () => {
    await r.del("l");
    await r.rpush("l", "a", "b", "a", "c");
    expect(await r.lrem("l", 1, "a")).toBe(1);
    await r.linsert("l", "BEFORE", "a", "X");
    expect(await r.lrange("l", 0, -1)).toEqual(["b", "X", "a", "c"]);
    await r.ltrim("l", 1, 2);
    expect(await r.lrange("l", 0, -1)).toEqual(["X", "a"]);
  });
  test("BRPOP immediate (data present)", async () => {
    await r.del("bq");
    await r.rpush("bq", "j1", "j2");
    expect(await r.brpop("bq", 0)).toEqual(["bq", "j2"]);
  });
  test("BLPOP blocks then wakes on push", async () => {
    await r.del("bw");
    const sub = new Redis({ host: "127.0.0.1", port: PORT });
    const p = sub.blpop("bw", 5);
    await new Promise((res) => setTimeout(res, 80));
    await r.rpush("bw", "hello");
    expect(await p).toEqual(["bw", "hello"]);
    sub.disconnect();
  });
  test("BLPOP timeout returns nil", async () => {
    const sub = new Redis({ host: "127.0.0.1", port: PORT });
    const res = await sub.blpop("never", 1);
    expect(res).toBeNull();
    sub.disconnect();
  });
});

describe("sets", () => {
  test("SADD/SMEMBERS/SCARD/SISMEMBER", async () => {
    await r.del("s");
    expect(await r.sadd("s", "a", "b", "c")).toBe(3);
    expect((await r.smembers("s")).sort()).toEqual(["a", "b", "c"]);
    expect(await r.scard("s")).toBe(3);
    expect(await r.sismember("s", "a")).toBe(1);
  });
  test("SUNION/SINTER/SDIFF", async () => {
    await r.del("s1", "s2");
    await r.sadd("s1", "a", "b", "c");
    await r.sadd("s2", "b", "c", "d");
    expect((await r.sunion("s1", "s2")).sort()).toEqual(["a", "b", "c", "d"]);
    expect((await r.sinter("s1", "s2")).sort()).toEqual(["b", "c"]);
    expect((await r.sdiff("s1", "s2")).sort()).toEqual(["a"]);
  });
});

describe("sorted sets", () => {
  test("ZADD/ZSCORE/ZRANGE/ZCARD", async () => {
    await r.del("z");
    expect(await r.zadd("z", 1, "a", 2, "b", 3, "c")).toBe(3);
    expect(await r.zscore("z", "b")).toBe("2");
    expect(await r.zrange("z", 0, -1)).toEqual(["a", "b", "c"]);
    expect(await r.zrange("z", 0, -1, "WITHSCORES")).toEqual(["a", "1", "b", "2", "c", "3"]);
    expect(await r.zcard("z")).toBe(3);
  });
  test("ZRANGEBYSCORE/ZINCRBY/ZRANK/ZPOP", async () => {
    await r.del("z");
    await r.zadd("z", 10, "x", 20, "y", 30, "w");
    expect(await r.zrangebyscore("z", 15, 25)).toEqual(["y"]);
    expect(await r.zincrby("z", 5, "x")).toBe("15");
    expect(await r.zrank("z", "x")).toBe(0);
    expect(await r.zpopmin("z")).toEqual(["x", "15"]);
  });
});

describe("transactions", () => {
  test("MULTI/EXEC", async () => {
    await r.del("t");
    const res = await r.multi().set("t", "1").incr("t").incr("t").get("t").exec();
    expect(res).toEqual([[null, "OK"], [null, 2], [null, 3], [null, "3"]]);
  });
  test("DISCARD", async () => {
    expect(await r.call("MULTI")).toBe("OK");
    expect(await r.call("SET", "d", "x")).toBe("QUEUED");
    expect(await r.call("DISCARD")).toBe("OK");
    expect(await r.get("d")).toBeNull();
  });
  test("WATCH abort", async () => {
    await r.set("w", "1");
    await r.watch("w");
    const other = new Redis({ host: "127.0.0.1", port: PORT });
    await other.set("w", "2");
    other.disconnect();
    const res = await r.multi().set("w", "3").exec();
    expect(res).toBeNull();
    expect(await r.get("w")).toBe("2");
  });
});

describe("pubsub", () => {
  test("SUBSCRIBE/PUBLISH", async () => {
    const sub = new Redis({ host: "127.0.0.1", port: PORT });
    const received: Array<[string, string]> = [];
    await new Promise<void>((resolve) => sub.subscribe("chan", () => resolve()));
    sub.on("message", (c, m) => received.push([c, m]));
    await new Promise((res) => setTimeout(res, 50));
    expect(await r.publish("chan", "hello")).toBe(1);
    await new Promise((res) => setTimeout(res, 100));
    expect(received).toEqual([["chan", "hello"]]);
    sub.disconnect();
  });
});

describe("server", () => {
  test("INFO/TIME/DBSIZE/CONFIG", async () => {
    expect(await r.info()).toContain("redis_version");
    expect(await r.time()).toHaveLength(2);
    expect(typeof (await r.dbsize())).toBe("number");
    await r.config("SET", "maxmemory", "100mb");
    expect(await r.config("GET", "maxmemory")).toEqual(["maxmemory", "100mb"]);
  });
  test("KEYS/SCAN/TYPE", async () => {
    await r.flushdb();
    await r.set("a", "1");
    await r.lpush("b", "x");
    expect((await r.keys("*")).sort()).toEqual(["a", "b"]);
    expect(await r.type("a")).toBe("string");
    expect(await r.type("b")).toBe("list");
  });
});

describe("streams", () => {
  test("XADD/XLEN/XRANGE", async () => {
    await r.del("st");
    const id1 = await r.xadd("st", "*", "level", "info");
    const id2 = await r.xadd("st", "*", "level", "warn");
    expect(await r.xlen("st")).toBe(2);
    const all = await r.xrange("st", "-", "+");
    expect(all.map((e) => e[0])).toEqual([id1, id2]);
  });
  test("XGROUP/XREADGROUP/XACK", async () => {
    await r.del("sg");
    await r.xadd("sg", "*", "n", "1");
    await r.xgroup("CREATE", "sg", "g1", "0");
    const read = await r.xreadgroup("GROUP", "g1", "c1", "COUNT", 10, "STREAMS", "sg", ">");
    expect(read).not.toBeNull();
    const pending = await r.xpending("sg", "g1");
    expect(pending[0]).toBe(1);
  });
});