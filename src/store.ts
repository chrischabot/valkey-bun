// In-memory data store. Binary-safe via latin1 bijection (byte n <-> codepoint
// n) so arbitrary bytes survive as Map keys. Data-plane: raw, no Effect here.

export type ValueType = "string" | "list" | "hash" | "set" | "zset" | "stream" | "none";

const LATIN1 = new TextDecoder("latin1" as unknown as undefined);

export function bytesToKey(b: Uint8Array): string {
  return LATIN1.decode(b);
}

export function keyToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

export interface ZSetEntry {
  member: string;
  score: number;
}

export class ZSet {
  byMember = new Map<string, number>();
  // Cached sorted entries; null = rebuild on next sortedEntries(). All writes
  // must go through setScore()/remove() so the cache is invalidated.
  private _sorted: ZSetEntry[] | null = null;

  _invalidate(): void { this._sorted = null; }

  setScore(member: string, score: number): boolean {
    const had = this.byMember.has(member);
    const cur = this.byMember.get(member);
    if (had && cur === score) return false;
    this.byMember.set(member, score);
    this._sorted = null;
    return !had;
  }

  add(score: number, member: string): boolean {
    return this.setScore(member, score);
  }

  remove(member: string): boolean {
    if (this.byMember.delete(member)) {
      this._sorted = null;
      return true;
    }
    return false;
  }

  score(member: string): number | undefined {
    return this.byMember.get(member);
  }

  size(): number {
    return this.byMember.size;
  }

  sortedEntries(): ZSetEntry[] {
    if (this._sorted) return this._sorted;
    const arr: ZSetEntry[] = [];
    for (const [m, s] of this.byMember) arr.push({ member: m, score: s });
    arr.sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      return a.member < b.member ? -1 : a.member > b.member ? 1 : 0;
    });
    this._sorted = arr;
    return arr;
  }

  rank(member: string, reverse = false): number | null {
    if (!this.byMember.has(member)) return null;
    const sorted = this.sortedEntries();
    const idx = sorted.findIndex((e) => e.member === member);
    if (idx < 0) return null;
    return reverse ? sorted.length - 1 - idx : idx;
  }
}

export interface StreamEntry {
  id: string;
  fields: Array<[string, Uint8Array]>;
}

export interface StreamGroup {
  name: string;
  lastDelivered: string;
  pending: Map<string, { consumer: string; deliveredAt: number; deliveries: number }>;
  consumers: Map<string, { name: string; lastSeen: number; pending: number }>;
}

export class Stream {
  entries: StreamEntry[] = [];
  lastMs = 0;
  lastSeq = 0;
  groups = new Map<string, StreamGroup>();

  nextId(hint?: string): string {
    if (hint && hint !== "*") {
      const [msStr, seqStr] = hint.split("-");
      const ms = Number(msStr);
      let seq: number;
      if (seqStr === undefined || seqStr === "*") {
        seq = ms === this.lastMs ? this.lastSeq + 1 : 0;
      } else {
        seq = Number(seqStr);
      }
      if (ms < this.lastMs || (ms === this.lastMs && seq <= this.lastSeq)) {
        throw new Error("ERR The ID specified in XADD is equal or smaller than the target stream top item");
      }
      this.lastMs = ms;
      this.lastSeq = seq;
      return `${ms}-${seq}`;
    }
    const ms = Date.now();
    if (ms > this.lastMs) {
      this.lastMs = ms;
      this.lastSeq = 0;
    } else {
      this.lastSeq++;
    }
    return `${this.lastMs}-${this.lastSeq}`;
  }

  add(id: string, fields: Array<[string, Uint8Array]>): void {
    this.entries.push({ id, fields });
  }
}

export type StoredValue =
  | { type: "string"; value: Uint8Array }
  | { type: "list"; value: Uint8Array[] }
  | { type: "hash"; value: Map<string, Uint8Array> }
  | { type: "set"; value: Set<string> }
  | { type: "zset"; value: ZSet }
  | { type: "stream"; value: Stream };

