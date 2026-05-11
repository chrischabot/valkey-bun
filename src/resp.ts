// RESP2 / RESP3 protocol codec.

export type RespValue =
  | { type: "simple"; value: string }
  | { type: "error"; value: string }
  | { type: "integer"; value: bigint | number }
  | { type: "bulk"; value: Uint8Array | null }
  | { type: "array"; value: RespValue[] | null }
  | { type: "null" }
  | { type: "boolean"; value: boolean }
  | { type: "double"; value: number }
  | { type: "bignum"; value: bigint }
  | { type: "verbatim"; format: string; value: string }
  | { type: "map"; value: Array<[RespValue, RespValue]> }
  | { type: "set"; value: RespValue[] }
  | { type: "attribute"; attrs: Array<[RespValue, RespValue]>; value: RespValue }
  | { type: "push"; value: RespValue[] }
  | { type: "blob_error"; value: Uint8Array };

export const CR = 0x0d;
export const LF = 0x0a;

export interface ParseResult { value: RespValue; next: number; }

function findCRLF(buf: Uint8Array, start: number): number {
  for (let i = start; i < buf.length - 1; i++) {
    if (buf[i] === CR && buf[i + 1] === LF) return i;
  }
  return -1;
}

function readLine(buf: Uint8Array, start: number): { line: string; next: number } | null {
  const end = findCRLF(buf, start);
  if (end === -1) return null;
  return { line: new TextDecoder().decode(buf.subarray(start, end)), next: end + 2 };
}

function readBulk(buf: Uint8Array, body: number): { data: Uint8Array | null; next: number } | null {
  const head = readLine(buf, body);
  if (!head) return null;
  const len = parseIntStrict(head.line);
  if (len === null) return null;
  if (len < 0) {
    if (len === -1) return { data: null, next: head.next };
    return null;
  }
  const dataEnd = head.next + len;
  if (buf.length < dataEnd + 2) return null;
  if (buf[dataEnd] !== CR || buf[dataEnd + 1] !== LF) return null;
  return { data: new Uint8Array(buf.subarray(head.next, dataEnd)), next: dataEnd + 2 };
}

// Strict integer parse: only ASCII digits with optional leading '-'.
function parseIntStrict(s: string): number | null {
  if (s.length === 0) return null;
  let i = 0;
  if (s[0] === "-" || s[0] === "+") i = 1;
  if (i >= s.length) return null;
  for (; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x30 || c > 0x39) return null;
  }
  const n = Number(s);
  if (!Number.isSafeInteger(n)) return null;
  return n;
}

// Aggregate count: must be a non-negative integer (arrays additionally allow -1
// for the legacy null-array form, handled by the caller).
function readAggregateLen(buf: Uint8Array, body: number, allowNegOne = false):
  | { n: number; next: number; nullForm?: boolean }
  | null {
  const head = readLine(buf, body);
  if (!head) return null;
  const n = parseIntStrict(head.line);
  if (n === null) return null;
  if (n < 0) {
    if (allowNegOne && n === -1) return { n: -1, next: head.next, nullForm: true };
    return null;
  }
  return { n, next: head.next };
}

