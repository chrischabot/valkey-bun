import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ServerContext } from "./server-context";
import type { ResolvedConfig } from "./config";
import { encode, parse } from "./resp";
import { bytesToKey, keyToBytes } from "./store";
import { serializeStore, loadStore, dumpValue } from "./rdb";

const ENC = new TextEncoder();

function frame(name: string, args: Uint8Array[]): Uint8Array {
  const items = [{ type: "bulk" as const, value: ENC.encode(name) },
    ...args.map((a) => ({ type: "bulk" as const, value: a }))];
  return encode({ type: "array", value: items });
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const b of parts) total += b.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const b of parts) { out.set(b, o); o += b.length; }
  return out;
}

function writeFileFsync(path: string, data: Uint8Array): void {
  writeFileSync(path, data);
  const fd = openSync(path, "r+");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

interface SaveRule { seconds: number; changes: number; }

export class Persistence {
  private ctx: ServerContext;
  private cfg: ResolvedConfig;
  private aofPath: string;
  private rdbPath: string;
  private aofBuf: Uint8Array[] = [];
  private aofFd: number | null = null;
  private lastAofDb = 0;
  private dirty = 0;
  private lastSaveMs = Date.now();
  private fsyncTimer: ReturnType<typeof setInterval> | null = null;
  private saveTimer: ReturnType<typeof setInterval> | null = null;
  private saveRules: SaveRule[] = [];
  private bgsaveInProgress = false;
  lastSaveSec: number = Math.floor(Date.now() / 1000);
  aofEnabled: boolean;

  constructor(ctx: ServerContext, cfg: ResolvedConfig) {
    this.ctx = ctx;
    this.cfg = cfg;
    this.aofEnabled = cfg.appendonly;
    try { mkdirSync(cfg.dir, { recursive: true }); } catch { /* dir may exist */ }
    this.aofPath = join(cfg.dir, cfg.appendfilename);
    this.rdbPath = join(cfg.dir, cfg.dbfilename);
    this.saveRules = this.parseSaveRules(cfg.save);
  }

  private parseSaveRules(s: string): SaveRule[] {
    const parts = s.trim().split(/\s+/).filter((x) => x.length > 0);
    const rules: SaveRule[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const sec = Number(parts[i]);
      const ch = Number(parts[i + 1]);
      if (Number.isFinite(sec) && Number.isFinite(ch)) rules.push({ seconds: sec, changes: ch });
    }
    return rules;
  }

  // ---- Boot load -------------------------------------------------------

  load(): void {
    this.ctx.aofLoading = true;
    try {
      if (this.aofEnabled && existsSync(this.aofPath)) {
        this.loadAof();
      } else if (existsSync(this.rdbPath)) {
        try {
          loadStore(this.ctx.store, new Uint8Array(readFileSync(this.rdbPath)));
        } catch (e) {
          console.error("[valkey2] RDB load failed:", (e as Error).message);
        }
      }
    } finally {
      this.ctx.aofLoading = false;
    }
    if (this.aofEnabled) this.aofFd = openSync(this.aofPath, "a");
  }

  private loadAof(): void {
    const buf = new Uint8Array(readFileSync(this.aofPath));
    let pos = 0;
    let db = 0;
    const conn = this.ctx.makeLoopbackConnection();
    while (pos < buf.length) {
      const r = parse(buf, pos);
      if (!r) break; // truncated tail — stop (aof-load-truncated semantics)
      pos = r.next;
      const v = r.value;
      if (v.type !== "array" || !v.value || v.value.length === 0) continue;
      const parts = v.value.map((x) => (x.type === "bulk" && x.value ? x.value : new Uint8Array(0)));
      const name = bytesToKey(parts[0]!).toUpperCase();
      const args = parts.slice(1);
      if (name === "SELECT") { db = Number(bytesToKey(args[0]!)); conn.selectedDb = db; continue; }
      conn.selectedDb = db;
      this.ctx.replayCommand(conn, name, args);
    }
  }

  // ---- AOF append (hot path: in-memory buffer only) --------------------

  feed(dbIndex: number, name: string, args: Uint8Array[], ttlKeys?: string[]): void {
    if (!this.aofEnabled || this.ctx.aofLoading) return;
    if (dbIndex !== this.lastAofDb) {
      this.aofBuf.push(frame("SELECT", [ENC.encode(String(dbIndex))]));
      this.lastAofDb = dbIndex;
    }
    this.aofBuf.push(frame(name, args));
    // Rewrite relative TTLs to absolute PEXPIREAT for replay correctness.
    if (ttlKeys && ttlKeys.length > 0) {
      const d = this.ctx.store.db(dbIndex);
      for (const k of ttlKeys) {
        const exp = d.expires.get(k);
        if (exp !== undefined) {
          this.aofBuf.push(frame("PEXPIREAT", [keyToBytes(k), ENC.encode(String(Math.floor(exp)))]));
        }
      }
    }
    this.dirty++;
    if (this.cfg.appendfsync === "always") this.flushAof(true);
  }

  private flushAof(doFsync: boolean): void {
    if (this.aofBuf.length === 0) return;
    const out = concat(this.aofBuf);
    this.aofBuf.length = 0;
    try {
      if (this.aofFd === null) this.aofFd = openSync(this.aofPath, "a");
      appendFileSync(this.aofFd, out);
      if (doFsync && this.aofFd !== null) fsyncSync(this.aofFd);
    } catch (e) {
      console.error("[valkey2] AOF write failed:", (e as Error).message);
    }
  }

  // ---- RDB save --------------------------------------------------------

  save(): void {
    const data = serializeStore(this.ctx.store);
    const tmp = `${this.rdbPath}.tmp-${process.pid}`;
    writeFileFsync(tmp, data);
    renameSync(tmp, this.rdbPath);
    this.dirty = 0;
    this.lastSaveMs = Date.now();
    this.lastSaveSec = Math.floor(this.lastSaveMs / 1000);
  }

  // Serialize synchronously (cheap, no in-place mutation hazard), then write
  // + fsync off the hot path on a microtask (the BGSAVE emulation, design B).
  // Guarded so overlapping BGSAVE requests cannot race the dirty counter.
  bgsave(): boolean {
    if (this.bgsaveInProgress) return false;
    this.bgsaveInProgress = true;
    const data = serializeStore(this.ctx.store);
    const consumed = this.dirty; // changes captured by this snapshot
    queueMicrotask(() => {
      try {
        const tmp = `${this.rdbPath}.tmp-${process.pid}`;
        writeFileFsync(tmp, data);
        renameSync(tmp, this.rdbPath);
        // Only the changes captured by this snapshot are cleared; writes that
        // arrived after the synchronous serialize remain counted. Never < 0.
        this.dirty = Math.max(0, this.dirty - consumed);
        this.lastSaveMs = Date.now();
        this.lastSaveSec = Math.floor(this.lastSaveMs / 1000);
      } catch (e) {
        console.error("[valkey2] BGSAVE failed:", (e as Error).message);
      } finally {
        this.bgsaveInProgress = false;
      }
    });
    return true;
  }

  // ---- AOF rewrite (minimal, fully faithful via RESTORE) ---------------
  //
  // Each key is emitted as a single RESTORE carrying the snapshot-codec
  // payload, so EVERY type — including streams with consumer groups, the
  // full PEL and last-id — round-trips losslessly. Absolute expiries are
  // preserved with ABSTTL. The temp file is fsynced before the atomic
  // rename so the rewritten AOF is durable.

  rewriteAof(): void {
    if (!this.aofEnabled) return;
    // The store is the single source of truth. Every command still buffered
    // in aofBuf has already been applied to ctx.store, and the rewrite below
    // serializes the ENTIRE store, so those buffered frames are fully
    // represented by the new base file and are safely superseded — clearing
    // aofBuf afterwards is non-lossy by construction.
    const w: Uint8Array[] = [];
    for (let dbi = 0; dbi < this.ctx.store.dbs.length; dbi++) {
      const d = this.ctx.store.dbs[dbi]!;
      if (d.data.size === 0) continue;
      w.push(frame("SELECT", [ENC.encode(String(dbi))]));
      for (const [key, val] of d.data) {
        const kb = keyToBytes(key);
        const payload = dumpValue(val);
        const exp = d.expires.get(key);
        if (exp !== undefined) {
          w.push(frame("RESTORE", [kb, ENC.encode(String(Math.floor(exp))), payload,
            ENC.encode("REPLACE"), ENC.encode("ABSTTL")]));
        } else {
          w.push(frame("RESTORE", [kb, ENC.encode("0"), payload, ENC.encode("REPLACE")]));
        }
      }
    }
    const tmp = `${this.aofPath}.tmp-${process.pid}`;
    writeFileFsync(tmp, concat(w));
    if (this.aofFd !== null) { try { closeSync(this.aofFd); } catch { /* ignore */ } }
    renameSync(tmp, this.aofPath);
    this.aofFd = openSync(this.aofPath, "a");
    this.lastAofDb = 0;
    this.aofBuf.length = 0;
  }

  // ---- Lifecycle -------------------------------------------------------

  start(): void {
    if (this.aofEnabled) {
      const doFsync = this.cfg.appendfsync === "everysec";
      this.fsyncTimer = setInterval(() => this.flushAof(doFsync), 1000);
      (this.fsyncTimer as any).unref?.();
    }
    if (this.saveRules.length > 0) {
      this.saveTimer = setInterval(() => {
        const elapsed = (Date.now() - this.lastSaveMs) / 1000;
        for (const rule of this.saveRules) {
          if (this.dirty >= rule.changes && elapsed >= rule.seconds) {
            this.bgsave();
            break;
          }
        }
      }, 1000);
      (this.saveTimer as any).unref?.();
    }
  }

  enableAof(): void {
    if (this.aofEnabled) return;
    this.aofEnabled = true;
    this.aofFd = openSync(this.aofPath, "a");
    this.rewriteAof(); // snapshot current dataset as the new AOF base
    if (!this.fsyncTimer) {
      const doFsync = this.cfg.appendfsync === "everysec";
      this.fsyncTimer = setInterval(() => this.flushAof(doFsync), 1000);
      (this.fsyncTimer as any).unref?.();
    }
  }

  disableAof(): void {
    this.flushAof(true);
    this.aofEnabled = false;
  }

  flushOnShutdown(): void {
    if (this.aofEnabled) this.flushAof(true);
    try { this.save(); } catch { /* best effort */ }
  }
}