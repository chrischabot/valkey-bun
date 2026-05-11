// valkey-bun benchmark suite.
//
// Spawns ./src/index.ts as a child process so server CPU/RSS can be measured
// in isolation via /proc. Connects N ioredis clients and drives a weighted
// production-like command mix at maximum throughput for the configured wall
// time. Records per-command latency into an exponential-bucket histogram and
// samples server resource usage every second.

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { Redis } from "ioredis";

const PORT = Number(process.env.BENCH_PORT ?? 16400);
const DURATION_S = Number(process.env.BENCH_SECONDS ?? 300);
const CLIENTS = Number(process.env.BENCH_CLIENTS ?? 32);
const PIPELINE = Number(process.env.BENCH_PIPELINE ?? 16);

// ---------- Histogram (exponential buckets) ----------
class Hist {
  // Buckets store latency in microseconds. Bucket k covers [base*r^k, base*r^(k+1)).
  static readonly BASE = 1; // 1us
  static readonly R = 1.1;
  static readonly N = 200; // up to ~1.1^200us = ~1.9e8us = ~190s
  buckets = new Uint32Array(Hist.N);
  count = 0;
  sum = 0;
  min = Infinity;
  max = 0;

  add(usec: number): void {
    this.count++;
    this.sum += usec;
    if (usec < this.min) this.min = usec;
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
      if (cum >= target) {
        // Mid-point of the bucket.
        return Hist.BASE * Math.pow(Hist.R, k + 0.5);
      }
    }
    return this.max;
  }
}

// ---------- Workload ----------
interface OpDef {
  name: string;
  weight: number;
  // Returns an awaited promise from the client.
  run: (r: Redis, i: number) => Promise<unknown>;
}

const ops: OpDef[] = [
  // 50% reads
  { name: "GET",       weight: 25, run: (r, i) => r.get(`k:${i % 10000}`) },
  { name: "HGETALL",   weight: 10, run: (r, i) => r.hgetall(`sess:${i % 5000}`) },
  { name: "HGET",      weight: 8,  run: (r, i) => r.hget(`sess:${i % 5000}`, "user_id") },
  { name: "ZRANGE",    weight: 5,  run: (r) => r.zrevrange("leaderboard", 0, 9, "WITHSCORES") },
  { name: "SISMEMBER", weight: 2,  run: (r, i) => r.sismember("active", `u:${i % 10000}`) },
  // 30% writes
  { name: "SET",       weight: 18, run: (r, i) => r.set(`k:${i % 10000}`, `v${i}`) },
  { name: "INCR",      weight: 7,  run: (r, i) => r.incr(`counter:${i % 100}`) },
  { name: "HSET",      weight: 3,  run: (r, i) => r.hset(`sess:${i % 5000}`, "last_seen", String(Date.now()), "ip", "10.0.0.1") },
  { name: "ZADD",      weight: 2,  run: (r, i) => r.zadd("leaderboard", String(i % 1000), `u:${i % 5000}`) },
  // 10% complex
  { name: "MULTI",     weight: 5,  run: (r, i) => r.multi().incr(`tx:${i % 500}`).expire(`tx:${i % 500}`, 60).exec() },
  { name: "ZRANGEBY",  weight: 3,  run: (r) => r.zrangebyscore("leaderboard", 100, 500) },
  { name: "EXPIRE",    weight: 2,  run: (r, i) => r.expire(`k:${i % 10000}`, 600) },
  // 5% pub/sub publish (subscribers attached separately)
  { name: "PUBLISH",   weight: 5,  run: (r, i) => r.publish(`events:${i % 8}`, `msg-${i}`) },
  // 3% streams
  { name: "XADD",      weight: 3,  run: (r, i) => r.xadd("log", "*", "level", "info", "id", String(i)) },
  // 2% misc
  { name: "EXISTS",    weight: 1,  run: (r, i) => r.exists(`k:${i % 10000}`) },
  { name: "SADD",      weight: 1,  run: (r, i) => r.sadd("active", `u:${i % 10000}`) },
];

// Build cumulative-weight lookup for O(1) selection.
const totalWeight = ops.reduce((s, o) => s + o.weight, 0);
const cumWeights = new Float64Array(ops.length);
{
  let acc = 0;
  for (let i = 0; i < ops.length; i++) { acc += ops[i]!.weight; cumWeights[i] = acc; }
}
function pickOp(): OpDef {
  const r = Math.random() * totalWeight;
  for (let i = 0; i < cumWeights.length; i++) if (r < cumWeights[i]!) return ops[i]!;
  return ops[ops.length - 1]!;
}

