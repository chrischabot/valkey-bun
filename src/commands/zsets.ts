import type { CommandSpec } from "./index";
import { RESP, type RespValue } from "../resp";
import { bytesToKey, keyToBytes, ZSet, type Database } from "../store";

const dec = (b: Uint8Array) => new TextDecoder().decode(b);

function db(ctx: any, conn: any): Database { return ctx.store.db(conn.selectedDb); }

function getZSet(d: Database, key: string): ZSet | null {
  const v = d.getRaw(key);
  if (!v) return null;
  if (v.type !== "zset") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
  return v.value;
}

function getOrCreateZSet(d: Database, key: string): ZSet {
  const v = d.getRaw(key);
  if (v) {
    if (v.type !== "zset") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
    return v.value;
  }
  const z = new ZSet();
  d.set(key, { type: "zset", value: z });
  return z;
}

function fmtScore(n: number): string {
  if (n === Infinity) return "inf";
  if (n === -Infinity) return "-inf";
  if (Number.isInteger(n)) return String(n);
  return n.toString();
}

function scoreReply(conn: any, n: number): RespValue {
  if (conn.resp3) return RESP.dbl(n);
  return { type: "bulk", value: new TextEncoder().encode(fmtScore(n)) };
}

function parseScore(s: string): number {
  if (s === "+inf" || s === "inf") return Infinity;
  if (s === "-inf") return -Infinity;
  return Number(s);
}

interface ScoreRange { min: number; minExcl: boolean; max: number; maxExcl: boolean; }
function parseScoreRange(minS: string, maxS: string): ScoreRange {
  const minExcl = minS.startsWith("(");
  const maxExcl = maxS.startsWith("(");
  return {
    min: parseScore(minExcl ? minS.slice(1) : minS),
    minExcl,
    max: parseScore(maxExcl ? maxS.slice(1) : maxS),
    maxExcl,
  };
}
function inScoreRange(s: number, r: ScoreRange): boolean {
  if (r.minExcl ? s <= r.min : s < r.min) return false;
  if (r.maxExcl ? s >= r.max : s > r.max) return false;
  return true;
}

function parseLex(s: string): { v: string | null; excl: boolean; inf: -1 | 0 | 1 } {
  if (s === "-") return { v: null, excl: false, inf: -1 };
  if (s === "+") return { v: null, excl: false, inf: 1 };
  if (s.startsWith("(")) return { v: s.slice(1), excl: true, inf: 0 };
  if (s.startsWith("[")) return { v: s.slice(1), excl: false, inf: 0 };
  throw new Error("ERR min or max not valid string range item");
}
function inLexRange(member: string, minS: string, maxS: string): boolean {
  const lo = parseLex(minS);
  const hi = parseLex(maxS);
  if (lo.inf === 1) return false;
  if (hi.inf === -1) return false;
  if (lo.inf !== -1) { if (lo.excl ? member <= lo.v! : member < lo.v!) return false; }
  if (hi.inf !== 1) { if (hi.excl ? member >= hi.v! : member > hi.v!) return false; }
  return true;
}

