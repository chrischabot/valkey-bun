// valkey2 benchmark — production-like weighted workload.
//
// Spawns src/index.ts as a child Bun process so server CPU/RSS can be measured
// in isolation via /proc. Drives a weighted command mix from N ioredis clients
// with pipelining for the configured wall time, recording per-command latency
// into exponential-bucket histograms.

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Redis } from "ioredis";

const PORT = Number(process.env.BENCH_PORT ?? 16500);
const DURATION_S = Number(process.env.BENCH_SECONDS ?? 300);
const CLIENTS = Number(process.env.BENCH_CLIENTS ?? 32);
const PIPELINE = Number(process.env.BENCH_PIPELINE ?? 16);

class Hist {
  static readonly BASE = 1;
  static readonly R = 1.1;
  static readonly N = 200;
  buckets = new Uint32Array(Hist.N);
  count = 0;
  sum = 0;
  max = 0;
  add(usec: number): void {
    this.count++;
    this.sum += usec;
    if (usec > this.max) this.max = usec;
    if (usec < 1) usec = 1;
    let k = Math.floor(Math.log(usec / Hist.BASE) / Math.log(Hist.R));
    if (k < 0) k = 0;
    if (k >= Hist.N) k = Hist.N - 1;
    this.buckets[k]!++;
  }
  percentile(p: number): number {
    if (this.count === 0) return 0;
    const target = Math.ceil((p / 100) * this.count);
    let cum = 0;
    for (let k = 0; k < Hist.N; k++) {
      cum += this.buckets[k]!;
      if (cum >= target) return Hist.BASE * Math.pow(Hist.R, k + 0.5);
    }
    return this.max;
  }
}

interface OpDef { name: string; weight: number; run: (r: Redis, i: number) => Promise<unknown>; }

const ops: OpDef[] = [
  { name: "GET",       weight: 25, run: (r, i) => r.get(`k:${i % 10000}`) },
  { name: "HGETALL",   weight: 10, run: (r, i) => r.hgetall(`sess:${i % 5000}`) },
  { name: "HGET",      weight: 8,  run: (r, i) => r.hget(`sess:${i % 5000}`, "user_id") },
  { name: "ZRANGE",    weight: 5,  run: (r) => r.zrevrange("leaderboard", 0, 9, "WITHSCORES") },
  { name: "SISMEMBER", weight: 2,  run: (r, i) => r.sismember("active", `u:${i % 10000}`) },
  { name: "SET",       weight: 18, run: (r, i) => r.set(`k:${i % 10000}`, `v${i}`) },
  { name: "INCR",      weight: 7,  run: (r, i) => r.incr(`counter:${i % 100}`) },
  { name: "HSET",      weight: 3,  run: (r, i) => r.hset(`sess:${i % 5000}`, "last_seen", String(Date.now())) },
  { name: "ZADD",      weight: 2,  run: (r, i) => r.zadd("leaderboard", String(i % 1000), `u:${i % 5000}`) },
  { name: "MULTI",     weight: 5,  run: (r, i) => r.multi().incr(`tx:${i % 500}`).expire(`tx:${i % 500}`, 60).exec() },
  { name: "ZRANGEBY",  weight: 3,  run: (r) => r.zrangebyscore("leaderboard", 100, 500) },
  { name: "EXPIRE",    weight: 2,  run: (r, i) => r.expire(`k:${i % 10000}`, 600) },
  { name: "PUBLISH",   weight: 5,  run: (r, i) => r.publish(`events:${i % 8}`, `msg-${i}`) },
  { name: "XADD",      weight: 3,  run: (r, i) => r.xadd("log", "*", "level", "info", "id", String(i)) },
  { name: "EXISTS",    weight: 1,  run: (r, i) => r.exists(`k:${i % 10000}`) },
  { name: "SADD",      weight: 1,  run: (r, i) => r.sadd("active", `u:${i % 10000}`) },
];

const totalWeight = ops.reduce((s, o) => s + o.weight, 0);
const cumWeights = new Float64Array(ops.length);
{ let acc = 0; for (let i = 0; i < ops.length; i++) { acc += ops[i]!.weight; cumWeights[i] = acc; } }
function pickOp(): OpDef {
  const r = Math.random() * totalWeight;
  for (let i = 0; i < cumWeights.length; i++) if (r < cumWeights[i]!) return ops[i]!;
  return ops[ops.length - 1]!;
}

function readProcStat(pid: number): { utime: number; stime: number; rss: number } | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const fields = stat.slice(close + 2).split(" ");
    return {
      utime: Number(fields[11]),
      stime: Number(fields[12]),
      rss: Number(fields[21]) * 4096,
    };
  } catch { return null; }
}
const HZ = 100;

