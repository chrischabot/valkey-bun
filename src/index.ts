import { Effect, Layer } from "effect";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ServerConfig, layer as configLayer } from "./config";
import { startTcpServer } from "./tcp-server";
import { startAdminServer } from "./admin";

// --- Multicore: master forks N reusePort workers, then exits with them. ---
const clusterEnv = Number(process.env.VALKEY_CLUSTER_SIZE ?? 1);
if (clusterEnv > 1 && !process.env.VALKEY_WORKER) {
  const self = fileURLToPath(import.meta.url);
  const workers: ChildProcess[] = [];
  for (let i = 0; i < clusterEnv; i++) {
    workers.push(
      spawn(process.execPath, ["--bun", "run", self], {
        env: { ...process.env, VALKEY_WORKER: String(i) },
        stdio: "inherit",
      }),
    );
  }
  const killAll = (sig: NodeJS.Signals) => { for (const w of workers) w.kill(sig); process.exit(0); };
  process.on("SIGINT", () => killAll("SIGINT"));
  process.on("SIGTERM", () => killAll("SIGTERM"));
  let alive = workers.length;
  for (const w of workers) w.on("exit", () => { if (--alive === 0) process.exit(0); });
} else {
  // --- Worker / single process: Effect-governed control plane. ---
  const program = Effect.gen(function* () {
    const { value: cfg } = yield* ServerConfig;
    const t0 = performance.now();

    const reusePort = clusterEnv > 1;
    const { ctx } = startTcpServer({ ...cfg, reusePort });

    const isAdminHost = process.env.VALKEY_WORKER === undefined
      || process.env.VALKEY_WORKER === "0";
    const admin = isAdminHost ? startAdminServer(ctx, cfg.adminPort) : null;

    const ms = (performance.now() - t0).toFixed(2);
    const role = process.env.VALKEY_WORKER !== undefined
      ? `worker ${process.env.VALKEY_WORKER}`
      : "single-process";
    yield* Effect.log(
      `valkey2 ${role} listening on ${cfg.host}:${cfg.port} ` +
      `(db=${cfg.dbCount})` +
      (isAdminHost ? ` admin http/3 (quic+h2+h1) on :${cfg.adminPort}` : " (admin: worker 0 only)") +
      ` ready in ${ms}ms`,
    );

    const shutdown = () => {
      try { ctx.persist?.flushOnShutdown(); } catch { /* ignore */ }
      try { admin?.stop(); } catch { /* ignore */ }
      process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);

    yield* Effect.never;
  });

  // effect.solutions: provide the layer once at the top of the application.
  const AppLayer = Layer.mergeAll(configLayer);

  const runnable = Effect.provide(program, AppLayer) as Effect.Effect<void, unknown, never>;
  Effect.runPromise(runnable).catch((e) => {
    // ConfigError (Schema.TaggedError) and any defect surface here at the
    // system boundary for diagnostics, then exit non-zero.
    console.error("[valkey2] fatal:", e?.message ?? e);
    process.exit(1);
  });
}