export const zsetCommands: CommandSpec[] = [
  {
    name: "ZADD",
    arity: -4,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const k = bytesToKey(args[0]!);
      let i = 1;
      let nx = false, xx = false, gt = false, lt = false, ch = false, incr = false;
      while (i < args.length) {
        const a = dec(args[i]!).toUpperCase();
        if (a === "NX") { nx = true; i++; }
        else if (a === "XX") { xx = true; i++; }
        else if (a === "GT") { gt = true; i++; }
        else if (a === "LT") { lt = true; i++; }
        else if (a === "CH") { ch = true; i++; }
        else if (a === "INCR") { incr = true; i++; }
        else break;
      }
      const pairs = args.slice(i);
      if (pairs.length === 0 || pairs.length % 2 !== 0) return RESP.err("ERR syntax error");
      if (incr && pairs.length !== 2) {
        return RESP.err("ERR INCR option supports a single increment-element pair");
      }
      const z = getOrCreateZSet(d, k);
      const existed = z.size() > 0;
      let added = 0, changed = 0, lastScore = 0;
      let incrApplied = false;
      for (let p = 0; p < pairs.length; p += 2) {
        const score = parseScore(dec(pairs[p]!));
        const member = bytesToKey(pairs[p + 1]!);
        const had = z.byMember.has(member);
        const cur = z.byMember.get(member);
        if (nx && had) continue;
        if (xx && !had) continue;
        let newScore = score;
        if (incr && cur !== undefined) newScore = cur + score;
        if (gt && cur !== undefined && newScore <= cur) continue;
        if (lt && cur !== undefined && newScore >= cur) continue;
        if (!had) added++;
        else if (cur !== newScore) changed++;
        z.setScore(member, newScore);
        lastScore = newScore;
        incrApplied = true;
      }
      const mutated = added > 0 || changed > 0;
      if (mutated) { ctx.bumpKey(conn.selectedDb, k); ctx.notifyKey(conn.selectedDb, k); }
      if (z.size() === 0 && !existed) d.delete(k);
      if (incr) return incrApplied ? scoreReply(conn, lastScore) : RESP.nil();
      return RESP.int(ch ? added + changed : added);
    },
  },
  {
    name: "ZREM",
    arity: -3,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const k = bytesToKey(args[0]!);
      const z = getZSet(d, k);
      if (!z) return RESP.int(0);
      let n = 0;
      for (let i = 1; i < args.length; i++) if (z.remove(bytesToKey(args[i]!))) n++;
      if (z.size() === 0) d.delete(k);
      if (n > 0) ctx.bumpKey(conn.selectedDb, k);
      return RESP.int(n);
    },
  },
  {
    name: "ZSCORE",
    arity: 3,
    handler: (ctx, conn, args) => {
      const z = getZSet(db(ctx, conn), bytesToKey(args[0]!));
      if (!z) return RESP.nil();
      const s = z.score(bytesToKey(args[1]!));
      if (s === undefined) return RESP.nil();
      return scoreReply(conn, s);
    },
  },
  {
    name: "ZMSCORE",
    arity: -3,
    handler: (ctx, conn, args) => {
      const z = getZSet(db(ctx, conn), bytesToKey(args[0]!));
      const out: RespValue[] = [];
      for (let i = 1; i < args.length; i++) {
        if (!z) { out.push(RESP.nil()); continue; }
        const s = z.score(bytesToKey(args[i]!));
        out.push(s === undefined ? RESP.nil() : scoreReply(conn, s));
      }
      return RESP.arr(out);
    },
  },
  {
    name: "ZINCRBY",
    arity: 4,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const k = bytesToKey(args[0]!);
      const z = getOrCreateZSet(d, k);
      const delta = parseScore(dec(args[1]!));
      const m = bytesToKey(args[2]!);
      const next = (z.score(m) ?? 0) + delta;
      z.setScore(m, next);
      ctx.bumpKey(conn.selectedDb, k);
      ctx.notifyKey(conn.selectedDb, k);
      return scoreReply(conn, next);
    },
  },
  { name: "ZCARD", arity: 2, handler: (ctx, conn, args) => RESP.int(getZSet(db(ctx, conn), bytesToKey(args[0]!))?.size() ?? 0) },
  {
    name: "ZCOUNT",
    arity: 4,
    handler: (ctx, conn, args) => {
      const z = getZSet(db(ctx, conn), bytesToKey(args[0]!));
      if (!z) return RESP.int(0);
      const r = parseScoreRange(dec(args[1]!), dec(args[2]!));
      let n = 0;
      for (const e of z.sortedEntries()) if (inScoreRange(e.score, r)) n++;
      return RESP.int(n);
    },
  },
  {
    name: "ZLEXCOUNT",
    arity: 4,
    handler: (ctx, conn, args) => {
      const z = getZSet(db(ctx, conn), bytesToKey(args[0]!));
      if (!z) return RESP.int(0);
      let n = 0;
      for (const e of z.sortedEntries()) if (inLexRange(e.member, dec(args[1]!), dec(args[2]!))) n++;
      return RESP.int(n);
    },
  },
  {
    name: "ZRANK",
    arity: -3,
    handler: (ctx, conn, args) => {
      const z = getZSet(db(ctx, conn), bytesToKey(args[0]!));
      if (!z) return RESP.nil();
      const withScore = args.length > 2 && dec(args[2]!).toUpperCase() === "WITHSCORE";
      const rank = z.rank(bytesToKey(args[1]!));
      if (rank === null) return withScore ? RESP.arr(null) : RESP.nil();
      if (withScore) {
        const s = z.score(bytesToKey(args[1]!))!;
        return RESP.arr([RESP.int(rank), scoreReply(conn, s)]);
      }
      return RESP.int(rank);
    },
  },
  {
    name: "ZREVRANK",
    arity: -3,
    handler: (ctx, conn, args) => {
      const z = getZSet(db(ctx, conn), bytesToKey(args[0]!));
      if (!z) return RESP.nil();
      const withScore = args.length > 2 && dec(args[2]!).toUpperCase() === "WITHSCORE";
      const rank = z.rank(bytesToKey(args[1]!), true);
      if (rank === null) return withScore ? RESP.arr(null) : RESP.nil();
      if (withScore) {
        const s = z.score(bytesToKey(args[1]!))!;
        return RESP.arr([RESP.int(rank), scoreReply(conn, s)]);
      }
      return RESP.int(rank);
    },
  },
  { name: "ZRANGE", arity: -4, handler: (ctx, conn, args) => zrange(ctx, conn, args) },
  { name: "ZREVRANGE", arity: -4, handler: (ctx, conn, args) => zrangeRev(ctx, conn, args) },
  { name: "ZRANGEBYSCORE", arity: -4, handler: (ctx, conn, args) => zrangeByScore(ctx, conn, args, false) },
  { name: "ZREVRANGEBYSCORE", arity: -4, handler: (ctx, conn, args) => zrangeByScore(ctx, conn, args, true) },
  { name: "ZRANGEBYLEX", arity: -4, handler: (ctx, conn, args) => zrangeByLex(ctx, conn, args, false) },
  { name: "ZREVRANGEBYLEX", arity: -4, handler: (ctx, conn, args) => zrangeByLex(ctx, conn, args, true) },
  { name: "ZPOPMIN", arity: -2, handler: (ctx, conn, args) => zpop(ctx, conn, args, false) },
  { name: "ZPOPMAX", arity: -2, handler: (ctx, conn, args) => zpop(ctx, conn, args, true) },
  {
    name: "ZRANDMEMBER",
    arity: -2,
    handler: (ctx, conn, args) => {
      const z = getZSet(db(ctx, conn), bytesToKey(args[0]!));
      if (!z || z.size() === 0) return args.length > 1 ? RESP.arr([]) : RESP.nil();
      const entries = z.sortedEntries();
      if (args.length === 1) {
        const e = entries[Math.floor(Math.random() * entries.length)]!;
        return { type: "bulk", value: keyToBytes(e.member) };
      }
      const count = Number(dec(args[1]!));
      const withScores = args.length > 2 && dec(args[2]!).toUpperCase() === "WITHSCORES";
      const n = Math.abs(count);
      const out: RespValue[] = [];
      const pool = entries.slice();
      for (let i = 0; i < n; i++) {
        if (count >= 0 && pool.length === 0) break;
        const idx = Math.floor(Math.random() * pool.length);
        const e = count >= 0 ? pool.splice(idx, 1)[0]! : pool[idx]!;
        out.push({ type: "bulk", value: keyToBytes(e.member) });
        if (withScores) out.push({ type: "bulk", value: new TextEncoder().encode(fmtScore(e.score)) });
      }
      return RESP.arr(out);
    },
  },
  { name: "ZUNION", arity: -3, handler: (ctx, conn, args) => zsetOp(ctx, conn, args, "union", false) },
  { name: "ZINTER", arity: -3, handler: (ctx, conn, args) => zsetOp(ctx, conn, args, "inter", false) },
  { name: "ZDIFF", arity: -3, handler: (ctx, conn, args) => zsetOp(ctx, conn, args, "diff", false) },
  { name: "ZUNIONSTORE", arity: -4, handler: (ctx, conn, args) => zsetOp(ctx, conn, args, "union", true) },
  { name: "ZINTERSTORE", arity: -4, handler: (ctx, conn, args) => zsetOp(ctx, conn, args, "inter", true) },
  { name: "ZDIFFSTORE", arity: -4, handler: (ctx, conn, args) => zsetOp(ctx, conn, args, "diff", true) },
  {
    name: "ZRANGESTORE",
    arity: -5,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const dst = bytesToKey(args[0]!);
      const z = getZSet(d, bytesToKey(args[1]!));
      if (!z) {
        // Source missing: deleting the destination is a write — bump its
        // version consistently with all other ZRANGESTORE write paths.
        d.delete(dst);
        ctx.bumpKey(conn.selectedDb, dst);
        return RESP.int(0);
      }
      const startS = dec(args[2]!);
      const stopS = dec(args[3]!);
      let byScore = false, byLex = false, rev = false;
      let limitOffset = 0, limitCount = -1;
      for (let i = 4; i < args.length; i++) {
        const opt = dec(args[i]!).toUpperCase();
        if (opt === "BYSCORE") byScore = true;
        else if (opt === "BYLEX") byLex = true;
        else if (opt === "REV") rev = true;
        else if (opt === "LIMIT") {
          limitOffset = Number(dec(args[++i]!));
          limitCount = Number(dec(args[++i]!));
        }
      }
      let entries = z.sortedEntries();
      if (rev) entries = entries.slice().reverse();
      if (byScore) {
        const r = rev ? parseScoreRange(stopS, startS) : parseScoreRange(startS, stopS);
        entries = entries.filter((e) => inScoreRange(e.score, r));
      } else if (byLex) {
        const lo = rev ? stopS : startS;
        const hi = rev ? startS : stopS;
        entries = entries.filter((e) => inLexRange(e.member, lo, hi));
      } else {
        const len = entries.length;
        let start = Number(startS), stop = Number(stopS);
        if (start < 0) start = Math.max(0, len + start);
        if (stop < 0) stop = len + stop;
        if (start >= len || start > stop) entries = [];
        else entries = entries.slice(start, Math.min(stop, len - 1) + 1);
      }
      if (limitCount >= 0 || limitOffset > 0) {
        entries = entries.slice(limitOffset, limitCount < 0 ? undefined : limitOffset + limitCount);
      }
      if (entries.length === 0) { d.delete(dst); ctx.bumpKey(conn.selectedDb, dst); return RESP.int(0); }
      const out = new ZSet();
      for (const e of entries) out.setScore(e.member, e.score);
      d.set(dst, { type: "zset", value: out });
      ctx.bumpKey(conn.selectedDb, dst);
      ctx.notifyKey(conn.selectedDb, dst);
      return RESP.int(entries.length);
    },
  },
  {
    name: "ZINTERCARD",
    arity: -3,
    handler: (ctx, conn, args) => {
      const numKeys = Number(dec(args[0]!));
      let limit = 0;
      const keyArgs = args.slice(1, 1 + numKeys);
      for (let i = 1 + numKeys; i < args.length; i++) {
        if (dec(args[i]!).toUpperCase() === "LIMIT") limit = Number(dec(args[++i]!));
      }
      const d = db(ctx, conn);
      const sets = keyArgs.map((a) => getZSet(d, bytesToKey(a)));
      if (sets.some((s) => !s)) return RESP.int(0);
      let inter = new Set(sets[0]!.byMember.keys());
      for (let i = 1; i < sets.length; i++) {
        const next = new Set<string>();
        for (const m of inter) if (sets[i]!.byMember.has(m)) next.add(m);
        inter = next;
      }
      const c = inter.size;
      return RESP.int(limit > 0 ? Math.min(limit, c) : c);
    },
  },
  {
    name: "ZSCAN",
    arity: -3,
    handler: (ctx, conn, args) => {
      const z = getZSet(db(ctx, conn), bytesToKey(args[0]!));
      const cursor = Number(dec(args[1]!));
      const entries = z ? Array.from(z.byMember.entries()) : [];
      const slice = entries.slice(cursor, cursor + 10);
      const next = cursor + 10 >= entries.length ? 0 : cursor + 10;
      const out: RespValue[] = [];
      for (const [m, s] of slice) {
        out.push({ type: "bulk", value: keyToBytes(m) });
        out.push({ type: "bulk", value: new TextEncoder().encode(fmtScore(s)) });
      }
      return RESP.arr([RESP.str(String(next)), RESP.arr(out)]);
    },
  },
  {
    name: "ZREMRANGEBYRANK",
    arity: 4,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const k = bytesToKey(args[0]!);
      const z = getZSet(d, k);
      if (!z) return RESP.int(0);
      const entries = z.sortedEntries();
      const len = entries.length;
      let start = Number(dec(args[1]!));
      let stop = Number(dec(args[2]!));
      if (start < 0) start = Math.max(0, len + start);
      if (stop < 0) stop = len + stop;
      if (start >= len || start > stop) return RESP.int(0);
      stop = Math.min(stop, len - 1);
      const victims = entries.slice(start, stop + 1);
      for (const e of victims) z.remove(e.member);
      if (z.size() === 0) d.delete(k);
      if (victims.length) ctx.bumpKey(conn.selectedDb, k);
      return RESP.int(victims.length);
    },
  },
  {
    name: "ZREMRANGEBYSCORE",
    arity: 4,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const k = bytesToKey(args[0]!);
      const z = getZSet(d, k);
      if (!z) return RESP.int(0);
      const r = parseScoreRange(dec(args[1]!), dec(args[2]!));
      const victims = z.sortedEntries().filter((e) => inScoreRange(e.score, r));
      for (const e of victims) z.remove(e.member);
      if (z.size() === 0) d.delete(k);
      if (victims.length) ctx.bumpKey(conn.selectedDb, k);
      return RESP.int(victims.length);
    },
  },
  {
    name: "ZREMRANGEBYLEX",
    arity: 4,
    handler: (ctx, conn, args) => {
      const d = db(ctx, conn);
      const k = bytesToKey(args[0]!);
      const z = getZSet(d, k);
      if (!z) return RESP.int(0);
      const victims = z.sortedEntries().filter((e) => inLexRange(e.member, dec(args[1]!), dec(args[2]!)));
      for (const e of victims) z.remove(e.member);
      if (z.size() === 0) d.delete(k);
      if (victims.length) ctx.bumpKey(conn.selectedDb, k);
      return RESP.int(victims.length);
    },
  },
  {
    name: "ZMPOP",
    arity: -4,
    handler: (ctx, conn, args) => {
      const parsed = parseZMpop(args, 0);
      if (typeof parsed === "string") return RESP.err(parsed);
      return zmpopOnce(ctx, conn, parsed.keys, parsed.max, parsed.count) ?? RESP.arr(null);
    },
  },
  {
    name: "BZMPOP",
    arity: -5,
    handler: (ctx, conn, args) => {
      const timeout = Number(dec(args[0]!));
      if (!Number.isFinite(timeout) || timeout < 0) return RESP.err("ERR timeout is not a float or out of range");
      const parsed = parseZMpop(args, 1);
      if (typeof parsed === "string") return RESP.err(parsed);
      const immediate = zmpopOnce(ctx, conn, parsed.keys, parsed.max, parsed.count);
      if (immediate) return immediate;
      return ctx.registerWaiter(
        conn.selectedDb, parsed.keys, timeout,
        () => zmpopOnce(ctx, conn, parsed.keys, parsed.max, parsed.count),
        () => RESP.arr(null),
      ) as Promise<RespValue>;
    },
  },
  { name: "BZPOPMIN", arity: -3, handler: (ctx, conn, args) => bzpop(ctx, conn, args, false) },
  { name: "BZPOPMAX", arity: -3, handler: (ctx, conn, args) => bzpop(ctx, conn, args, true) },
];

