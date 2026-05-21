import type { CommandSpec } from "./index";
import { RESP } from "../resp";
import { bytesToKey, type Database } from "../store";

function db(ctx: any, conn: any): Database { return ctx.store.db(conn.selectedDb); }

const P = 14;
const M = 1 << P; // 16384 registers
const MAGIC = [0x48, 0x59, 0x4c, 0x4c, 0x32]; // "HYLL2" (our dense layout)
const HEADER = MAGIC.length;
const MASK64 = (1n << 64n) - 1n;

function isHll(buf: Uint8Array): boolean {
  if (buf.length !== HEADER + M) return false;
  for (let i = 0; i < HEADER; i++) if (buf[i] !== MAGIC[i]) return false;
  return true;
}

function newHll(): Uint8Array {
  const b = new Uint8Array(HEADER + M);
  for (let i = 0; i < HEADER; i++) b[i] = MAGIC[i]!;
  return b;
}

// MurmurHash3 x64_128 over `data`; we use the low 64 bits (h1) as the hash.
function murmur3_x64_64(data: Uint8Array): bigint {
  const c1 = 0x87c37b91114253d5n;
  const c2 = 0x4cf5ad432745937fn;
  let h1 = 0n;
  let h2 = 0n;
  const rotl = (x: bigint, r: bigint): bigint =>
    ((x << r) | (x >> (64n - r))) & MASK64;
  const fmix = (k: bigint): bigint => {
    k ^= k >> 33n;
    k = (k * 0xff51afd7ed558ccdn) & MASK64;
    k ^= k >> 33n;
    k = (k * 0xc4ceb9fe1a85ec53n) & MASK64;
    k ^= k >> 33n;
    return k;
  };
  const readLE = (off: number, len: number): bigint => {
    let v = 0n;
    for (let i = len - 1; i >= 0; i--) v = (v << 8n) | BigInt(data[off + i] ?? 0);
    return v;
  };
  const nblocks = Math.floor(data.length / 16);
  for (let b = 0; b < nblocks; b++) {
    let k1 = readLE(b * 16, 8);
    let k2 = readLE(b * 16 + 8, 8);
    k1 = (k1 * c1) & MASK64; k1 = rotl(k1, 31n); k1 = (k1 * c2) & MASK64; h1 ^= k1;
    h1 = rotl(h1, 27n); h1 = (h1 + h2) & MASK64; h1 = (h1 * 5n + 0x52dce729n) & MASK64;
    k2 = (k2 * c2) & MASK64; k2 = rotl(k2, 33n); k2 = (k2 * c1) & MASK64; h2 ^= k2;
    h2 = rotl(h2, 31n); h2 = (h2 + h1) & MASK64; h2 = (h2 * 5n + 0x38495ab5n) & MASK64;
  }
  const tail = nblocks * 16;
  const rem = data.length - tail;
  if (rem > 8) {
    let k2 = readLE(tail + 8, rem - 8);
    k2 = (k2 * c2) & MASK64; k2 = rotl(k2, 33n); k2 = (k2 * c1) & MASK64; h2 ^= k2;
  }
  if (rem > 0) {
    let k1 = readLE(tail, Math.min(rem, 8));
    k1 = (k1 * c1) & MASK64; k1 = rotl(k1, 31n); k1 = (k1 * c2) & MASK64; h1 ^= k1;
  }
  h1 ^= BigInt(data.length);
  h2 ^= BigInt(data.length);
  h1 = (h1 + h2) & MASK64;
  h2 = (h2 + h1) & MASK64;
  h1 = fmix(h1);
  h2 = fmix(h2);
  h1 = (h1 + h2) & MASK64;
  return h1 & MASK64;
}

function rho(w: bigint, maxBits: number): number {
  let r = 1;
  let mask = 1n << BigInt(maxBits - 1);
  while (mask > 0n && (w & mask) === 0n) {
    r++;
    mask >>= 1n;
  }
  return r;
}

function addElement(reg: Uint8Array, element: Uint8Array): boolean {
  const h = murmur3_x64_64(element);
  const idx = Number(h & BigInt(M - 1));
  const w = h >> BigInt(P);
  const count = rho(w, 64 - P);
  const pos = HEADER + idx;
  if (count > reg[pos]!) { reg[pos] = count; return true; }
  return false;
}