export function parse(buf: Uint8Array, offset = 0): ParseResult | null {
  if (offset >= buf.length) return null;
  const tag = buf[offset];
  const body = offset + 1;
  switch (tag) {
    case 0x2b: {
      const l = readLine(buf, body);
      if (!l) return null;
      return { value: { type: "simple", value: l.line }, next: l.next };
    }
    case 0x2d: {
      const l = readLine(buf, body);
      if (!l) return null;
      return { value: { type: "error", value: l.line }, next: l.next };
    }
    case 0x3a: {
      const l = readLine(buf, body);
      if (!l) return null;
      const n = parseIntStrict(l.line);
      if (n === null) {
        try { return { value: { type: "integer", value: BigInt(l.line) }, next: l.next }; }
        catch { return null; }
      }
      return { value: { type: "integer", value: n }, next: l.next };
    }
    case 0x24: {
      const r = readBulk(buf, body);
      if (!r) return null;
      return { value: { type: "bulk", value: r.data }, next: r.next };
    }
    case 0x3d: {
      const r = readBulk(buf, body);
      if (!r || !r.data) return null;
      if (r.data.length < 4 || r.data[3] !== 0x3a) return null;
      const text = new TextDecoder().decode(r.data);
      return { value: { type: "verbatim", format: text.slice(0, 3), value: text.slice(4) }, next: r.next };
    }
    case 0x21: {
      const r = readBulk(buf, body);
      if (!r || !r.data) return null;
      return { value: { type: "blob_error", value: r.data }, next: r.next };
    }
    case 0x2a: { // '*' array: allows -1 for legacy null form
      const head = readAggregateLen(buf, body, true);
      if (!head) return null;
      if (head.nullForm) return { value: { type: "array", value: null }, next: head.next };
      const out: RespValue[] = [];
      let pos = head.next;
      for (let i = 0; i < head.n; i++) {
        const r = parse(buf, pos);
        if (!r) return null;
        out.push(r.value);
        pos = r.next;
      }
      return { value: { type: "array", value: out }, next: pos };
    }
    case 0x5f: {
      const l = readLine(buf, body);
      if (!l) return null;
      if (l.line.length !== 0) return null;
      return { value: { type: "null" }, next: l.next };
    }
    case 0x23: {
      const l = readLine(buf, body);
      if (!l) return null;
      if (l.line !== "t" && l.line !== "f") return null;
      return { value: { type: "boolean", value: l.line === "t" }, next: l.next };
    }
    case 0x2c: {
      const l = readLine(buf, body);
      if (!l) return null;
      let v: number;
      if (l.line === "inf") v = Infinity;
      else if (l.line === "-inf") v = -Infinity;
      else if (l.line === "nan") v = NaN;
      else {
        v = Number(l.line);
        if (Number.isNaN(v) && l.line !== "nan") return null;
      }
      return { value: { type: "double", value: v }, next: l.next };
    }
    case 0x28: {
      const l = readLine(buf, body);
      if (!l) return null;
      try { return { value: { type: "bignum", value: BigInt(l.line) }, next: l.next }; }
      catch { return null; }
    }
    case 0x25: { // '%' map
      const head = readAggregateLen(buf, body);
      if (!head) return null;
      const entries: Array<[RespValue, RespValue]> = [];
      let pos = head.next;
      for (let i = 0; i < head.n; i++) {
        const k = parse(buf, pos);
        if (!k) return null;
        const v = parse(buf, k.next);
        if (!v) return null;
        entries.push([k.value, v.value]);
        pos = v.next;
      }
      return { value: { type: "map", value: entries }, next: pos };
    }
    case 0x7e: { // '~' set
      const head = readAggregateLen(buf, body);
      if (!head) return null;
      const out: RespValue[] = [];
      let pos = head.next;
      for (let i = 0; i < head.n; i++) {
        const r = parse(buf, pos);
        if (!r) return null;
        out.push(r.value);
        pos = r.next;
      }
      return { value: { type: "set", value: out }, next: pos };
    }
    case 0x7c: { // '|' attribute
      const head = readAggregateLen(buf, body);
      if (!head) return null;
      const attrs: Array<[RespValue, RespValue]> = [];
      let pos = head.next;
      for (let i = 0; i < head.n; i++) {
        const k = parse(buf, pos);
        if (!k) return null;
        const v = parse(buf, k.next);
        if (!v) return null;
        attrs.push([k.value, v.value]);
        pos = v.next;
      }
      const payload = parse(buf, pos);
      if (!payload) return null;
      return { value: { type: "attribute", attrs, value: payload.value }, next: payload.next };
    }
    case 0x3e: { // '>' push
      const head = readAggregateLen(buf, body);
      if (!head) return null;
      const out: RespValue[] = [];
      let pos = head.next;
      for (let i = 0; i < head.n; i++) {
        const r = parse(buf, pos);
        if (!r) return null;
        out.push(r.value);
        pos = r.next;
      }
      return { value: { type: "push", value: out }, next: pos };
    }
    default: {
      const l = readLine(buf, offset);
      if (!l) return null;
      const parts = l.line.trim().split(/\s+/).filter((s) => s.length > 0);
      const arr: RespValue[] = parts.map((p) => ({ type: "bulk" as const, value: new TextEncoder().encode(p) }));
      return { value: { type: "array", value: arr }, next: l.next };
    }
  }
}