function zrangeRev(ctx: any, conn: any, args: Uint8Array[]): RespValue {
  const z = getZSet(db(ctx, conn), bytesToKey(args[0]!));
  if (!z) return RESP.arr([]);
  const start = Number(dec(args[1]!));
  const stop = Number(dec(args[2]!));
  const withScores = args.length > 3 && dec(args[3]!).toUpperCase() === "WITHSCORES";
  const entries = z.sortedEntries().slice().reverse();
  return sliceAndEmit(entries, start, stop, withScores);
}

function zrange(ctx: any, conn: any, args: Uint8Array[]): RespValue {
  const z = getZSet(db(ctx, conn), bytesToKey(args[0]!));
  if (!z) return RESP.arr([]);
  const startS = dec(args[1]!);
  const stopS = dec(args[2]!);
  let byScore = false, byLex = false, rev = false, withScores = false;
  let limitOffset = 0, limitCount = -1;
  for (let i = 3; i < args.length; i++) {
    const opt = dec(args[i]!).toUpperCase();
    if (opt === "BYSCORE") byScore = true;
    else if (opt === "BYLEX") byLex = true;
    else if (opt === "REV") rev = true;
    else if (opt === "WITHSCORES") withScores = true;
    else if (opt === "LIMIT") {
      limitOffset = Number(dec(args[++i]!));
      limitCount = Number(dec(args[++i]!));
    }
  }
  let entries = z.sortedEntries();
  if (rev) entries = entries.slice().reverse();
  if (byScore) {
    const r = rev ? parseScoreRange(stopS, startS) : parseScoreRange(startS, stopS);
    entries = entries.filter((e) => inScoreRange(e.score, r));
  } else if (byLex) {
    const lo = rev ? stopS : startS;
    const hi = rev ? startS : stopS;
    entries = entries.filter((e) => inLexRange(e.member, lo, hi));
  } else {
    return sliceAndEmit(entries, Number(startS), Number(stopS), withScores);
  }
  if (limitCount >= 0 || limitOffset > 0) {
    entries = entries.slice(limitOffset, limitCount < 0 ? undefined : limitOffset + limitCount);
  }
  return entriesToReply(entries, withScores);
}