function estimate(reg: Uint8Array): number {
  let sum = 0;
  let ez = 0;
  for (let i = 0; i < M; i++) {
    const v = reg[HEADER + i]!;
    if (v === 0) ez++;
    sum += 1 / Math.pow(2, v);
  }
  const m = M;
  const zl = Math.log(ez + 1);
  const beta =
    -0.370393911 * ez +
    0.070471823 * zl +
    0.17393686 * Math.pow(zl, 2) +
    0.16339839 * Math.pow(zl, 3) +
    -0.09237745 * Math.pow(zl, 4) +
    0.03738027 * Math.pow(zl, 5) +
    -0.005384159 * Math.pow(zl, 6) +
    0.00042419 * Math.pow(zl, 7);
  const alpha = 0.7213 / (1 + 1.079 / m);
  const est = alpha * m * (m - ez) / (beta + sum);
  return Math.round(est);
}

function loadReg(d: Database, key: string): Uint8Array | null {
  const v = d.getRaw(key);
  if (!v) return null;
  if (v.type !== "string") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
  if (!isHll(v.value)) {
    throw new Error("WRONGTYPE Key is not a valid HyperLogLog string value.");
  }
  return v.value;
}

export const hllCommands: CommandSpec[] = [
  {
    name: "PFADD",
    arity: -2,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const k = bytesToKey(args[0]!);
      let reg = loadReg(d, k);
      let changed = false;
      if (!reg) { reg = newHll(); changed = true; }
      else reg = new Uint8Array(reg);
      for (let i = 1; i < args.length; i++) {
        if (addElement(reg, args[i]!)) changed = true;
      }
      if (changed) {
        d.set(k, { type: "string", value: reg }, { keepTtl: true });
        ctx.bumpKey(conn.selectedDb, k);
      }
      return RESP.int(changed ? 1 : 0);
    },
  },
  {
    name: "PFCOUNT",
    arity: -2,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      if (args.length === 1) {
        const reg = loadReg(d, bytesToKey(args[0]!));
        return RESP.int(reg ? estimate(reg) : 0);
      }
      const merged = newHll();
      for (let i = 0; i < args.length; i++) {
        const reg = loadReg(d, bytesToKey(args[i]!));
        if (reg) for (let j = 0; j < M; j++) {
          if (reg[HEADER + j]! > merged[HEADER + j]!) merged[HEADER + j] = reg[HEADER + j]!;
        }
      }
      return RESP.int(estimate(merged));
    },
  },
  {
    name: "PFMERGE",
    arity: -2,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const dest = bytesToKey(args[0]!);
      const existing = loadReg(d, dest);
      const merged = existing ? new Uint8Array(existing) : newHll();
      for (let i = 1; i < args.length; i++) {
        const reg = loadReg(d, bytesToKey(args[i]!));
        if (reg) for (let j = 0; j < M; j++) {
          if (reg[HEADER + j]! > merged[HEADER + j]!) merged[HEADER + j] = reg[HEADER + j]!;
        }
      }
      d.set(dest, { type: "string", value: merged }, { keepTtl: true });
      ctx.bumpKey(conn.selectedDb, dest);
      return RESP.ok();
    },
  },
  {
    name: "PFDEBUG",
    arity: -3,
    handler: (ctx, conn, args) => {
      const sub = new TextDecoder().decode(args[0]!).toUpperCase();
      if (sub === "GETREG") {
        const reg = loadReg(db(ctx, conn), bytesToKey(args[1]!));
        if (!reg) return RESP.err("ERR The specified key does not exist");
        const out = [];
        for (let i = 0; i < M; i++) out.push(RESP.int(reg[HEADER + i]!));
        return RESP.arr(out);
      }
      if (sub === "DECODE" || sub === "ENCODING" || sub === "TODENSE") {
        return RESP.ok();
      }
      return RESP.err(`ERR Unknown PFDEBUG subcommand or wrong number of arguments for '${sub.toLowerCase()}'`);
    },
  },
  { name: "PFSELFTEST", arity: 1, handler: () => RESP.ok() },
];