// ---------- Server resource sampling ----------
function readProcStat(pid: number): { utime: number; stime: number; rss: number } | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Field layout: ... 14=utime 15=stime ... 24=rss (pages)
    // Skip to after the comm field which can contain spaces in parens.
    const close = stat.lastIndexOf(")");
    const fields = stat.slice(close + 2).split(" ");
    // After the close-paren we are at field index 3 (state).
    // utime is field 14 -> index in fields = 14 - 3 = 11
    const utime = Number(fields[11]);
    const stime = Number(fields[12]);
    const rssPages = Number(fields[21]);
    const pageSize = 4096;
    return { utime, stime, rss: rssPages * pageSize };
  } catch {
    return null;
  }
}

const HZ = 100; // typical Linux CLK_TCK

// ---------- Main ----------
async function main() {
  console.log(`[bench] starting valkey-bun on port ${PORT}`);
  const bunBin = (process as any).versions?.bun ? process.execPath : "bun";
  const server: ChildProcess = spawn(bunBin, ["--bun", "run", "src/index.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, VALKEY_PORT: String(PORT), VALKEY_HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", () => {});
  server.stderr?.on("data", (d) => process.stderr.write(`[server] ${d}`));
  // Wait until server is ready.
  await waitPort(PORT, 5000);
  console.log(`[bench] server pid=${server.pid}`);

  // Histograms.
  const overall = new Hist();
  const perOp = new Map<string, Hist>();
  for (const o of ops) perOp.set(o.name, new Hist());

  // Subscribers for pub/sub realism.
  const subs: Redis[] = [];
  for (let i = 0; i < 4; i++) {
    const s = new Redis({ host: "127.0.0.1", port: PORT });
    await new Promise<void>((res) => s.subscribe(`events:${i * 2}`, `events:${i * 2 + 1}`, () => res()));
    s.on("message", () => {}); // drain
    subs.push(s);
  }

  // Worker connections.
  const clients: Redis[] = [];
  for (let i = 0; i < CLIENTS; i++) {
    clients.push(new Redis({ host: "127.0.0.1", port: PORT, lazyConnect: false, enableAutoPipelining: true }));
  }
  await Promise.all(clients.map((c) => c.ping()));
  console.log(`[bench] ${CLIENTS} client connections established, pipeline=${PIPELINE}`);

  // Resource sampler.
  const samples: { ts: number; rss: number; cpuPct: number }[] = [];
  let lastStat = readProcStat(server.pid!);
  let lastSampleAt = Date.now();
  const sampler = setInterval(() => {
    const now = Date.now();
    const cur = readProcStat(server.pid!);
    if (cur && lastStat) {
      const elapsedMs = now - lastSampleAt;
      const cpuTicks = (cur.utime + cur.stime) - (lastStat.utime + lastStat.stime);
      const cpuPct = (cpuTicks / HZ) / (elapsedMs / 1000) * 100;
      samples.push({ ts: now, rss: cur.rss, cpuPct });
    }
    lastStat = cur;
    lastSampleAt = now;
  }, 1000);

  // Drive workload.
  const stopAt = Date.now() + DURATION_S * 1000;
  let total = 0;
  let opCounter = 0;

  const startNs = process.hrtime.bigint();
  const progressTimer = setInterval(() => {
    const elapsed = Number(process.hrtime.bigint() - startNs) / 1e9;
    const remaining = Math.max(0, DURATION_S - elapsed);
    process.stdout.write(`\r[bench] elapsed=${elapsed.toFixed(0)}s remaining=${remaining.toFixed(0)}s ops=${total} rps=${(total / elapsed).toFixed(0)}      `);
  }, 1000);

  async function workerLoop(client: Redis) {
    while (Date.now() < stopAt) {
      // Issue PIPELINE concurrent commands against this client.
      const promises: Promise<void>[] = [];
      for (let i = 0; i < PIPELINE; i++) {
        const op = pickOp();
        const idx = opCounter++;
        const t0 = process.hrtime.bigint();
        const p = op.run(client, idx).then(
          () => {
            const usec = Number(process.hrtime.bigint() - t0) / 1000;
            overall.add(usec);
            perOp.get(op.name)!.add(usec);
            total++;
          },
          () => {
            // Count errors as latency too so failing commands don't bias stats.
            const usec = Number(process.hrtime.bigint() - t0) / 1000;
            overall.add(usec);
            perOp.get(op.name)!.add(usec);
            total++;
          },
        );
        promises.push(p);
      }
      await Promise.all(promises);
    }
  }

  await Promise.all(clients.map((c) => workerLoop(c)));
  clearInterval(progressTimer);
  clearInterval(sampler);
  process.stdout.write("\n");

  // Cleanup.
  for (const s of subs) s.disconnect();
  for (const c of clients) c.disconnect();

  // Summary.
  const elapsed = Number(process.hrtime.bigint() - startNs) / 1e9;
  printSummary(elapsed, total, overall, perOp, samples);

  // Stop server.
  server.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 200));
}