function zrangeByScore(ctx: any, conn: any, args: Uint8Array[], rev: boolean): RespValue {
  const z = getZSet(db(ctx, conn), bytesToKey(args[0]!));
  if (!z) return RESP.arr([]);
  const r = rev ? parseScoreRange(dec(args[2]!), dec(args[1]!)) : parseScoreRange(dec(args[1]!), dec(args[2]!));
  let withScores = false;
  let limitOffset = 0, limitCount = -1;
  for (let i = 3; i < args.length; i++) {
    const opt = dec(args[i]!).toUpperCase();
    if (opt === "WITHSCORES") withScores = true;
    else if (opt === "LIMIT") {
      limitOffset = Number(dec(args[++i]!));
      limitCount = Number(dec(args[++i]!));
    }
  }
  let entries = z.sortedEntries().filter((e) => inScoreRange(e.score, r));
  if (rev) entries = entries.slice().reverse();
  if (limitCount >= 0 || limitOffset > 0) {
    entries = entries.slice(limitOffset, limitCount < 0 ? undefined : limitOffset + limitCount);
  }
  return entriesToReply(entries, withScores);
}

function zrangeByLex(ctx: any, conn: any, args: Uint8Array[], rev: boolean): RespValue {
  const z = getZSet(db(ctx, conn), bytesToKey(args[0]!));
  if (!z) return RESP.arr([]);
  const lo = rev ? dec(args[2]!) : dec(args[1]!);
  const hi = rev ? dec(args[1]!) : dec(args[2]!);
  let limitOffset = 0, limitCount = -1;
  for (let i = 3; i < args.length; i++) {
    const opt = dec(args[i]!).toUpperCase();
    if (opt === "LIMIT") {
      limitOffset = Number(dec(args[++i]!));
      limitCount = Number(dec(args[++i]!));
    }
  }
  let entries = z.sortedEntries().filter((e) => inLexRange(e.member, lo, hi));
  if (rev) entries = entries.slice().reverse();
  if (limitCount >= 0 || limitOffset > 0) {
    entries = entries.slice(limitOffset, limitCount < 0 ? undefined : limitOffset + limitCount);
  }
  return entriesToReply(entries, false);
}

