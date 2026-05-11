import { Store } from "./store";
import { PubSub } from "./pubsub";
import type { Connection } from "./connection";

export interface ServerConfig {
  host: string;
  port: number;
  password: string | null;
  maxClients: number;
  dbCount: number;
}

export class ServerContext {
  store: Store;
  pubsub = new PubSub();
  connections = new Set<Connection>();
  startTime = Date.now();
  // Per-(db,key) version counters used by WATCH for optimistic concurrency.
  keyVersions: Map<number, Map<string, number>> = new Map();
  config: ServerConfig;
  configMap: Map<string, string>;

  constructor(config: ServerConfig) {
    this.config = config;
    this.store = new Store(config.dbCount);
    for (let i = 0; i < config.dbCount; i++) this.keyVersions.set(i, new Map());
    this.configMap = new Map<string, string>([
      ["maxmemory", "0"],
      ["maxmemory-policy", "noeviction"],
      ["save", ""],
      ["appendonly", "no"],
      ["timeout", "0"],
      ["tcp-keepalive", "300"],
      ["databases", String(config.dbCount)],
      ["bind", config.host],
      ["port", String(config.port)],
      ["requirepass", config.password ?? ""],
    ]);
  }

  bumpKey(db: number, key: string): void {
    const m = this.keyVersions.get(db)!;
    m.set(key, (m.get(key) ?? 0) + 1);
  }

  keyVersion(db: number, key: string): number {
    return this.keyVersions.get(db)!.get(key) ?? 0;
  }
}