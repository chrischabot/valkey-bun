import { Context, Effect, Layer } from "effect";
import { spawn } from "node:child_process";
import { startServer } from "./server";
import type { ServerConfig } from "./server-context";

const CLUSTER_SIZE = Number(process.env.VALKEY_CLUSTER_SIZE ?? 1);

if (CLUSTER_SIZE > 1 && !process.env.VALKEY_WORKER) {
  // Master: fork N workers and exit.
  const workers = [];
  for (let i = 0; i < CLUSTER_SIZE; i++) {
    const w = spawn(process.execPath, ["--bun", "run", new URL(import.meta.url).pathname], {
      env: { ...process.env, VALKEY_WORKER: String(i) },
      stdio: "inherit",
    });
    workers.push(w);
  }
  process.on("SIGINT", () => { for (const w of workers) w.kill("SIGINT"); process.exit(0); });
  process.on("SIGTERM", () => { for (const w of workers) w.kill("SIGTERM"); process.exit(0); });
  // Keep master alive until all workers exit.
  let alive = workers.length;
  for (const w of workers) w.on("exit", () => { if (--alive === 0) process.exit(0); });
} else {
  // Worker (or single-process): start the listener.
  class Config extends Context.Service<Config>()("Config") {
    declare readonly value: ServerConfig & { reusePort?: boolean };
  }

  const ConfigLive = Layer.succeed(
    Config,
    { value: {
      host: process.env.VALKEY_HOST ?? "0.0.0.0",
      port: Number(process.env.VALKEY_PORT ?? 6379),
      password: process.env.VALKEY_PASSWORD || null,
      maxClients: Number(process.env.VALKEY_MAXCLIENTS ?? 10000),
      dbCount: Number(process.env.VALKEY_DBCOUNT ?? 16),
      reusePort: CLUSTER_SIZE > 1,
    } } as any,
  );

  const program = Effect.gen(function* () {
    const cfg = (yield* Config).value;
    const t0 = performance.now();
    startServer(cfg);
    const ms = (performance.now() - t0).toFixed(2);
    const role = process.env.VALKEY_WORKER !== undefined
      ? `worker ${process.env.VALKEY_WORKER}`
      : "single-process";
    yield* Effect.log(
      `valkey-bun ${role} listening on ${cfg.host}:${cfg.port} (db=${cfg.dbCount}) ready in ${ms}ms`,
    );
    yield* Effect.never;
  });

  Effect.runPromise(Effect.provide(program, ConfigLive)).catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
}