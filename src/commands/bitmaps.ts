import type { CommandSpec } from "./index";
import { RESP, type RespValue } from "../resp";
import { bytesToKey, type Database } from "../store";

const dec = (b: Uint8Array) => new TextDecoder().decode(b);

function db(ctx: any, conn: any): Database { return ctx.store.db(conn.selectedDb); }

function getStr(d: Database, key: string): Uint8Array | null {
  const v = d.getRaw(key);
  if (!v) return null;
  if (v.type !== "string") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
  return v.value;
}

function popcount(b: number): number {
  b = b - ((b >> 1) & 0x55);
  b = (b & 0x33) + ((b >> 2) & 0x33);
  return (b + (b >> 4)) & 0x0f;
}

export const bitmapCommands: CommandSpec[] = [
  {
    name: "SETBIT",
    arity: 4,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const k = bytesToKey(args[0]!);
      const offset = Number(dec(args[1]!));
      const bit = Number(dec(args[2]!));
      if (!Number.isInteger(offset) || offset < 0) return RESP.err("ERR bit offset is not an integer or out of range");
      if (bit !== 0 && bit !== 1) return RESP.err("ERR bit is not an integer or out of range");
      const byteIdx = offset >> 3;
      const cur = getStr(d, k) ?? new Uint8Array(0);
      let buf: Uint8Array;
      if (byteIdx >= cur.length) {
        buf = new Uint8Array(byteIdx + 1);
        buf.set(cur, 0);
      } else {
        buf = new Uint8Array(cur);
      }
      const mask = 1 << (7 - (offset & 7));
      const old = (buf[byteIdx]! & mask) ? 1 : 0;
      if (bit) buf[byteIdx]! |= mask;
      else buf[byteIdx]! &= ~mask;
      d.set(k, { type: "string", value: buf }, { keepTtl: true });
      ctx.bumpKey(conn.selectedDb, k);
      return RESP.int(old);
    },
  },
  {
    name: "GETBIT",
    arity: 3,
    handler: (ctx, conn, args) => {
      const v = getStr(db(ctx, conn), bytesToKey(args[0]!));
      const offset = Number(dec(args[1]!));
      if (!Number.isInteger(offset) || offset < 0) return RESP.err("ERR bit offset is not an integer or out of range");
      if (!v) return RESP.int(0);
      const byteIdx = offset >> 3;
      if (byteIdx >= v.length) return RESP.int(0);
      return RESP.int((v[byteIdx]! & (1 << (7 - (offset & 7)))) ? 1 : 0);
    },
  },
  {
    name: "BITCOUNT",
    arity: -2,
    handler: (ctx, conn, args) => {
      const v = getStr(db(ctx, conn), bytesToKey(args[0]!));
      if (!v) return RESP.int(0);
      let bitMode = false;
      let start = 0, end = -1;
      if (args.length >= 3) {
        start = Number(dec(args[1]!));
        end = Number(dec(args[2]!));
        if (args.length >= 4) bitMode = dec(args[3]!).toUpperCase() === "BIT";
      } else if (args.length === 2) {
        return RESP.err("ERR syntax error");
      }
      let count = 0;
      if (!bitMode) {
        const len = v.length;
        if (start < 0) start = Math.max(0, len + start);
        if (end < 0) end = len + end;
        end = Math.min(end, len - 1);
        for (let i = start; i <= end; i++) count += popcount(v[i]!);
      } else {
        const totalBits = v.length * 8;
        if (start < 0) start = Math.max(0, totalBits + start);
        if (end < 0) end = totalBits + end;
        end = Math.min(end, totalBits - 1);
        for (let i = start; i <= end; i++) {
          if (v[i >> 3]! & (1 << (7 - (i & 7)))) count++;
        }
      }
      return RESP.int(count);
    },
  },
  {
    name: "BITPOS",
    arity: -3,
    handler: (ctx, conn, args) => {
      const v = getStr(db(ctx, conn), bytesToKey(args[0]!));
      const target = Number(dec(args[1]!));
      if (target !== 0 && target !== 1) return RESP.err("ERR The bit argument must be 1 or 0.");
      if (!v) return RESP.int(target === 0 ? 0 : -1);
      let bitMode = false;
      let hasStart = false, hasEnd = false;
      let start = 0, end = v.length - 1;
      if (args.length >= 3) { start = Number(dec(args[2]!)); hasStart = true; }
      if (args.length >= 4) { end = Number(dec(args[3]!)); hasEnd = true; }
      if (args.length >= 5) bitMode = dec(args[4]!).toUpperCase() === "BIT";
      let startBit: number, endBit: number;
      if (bitMode) {
        const totalBits = v.length * 8;
        startBit = hasStart ? (start < 0 ? Math.max(0, totalBits + start) : start) : 0;
        endBit = hasEnd ? (end < 0 ? totalBits + end : Math.min(end, totalBits - 1)) : totalBits - 1;
      } else {
        const len = v.length;
        const s = hasStart ? (start < 0 ? Math.max(0, len + start) : start) : 0;
        const e = hasEnd ? (end < 0 ? len + end : Math.min(end, len - 1)) : len - 1;
        startBit = s * 8;
        endBit = e * 8 + 7;
      }
      for (let i = startBit; i <= endBit; i++) {
        const bit = (v[i >> 3]! & (1 << (7 - (i & 7)))) ? 1 : 0;
        if (bit === target) return RESP.int(i);
      }
      if (target === 0 && !hasEnd) return RESP.int(v.length * 8);
      return RESP.int(-1);
    },
  },
  {
    name: "BITOP",
    arity: -4,
    handler: (ctx, conn, args) => {
      const op = dec(args[0]!).toUpperCase();
      if (op !== "AND" && op !== "OR" && op !== "XOR" && op !== "NOT") {
        return RESP.err("ERR syntax error");
      }
      const d = db(ctx, conn);
      const dest = bytesToKey(args[1]!);
      const srcs: Uint8Array[] = [];
      for (let i = 2; i < args.length; i++) srcs.push(getStr(d, bytesToKey(args[i]!)) ?? new Uint8Array(0));
      let maxLen = 0;
      for (const s of srcs) maxLen = Math.max(maxLen, s.length);
      let out: Uint8Array;
      if (op === "NOT") {
        if (srcs.length !== 1) return RESP.err("ERR BITOP NOT must be called with a single source key.");
        const s = srcs[0]!;
        out = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) out[i] = ~s[i]! & 0xff;
      } else {
        out = new Uint8Array(maxLen);
        for (let i = 0; i < maxLen; i++) {
          let acc = op === "AND" ? 0xff : 0;
          let first = true;
          for (const s of srcs) {
            const byte = i < s.length ? s[i]! : 0;
            if (op === "AND") acc &= byte;
            else if (op === "OR") acc |= byte;
            else acc = first ? byte : acc ^ byte; // XOR
            first = false;
          }
          out[i] = acc & 0xff;
        }
      }
      if (out.length === 0) d.delete(dest);
      else d.set(dest, { type: "string", value: out });
      ctx.bumpKey(conn.selectedDb, dest);
      return RESP.int(out.length);
    },
  },
  { name: "BITFIELD", arity: -2, handler: (ctx, conn, args) => bitfield(ctx, conn, args, false) },
  { name: "BITFIELD_RO", arity: -2, handler: (ctx, conn, args) => bitfield(ctx, conn, args, true) },
];

