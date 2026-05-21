// valkey2 admin-endpoint HTTP protocol benchmark.
//
// The Redis data plane is raw RESP over TCP and has no HTTP version — it is
// unaffected by HTTP/2 vs HTTP/3. The only HTTP surface is the admin/metrics
// endpoint (Bun.serve({ http3: true, tls })), which simultaneously serves
// HTTP/1.1 + HTTP/2 over TCP and HTTP/3 over QUIC/UDP on the same port. This
// benchmark pins Bun's fetch client to each protocol via the `proto` option
// and drives the same live server so the H1.1 vs H2 vs H3 deltas are apples-
// to-apples (same handler, same TLS, same host).
//
// Usage (server must already be listening on ADMIN_PORT):
//   HTTP_BENCH_SECONDS=15 HTTP_BENCH_CONCURRENCY=64 ADMIN_PORT=8399 \
//     bun run bench/http-bench.ts

const ADMIN_PORT = Number(process.env.ADMIN_PORT ?? 8399);
const SECONDS = Number(process.env.HTTP_BENCH_SECONDS ?? 15);
const CONCURRENCY = Number(process.env.HTTP_BENCH_CONCURRENCY ?? 64);
const BASE = `https://127.0.0.1:${ADMIN_PORT}`;

interface ProtoDef {
  label: string;
  proto: string;
}

// Bun's fetch `proto` pin (https://bun.com/blog/bun-v1.3.14): http1.1 / http2
// / http3 are accepted; h1/h2/h3 are accepted aliases.
const PROTOS: ProtoDef[] = [
  { label: "HTTP/1.1", proto: "http1.1" },
  { label: "HTTP/2", proto: "http2" },
  { label: "HTTP/3 (QUIC)", proto: "http3" },
];

const PATHS = ["/health", "/info"] as const;

class Hist {
  static readonly BASE = 1; // microseconds
  static readonly R = 1.08;
  static readonly N = 256;
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

  pct(p: number): number {
    if (this.count === 0) return 0;
    const target = Math.ceil((p / 100) * this.count);
    let cum = 0;
    for (let k = 0; k < Hist.N; k++) {
      cum += this.buckets[k]!;
      if (cum >= target) return Hist.BASE * Math.pow(Hist.R, k + 0.5);
    }
    return this.max;
  }

  mean(): number {
    return this.count ? this.sum / this.count : 0;
  }
}

function fmtUs(us: number): string {
  if (us < 1000) return `${us.toFixed(1)}us`;
  if (us < 1_000_000) return `${(us / 1000).toFixed(2)}ms`;
  return `${(us / 1_000_000).toFixed(2)}s`;
}

interface Result {
  label: string;
  path: string;
  ok: number;
  err: number;
  rps: number;
  hist: Hist;
  unsupported?: string;
}

async function probe(proto: string, url: string): Promise<string | null> {
  try {
    const r = await fetch(url, {
      proto,
      tls: { rejectUnauthorized: false },
    } as RequestInit);
    await r.text();
    if (r.status !== 200) return `status ${r.status}`;
    return null;
  } catch (e) {
    return (e as Error).message ?? String(e);
  }
}

async function runOne(proto: string, path: string, label: string): Promise<Result> {
  const url = BASE + path;
  const hist = new Hist();
  let ok = 0;
  let err = 0;

  // Warmup + capability probe (also primes keep-alive / QUIC session).
  const probeErr = await probe(proto, url);
  if (probeErr) {
    return { label, path, ok: 0, err: 0, rps: 0, hist, unsupported: probeErr };
  }
  for (let i = 0; i < 50; i++) await probe(proto, url);

  const stopAt = Date.now() + SECONDS * 1000;
  const t0 = process.hrtime.bigint();

  async function worker(): Promise<void> {
    while (Date.now() < stopAt) {
      const s = process.hrtime.bigint();
      try {
        const r = await fetch(url, {
          proto,
          tls: { rejectUnauthorized: false },
        } as RequestInit);
        await r.text();
        const usec = Number(process.hrtime.bigint() - s) / 1000;
        if (r.status === 200) {
          ok++;
          hist.add(usec);
        } else {
          err++;
        }
      } catch {
        err++;
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  const elapsed = Number(process.hrtime.bigint() - t0) / 1e9;
  return { label, path, ok, err, rps: ok / elapsed, hist };
}

async function main(): Promise<void> {
  // Ensure the server is reachable at all before benchmarking.
  const up = await probe("http1.1", BASE + "/health");
  if (up) {
    console.error(
      `[http-bench] admin endpoint not reachable at ${BASE} (${up}). ` +
      `Start valkey2 with VALKEY_ADMIN_PORT=${ADMIN_PORT} first.`,
    );
    process.exit(1);
  }

  console.log(
    `[http-bench] target=${BASE} duration=${SECONDS}s/leg ` +
    `concurrency=${CONCURRENCY} paths=${PATHS.join(",")}`,
  );

  const results: Result[] = [];
  for (const path of PATHS) {
    for (const p of PROTOS) {
      process.stdout.write(`  running ${p.label.padEnd(14)} ${path} ... `);
      const r = await runOne(p.proto, path, p.label);
      if (r.unsupported) {
        console.log(`unsupported (${r.unsupported})`);
      } else {
        console.log(
          `${r.rps.toFixed(0).padStart(7)} req/s  p50 ${fmtUs(r.hist.pct(50))}`,
        );
      }
      results.push(r);
    }
  }

  for (const path of PATHS) {
    console.log("\n=========================================================");
    console.log(`  Admin endpoint ${path} — ${SECONDS}s/leg, ${CONCURRENCY} concurrent`);
    console.log("=========================================================");
    console.log(
      `  ${"protocol".padEnd(15)} ${"req/s".padStart(9)} ${"p50".padStart(10)} ` +
      `${"p90".padStart(10)} ${"p99".padStart(10)} ${"mean".padStart(10)} ${"max".padStart(10)}`,
    );
    const rowsForPath = results.filter((r) => r.path === path);
    for (const r of rowsForPath) {
      if (r.unsupported) {
        console.log(`  ${r.label.padEnd(15)} ${"n/a".padStart(9)}  (unsupported: ${r.unsupported})`);
        continue;
      }
      console.log(
        `  ${r.label.padEnd(15)} ${r.rps.toFixed(0).padStart(9)} ` +
        `${fmtUs(r.hist.pct(50)).padStart(10)} ${fmtUs(r.hist.pct(90)).padStart(10)} ` +
        `${fmtUs(r.hist.pct(99)).padStart(10)} ${fmtUs(r.hist.mean()).padStart(10)} ` +
        `${fmtUs(r.hist.max).padStart(10)}`,
      );
    }
    // Explicit H3-vs-H2 delta.
    const h2 = rowsForPath.find((r) => r.label === "HTTP/2" && !r.unsupported);
    const h3 = rowsForPath.find((r) => r.label === "HTTP/3 (QUIC)" && !r.unsupported);
    if (h2 && h3 && h2.rps > 0) {
      const tputDelta = (h3.rps / h2.rps - 1) * 100;
      const p50Delta = (h3.hist.pct(50) / h2.hist.pct(50) - 1) * 100;
      const sign = (n: number) => (n >= 0 ? "+" : "");
      console.log("---------------------------------------------------------");
      console.log(
        `  HTTP/3 vs HTTP/2: throughput ${sign(tputDelta)}${tputDelta.toFixed(1)}%  ` +
        `p50 ${sign(p50Delta)}${p50Delta.toFixed(1)}%`,
      );
    }
  }
  console.log("=========================================================");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});