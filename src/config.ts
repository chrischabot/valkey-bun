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
  // Persistence
  readonly dir: string;
  readonly dbfilename: string;
  readonly appendonly: boolean;
  readonly appendfilename: string;
  readonly appendfsync: "always" | "everysec" | "no";
  readonly save: string;
  readonly aofUseRdbPreamble: boolean;
  // Keyspace notifications (flag string, e.g. "KEA")
  readonly notifyKeyspaceEvents: string;
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

  const dir = yield* Config.string("VALKEY_DIR").pipe(Config.withDefault("."));
  const dbfilename = yield* Config.string("VALKEY_DBFILENAME").pipe(Config.withDefault("dump.rdb"));
  const appendonlyStr = yield* Config.string("VALKEY_APPENDONLY").pipe(Config.withDefault("no"));
  const appendfilename = yield* Config.string("VALKEY_APPENDFILENAME").pipe(
    Config.withDefault("appendonly.aof"),
  );
  const appendfsyncStr = yield* Config.string("VALKEY_APPENDFSYNC").pipe(
    Config.withDefault("everysec"),
  );
  const save = yield* Config.string("VALKEY_SAVE").pipe(
    Config.withDefault("3600 1 300 100 60 10000"),
  );
  const aofPreambleStr = yield* Config.string("VALKEY_AOF_USE_RDB_PREAMBLE").pipe(
    Config.withDefault("yes"),
  );
  const notifyKeyspaceEvents = yield* Config.string("VALKEY_NOTIFY_KEYSPACE_EVENTS").pipe(
    Config.withDefault(""),
  );

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
  const fsync = appendfsyncStr.toLowerCase();
  if (fsync !== "always" && fsync !== "everysec" && fsync !== "no") {
    return yield* new ConfigError({
      field: "VALKEY_APPENDFSYNC",
      reason: `must be always|everysec|no, got ${appendfsyncStr}`,
    });
  }
  const parseBool = function* (field: string, raw: string) {
    if (/^(yes|true|1)$/i.test(raw)) return true;
    if (/^(no|false|0)$/i.test(raw)) return false;
    return yield* new ConfigError({ field, reason: `must be yes|no|true|false|1|0, got ${raw}` });
  };
  const appendonly = yield* parseBool("VALKEY_APPENDONLY", appendonlyStr);
  const aofUseRdbPreamble = yield* parseBool("VALKEY_AOF_USE_RDB_PREAMBLE", aofPreambleStr);
  if (save.trim().length > 0) {
    const parts = save.trim().split(/\s+/);
    if (parts.length % 2 !== 0 || parts.some((p) => !/^\d+$/.test(p))) {
      return yield* new ConfigError({
        field: "VALKEY_SAVE",
        reason: `must be space-separated <seconds> <changes> integer pairs, got "${save}"`,
      });
    }
  }
  if (notifyKeyspaceEvents.length > 0 && !/^[KEg$lshzxetmdnA]+$/.test(notifyKeyspaceEvents)) {
    return yield* new ConfigError({
      field: "VALKEY_NOTIFY_KEYSPACE_EVENTS",
      reason: `contains unknown flag characters: "${notifyKeyspaceEvents}"`,
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
    dir,
    dbfilename,
    appendonly,
    appendfilename,
    appendfsync: fsync as "always" | "everysec" | "no",
    save,
    aofUseRdbPreamble,
    notifyKeyspaceEvents,
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