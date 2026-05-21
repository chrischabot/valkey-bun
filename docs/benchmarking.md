# Benchmarking

valkey2 ships two benchmarks.

## 1. RESP data-plane benchmark — `bun run bench`

`bench/bench.ts` drives a production-realistic, weighted command mix through
the `ioredis` client with pipelining, against an in-process server.

```bash
bun run bench
# tunables (env):
BENCH_SECONDS=300 BENCH_PORT=16590 bun run bench
```

It reports total commands, throughput (cmd/s), latency percentiles
(p50/p90/p99/p99.9/max/mean), per-command percentiles, and `/proc`-sampled
server RSS/CPU. Representative result on a 2 vCPU box (30–60 s run):

```
Total commands : ~870k–1.38M
Throughput     : ~23,000–29,000 cmd/s
Latency p50    : ~17–21 ms
Latency p99    : ~41–50 ms
Server RSS     : peak ~165–173 MB
Server CPU     : ~1 core saturated
```

Numbers vary with host, duration, and concurrency; treat them as relative.

## 2. Admin HTTP protocol benchmark — `bun run http-bench`

`bench/http-bench.ts` drives the **admin endpoint** over HTTP/1.1, HTTP/2,
and HTTP/3 (QUIC) using Bun's `proto`-pinned fetch client, for a static route
(`/health`) and a dynamic route (`/info`).

The server must already be running on `ADMIN_PORT`:

```bash
# terminal 1
VALKEY_ADMIN_PORT=8399 bun run start
# terminal 2
HTTP_BENCH_SECONDS=15 HTTP_BENCH_CONCURRENCY=64 ADMIN_PORT=8399 bun run http-bench
```

It prints, per route, a table of req/s and p50/p90/p99/mean/max for each
protocol plus an explicit **HTTP/3-vs-HTTP/2 delta**.

### Interpreting RESP vs HTTP

The Redis **data plane is raw RESP over TCP** — it has *no* HTTP version and
is unaffected by HTTP/2 vs HTTP/3. Only the admin endpoint has an HTTP
version. On loopback (zero RTT/loss) HTTP/1.1≈HTTP/2≈HTTP/3 on throughput and
median latency; the consistent, reproducible signal is that **HTTP/3 has the
lowest tail/max latency**. QUIC's structural advantages (no head-of-line
blocking under loss, connection migration, 0/1-RTT over real RTT) only fully
manifest over a lossy/high-latency WAN, which a single-box benchmark cannot
reproduce.

## Methodology notes

- Both benchmarks warm up before measuring.
- Latency uses exponential-bucket histograms (`bench/*`), not naive arrays.
- For stable numbers, pin the process, close other load, and use
  `BENCH_SECONDS`/`HTTP_BENCH_SECONDS` ≥ 60.