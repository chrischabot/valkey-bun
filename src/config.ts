import { Config, Context, Effect, Layer, Redacted } from "effect";
import { ConfigError } from "./errors";

// Plain config record consumed by the raw data-plane server. Effect governs
// how it is loaded/validated (control plane); the value itself is plain.
export interface ResolvedConfig {
  readonly host: string;
  readonly port: number;
  readonly password: string | null;
  readonly maxClients: number;
  readonly dbCount: number;
  readonly clusterSize: number;
  readonly adminPort: number;
}

// Service: contract only (effect.solutions — Services & Layers). Tag id uses
// the @path/to/Name convention.
export class ServerConfig extends Context.Service<ServerConfig, {
  readonly value: ResolvedConfig;
}>()("@valkey2/ServerConfig") {}

// Verified Effect v4 Config API (see vendor/effect CONFIG.md):
//   Config.string / Config.int / Config.port / Config.redacted are lowercase
//   constructors; Config.withDefault supplies a fallback; Redacted.value
//   unwraps a redacted secret.
const loadConfig = Effect.gen(function* () {
  const host = yield* Config.string("VALKEY_HOST").pipe(Config.withDefault("0.0.0.0"));
  const port = yield* Config.port("VALKEY_PORT").pipe(Config.withDefault(6379));
  const maxClients = yield* Config.int("VALKEY_MAXCLIENTS").pipe(Config.withDefault(10000));
  const dbCount = yield* Config.int("VALKEY_DBCOUNT").pipe(Config.withDefault(16));
  const clusterSize = yield* Config.int("VALKEY_CLUSTER_SIZE").pipe(Config.withDefault(1));
  const adminPort = yield* Config.port("VALKEY_ADMIN_PORT").pipe(Config.withDefault(8080));
  const passwordRedacted = yield* Config.redacted("VALKEY_PASSWORD").pipe(
    Config.withDefault(Redacted.make("")),
  );
  const password = Redacted.value(passwordRedacted);

  if (dbCount < 1) {
    return yield* new ConfigError({
      field: "VALKEY_DBCOUNT",
      reason: `must be >= 1, got ${dbCount}`,
    });
  }
  if (clusterSize < 1) {
    return yield* new ConfigError({
      field: "VALKEY_CLUSTER_SIZE",
      reason: `must be >= 1, got ${clusterSize}`,
    });
  }
  if (maxClients < 1) {
    return yield* new ConfigError({
      field: "VALKEY_MAXCLIENTS",
      reason: `must be >= 1, got ${maxClients}`,
    });
  }

  const resolved: ResolvedConfig = {
    host,
    port,
    password: password.length > 0 ? password : null,
    maxClients,
    dbCount,
    clusterSize,
    adminPort,
  };
  return resolved;
});

// Primary layer (effect.solutions naming convention: `.layer`).
export const layer = Layer.effect(
  ServerConfig,
  Effect.gen(function* () {
    const value = yield* loadConfig;
    return { value };
  }),
);

// Explicit/test layer: provide a value directly (effect.solutions — Config in
// tests: just provide a layer with test values, no ConfigProvider needed).
export const layerValue = (value: ResolvedConfig): Layer.Layer<ServerConfig> =>
  Layer.succeed(ServerConfig, { value });