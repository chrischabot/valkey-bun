import { Store, keyToBytes } from "./store";
import { PubSub } from "./pubsub";
import { RESP, type RespValue } from "./resp";
import { Connection } from "./connection";
import type { ResolvedConfig } from "./config";
import type { Persistence } from "./persistence";
import type { Registry } from "./commands";
import { dispatchSync } from "./commands";

interface Waiter {
  dbIndex: number;
  keys: string[];
  attempt: () => RespValue | null;
  onTimeout: () => RespValue;
  resolve: (v: RespValue) => void;
  timer: ReturnType<typeof setTimeout> | null;
  done: boolean;
}

// Minimal socket stub for loopback connections (AOF replay). It never writes
// to a real socket; replies are encoded into the connection buffer and
// discarded.
const NOOP_SOCKET = {
  write: () => 0,
  end: () => {},
  data: {},
} as unknown as ConstructorParameters<typeof Connection>[0];

export class ServerContext {
  store: Store;
  pubsub = new PubSub();
  connections = new Set<Connection>();
  startTime = Date.now();
  keyVersions: Map<number, Map<string, number>> = new Map();
  config: ResolvedConfig;
  configMap: Map<string, string>;
  totalCommands = 0;

  // Persistence wiring (set by index.ts) + AOF replay guard.
  persist: Persistence | null = null;
  registry: Registry | null = null;
  aofLoading = false;

  // Keyspace notifications (notify-keyspace-events flag string, e.g. "KEA").
  private notifyFlags: string;

  // Generic FIFO registry of parked (blocking) clients.
  private waiters: Waiter[] = [];

  // CLIENT TRACKING (RESP3 client-side caching) registry.
  trackingClients = new Set<Connection>();
  private trackedKeyIndex = new Map<string, Set<Connection>>();