function sliceAndEmit(entries: { member: string; score: number }[], start: number, stop: number, withScores: boolean): RespValue {
  const len = entries.length;
  if (start < 0) start = Math.max(0, len + start);
  if (stop < 0) stop = len + stop;
  if (start >= len || start > stop) return RESP.arr([]);
  stop = Math.min(stop, len - 1);
  return entriesToReply(entries.slice(start, stop + 1), withScores);
}

function entriesToReply(entries: { member: string; score: number }[], withScores: boolean): RespValue {
  const out: RespValue[] = [];
  for (const e of entries) {
    out.push({ type: "bulk", value: keyToBytes(e.member) });
    if (withScores) out.push({ type: "bulk", value: new TextEncoder().encode(fmtScore(e.score)) });
  }
  return RESP.arr(out);
}

function zpop(ctx: any, conn: any, args: Uint8Array[], reverse: boolean): RespValue {
  const d = db(ctx, conn);
  const k = bytesToKey(args[0]!);
  const z = getZSet(d, k);
  if (!z || z.size() === 0) return RESP.arr([]);
  const count = args.length > 1 ? Number(dec(args[1]!)) : 1;
  let entries = z.sortedEntries();
  if (reverse) entries = entries.slice().reverse();
  const picked = entries.slice(0, count);
  for (const e of picked) z.remove(e.member);
  if (z.size() === 0) d.delete(k);
  if (picked.length > 0) ctx.bumpKey(conn.selectedDb, k);
  const out: RespValue[] = [];
  for (const e of picked) {
    out.push({ type: "bulk", value: keyToBytes(e.member) });
    out.push({ type: "bulk", value: new TextEncoder().encode(fmtScore(e.score)) });
  }
  return RESP.arr(out);
}