async function waitPort(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      const s = await Bun.connect({ hostname: "127.0.0.1", port, socket: { open(x) { x.end(); }, data() {}, error() {} } });
      void s;
      return;
    } catch {
      if (Date.now() - start > timeoutMs) throw new Error("server start timeout");
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

function fmtUs(us: number): string {
  if (us < 1000) return `${us.toFixed(1)}us`;
  if (us < 1_000_000) return `${(us / 1000).toFixed(2)}ms`;
  return `${(us / 1_000_000).toFixed(2)}s`;
}
function fmtMB(b: number): string { return `${(b / 1024 / 1024).toFixed(1)}MB`; }

async function main() {
  const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  console.log(`[bench] starting valkey2 on port ${PORT}`);
  const server: ChildProcess = spawn(process.execPath, ["--bun", "run", entry], {
    env: { ...process.env, VALKEY_PORT: String(PORT), VALKEY_HOST: "127.0.0.1", VALKEY_ADMIN_PORT: String(PORT + 1) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", () => {});
  server.stderr?.on("data", (d) => process.stderr.write(`[server] ${d}`));
  await waitPort(PORT, 8000);
  console.log(`[bench] server pid=${server.pid}`);

  const overall = new Hist();
  const perOp = new Map<string, Hist>();
  for (const o of ops) perOp.set(o.name, new Hist());

  const subs: Redis[] = [];
  for (let i = 0; i < 4; i++) {
    const s = new Redis({ host: "127.0.0.1", port: PORT });
    await new Promise<void>((res) => s.subscribe(`events:${i * 2}`, `events:${i * 2 + 1}`, () => res()));
    s.on("message", () => {});
    subs.push(s);
  }

  const clients: Redis[] = [];
  for (let i = 0; i < CLIENTS; i++) {
    clients.push(new Redis({ host: "127.0.0.1", port: PORT, lazyConnect: false, enableAutoPipelining: true }));
  }
  await Promise.all(clients.map((c) => c.ping()));
  console.log(`[bench] ${CLIENTS} clients connected, pipeline=${PIPELINE}`);

  const samples: { rss: number; cpuPct: number }[] = [];
  let lastStat = readProcStat(server.pid!);
  let lastAt = Date.now();
  const sampler = setInterval(() => {
    const now = Date.now();
    const cur = readProcStat(server.pid!);
    if (cur && lastStat) {
      const elapsedMs = now - lastAt;
      const ticks = (cur.utime + cur.stime) - (lastStat.utime + lastStat.stime);
      samples.push({ rss: cur.rss, cpuPct: (ticks / HZ) / (elapsedMs / 1000) * 100 });
    }
    lastStat = cur;
    lastAt = now;
  }, 1000);

  const stopAt = Date.now() + DURATION_S * 1000;
  let total = 0;
  let opCounter = 0;
  const startNs = process.hrtime.bigint();
  const progress = setInterval(() => {
    const el = Number(process.hrtime.bigint() - startNs) / 1e9;
    process.stdout.write(`\r[bench] elapsed=${el.toFixed(0)}s ops=${total} rps=${(total / el).toFixed(0)}    `);
  }, 1000);

  async function worker(client: Redis) {
    while (Date.now() < stopAt) {
      const ps: Promise<void>[] = [];
      for (let i = 0; i < PIPELINE; i++) {
        const op = pickOp();
        const idx = opCounter++;
        const t0 = process.hrtime.bigint();
        ps.push(op.run(client, idx).then(
          () => { const us = Number(process.hrtime.bigint() - t0) / 1000; overall.add(us); perOp.get(op.name)!.add(us); total++; },
          () => { const us = Number(process.hrtime.bigint() - t0) / 1000; overall.add(us); perOp.get(op.name)!.add(us); total++; },
        ));
      }
      await Promise.all(ps);
    }
  }
  await Promise.all(clients.map((c) => worker(c)));
  clearInterval(progress);
  clearInterval(sampler);
  process.stdout.write("\n");
  for (const s of subs) s.disconnect();
  for (const c of clients) c.disconnect();

  const elapsed = Number(process.hrtime.bigint() - startNs) / 1e9;
  const peakRss = samples.reduce((m, s) => Math.max(m, s.rss), 0);
  const avgCpu = samples.length ? samples.reduce((s, x) => s + x.cpuPct, 0) / samples.length : 0;
  const peakCpu = samples.reduce((m, s) => Math.max(m, s.cpuPct), 0);

  console.log("\n=========================================================");
  console.log(`  valkey2 benchmark - ${elapsed.toFixed(1)}s, ${CLIENTS} clients, pipeline=${PIPELINE}`);
  console.log("=========================================================");
  console.log(`  Total commands : ${total.toLocaleString()}`);
  console.log(`  Throughput     : ${(total / elapsed).toFixed(0).padStart(8)} cmd/s`);
  console.log(`  Latency p50    : ${fmtUs(overall.percentile(50)).padStart(8)}`);
  console.log(`  Latency p90    : ${fmtUs(overall.percentile(90)).padStart(8)}`);
  console.log(`  Latency p99    : ${fmtUs(overall.percentile(99)).padStart(8)}`);
  console.log(`  Latency p99.9  : ${fmtUs(overall.percentile(99.9)).padStart(8)}`);
  console.log(`  Latency max    : ${fmtUs(overall.max).padStart(8)}`);
  console.log(`  Latency mean   : ${fmtUs(overall.sum / Math.max(1, overall.count)).padStart(8)}`);
  console.log("---------------------------------------------------------");
  console.log(`  Server RSS     : peak ${fmtMB(peakRss)}`);
  console.log(`  Server CPU     : peak ${peakCpu.toFixed(1)}%, avg ${avgCpu.toFixed(1)}%`);
  console.log("=========================================================");
  console.log(`  ${"command".padEnd(12)} ${"count".padStart(10)} ${"p50".padStart(10)} ${"p90".padStart(10)} ${"p99".padStart(10)}`);
  for (const op of ops) {
    const h = perOp.get(op.name)!;
    if (h.count === 0) continue;
    console.log(`  ${op.name.padEnd(12)} ${h.count.toLocaleString().padStart(10)} ${fmtUs(h.percentile(50)).padStart(10)} ${fmtUs(h.percentile(90)).padStart(10)} ${fmtUs(h.percentile(99)).padStart(10)}`);
  }
  console.log("=========================================================");

  server.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 200));
}

main().catch((e) => { console.error(e); process.exit(1); });