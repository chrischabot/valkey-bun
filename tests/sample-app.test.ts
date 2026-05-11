import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Redis } from "ioredis";
import { startServer } from "../src/server";

const PORT = 16382;
let server: ReturnType<typeof startServer>;
let r: Redis;

beforeAll(async () => {
  server = startServer({ host: "127.0.0.1", port: PORT, password: null, maxClients: 1000, dbCount: 16 });
  r = new Redis({ host: "127.0.0.1", port: PORT, lazyConnect: false, maxRetriesPerRequest: 1 });
  await r.flushall();
});

afterAll(async () => {
  r.disconnect();
  server.server.stop(true);
});

describe("sample app", () => {
  test("session store with TTL and pipelined reads", async () => {
    const sid = "sess:abc123";
    await r.hset(sid, { user_id: "42", role: "admin", csrf: "xyz" });
    await r.expire(sid, 600);
    const [ttl, role, all] = await Promise.all([r.ttl(sid), r.hget(sid, "role"), r.hgetall(sid)]);
    expect(ttl).toBeGreaterThan(500);
    expect(role).toBe("admin");
    expect(all).toEqual({ user_id: "42", role: "admin", csrf: "xyz" });
  });

  test("page view counter under contention", async () => {
    await r.del("views:home");
    const N = 200;
    await Promise.all(Array.from({ length: N }, () => r.incr("views:home")));
    expect(await r.get("views:home")).toBe(String(N));
  });

  test("game leaderboard", async () => {
    await r.del("leaderboard");
    await r.zadd("leaderboard",
      "100", "alice", "200", "bob", "150", "carol", "175", "dave");
    const top3 = await r.zrevrange("leaderboard", 0, 2, "WITHSCORES");
    expect(top3).toEqual(["bob", "200", "dave", "175", "carol", "150"]);
    await r.zincrby("leaderboard", 60, "alice"); // alice -> 160
    const aliceRank = await r.zrevrank("leaderboard", "alice");
    expect(aliceRank).toBe(2); // bob, dave, alice
  });

  test("pub/sub event bus across multiple subscribers", async () => {
    const a = new Redis({ host: "127.0.0.1", port: PORT });
    const b = new Redis({ host: "127.0.0.1", port: PORT });
    const aMsgs: string[] = [];
    const bMsgs: string[] = [];
    await new Promise<void>((res) => a.subscribe("events", () => res()));
    await new Promise<void>((res) => b.psubscribe("events*", () => res()));
    a.on("message", (_c, m) => aMsgs.push(m));
    b.on("pmessage", (_p, _c, m) => bMsgs.push(m));
    await new Promise((r2) => setTimeout(r2, 30));
    await r.publish("events", "user.login");
    await r.publish("events.audit", "action.purge");
    await new Promise((r2) => setTimeout(r2, 100));
    expect(aMsgs).toEqual(["user.login"]);
    expect(bMsgs.sort()).toEqual(["action.purge", "user.login"]);
    a.disconnect();
    b.disconnect();
  });

  test("transactional money transfer with WATCH", async () => {
    await r.mset("acct:alice", "100", "acct:bob", "50");
    await r.watch("acct:alice", "acct:bob");
    const alice = Number(await r.get("acct:alice"));
    const bob = Number(await r.get("acct:bob"));
    const amount = 30;
    const res = await r.multi()
      .set("acct:alice", String(alice - amount))
      .set("acct:bob", String(bob + amount))
      .exec();
    expect(res).not.toBeNull();
    expect(await r.get("acct:alice")).toBe("70");
    expect(await r.get("acct:bob")).toBe("80");
  });

  test("cache pattern with SET EX and GETEX touch", async () => {
    await r.set("cache:user:42", JSON.stringify({ id: 42, name: "ada" }), "EX", 3600);
    const cached = await r.getex("cache:user:42", "EX", 7200);
    expect(JSON.parse(cached!)).toEqual({ id: 42, name: "ada" });
    expect(await r.ttl("cache:user:42")).toBeGreaterThan(7000);
  });

  test("queue pattern with LPUSH/BRPOP", async () => {
    await r.del("queue:work");
    await r.lpush("queue:work", "job1", "job2", "job3");
    const item = await r.brpop("queue:work", 0);
    expect(item).toEqual(["queue:work", "job1"]);
    expect(await r.llen("queue:work")).toBe(2);
  });

  test("stream event log", async () => {
    await r.del("log");
    const id1 = await r.xadd("log", "*", "level", "info", "msg", "started");
    const id2 = await r.xadd("log", "*", "level", "warn", "msg", "high cpu");
    expect(await r.xlen("log")).toBe(2);
    const all = await r.xrange("log", "-", "+");
    expect(all.map((e) => e[0])).toEqual([id1, id2]);
  });
});