function zsetOp(ctx: any, conn: any, args: Uint8Array[], op: "union" | "inter" | "diff", store: boolean): RespValue {
  const d = db(ctx, conn);
  let argIdx = 0;
  let dest = "";
  if (store) dest = bytesToKey(args[argIdx++]!);
  const numKeys = Number(dec(args[argIdx++]!));
  const keys = args.slice(argIdx, argIdx + numKeys);
  argIdx += numKeys;
  const weights: number[] = new Array(numKeys).fill(1);
  let aggregate: "SUM" | "MIN" | "MAX" = "SUM";
  let withScores = false;
  while (argIdx < args.length) {
    const opt = dec(args[argIdx++]!).toUpperCase();
    if (opt === "WEIGHTS") for (let i = 0; i < numKeys; i++) weights[i] = Number(dec(args[argIdx++]!));
    else if (opt === "AGGREGATE") aggregate = dec(args[argIdx++]!).toUpperCase() as any;
    else if (opt === "WITHSCORES") withScores = true;
  }
  const sources: Map<string, number>[] = keys.map((k) => {
    const v = d.getRaw(bytesToKey(k));
    if (!v) return new Map();
    if (v.type === "zset") return new Map(v.value.byMember);
    if (v.type === "set") {
      const m = new Map<string, number>();
      for (const x of v.value) m.set(x, 1);
      return m;
    }
    throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
  });
  const result = new Map<string, number>();
  if (op === "union") {
    for (let i = 0; i < sources.length; i++) for (const [m, s] of sources[i]!) {
      const w = weights[i]! * s;
      const cur = result.get(m);
      result.set(m, cur === undefined ? w : combine(cur, w, aggregate));
    }
  } else if (op === "inter") {
    if (sources.length > 0) {
      for (const [m, s] of sources[0]!) {
        let val = weights[0]! * s;
        let ok = true;
        for (let i = 1; i < sources.length; i++) {
          const v2 = sources[i]!.get(m);
          if (v2 === undefined) { ok = false; break; }
          val = combine(val, weights[i]! * v2, aggregate);
        }
        if (ok) result.set(m, val);
      }
    }
  } else {
    for (const [m, s] of sources[0] ?? []) result.set(m, weights[0]! * s);
    for (let i = 1; i < sources.length; i++) for (const m of sources[i]!.keys()) result.delete(m);
  }
  if (store) {
    if (result.size === 0) d.delete(dest);
    else {
      const z = new ZSet();
      for (const [m, s] of result) z.setScore(m, s);
      d.set(dest, { type: "zset", value: z });
    }
    ctx.bumpKey(conn.selectedDb, dest);
    if (result.size > 0) ctx.notifyKey(conn.selectedDb, dest);
    return RESP.int(result.size);
  }
  const z = new ZSet();
  for (const [m, s] of result) z.setScore(m, s);
  return entriesToReply(z.sortedEntries(), withScores);
}