function parseType(t: string): { signed: boolean; bits: number } | null {
  const m = /^([iu])(\d+)$/.exec(t);
  if (!m) return null;
  const signed = m[1] === "i";
  const bits = Number(m[2]);
  if (bits < 1) return null;
  if (signed && bits > 64) return null;
  if (!signed && bits > 63) return null;
  return { signed, bits };
}

function readField(buf: Uint8Array, bitOffset: number, bits: number, signed: boolean): bigint {
  let val = 0n;
  for (let i = 0; i < bits; i++) {
    const pos = bitOffset + i;
    const byteIdx = pos >> 3;
    const bit = byteIdx < buf.length ? ((buf[byteIdx]! >> (7 - (pos & 7))) & 1) : 0;
    val = (val << 1n) | BigInt(bit);
  }
  if (signed && bits > 0 && ((val >> BigInt(bits - 1)) & 1n)) {
    val -= 1n << BigInt(bits);
  }
  return val;
}

function writeField(buf: Uint8Array, bitOffset: number, bits: number, value: bigint): void {
  const v = value & ((1n << BigInt(bits)) - 1n);
  for (let i = 0; i < bits; i++) {
    const pos = bitOffset + i;
    const byteIdx = pos >> 3;
    const bitVal = Number((v >> BigInt(bits - 1 - i)) & 1n);
    const mask = 1 << (7 - (pos & 7));
    if (bitVal) buf[byteIdx]! |= mask;
    else buf[byteIdx]! &= ~mask;
  }
}

