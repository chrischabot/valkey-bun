import { Store, keyToBytes } from "./store";
import { PubSub } from "./pubsub";
import { RESP, type RespValue } from "./resp";
import type { Connection } from "./connection";
import type { ResolvedConfig } from "./config";

interface ListWaiter {
  dbIndex: number;
  keys: string[];
  side: "left" | "right";
  resolve: (v: RespValue) => void;
  timer: ReturnType<typeof setTimeout> | null;
  done: boolean;
}

export class ServerContext {
  store: Store;
  pubsub = new PubSub();
  connections = new Set<Connection>();
  startTime = Date.now();
  keyVersions: Map<number, Map<string, number>> = new Map();
  config: ResolvedConfig;
  configMap: Map<string, string>;
  totalCommands = 0;

  // FIFO queue of clients parked on BLPOP/BRPOP.
  private listWaiters: ListWaiter[] = [];

  constructor(config: ResolvedConfig) {
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

  // Park a BLPOP/BRPOP client. Resolves with the [key, element] array when an
  // element becomes available, or nil-array on timeout (0 => block forever).
  registerListWaiter(
    dbIndex: number,
    keys: string[],
    side: "left" | "right",
    timeoutSeconds: number,
  ): Promise<RespValue> {
    return new Promise<RespValue>((resolve) => {
      const waiter: ListWaiter = { dbIndex, keys, side, resolve, timer: null, done: false };
      if (timeoutSeconds > 0) {
        waiter.timer = setTimeout(() => {
          if (waiter.done) return;
          waiter.done = true;
          this.listWaiters = this.listWaiters.filter((w) => w !== waiter);
          resolve(RESP.arr(null));
        }, timeoutSeconds * 1000);
        (waiter.timer as any).unref?.();
      }
      this.listWaiters.push(waiter);
    });
  }

  // Called by list-push commands after appending. Wakes the OLDEST single
  // matching waiter (FIFO) and hands it one popped element, then stops. One
  // push event resolves at most one blocked client (Redis-correct).
  notifyListPush(dbIndex: number, key: string): void {
    if (this.listWaiters.length === 0) return;
    for (let idx = 0; idx < this.listWaiters.length; idx++) {
      const w = this.listWaiters[idx]!;
      if (w.done || w.dbIndex !== dbIndex || !w.keys.includes(key)) continue;
      const d = this.store.db(dbIndex);
      const v = d.getRaw(key);
      if (!v || v.type !== "list" || v.value.length === 0) continue;
      const item = w.side === "left" ? v.value.shift()! : v.value.pop()!;
      if (v.value.length === 0) d.delete(key);
      this.bumpKey(dbIndex, key);
      w.done = true;
      if (w.timer) clearTimeout(w.timer);
      w.resolve(RESP.arr([
        { type: "bulk", value: keyToBytes(key) },
        { type: "bulk", value: item },
      ]));
      this.listWaiters = this.listWaiters.filter((x) => !x.done);
      return;
    }
  }
}