function combine(a: number, b: number, agg: "SUM" | "MIN" | "MAX"): number {
  if (agg === "SUM") return a + b;
  if (agg === "MIN") return Math.min(a, b);
  return Math.max(a, b);
}

interface ZMpopSpec { keys: string[]; max: boolean; count: number; }
function parseZMpop(args: Uint8Array[], start: number): ZMpopSpec | string {
  const numKeys = Number(dec(args[start]!));
  if (!Number.isInteger(numKeys) || numKeys <= 0) return "ERR numkeys should be greater than 0";
  const keys: string[] = [];
  for (let i = 0; i < numKeys; i++) {
    if (start + 1 + i >= args.length) return "ERR syntax error";
    keys.push(bytesToKey(args[start + 1 + i]!));
  }
  let idx = start + 1 + numKeys;
  if (idx >= args.length) return "ERR syntax error";
  const where = dec(args[idx]!).toUpperCase();
  if (where !== "MIN" && where !== "MAX") return "ERR syntax error";
  idx++;
  let count = 1;
  if (idx < args.length) {
    if (dec(args[idx]!).toUpperCase() !== "COUNT" || idx + 1 >= args.length) return "ERR syntax error";
    count = Number(dec(args[idx + 1]!));
    if (!Number.isInteger(count) || count <= 0) return "ERR count should be greater than 0";
    idx += 2;
  }
  if (idx !== args.length) return "ERR syntax error";
  return { keys, max: where === "MAX", count };
}