export class Database {
  data = new Map<string, StoredValue>();
  expires = new Map<string, number>();
  hashTtls = new Map<string, Map<string, number>>();

  clear(): void {
    this.data.clear();
    this.expires.clear();
    this.hashTtls.clear();
  }

  size(): number {
    this.sweepLazy();
    return this.data.size;
  }

  getRaw(key: string): StoredValue | undefined {
    if (this.isExpired(key)) {
      this.data.delete(key);
      this.expires.delete(key);
      this.hashTtls.delete(key);
      return undefined;
    }
    const val = this.data.get(key);
    if (val && val.type === "hash") {
      const ft = this.hashTtls.get(key);
      if (ft && ft.size > 0) {
        const now = Date.now();
        for (const [f, exp] of ft) {
          if (now >= exp) { val.value.delete(f); ft.delete(f); }
        }
        if (ft.size === 0) this.hashTtls.delete(key);
        if (val.value.size === 0) {
          this.data.delete(key);
          this.expires.delete(key);
          this.hashTtls.delete(key);
          return undefined;
        }
      }
    }
    return val;
  }

  set(key: string, value: StoredValue, opts?: { keepTtl?: boolean | undefined; expireAt?: number | undefined }): void {
    this.data.set(key, value);
    if (opts?.expireAt !== undefined) {
      this.expires.set(key, opts.expireAt);
    } else if (!opts?.keepTtl) {
      this.expires.delete(key);
    }
  }

  delete(key: string): boolean {
    const had = this.data.has(key);
    this.data.delete(key);
    this.expires.delete(key);
    this.hashTtls.delete(key);
    return had;
  }

  rename(src: string, dst: string): boolean {
    const val = this.getRaw(src);
    if (!val) return false;
    const ttl = this.expires.get(src);
    const ht = this.hashTtls.get(src);
    this.data.delete(src);
    this.expires.delete(src);
    this.hashTtls.delete(src);
    this.data.set(dst, val);
    if (ttl !== undefined) this.expires.set(dst, ttl);
    else this.expires.delete(dst);
    if (ht) this.hashTtls.set(dst, ht);
    else this.hashTtls.delete(dst);
    return true;
  }

  exists(key: string): boolean {
    return this.getRaw(key) !== undefined;
  }

  keys(): string[] {
    this.sweepLazy();
    return Array.from(this.data.keys());
  }

  setExpiry(key: string, absoluteMs: number): boolean {
    if (!this.data.has(key)) return false;
    this.expires.set(key, absoluteMs);
    return true;
  }

  removeExpiry(key: string): boolean {
    return this.expires.delete(key);
  }

  ttl(key: string): { kind: "none" | "no_expire" | "ms"; ms?: number | undefined } {
    if (!this.data.has(key)) return { kind: "none" };
    const exp = this.expires.get(key);
    if (exp === undefined) return { kind: "no_expire" };
    return { kind: "ms", ms: exp - Date.now() };
  }

  private isExpired(key: string): boolean {
    const exp = this.expires.get(key);
    if (exp === undefined) return false;
    return Date.now() >= exp;
  }

  sweepLazy(): void {
    const now = Date.now();
    for (const [k, exp] of this.expires) {
      if (now >= exp) {
        this.data.delete(k);
        this.expires.delete(k);
        this.hashTtls.delete(k);
      }
    }
  }
}

export class Store {
  dbs: Database[];
  constructor(public dbCount = 16) {
    this.dbs = Array.from({ length: dbCount }, () => new Database());
  }
  db(index: number): Database {
    if (index < 0 || index >= this.dbs.length) throw new Error("ERR DB index is out of range");
    return this.dbs[index]!;
  }
}

export function type(v: StoredValue | undefined): ValueType {
  if (!v) return "none";
  return v.type;
}