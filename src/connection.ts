import type { Socket } from "bun";
import { encodeInto, OutWriter, RESP, type RespValue } from "./resp";

export interface QueuedCommand {
  name: string;
  args: Uint8Array[];
}

export class Connection {
  static nextId = 1;

  id: number;
  socket: Socket<unknown>;
  buffer: Uint8Array = new Uint8Array(0);
  resp3 = false;
  selectedDb = 0;
  name = "";
  authenticated = false;
  inMulti = false;
  multiQueue: QueuedCommand[] = [];
  multiError = false;
  watched: Map<number, Map<string, number>> = new Map();
  subscribedChannels = new Set<string>();
  subscribedPatterns = new Set<string>();
  closed = false;

  tracking = false;
  trackingBcast = false;
  trackingPrefixes: string[] = [];
  trackingRedirect = 0;
  trackingOptin = false;
  trackingOptout = false;
  trackingNoloop = false;
  caching: boolean | null = null;
  trackedKeys = new Set<string>();

  // Per-connection write buffer. flush() emits one socket.write() per drain.
  out = new OutWriter(8192);

  constructor(socket: Socket<unknown>) {
    this.id = Connection.nextId++;
    this.socket = socket;
  }

  appendData(chunk: Uint8Array): void {
    if (this.buffer.length === 0) {
      this.buffer = chunk;
      return;
    }
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;
  }

  consume(n: number): void {
    this.buffer = this.buffer.subarray(n);
  }

  reply(value: RespValue): void {
    if (this.closed) return;
    encodeInto(this.out, value, this.resp3);
  }

  flush(): void {
    if (this.closed || this.out.pos === 0) return;
    try {
      this.socket.write(this.out.snapshot());
    } catch {
      this.closed = true;
    }
    this.out.reset();
  }

  replyMany(values: RespValue[]): void {
    for (const v of values) this.reply(v);
  }

  inSubscribeMode(): boolean {
    return this.subscribedChannels.size > 0 || this.subscribedPatterns.size > 0;
  }

  sendMessage(channel: string, message: Uint8Array): void {
    const items: RespValue[] = [RESP.str("message"), RESP.str(channel), RESP.bulk(message)];
    this.reply(this.resp3 ? { type: "push", value: items } : { type: "array", value: items });
    this.flush();
  }

  sendPMessage(pattern: string, channel: string, message: Uint8Array): void {
    const items: RespValue[] = [
      RESP.str("pmessage"),
      RESP.str(pattern),
      RESP.str(channel),
      RESP.bulk(message),
    ];
    this.reply(this.resp3 ? { type: "push", value: items } : { type: "array", value: items });
    this.flush();
  }

  sendInvalidation(keys: Uint8Array[] | null): void {
    const payload: RespValue = keys === null
      ? RESP.nil()
      : { type: "array", value: keys.map((k) => RESP.bulk(k)) };
    if (this.resp3) {
      this.reply({ type: "push", value: [RESP.str("invalidation"), payload] });
    } else {
      this.reply({
        type: "array",
        value: [RESP.str("message"), RESP.str("__redis__:invalidate"), payload],
      });
    }
    this.flush();
  }

  close(): void {
    if (this.closed) return;
    this.flush();
    this.closed = true;
    try { this.socket.end(); } catch { /* ignore */ }
  }
}