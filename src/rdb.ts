// Custom versioned snapshot codec for the in-memory Store.
//
// This is NOT the real Redis RDB binary format (loading by redis-check-rdb is
// a documented optional future milestone). It is a compact, versioned,
// binary-safe self-describing format that round-trips every valkey2 value
// type exactly — including raw Uint8Array payloads, latin1 keys, stream
// consumer groups, the full PEL, last-id counters, and absolute expiries —
// with a trailing CRC32 integrity check that is verified before any data is
// accepted on load.
//
// Empty databases are intentionally not written: the Store always
// pre-allocates `dbCount` empty Database instances, and SELECTDB opcodes
// restore every non-empty DB to its exact index, so leading/intermediate
// empty DBs are faithfully represented by their absence (identical approach
// to real Redis RDB, which also only emits non-empty DBs).

import {
  Database,
  Store,
  Stream,
  ZSet,
  bytesToKey,
  keyToBytes,
  type StoredValue,
} from "./store";

const MAGIC = new Uint8Array([0x56, 0x4b, 0x42, 0x31]); // "VKB1"
const VERSION = 1;

const OP_SELECTDB = 0xfe;
const OP_EXPIRE_MS = 0xfc;
const OP_EOF = 0xff;

const T_STRING = 0;
const T_LIST = 1;
const T_HASH = 2;
const T_SET = 3;
const T_ZSET = 4;
const T_STREAM = 5;

class ByteWriter {
  private buf = new Uint8Array(1 << 16);
  pos = 0;
  private ensure(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.pos + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.pos), 0);
    this.buf = next;
  }
  u8(n: number): void { this.ensure(1); this.buf[this.pos++] = n & 0xff; }
  // LEB128-style unsigned varint (handles values beyond 32-bit via Math).
  uvarint(n: number): void {
    this.ensure(10);
    let x = n;
    while (x >= 0x80) {
      this.buf[this.pos++] = (x & 0x7f) | 0x80;
      x = Math.floor(x / 128);
    }
    this.buf[this.pos++] = x & 0x7f;
  }
  f64(n: number): void {
    this.ensure(8);
    const dv = new DataView(this.buf.buffer, this.pos, 8);
    dv.setFloat64(0, n, true);
    this.pos += 8;
  }
  bytes(b: Uint8Array): void {
    this.uvarint(b.length);
    this.ensure(b.length);
    this.buf.set(b, this.pos);
    this.pos += b.length;
  }
  str(s: string): void { this.bytes(keyToBytes(s)); }
  raw(b: Uint8Array): void { this.ensure(b.length); this.buf.set(b, this.pos); this.pos += b.length; }
  snapshot(): Uint8Array { return this.buf.subarray(0, this.pos); }
}

