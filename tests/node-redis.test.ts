import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createClient } from "redis";
import { startServer } from "../src/server";

const PORT = 16381;
let server: ReturnType<typeof startServer>;
let r: ReturnType<typeof createClient>;

beforeAll(async () => {
  server = startServer({ host: "127.0.0.1", port: PORT, password: null, maxClients: 1000, dbCount: 16 });
  r = createClient({ url: `redis://127.0.0.1:${PORT}`, RESP: 3 });
  await r.connect();
});

afterAll(async () => {
  await r.quit().catch(() => {});
  server.server.stop(true);
});

describe("node-redis: strings", () => {
  test("SET/GET/DEL/EXISTS", async () => {
    await r.set("k", "v");
    expect(await r.get("k")).toBe("v");
    expect(await r.exists("k")).toBe(1);
    expect(await r.del("k")).toBe(1);
    expect(await r.get("k")).toBeNull();
  });
  test("INCR/DECR", async () => {
    await r.set("n", "5");
    expect(await r.incr("n")).toBe(6);
    expect(await r.decrBy("n", 2)).toBe(4);
  });
  test("MGET/MSET", async () => {
    await r.mSet({ a: "1", b: "2", c: "3" });
    expect(await r.mGet(["a", "b", "c"])).toEqual(["1", "2", "3"]);
  });
});

describe("node-redis: hashes", () => {
  test("HSET/HGET/HGETALL", async () => {
    await r.del("h");
    await r.hSet("h", { name: "ada", age: "36" });
    expect(await r.hGet("h", "name")).toBe("ada");
    expect(await r.hGetAll("h")).toEqual({ name: "ada", age: "36" });
  });
});

describe("node-redis: lists", () => {
  test("RPUSH/LRANGE/LLEN", async () => {
    await r.del("l");
    expect(await r.rPush("l", ["a", "b", "c"])).toBe(3);
    expect(await r.lRange("l", 0, -1)).toEqual(["a", "b", "c"]);
    expect(await r.lLen("l")).toBe(3);
  });
});

describe("node-redis: sets", () => {
  test("SADD/SMEMBERS/SISMEMBER", async () => {
    await r.del("s");
    expect(await r.sAdd("s", ["a", "b", "c"])).toBe(3);
    expect((await r.sMembers("s")).sort()).toEqual(["a", "b", "c"]);
    expect(await r.sIsMember("s", "a")).toBe(true);
  });
});

describe("node-redis: sorted sets", () => {
  test("ZADD/ZRANGE/ZSCORE", async () => {
    await r.del("z");
    await r.zAdd("z", [
      { score: 1, value: "a" },
      { score: 2, value: "b" },
      { score: 3, value: "c" },
    ]);
    expect(await r.zRange("z", 0, -1)).toEqual(["a", "b", "c"]);
    expect(await r.zScore("z", "b")).toBe(2);
  });
});

describe("node-redis: transactions", () => {
  test("MULTI/EXEC", async () => {
    await r.del("t");
    const res = await r.multi().set("t", "1").incr("t").get("t").exec();
    expect(res).toEqual(["OK", 2, "2"]);
  });
});

describe("node-redis: pubsub", () => {
  test("subscribe/publish", async () => {
    const sub = r.duplicate();
    await sub.connect();
    const received: Array<[string, string]> = [];
    await sub.subscribe("nrchan", (message, channel) => {
      received.push([channel, message]);
    });
    await new Promise((r2) => setTimeout(r2, 50));
    expect(await r.publish("nrchan", "hello")).toBe(1);
    await new Promise((r2) => setTimeout(r2, 100));
    expect(received).toEqual([["nrchan", "hello"]]);
    await sub.quit();
  });
});

describe("node-redis: server", () => {
  test("INFO/PING", async () => {
    expect(await r.ping()).toBe("PONG");
    const info = await r.info();
    expect(info).toContain("redis_version");
  });
});