import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Redis } from "ioredis";
import { startServer } from "../src/server";

const PORT = 16380;
let server: ReturnType<typeof startServer>;
let r: Redis;

beforeAll(async () => {
  server = startServer({
    host: "127.0.0.1",
    port: PORT,
    password: null,
    maxClients: 1000,
    dbCount: 16,
  });
  r = new Redis({ host: "127.0.0.1", port: PORT, lazyConnect: false, maxRetriesPerRequest: 1 });
  await r.ping();
});

afterAll(async () => {
  r.disconnect();
  server.server.stop(true);
});

describe("connection", () => {
  test("PING", async () => {
    expect(await r.ping()).toBe("PONG");
    expect(await r.ping("hello")).toBe("hello");
  });
  test("ECHO", async () => {
    expect(await r.echo("payload")).toBe("payload");
  });
  test("CLIENT ID/NAME", async () => {
    const id = await r.client("ID");
    expect(typeof id).toBe("number");
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
  test("SET NX/XX, GET option", async () => {
    expect(await r.set("k1", "v1", "NX")).toBe("OK");
    expect(await r.set("k1", "v2", "NX")).toBeNull();
    expect(await r.set("k1", "v3", "XX")).toBe("OK");
    expect(await r.set("missing", "x", "XX")).toBeNull();
    expect(await r.get("k1")).toBe("v3");
    const prev = await r.set("k1", "v4", "GET");
    expect(prev).toBe("v3");
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
    expect(await r.get("a")).toBe("19");
    expect(await r.strlen("a")).toBe(2);
  });
  test("EXPIRE/TTL/PERSIST", async () => {
    await r.set("e", "x");
    expect(await r.expire("e", 100)).toBe(1);
    const ttl = await r.ttl("e");
    expect(ttl).toBeGreaterThan(0);
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
    const all = await r.hgetall("h");
    expect(all).toEqual({ a: "1", b: "2" });
    expect(await r.hdel("h", "a")).toBe(1);
  });
  test("HINCRBY", async () => {
    await r.del("h");
    expect(await r.hincrby("h", "counter", 7)).toBe(7);
    expect(await r.hincrby("h", "counter", -2)).toBe(5);
  });
  test("HKEYS/HVALS/HLEN", async () => {
    await r.del("h");
    await r.hset("h", "x", "1", "y", "2", "z", "3");
    const ks = (await r.hkeys("h")).sort();
    expect(ks).toEqual(["x", "y", "z"]);
    expect((await r.hvals("h")).sort()).toEqual(["1", "2", "3"]);
    expect(await r.hlen("h")).toBe(3);
  });
});

describe("lists", () => {
  test("LPUSH/RPUSH/LRANGE/LLEN", async () => {
    await r.del("l");
    expect(await r.rpush("l", "a", "b", "c")).toBe(3);
    expect(await r.lrange("l", 0, -1)).toEqual(["a", "b", "c"]);
    expect(await r.lpush("l", "z")).toBe(4);
    expect(await r.lrange("l", 0, -1)).toEqual(["z", "a", "b", "c"]);
    expect(await r.llen("l")).toBe(4);
  });
  test("LPOP/RPOP/LINDEX/LSET", async () => {
    await r.del("l");
    await r.rpush("l", "1", "2", "3", "4");
    expect(await r.lpop("l")).toBe("1");
    expect(await r.rpop("l")).toBe("4");
    expect(await r.lindex("l", 0)).toBe("2");
    await r.lset("l", 0, "X");
    expect(await r.lindex("l", 0)).toBe("X");
  });
  test("LREM/LTRIM/LINSERT", async () => {
    await r.del("l");
    await r.rpush("l", "a", "b", "a", "c");
    expect(await r.lrem("l", 1, "a")).toBe(1);
    expect(await r.lrange("l", 0, -1)).toEqual(["b", "a", "c"]);
    await r.linsert("l", "BEFORE", "a", "X");
    expect(await r.lrange("l", 0, -1)).toEqual(["b", "X", "a", "c"]);
    await r.ltrim("l", 1, 2);
    expect(await r.lrange("l", 0, -1)).toEqual(["X", "a"]);
  });
});

describe("sets", () => {
  test("SADD/SMEMBERS/SCARD/SISMEMBER", async () => {
    await r.del("s");
    expect(await r.sadd("s", "a", "b", "c")).toBe(3);
    expect((await r.smembers("s")).sort()).toEqual(["a", "b", "c"]);
    expect(await r.scard("s")).toBe(3);
    expect(await r.sismember("s", "a")).toBe(1);
    expect(await r.sismember("s", "z")).toBe(0);
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
  test("ZRANGEBYSCORE/ZINCRBY/ZRANK", async () => {
    await r.del("z");
    await r.zadd("z", 10, "x", 20, "y", 30, "z");
    expect(await r.zrangebyscore("z", 15, 25)).toEqual(["y"]);
    expect(await r.zincrby("z", 5, "x")).toBe("15");
    expect(await r.zrank("z", "x")).toBe(0);
  });
  test("ZREM/ZPOPMIN/ZPOPMAX", async () => {
    await r.del("z");
    await r.zadd("z", 1, "a", 2, "b", 3, "c");
    expect(await r.zrem("z", "b")).toBe(1);
    expect(await r.zpopmin("z")).toEqual(["a", "1"]);
    expect(await r.zpopmax("z")).toEqual(["c", "3"]);
  });
});

describe("transactions", () => {
  test("MULTI/EXEC", async () => {
    await r.del("t");
    const res = await r
      .multi()
      .set("t", "1")
      .incr("t")
      .incr("t")
      .get("t")
      .exec();
    expect(res).toEqual([
      [null, "OK"],
      [null, 2],
      [null, 3],
      [null, "3"],
    ]);
  });
  test("DISCARD", async () => {
    expect(await r.call("MULTI")).toBe("OK");
    expect(await r.call("SET", "d", "x")).toBe("QUEUED");
    expect(await r.call("DISCARD")).toBe("OK");
    expect(await r.get("d")).toBeNull();
  });
});

describe("pubsub", () => {
  test("SUBSCRIBE/PUBLISH", async () => {
    const sub = new Redis({ host: "127.0.0.1", port: PORT });
    const received: Array<[string, string]> = [];
    await new Promise<void>((resolve) => {
      sub.subscribe("chan", (err) => {
        expect(err).toBeNull();
        resolve();
      });
    });
    sub.on("message", (channel, message) => received.push([channel, message]));
    await new Promise((r2) => setTimeout(r2, 50));
    expect(await r.publish("chan", "hello")).toBe(1);
    await new Promise((r2) => setTimeout(r2, 100));
    expect(received).toEqual([["chan", "hello"]]);
    sub.disconnect();
  });
});

describe("server", () => {
  test("INFO/TIME/DBSIZE", async () => {
    const info = await r.info();
    expect(info).toContain("redis_version");
    const t = await r.time();
    expect(t).toHaveLength(2);
    expect(typeof (await r.dbsize())).toBe("number");
  });
  test("CONFIG GET/SET", async () => {
    await r.config("SET", "maxmemory", "100mb");
    const got = await r.config("GET", "maxmemory");
    expect(got).toEqual(["maxmemory", "100mb"]);
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
    const id = await r.xadd("st", "*", "field", "val");
    expect(typeof id).toBe("string");
    expect(await r.xlen("st")).toBe(1);
    const range = await r.xrange("st", "-", "+");
    expect(range[0]?.[0]).toBe(id);
  });
});