function zmpopOnce(ctx: any, conn: any, keys: string[], max: boolean, count: number): RespValue | null {
  const d = db(ctx, conn);
  for (const key of keys) {
    const z = getZSet(d, key);
    if (z && z.size() > 0) {
      let entries = z.sortedEntries();
      if (max) entries = entries.slice().reverse();
      const picked = entries.slice(0, count);
      const pairs: RespValue[] = [];
      for (const e of picked) {
        z.remove(e.member);
        pairs.push(RESP.arr([
          { type: "bulk", value: keyToBytes(e.member) },
          { type: "bulk", value: new TextEncoder().encode(fmtScore(e.score)) },
        ]));
      }
      if (z.size() === 0) d.delete(key);
      ctx.bumpKey(conn.selectedDb, key);
      return RESP.arr([{ type: "bulk", value: keyToBytes(key) }, RESP.arr(pairs)]);
    }
  }
  return null;
}

function bzpop(ctx: any, conn: any, args: Uint8Array[], max: boolean): RespValue | Promise<RespValue> {
  const timeout = Number(dec(args[args.length - 1]!));
  if (!Number.isFinite(timeout) || timeout < 0) return RESP.err("ERR timeout is not a float or out of range");
  const keys = args.slice(0, -1).map((a) => bytesToKey(a));
  const attempt = (): RespValue | null => {
    const d = db(ctx, conn);
    for (const key of keys) {
      const z = getZSet(d, key);
      if (z && z.size() > 0) {
        let entries = z.sortedEntries();
        if (max) entries = entries.slice().reverse();
        const e = entries[0]!;
        z.remove(e.member);
        if (z.size() === 0) d.delete(key);
        ctx.bumpKey(conn.selectedDb, key);
        return RESP.arr([
          { type: "bulk", value: keyToBytes(key) },
          { type: "bulk", value: keyToBytes(e.member) },
          { type: "bulk", value: new TextEncoder().encode(fmtScore(e.score)) },
        ]);
      }
    }
    return null;
  };
  const immediate = attempt();
  if (immediate) return immediate;
  return ctx.registerWaiter(conn.selectedDb, keys, timeout, attempt, () => RESP.arr(null)) as Promise<RespValue>;
}