const ENC = new TextEncoder();

// ----------------------- Output writer / fast path -----------------------

// Pre-encoded common reply bytes - avoid allocation/encoding for the hottest replies.
const ENC_OK = ENC.encode("+OK\r\n");
const ENC_PONG = ENC.encode("+PONG\r\n");
const ENC_NIL_BULK = ENC.encode("$-1\r\n");
const ENC_NIL_ARR = ENC.encode("*-1\r\n");
const ENC_NULL = ENC.encode("_\r\n");
const ENC_EMPTY_ARR = ENC.encode("*0\r\n");
const ENC_TRUE = ENC.encode("#t\r\n");
const ENC_FALSE = ENC.encode("#f\r\n");
const ENC_BOOL_T = ENC.encode(":1\r\n");
const ENC_BOOL_F = ENC.encode(":0\r\n");
// Cache integer replies :-1..:256 in RESP2 form.
const ENC_INT_CACHE: Uint8Array[] = [];
for (let i = -1; i < 256; i++) ENC_INT_CACHE.push(ENC.encode(`:${i}\r\n`));
function cachedInt(n: number): Uint8Array | null {
  if (Number.isInteger(n) && n >= -1 && n < 256) return ENC_INT_CACHE[n + 1]!;
  return null;
}

export class OutWriter {
  buf: Uint8Array;
  pos = 0;
  constructor(initial = 4096) {
    this.buf = new Uint8Array(initial);
  }
  reset(): void { this.pos = 0; }
  ensure(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.pos + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.pos), 0);
    this.buf = next;
  }
  writeBytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.pos);
    this.pos += b.length;
  }
  writeAscii(s: string): void {
    this.ensure(s.length);
    for (let i = 0; i < s.length; i++) this.buf[this.pos++] = s.charCodeAt(i);
  }
  writeIntLine(prefix: number, n: number): void {
    this.ensure(24);
    this.buf[this.pos++] = prefix;
    if (n < 0) { this.buf[this.pos++] = 0x2d; n = -n; }
    if (n === 0) { this.buf[this.pos++] = 0x30; }
    else {
      const start = this.pos;
      while (n > 0) {
        this.buf[this.pos++] = 0x30 + (n % 10);
        n = Math.floor(n / 10);
      }
      let lo = start, hi = this.pos - 1;
      while (lo < hi) {
        const t = this.buf[lo]!;
        this.buf[lo++] = this.buf[hi]!;
        this.buf[hi--] = t;
      }
    }
    this.buf[this.pos++] = 0x0d;
    this.buf[this.pos++] = 0x0a;
  }
  snapshot(): Uint8Array {
    return this.buf.subarray(0, this.pos);
  }
}