  constructor(config: ResolvedConfig) {
    this.config = config;
    this.notifyFlags = config.notifyKeyspaceEvents ?? "";
    this.store = new Store(config.dbCount);
    for (let i = 0; i < config.dbCount; i++) this.keyVersions.set(i, new Map());
    this.configMap = new Map<string, string>([
      ["maxmemory", "0"],
      ["maxmemory-policy", "noeviction"],
      ["save", config.save ?? ""],
      ["appendonly", config.appendonly ? "yes" : "no"],
      ["appendfsync", config.appendfsync ?? "everysec"],
      ["appendfilename", config.appendfilename ?? "appendonly.aof"],
      ["dbfilename", config.dbfilename ?? "dump.rdb"],
      ["dir", config.dir ?? "."],
      ["aof-use-rdb-preamble", config.aofUseRdbPreamble ? "yes" : "no"],
      ["notify-keyspace-events", config.notifyKeyspaceEvents ?? ""],
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

  setNotifyKeyspaceEvents(flags: string): void {
    this.notifyFlags = flags;
  }

  notifyEnabled(): boolean {
    return this.notifyFlags.length > 0
      && (this.notifyFlags.includes("K") || this.notifyFlags.includes("E"));
  }

  notifyKeyspace(db: number, key: string, event: string, cls: string): void {
    const f = this.notifyFlags;
    if (f.length === 0) return;
    if (!(f.includes("A") || f.includes(cls))) return;
    if (f.includes("K")) {
      this.pubsub.publish(`__keyspace@${db}__:${key}`, keyToBytes(event));
    }
    if (f.includes("E")) {
      this.pubsub.publish(`__keyevent@${db}__:${event}`, keyToBytes(key));
    }
  }

  // ---- CLIENT TRACKING (RESP3 client-side caching) --------------------

  findConnection(id: number): Connection | undefined {
    for (const c of this.connections) if (c.id === id) return c;
    return undefined;
  }

  untrackConnection(conn: Connection): void {
    this.trackingClients.delete(conn);
    for (const id of conn.trackedKeys) {
      const s = this.trackedKeyIndex.get(id);
      if (s) { s.delete(conn); if (s.size === 0) this.trackedKeyIndex.delete(id); }
    }
    conn.trackedKeys.clear();
    conn.tracking = false;
    conn.trackingBcast = false;
    conn.trackingPrefixes = [];
    conn.trackingRedirect = 0;
    conn.trackingOptin = false;
    conn.trackingOptout = false;
    conn.trackingNoloop = false;
    conn.caching = null;
  }

  trackKeyRead(conn: Connection, db: number, key: string): void {
    if (!conn.tracking || conn.trackingBcast) return;
    if (conn.trackingOptin && conn.caching !== true) return;
    if (conn.trackingOptout && conn.caching === false) return;
    const id = `${db}\u0000${key}`;
    let s = this.trackedKeyIndex.get(id);
    if (!s) { s = new Set(); this.trackedKeyIndex.set(id, s); }
    s.add(conn);
    conn.trackedKeys.add(id);
  }

  private deliverInvalidation(c: Connection, keys: Uint8Array[] | null): void {
    const target = c.trackingRedirect > 0 ? this.findConnection(c.trackingRedirect) : c;
    if (target && !target.closed) target.sendInvalidation(keys);
  }

  invalidateKey(db: number, key: string, origin: Connection | null): void {
    if (this.trackingClients.size === 0) return;
    const id = `${db}\u0000${key}`;
    const kb = keyToBytes(key);
    const s = this.trackedKeyIndex.get(id);
    if (s) {
      for (const c of s) {
        if (c.trackingNoloop && c === origin) continue;
        this.deliverInvalidation(c, [kb]);
      }
      this.trackedKeyIndex.delete(id);
      for (const c of s) c.trackedKeys.delete(id);
    }
    for (const c of this.trackingClients) {
      if (!c.trackingBcast) continue;
      if (c.trackingNoloop && c === origin) continue;
      if (c.trackingPrefixes.length === 0 || c.trackingPrefixes.some((p) => key.startsWith(p))) {
        this.deliverInvalidation(c, [kb]);
      }
    }
  }

  invalidateAll(origin: Connection | null): void {
    if (this.trackingClients.size === 0) return;
    for (const c of this.trackingClients) {
      if (c.trackingNoloop && c === origin) continue;
      this.deliverInvalidation(c, null);
    }
    this.trackedKeyIndex.clear();
    for (const c of this.trackingClients) c.trackedKeys.clear();
  }

  // A reply-swallowing connection used to replay the AOF on boot.
  makeLoopbackConnection(): Connection {
    const c = new Connection(NOOP_SOCKET);
    c.authenticated = true;
    return c;
  }

  // Replay one command synchronously through the registry (AOF load).
  replayCommand(conn: Connection, name: string, args: Uint8Array[]): void {
    if (!this.registry) return;
    const maybe = dispatchSync(this, conn, this.registry, name, args);
    // RESTORE/SET/RPUSH/... are synchronous; nothing to await on replay.
    void maybe;
  }

  // ---- Generic blocking-waiter registry -------------------------------

  // Park a client until `attempt()` can satisfy it (re-evaluated whenever a
  // watched key is touched) or the timeout elapses (0 => block forever).
  registerWaiter(
    dbIndex: number,
    keys: string[],
    timeoutSeconds: number,
    attempt: () => RespValue | null,
    onTimeout: () => RespValue,
  ): Promise<RespValue> {
    return new Promise<RespValue>((resolve) => {
      const waiter: Waiter = {
        dbIndex, keys, attempt, onTimeout, resolve, timer: null, done: false,
      };
      if (timeoutSeconds > 0) {
        waiter.timer = setTimeout(() => {
          if (waiter.done) return;
          waiter.done = true;
          this.waiters = this.waiters.filter((w) => w !== waiter);
          resolve(onTimeout());
        }, timeoutSeconds * 1000);
        (waiter.timer as any).unref?.();
      }
      this.waiters.push(waiter);
    });
  }

  // Re-evaluate parked waiters watching (dbIndex,key) in FIFO order. Each
  // waiter's attempt() consumes from the store itself, so a single push
  // satisfies at most the appropriate number of waiters (Redis-correct).
  notifyKey(dbIndex: number, key: string): void {
    if (this.waiters.length === 0) return;
    let progressed = false;
    for (const w of this.waiters) {
      if (w.done || w.dbIndex !== dbIndex || !w.keys.includes(key)) continue;
      const r = w.attempt();
      if (r !== null) {
        w.done = true;
        if (w.timer) clearTimeout(w.timer);
        w.resolve(r);
        progressed = true;
      }
    }
    if (progressed) this.waiters = this.waiters.filter((w) => !w.done);
  }

  // Back-compat: BLPOP/BRPOP path. Pops one element off the first non-empty
  // watched key when notified.
  registerListWaiter(
    dbIndex: number,
    keys: string[],
    side: "left" | "right",
    timeoutSeconds: number,
  ): Promise<RespValue> {
    const attempt = (): RespValue | null => {
      const d = this.store.db(dbIndex);
      for (const key of keys) {
        const v = d.getRaw(key);
        if (v && v.type === "list" && v.value.length > 0) {
          const item = side === "left" ? v.value.shift()! : v.value.pop()!;
          if (v.value.length === 0) d.delete(key);
          this.bumpKey(dbIndex, key);
          return RESP.arr([
            { type: "bulk", value: keyToBytes(key) },
            { type: "bulk", value: item },
          ]);
        }
      }
      return null;
    };
    return this.registerWaiter(dbIndex, keys, timeoutSeconds, attempt, () => RESP.arr(null));
  }

  // Called by every list/zset/stream write that can satisfy a blocked client.
  notifyListPush(dbIndex: number, key: string): void {
    this.notifyKey(dbIndex, key);
  }
}