function waitPort(port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tryConn = () => {
      const sock = Bun.connect({
        hostname: "127.0.0.1",
        port,
        socket: {
          open(s) { s.end(); resolve(); },
          error() {
            if (Date.now() - start > timeoutMs) reject(new Error("server start timeout"));
            else setTimeout(tryConn, 50);
          },
          data() {},
        },
      }).catch(() => {
        if (Date.now() - start > timeoutMs) reject(new Error("server start timeout"));
        else setTimeout(tryConn, 50);
      });
      void sock;
    };
    tryConn();
  });
}

function fmtUs(us: number): string {
  if (us < 1000) return `${us.toFixed(1)}us`;
  if (us < 1000_000) return `${(us / 1000).toFixed(2)}ms`;
  return `${(us / 1000_000).toFixed(2)}s`;
}
function fmtMB(bytes: number): string { return `${(bytes / 1024 / 1024).toFixed(1)}MB`; }

function printSummary(
  elapsed: number,
  total: number,
  overall: Hist,
  perOp: Map<string, Hist>,
  samples: { ts: number; rss: number; cpuPct: number }[],
) {
  const rps = total / elapsed;
  const peakRss = samples.reduce((m, s) => Math.max(m, s.rss), 0);
  const avgRss = samples.length ? samples.reduce((s, x) => s + x.rss, 0) / samples.length : 0;
  const avgCpu = samples.length ? samples.reduce((s, x) => s + x.cpuPct, 0) / samples.length : 0;
  const peakCpu = samples.reduce((m, s) => Math.max(m, s.cpuPct), 0);

  console.log("\n=========================================================");
  console.log(`  valkey-bun benchmark - ${elapsed.toFixed(1)}s, ${CLIENTS} clients, pipeline=${PIPELINE}`);
  console.log("=========================================================");
  console.log(`  Total commands : ${total.toLocaleString()}`);
  console.log(`  Throughput     : ${rps.toFixed(0).padStart(8)} cmd/s`);
  console.log(`  Latency p50    : ${fmtUs(overall.percentile(50)).padStart(8)}`);
  console.log(`  Latency p90    : ${fmtUs(overall.percentile(90)).padStart(8)}`);
  console.log(`  Latency p99    : ${fmtUs(overall.percentile(99)).padStart(8)}`);
  console.log(`  Latency p99.9  : ${fmtUs(overall.percentile(99.9)).padStart(8)}`);
  console.log(`  Latency max    : ${fmtUs(overall.max).padStart(8)}`);
  console.log(`  Latency mean   : ${fmtUs(overall.sum / Math.max(1, overall.count)).padStart(8)}`);
  console.log("---------------------------------------------------------");
  console.log(`  Server RSS     : peak ${fmtMB(peakRss)}, avg ${fmtMB(avgRss)}`);
  console.log(`  Server CPU     : peak ${peakCpu.toFixed(1)}%, avg ${avgCpu.toFixed(1)}%`);
  console.log(`  Samples        : ${samples.length} (1s interval)`);
  console.log("=========================================================");
  console.log("  Per-command percentiles (us)");
  console.log(`  ${"command".padEnd(12)} ${"count".padStart(10)} ${"p50".padStart(10)} ${"p90".padStart(10)} ${"p99".padStart(10)} ${"max".padStart(10)}`);
  for (const op of ops) {
    const h = perOp.get(op.name)!;
    if (h.count === 0) continue;
    console.log(`  ${op.name.padEnd(12)} ${h.count.toLocaleString().padStart(10)} ${fmtUs(h.percentile(50)).padStart(10)} ${fmtUs(h.percentile(90)).padStart(10)} ${fmtUs(h.percentile(99)).padStart(10)} ${fmtUs(h.max).padStart(10)}`);
  }
  console.log("=========================================================");
}

main().catch((e) => { console.error(e); process.exit(1); });