export function encodeInto(out: OutWriter, value: RespValue, resp3 = false): void {
  switch (value.type) {
    case "simple": {
      if (value.value === "OK") return out.writeBytes(ENC_OK);
      if (value.value === "PONG") return out.writeBytes(ENC_PONG);
      out.ensure(1 + value.value.length + 2);
      out.buf[out.pos++] = 0x2b;
      out.writeAscii(value.value);
      out.buf[out.pos++] = 0x0d; out.buf[out.pos++] = 0x0a;
      return;
    }
    case "error": {
      out.ensure(1 + value.value.length + 2);
      out.buf[out.pos++] = 0x2d;
      out.writeAscii(value.value);
      out.buf[out.pos++] = 0x0d; out.buf[out.pos++] = 0x0a;
      return;
    }
    case "integer": {
      if (typeof value.value === "number") {
        const c = cachedInt(value.value);
        if (c) return out.writeBytes(c);
        out.writeIntLine(0x3a, value.value);
        return;
      }
      const s = value.value.toString();
      out.ensure(1 + s.length + 2);
      out.buf[out.pos++] = 0x3a;
      out.writeAscii(s);
      out.buf[out.pos++] = 0x0d; out.buf[out.pos++] = 0x0a;
      return;
    }
    case "bulk": {
      if (value.value === null) return out.writeBytes(ENC_NIL_BULK);
      out.writeIntLine(0x24, value.value.length);
      out.writeBytes(value.value);
      out.ensure(2);
      out.buf[out.pos++] = 0x0d; out.buf[out.pos++] = 0x0a;
      return;
    }
    case "array": {
      if (value.value === null) return out.writeBytes(ENC_NIL_ARR);
      if (value.value.length === 0) return out.writeBytes(ENC_EMPTY_ARR);
      out.writeIntLine(0x2a, value.value.length);
      for (const v of value.value) encodeInto(out, v, resp3);
      return;
    }
    case "null":
      return out.writeBytes(resp3 ? ENC_NULL : ENC_NIL_BULK);
    case "boolean":
      if (resp3) return out.writeBytes(value.value ? ENC_TRUE : ENC_FALSE);
      return out.writeBytes(value.value ? ENC_BOOL_T : ENC_BOOL_F);
    case "double": {
      let s: string;
      if (value.value === Infinity) s = "inf";
      else if (value.value === -Infinity) s = "-inf";
      else if (Number.isNaN(value.value)) s = "nan";
      else s = String(value.value);
      if (!resp3) {
        out.writeIntLine(0x24, s.length);
        out.writeAscii(s);
        out.ensure(2);
        out.buf[out.pos++] = 0x0d; out.buf[out.pos++] = 0x0a;
        return;
      }
      out.ensure(1 + s.length + 2);
      out.buf[out.pos++] = 0x2c;
      out.writeAscii(s);
      out.buf[out.pos++] = 0x0d; out.buf[out.pos++] = 0x0a;
      return;
    }
    case "map": {
      if (resp3) {
        out.writeIntLine(0x25, value.value.length);
        for (const [k, v] of value.value) {
          encodeInto(out, k, resp3);
          encodeInto(out, v, resp3);
        }
        return;
      }
      out.writeIntLine(0x2a, value.value.length * 2);
      for (const [k, v] of value.value) {
        encodeInto(out, k, resp3);
        encodeInto(out, v, resp3);
      }
      return;
    }
    case "set": {
      if (resp3) {
        out.writeIntLine(0x7e, value.value.length);
      } else {
        out.writeIntLine(0x2a, value.value.length);
      }
      for (const v of value.value) encodeInto(out, v, resp3);
      return;
    }
    case "push": {
      if (resp3) {
        out.writeIntLine(0x3e, value.value.length);
      } else {
        out.writeIntLine(0x2a, value.value.length);
      }
      for (const v of value.value) encodeInto(out, v, resp3);
      return;
    }
    case "attribute":
      if (resp3) {
        out.writeIntLine(0x7c, value.attrs.length);
        for (const [k, v] of value.attrs) {
          encodeInto(out, k, resp3);
          encodeInto(out, v, resp3);
        }
      }
      encodeInto(out, value.value, resp3);
      return;
    case "verbatim": {
      const body = `${value.format}:${value.value}`;
      const b = ENC.encode(body);
      out.writeIntLine(resp3 ? 0x3d : 0x24, b.length);
      out.writeBytes(b);
      out.ensure(2);
      out.buf[out.pos++] = 0x0d; out.buf[out.pos++] = 0x0a;
      return;
    }
    case "bignum":
      if (resp3) {
        const s = value.value.toString();
        out.ensure(1 + s.length + 2);
        out.buf[out.pos++] = 0x28;
        out.writeAscii(s);
        out.buf[out.pos++] = 0x0d; out.buf[out.pos++] = 0x0a;
        return;
      }
      out.writeAscii(`:${value.value.toString()}\r\n`);
      return;
    case "blob_error":
      out.writeIntLine(0x21, value.value.length);
      out.writeBytes(value.value);
      out.ensure(2);
      out.buf[out.pos++] = 0x0d; out.buf[out.pos++] = 0x0a;
      return;
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function encode(value: RespValue, resp3 = false): Uint8Array {
  switch (value.type) {
    case "simple": return ENC.encode(`+${value.value}\r\n`);
    case "error": return ENC.encode(`-${value.value}\r\n`);
    case "integer": {
      const s = typeof value.value === "bigint" ? value.value.toString() : String(value.value);
      return ENC.encode(`:${s}\r\n`);
    }
    case "bulk": {
      if (value.value === null) return ENC.encode("$-1\r\n");
      return concat([ENC.encode(`$${value.value.length}\r\n`), value.value, ENC.encode("\r\n")]);
    }
    case "array": {
      if (value.value === null) return ENC.encode("*-1\r\n");
      const parts = [ENC.encode(`*${value.value.length}\r\n`)];
      for (const v of value.value) parts.push(encode(v, resp3));
      return concat(parts);
    }
    case "null": return resp3 ? ENC.encode("_\r\n") : ENC.encode("$-1\r\n");
    case "boolean":
      return resp3 ? ENC.encode(value.value ? "#t\r\n" : "#f\r\n") : ENC.encode(`:${value.value ? 1 : 0}\r\n`);
    case "double": {
      if (!resp3) {
        const s = String(value.value);
        const b = ENC.encode(s);
        return concat([ENC.encode(`$${b.length}\r\n`), b, ENC.encode("\r\n")]);
      }
      let s: string;
      if (value.value === Infinity) s = "inf";
      else if (value.value === -Infinity) s = "-inf";
      else if (Number.isNaN(value.value)) s = "nan";
      else s = String(value.value);
      return ENC.encode(`,${s}\r\n`);
    }
    case "bignum":
      return resp3 ? ENC.encode(`(${value.value.toString()}\r\n`) : ENC.encode(`:${value.value.toString()}\r\n`);
    case "verbatim": {
      if (!resp3) {
        const b = ENC.encode(value.value);
        return concat([ENC.encode(`$${b.length}\r\n`), b, ENC.encode("\r\n")]);
      }
      const body = `${value.format}:${value.value}`;
      const b = ENC.encode(body);
      return concat([ENC.encode(`=${b.length}\r\n`), b, ENC.encode("\r\n")]);
    }
    case "map": {
      if (resp3) {
        const parts = [ENC.encode(`%${value.value.length}\r\n`)];
        for (const [k, v] of value.value) { parts.push(encode(k, resp3)); parts.push(encode(v, resp3)); }
        return concat(parts);
      }
      const flat: RespValue[] = [];
      for (const [k, v] of value.value) flat.push(k, v);
      return encode({ type: "array", value: flat }, resp3);
    }
    case "set": {
      if (resp3) {
        const parts = [ENC.encode(`~${value.value.length}\r\n`)];
        for (const v of value.value) parts.push(encode(v, resp3));
        return concat(parts);
      }
      return encode({ type: "array", value: value.value }, resp3);
    }
    case "attribute": {
      if (resp3) {
        const parts = [ENC.encode(`|${value.attrs.length}\r\n`)];
        for (const [k, v] of value.attrs) { parts.push(encode(k, resp3)); parts.push(encode(v, resp3)); }
        parts.push(encode(value.value, resp3));
        return concat(parts);
      }
      return encode(value.value, resp3);
    }
    case "push": {
      if (resp3) {
        const parts = [ENC.encode(`>${value.value.length}\r\n`)];
        for (const v of value.value) parts.push(encode(v, resp3));
        return concat(parts);
      }
      return encode({ type: "array", value: value.value }, resp3);
    }
    case "blob_error":
      return concat([ENC.encode(`!${value.value.length}\r\n`), value.value, ENC.encode("\r\n")]);
  }
}

export const RESP = {
  ok: (): RespValue => ({ type: "simple", value: "OK" }),
  pong: (): RespValue => ({ type: "simple", value: "PONG" }),
  err: (msg: string): RespValue => ({ type: "error", value: msg }),
  int: (n: number | bigint): RespValue => ({ type: "integer", value: n }),
  str: (s: string): RespValue => ({ type: "bulk", value: new TextEncoder().encode(s) }),
  bulk: (b: Uint8Array | null): RespValue => ({ type: "bulk", value: b }),
  nil: (): RespValue => ({ type: "bulk", value: null }),
  arr: (items: RespValue[] | null): RespValue => ({ type: "array", value: items }),
  simple: (s: string): RespValue => ({ type: "simple", value: s }),
  bool: (b: boolean): RespValue => ({ type: "boolean", value: b }),
  dbl: (d: number): RespValue => ({ type: "double", value: d }),
  mapv: (entries: Array<[RespValue, RespValue]>): RespValue => ({ type: "map", value: entries }),
  setv: (items: RespValue[]): RespValue => ({ type: "set", value: items }),
  push: (items: RespValue[]): RespValue => ({ type: "push", value: items }),
};

export function toStr(v: RespValue): string {
  if (v.type === "bulk" && v.value) return new TextDecoder().decode(v.value);
  if (v.type === "simple") return v.value;
  if (v.type === "integer") return String(v.value);
  return "";
}

export function toBytes(v: RespValue): Uint8Array {
  if (v.type === "bulk" && v.value) return v.value;
  if (v.type === "simple") return new TextEncoder().encode(v.value);
  return new Uint8Array(0);
}

// ----------------------- Fast-path command parser -----------------------

const LATIN1 = new TextDecoder("latin1");

export interface ParsedCommand {
  cmd: string;
  args: Uint8Array[];
  next: number;
}

export function parseCommand(buf: Uint8Array, offset = 0): ParsedCommand | null | false {
  if (offset >= buf.length) return null;
  if (buf[offset] !== 0x2a) return false;
  const lineEnd = findCRLF(buf, offset + 1);
  if (lineEnd === -1) return null;
  let count = 0;
  for (let i = offset + 1; i < lineEnd; i++) {
    const c = buf[i]!;
    if (c < 0x30 || c > 0x39) return false;
    count = count * 10 + (c - 0x30);
  }
  if (count === 0) return false;
  let pos = lineEnd + 2;
  if (pos >= buf.length) return null;
  if (buf[pos] !== 0x24) return false;
  const headEnd = findCRLF(buf, pos + 1);
  if (headEnd === -1) return null;
  if (buf[pos + 1] === 0x2d) return false;
  let len = 0;
  for (let i = pos + 1; i < headEnd; i++) {
    const c = buf[i]!;
    if (c < 0x30 || c > 0x39) return false;
    len = len * 10 + (c - 0x30);
  }
  const dataStart = headEnd + 2;
  const dataEnd = dataStart + len;
  if (buf.length < dataEnd + 2) return null;
  if (buf[dataEnd] !== 0x0d || buf[dataEnd + 1] !== 0x0a) return false;
  const cmd = LATIN1.decode(buf.subarray(dataStart, dataEnd));
  pos = dataEnd + 2;
  const args: Uint8Array[] = new Array(count - 1);
  for (let i = 0; i < count - 1; i++) {
    if (pos >= buf.length) return null;
    if (buf[pos] !== 0x24) return false;
    const aHead = findCRLF(buf, pos + 1);
    if (aHead === -1) return null;
    if (buf[pos + 1] === 0x2d) {
      if (aHead - (pos + 1) !== 2 || buf[pos + 2] !== 0x31) return false;
      args[i] = new Uint8Array(0);
      pos = aHead + 2;
      continue;
    }
    let alen = 0;
    for (let j = pos + 1; j < aHead; j++) {
      const c = buf[j]!;
      if (c < 0x30 || c > 0x39) return false;
      alen = alen * 10 + (c - 0x30);
    }
    const aStart = aHead + 2;
    const aEnd = aStart + alen;
    if (buf.length < aEnd + 2) return null;
    if (buf[aEnd] !== 0x0d || buf[aEnd + 1] !== 0x0a) return false;
    args[i] = buf.subarray(aStart, aEnd);
    pos = aEnd + 2;
  }
  return { cmd, args, next: pos };
}