function bitfield(ctx: any, conn: any, args: Uint8Array[], readonly: boolean): RespValue {
  const d = db(ctx, conn);
  const k = bytesToKey(args[0]!);
  const existing = getStr(d, k);
  let buf = existing ? new Uint8Array(existing) : new Uint8Array(0);
  let overflow: "WRAP" | "SAT" | "FAIL" = "WRAP";
  const out: RespValue[] = [];
  let mutated = false;
  const growFor = (bitOffset: number, bits: number): void => {
    const need = (bitOffset + bits + 7) >> 3;
    if (need > buf.length) {
      const nb = new Uint8Array(need);
      nb.set(buf, 0);
      buf = nb;
    }
  };
  for (let i = 1; i < args.length; ) {
    const opName = dec(args[i]!).toUpperCase();
    if (opName === "OVERFLOW") {
      if (i + 1 >= args.length) return RESP.err("ERR syntax error");
      const mode = dec(args[i + 1]!).toUpperCase();
      if (mode !== "WRAP" && mode !== "SAT" && mode !== "FAIL") {
        return RESP.err("ERR Invalid OVERFLOW type specified");
      }
      overflow = mode;
      i += 2;
      continue;
    }
    // GET needs type+offset (2 operands); SET/INCRBY need type+offset+value.
    if (i + 2 >= args.length) return RESP.err("ERR syntax error");
    const tInfo = parseType(dec(args[i + 1]!));
    if (!tInfo) return RESP.err("ERR Invalid bitfield type. Use something like i16 u8. Note that u64 is not supported but i64 is.");
    const offStr = dec(args[i + 2]!);
    const bitOffset = offStr.startsWith("#")
      ? Number(offStr.slice(1)) * tInfo.bits
      : Number(offStr);
    if (opName === "GET") {
      out.push(RESP.int(readField(buf, bitOffset, tInfo.bits, tInfo.signed)));
      i += 3;
    } else if (opName === "SET") {
      if (readonly) return RESP.err("ERR BITFIELD_RO only supports the GET subcommand");
      if (i + 3 >= args.length) return RESP.err("ERR syntax error");
      growFor(bitOffset, tInfo.bits);
      const prev = readField(buf, bitOffset, tInfo.bits, tInfo.signed);
      const newVal = BigInt(dec(args[i + 3]!));
      const clamped = applyOverflow(newVal, tInfo.bits, tInfo.signed, overflow);
      if (clamped === null) out.push(RESP.nil());
      else { writeField(buf, bitOffset, tInfo.bits, clamped); mutated = true; out.push(RESP.int(prev)); }
      i += 4;
    } else if (opName === "INCRBY") {
      if (readonly) return RESP.err("ERR BITFIELD_RO only supports the GET subcommand");
      if (i + 3 >= args.length) return RESP.err("ERR syntax error");
      growFor(bitOffset, tInfo.bits);
      const cur = readField(buf, bitOffset, tInfo.bits, tInfo.signed);
      const incr = BigInt(dec(args[i + 3]!));
      const clamped = applyOverflow(cur + incr, tInfo.bits, tInfo.signed, overflow);
      if (clamped === null) out.push(RESP.nil());
      else { writeField(buf, bitOffset, tInfo.bits, clamped); mutated = true; out.push(RESP.int(clamped)); }
      i += 4;
    } else {
      return RESP.err("ERR BITFIELD only supports GET, SET, INCRBY and OVERFLOW subcommands");
    }
  }
  if (mutated && !readonly) {
    d.set(k, { type: "string", value: buf }, { keepTtl: true });
    ctx.bumpKey(conn.selectedDb, k);
  }
  return RESP.arr(out);
}

function applyOverflow(v: bigint, bits: number, signed: boolean, mode: "WRAP" | "SAT" | "FAIL"): bigint | null {
  const min = signed ? -(1n << BigInt(bits - 1)) : 0n;
  const max = signed ? (1n << BigInt(bits - 1)) - 1n : (1n << BigInt(bits)) - 1n;
  if (v >= min && v <= max) return v;
  if (mode === "FAIL") return null;
  if (mode === "SAT") return v < min ? min : max;
  const range = 1n << BigInt(bits);
  return ((v - min) % range + range) % range + min;
}