class ByteReader {
  pos = 0;
  constructor(private buf: Uint8Array) {}
  eof(): boolean { return this.pos >= this.buf.length; }
  private need(n: number): void {
    if (this.pos + n > this.buf.length) {
      throw new Error("rdb: truncated or corrupt payload");
    }
  }
  u8(): number { this.need(1); return this.buf[this.pos++]!; }
  uvarint(): number {
    let shift = 1;
    let result = 0;
    while (true) {
      this.need(1);
      const b = this.buf[this.pos++]!;
      result += (b & 0x7f) * shift;
      if ((b & 0x80) === 0) break;
      shift *= 128;
    }
    return result;
  }
  f64(): number {
    this.need(8);
    const dv = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8);
    const n = dv.getFloat64(0, true);
    this.pos += 8;
    return n;
  }
  bytes(): Uint8Array {
    const len = this.uvarint();
    this.need(len);
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return new Uint8Array(out);
  }
  str(): string { return bytesToKey(this.bytes()); }
}

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function writeValue(w: ByteWriter, v: StoredValue): void {
  switch (v.type) {
    case "string":
      w.u8(T_STRING);
      w.bytes(v.value);
      return;
    case "list":
      w.u8(T_LIST);
      w.uvarint(v.value.length);
      for (const e of v.value) w.bytes(e);
      return;
    case "hash":
      w.u8(T_HASH);
      w.uvarint(v.value.size);
      for (const [f, val] of v.value) { w.str(f); w.bytes(val); }
      return;
    case "set":
      w.u8(T_SET);
      w.uvarint(v.value.size);
      for (const m of v.value) w.str(m);
      return;
    case "zset": {
      w.u8(T_ZSET);
      w.uvarint(v.value.byMember.size);
      for (const [m, s] of v.value.byMember) { w.str(m); w.f64(s); }
      return;
    }
    case "stream": {
      w.u8(T_STREAM);
      const s = v.value;
      w.uvarint(s.lastMs);
      w.uvarint(s.lastSeq);
      w.uvarint(s.entries.length);
      for (const e of s.entries) {
        w.str(e.id);
        w.uvarint(e.fields.length);
        for (const [f, val] of e.fields) { w.str(f); w.bytes(val); }
      }
      w.uvarint(s.groups.size);
      for (const g of s.groups.values()) {
        w.str(g.name);
        w.str(g.lastDelivered);
        w.uvarint(g.pending.size);
        for (const [id, p] of g.pending) {
          w.str(id); w.str(p.consumer); w.f64(p.deliveredAt); w.uvarint(p.deliveries);
        }
        w.uvarint(g.consumers.size);
        for (const c of g.consumers.values()) {
          w.str(c.name); w.f64(c.lastSeen); w.uvarint(c.pending);
        }
      }
      return;
    }
  }
}

function readValue(r: ByteReader): StoredValue {
  const t = r.u8();
  switch (t) {
    case T_STRING:
      return { type: "string", value: r.bytes() };
    case T_LIST: {
      const n = r.uvarint();
      const arr: Uint8Array[] = new Array(n);
      for (let i = 0; i < n; i++) arr[i] = r.bytes();
      return { type: "list", value: arr };
    }
    case T_HASH: {
      const n = r.uvarint();
      const m = new Map<string, Uint8Array>();
      for (let i = 0; i < n; i++) { const f = r.str(); m.set(f, r.bytes()); }
      return { type: "hash", value: m };
    }
    case T_SET: {
      const n = r.uvarint();
      const s = new Set<string>();
      for (let i = 0; i < n; i++) s.add(r.str());
      return { type: "set", value: s };
    }
    case T_ZSET: {
      const n = r.uvarint();
      const z = new ZSet();
      for (let i = 0; i < n; i++) { const m = r.str(); z.setScore(m, r.f64()); }
      return { type: "zset", value: z };
    }
    case T_STREAM: {
      const s = new Stream();
      s.lastMs = r.uvarint();
      s.lastSeq = r.uvarint();
      const ne = r.uvarint();
      for (let i = 0; i < ne; i++) {
        const id = r.str();
        const nf = r.uvarint();
        const fields: Array<[string, Uint8Array]> = [];
        for (let j = 0; j < nf; j++) { const f = r.str(); fields.push([f, r.bytes()]); }
        s.entries.push({ id, fields });
      }
      const ng = r.uvarint();
      for (let gi = 0; gi < ng; gi++) {
        const name = r.str();
        const lastDelivered = r.str();
        const pending = new Map<string, { consumer: string; deliveredAt: number; deliveries: number }>();
        const np = r.uvarint();
        for (let pi = 0; pi < np; pi++) {
          const id = r.str(); const consumer = r.str();
          const deliveredAt = r.f64(); const deliveries = r.uvarint();
          pending.set(id, { consumer, deliveredAt, deliveries });
        }
        const consumers = new Map<string, { name: string; lastSeen: number; pending: number }>();
        const nc = r.uvarint();
        for (let ci = 0; ci < nc; ci++) {
          const cname = r.str(); const lastSeen = r.f64(); const cp = r.uvarint();
          consumers.set(cname, { name: cname, lastSeen, pending: cp });
        }
        s.groups.set(name, { name, lastDelivered, pending, consumers });
      }
      return { type: "stream", value: s };
    }
    default:
      throw new Error(`rdb: unknown value type ${t}`);
  }
}

