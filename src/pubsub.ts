import type { Connection } from "./connection";

export class PubSub {
  channels = new Map<string, Set<Connection>>();
  patterns = new Map<string, Set<Connection>>();

  subscribe(conn: Connection, channel: string): number {
    let set = this.channels.get(channel);
    if (!set) {
      set = new Set();
      this.channels.set(channel, set);
    }
    set.add(conn);
    conn.subscribedChannels.add(channel);
    return conn.subscribedChannels.size + conn.subscribedPatterns.size;
  }

  unsubscribe(conn: Connection, channel: string): number {
    const set = this.channels.get(channel);
    if (set) {
      set.delete(conn);
      if (set.size === 0) this.channels.delete(channel);
    }
    conn.subscribedChannels.delete(channel);
    return conn.subscribedChannels.size + conn.subscribedPatterns.size;
  }

  psubscribe(conn: Connection, pattern: string): number {
    let set = this.patterns.get(pattern);
    if (!set) {
      set = new Set();
      this.patterns.set(pattern, set);
    }
    set.add(conn);
    conn.subscribedPatterns.add(pattern);
    return conn.subscribedChannels.size + conn.subscribedPatterns.size;
  }

  punsubscribe(conn: Connection, pattern: string): number {
    const set = this.patterns.get(pattern);
    if (set) {
      set.delete(conn);
      if (set.size === 0) this.patterns.delete(pattern);
    }
    conn.subscribedPatterns.delete(pattern);
    return conn.subscribedChannels.size + conn.subscribedPatterns.size;
  }

  publish(channel: string, message: Uint8Array): number {
    const seen = new Set<Connection>();
    const subs = this.channels.get(channel);
    if (subs) {
      for (const conn of subs) {
        conn.sendMessage(channel, message);
        seen.add(conn);
      }
    }
    for (const [pattern, pSubs] of this.patterns) {
      if (matchPattern(pattern, channel)) {
        for (const conn of pSubs) {
          conn.sendPMessage(pattern, channel, message);
          seen.add(conn);
        }
      }
    }
    return seen.size;
  }

  removeConnection(conn: Connection): void {
    for (const ch of conn.subscribedChannels) {
      const set = this.channels.get(ch);
      if (set) {
        set.delete(conn);
        if (set.size === 0) this.channels.delete(ch);
      }
    }
    for (const pat of conn.subscribedPatterns) {
      const set = this.patterns.get(pat);
      if (set) {
        set.delete(conn);
        if (set.size === 0) this.patterns.delete(pat);
      }
    }
    conn.subscribedChannels.clear();
    conn.subscribedPatterns.clear();
  }

  channelList(pattern?: string): string[] {
    const out: string[] = [];
    for (const ch of this.channels.keys()) {
      if (!pattern || matchPattern(pattern, ch)) out.push(ch);
    }
    return out;
  }

  numSub(channel: string): number {
    return this.channels.get(channel)?.size ?? 0;
  }

  numPat(): number {
    return this.patterns.size;
  }
}

export function matchPattern(pattern: string, str: string): boolean {
  return globMatch(pattern, 0, str, 0);
}

function globMatch(p: string, pi: number, s: string, si: number): boolean {
  while (pi < p.length) {
    const c = p[pi];
    if (c === "*") {
      while (pi + 1 < p.length && p[pi + 1] === "*") pi++;
      if (pi === p.length - 1) return true;
      for (let i = si; i <= s.length; i++) {
        if (globMatch(p, pi + 1, s, i)) return true;
      }
      return false;
    } else if (c === "?") {
      if (si >= s.length) return false;
      pi++;
      si++;
    } else if (c === "[") {
      if (si >= s.length) return false;
      const end = p.indexOf("]", pi + 1);
      if (end === -1) return false;
      const set = p.slice(pi + 1, end);
      let negate = false;
      let body = set;
      if (body.startsWith("^")) {
        negate = true;
        body = body.slice(1);
      }
      let matched = false;
      for (let i = 0; i < body.length; i++) {
        if (body[i + 1] === "-" && i + 2 < body.length) {
          if (s[si]! >= body[i]! && s[si]! <= body[i + 2]!) matched = true;
          i += 2;
        } else if (body[i] === s[si]) {
          matched = true;
        }
      }
      if (matched === negate) return false;
      pi = end + 1;
      si++;
    } else if (c === "\\" && pi + 1 < p.length) {
      if (s[si] !== p[pi + 1]) return false;
      pi += 2;
      si++;
    } else {
      if (s[si] !== c) return false;
      pi++;
      si++;
    }
  }
  return si === s.length;
}