export function serializeStore(store: Store): Uint8Array {
  const w = new ByteWriter();
  w.raw(MAGIC);
  w.u8(VERSION);
  for (let dbi = 0; dbi < store.dbs.length; dbi++) {
    const d = store.dbs[dbi]!;
    if (d.data.size === 0) continue; // empty DBs are restored by pre-allocation
    w.u8(OP_SELECTDB);
    w.uvarint(dbi);
    for (const [key, val] of d.data) {
      const exp = d.expires.get(key);
      if (exp !== undefined) { w.u8(OP_EXPIRE_MS); w.f64(exp); }
      w.str(key);
      writeValue(w, val);
    }
  }
  w.u8(OP_EOF);
  const body = w.snapshot();
  const out = new Uint8Array(body.length + 4);
  out.set(body, 0);
  new DataView(out.buffer, body.length, 4).setUint32(0, crc32(body), true);
  return out;
}

// DUMP payload: value bytes + 2-byte version + 2-byte CRC16 footer.
export function dumpValue(v: StoredValue): Uint8Array {
  const w = new ByteWriter();
  writeValue(w, v);
  const body = w.snapshot();
  const out = new Uint8Array(body.length + 4);
  out.set(body, 0);
  const dv = new DataView(out.buffer, body.length, 4);
  dv.setUint16(0, VERSION, true);
  dv.setUint16(2, crc32(body) & 0xffff, true);
  return out;
}

export function restoreValue(payload: Uint8Array): StoredValue {
  if (payload.length < 5) throw new Error("ERR DUMP payload version or checksum are wrong");
  const body = payload.subarray(0, payload.length - 4);
  const dv = new DataView(payload.buffer, payload.byteOffset + payload.length - 4, 4);
  const ver = dv.getUint16(0, true);
  const crc = dv.getUint16(2, true);
  if (ver !== VERSION || crc !== (crc32(new Uint8Array(body)) & 0xffff)) {
    throw new Error("ERR DUMP payload version or checksum are wrong");
  }
  return readValue(new ByteReader(new Uint8Array(body)));
}

export function loadStore(store: Store, data: Uint8Array): void {
  if (data.length < 9) return;
  for (let i = 0; i < MAGIC.length; i++) {
    if (data[i] !== MAGIC[i]) throw new Error("rdb: bad magic");
  }
  const body = data.subarray(0, data.length - 4);
  const expected = new DataView(
    data.buffer, data.byteOffset + data.length - 4, 4,
  ).getUint32(0, true);
  if (crc32(new Uint8Array(body)) !== expected) {
    throw new Error("rdb: checksum mismatch — refusing to load corrupt snapshot");
  }
  const r = new ByteReader(new Uint8Array(body));
  r.pos = MAGIC.length;
  const ver = r.u8();
  if (ver !== VERSION) throw new Error(`rdb: unsupported version ${ver}`);
  let dbi = 0;
  let pendingExpiry: number | undefined;
  while (!r.eof()) {
    const op = r.u8();
    if (op === OP_EOF) break;
    if (op === OP_SELECTDB) { dbi = r.uvarint(); continue; }
    if (op === OP_EXPIRE_MS) { pendingExpiry = r.f64(); continue; }
    r.pos--; // op was the first byte of the key-length varint
    const key = r.str();
    const val = readValue(r);
    const d: Database = store.db(dbi);
    if (pendingExpiry !== undefined) {
      d.set(key, val, { expireAt: pendingExpiry });
      pendingExpiry = undefined;
    } else {
      d.set(key, val);
    }
  }
}