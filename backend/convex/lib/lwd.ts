"use node";
// Minimal lightwalletd (CompactTxStreamer) client over gRPC with raw protobuf bytes. Requests are
// tiny and encoded here; responses are decoded by the alibi-core WebAssembly module.
import * as grpc from "@grpc/grpc-js";
import { core, toHex } from "./core";

const SVC = "/cash.z.wallet.sdk.rpc.CompactTxStreamer/";
const id = (b: Buffer) => b;

function varint(n: number): number[] {
  const out: number[] = [];
  let v = BigInt(n);
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return out;
}

function field(tag: number, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag, ...varint(payload.length)]), payload]);
}

const blockId = (height: number) => Buffer.from([0x08, ...varint(height)]);
const blockRange = (start: number, end: number) => Buffer.concat([field(0x0a, blockId(start)), field(0x12, blockId(end))]);
const txFilter = (wireHash: Buffer) => field(0x1a, wireHash);

/** Reads a protobuf varint at `i`; returns [value, next index]. */
function readVarint(b: Buffer, i: number): [number, number] {
  let v = 0n;
  let shift = 0n;
  for (;;) {
    if (i >= b.length) throw new Error("truncated varint");
    const byte = b[i++];
    v |= BigInt(byte & 0x7f) << shift;
    if (!(byte & 0x80)) return [Number(BigInt.asIntN(32, v)), i];
    shift += 7n;
  }
}

/** SendResponse { int32 errorCode = 1; string errorMessage = 2; } */
export function decodeSendResponse(b: Buffer): { errorCode: number; errorMessage: string } {
  let errorCode = 0;
  let errorMessage = "";
  let i = 0;
  while (i < b.length) {
    const [tag, j] = readVarint(b, i);
    i = j;
    if (tag === 0x08) [errorCode, i] = readVarint(b, i);
    else if (tag === 0x12) {
      const [len, k] = readVarint(b, i);
      errorMessage = b.subarray(k, k + len).toString("utf8");
      i = k + len;
    } else throw new Error(`unexpected SendResponse field tag ${tag}`);
  }
  return { errorCode, errorMessage };
}

export type TreeState = {
  network: string;
  height: number;
  hash: string;
  time: number;
  trees: { sapling: string; orchard: string; ironwood: string };
  roots: { sapling: string; orchard: string; ironwood: string };
};

/** Public-safe identifier for an upstream; omit credentials, paths, and query parameters. */
export function publicEndpoint(url: string): string {
  try {
    const endpoint = new URL(url);
    return `${endpoint.protocol}//${endpoint.host}`;
  } catch {
    return "configured lightwalletd";
  }
}

export class NotFound extends Error {}

export class Lightwalletd {
  private client: grpc.Client;

  url: string;
  constructor(url: string) {
    this.url = url;
    const target = url.replace(/^https?:\/\//, "");
    const creds = url.startsWith("http://") ? grpc.credentials.createInsecure() : grpc.credentials.createSsl();
    this.client = new grpc.Client(target, creds, {
      "grpc.max_receive_message_length": 64 * 1024 * 1024,
      "grpc.primary_user_agent": "alibi-verifier/0.1",
    });
  }

  close() {
    this.client.close();
  }

  private unaryOnce(method: string, arg: Buffer, timeoutMs: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      this.client.makeUnaryRequest(
        SVC + method,
        id,
        id,
        arg,
        new grpc.Metadata(),
        { deadline: Date.now() + timeoutMs },
        (err, res) => (err ? reject(err) : resolve(res as Buffer)),
      );
    });
  }

  private async unary(method: string, arg: Buffer, timeoutMs = 60_000): Promise<Buffer> {
    let delay = 500;
    let last: unknown;
    for (let i = 0; i < 4; i++) {
      try {
        return await this.unaryOnce(method, arg, timeoutMs);
      } catch (e: any) {
        if (e?.code === grpc.status.NOT_FOUND || e?.code === grpc.status.INVALID_ARGUMENT) throw e;
        last = e;
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 8000);
      }
    }
    throw new Error(`${method}: ${(last as any)?.details ?? last}`);
  }

  async latestHeight(): Promise<number> {
    const b = await this.unary("GetLatestBlock", Buffer.alloc(0));
    return Number(core<{ height: number }>("decode_block_id", { hex: toHex(b) }).height);
  }

  async treeState(height: number): Promise<TreeState> {
    const b = await this.unary("GetTreeState", blockId(height));
    const t = core<TreeState>("decode_tree_state", { hex: toHex(b) });
    return { ...t, height: Number(t.height) };
  }

  async blockHeader(height: number): Promise<{ height: number; hash: string; time: number }> {
    const b = await this.unary("GetBlock", blockId(height));
    const h = core("decode_block_header", { hex: toHex(b) });
    return { height: Number(h.height), hash: h.hash, time: h.time };
  }

  /** Compact blocks start..=end as one framed buffer `[u32 LE len][CompactBlock]...`. */
  blockRange(start: number, end: number, timeoutMs = 120_000): Promise<{ framed: Buffer; count: number }> {
    return new Promise((resolve, reject) => {
      const parts: Buffer[] = [];
      let count = 0;
      const call = this.client.makeServerStreamRequest(SVC + "GetBlockRange", id, id, blockRange(start, end), new grpc.Metadata(), {
        deadline: Date.now() + timeoutMs,
      });
      call.on("data", (msg: Buffer) => {
        const len = Buffer.alloc(4);
        len.writeUInt32LE(msg.length);
        parts.push(len, msg);
        count++;
      });
      call.on("error", (e: any) => reject(new Error(`GetBlockRange ${start}..${end}: ${e?.details ?? e}`)));
      call.on("end", () => resolve({ framed: Buffer.concat(parts), count }));
    });
  }

  /** Broadcasts a raw transaction. Not retried: a resend of the same bytes is harmless, but a
   * timeout must surface to the caller rather than being masked. */
  async sendTransaction(raw: Buffer): Promise<{ errorCode: number; errorMessage: string }> {
    const b = await this.unaryOnce("SendTransaction", field(0x0a, raw), 60_000);
    return decodeSendResponse(b);
  }

  /** Raw transaction by display-order txid. height: 0 = mempool, >= 2^32-1 = not in best chain. */
  async transaction(txidDisplay: string): Promise<{ hex: string; height: number }> {
    const wire = Buffer.from(txidDisplay, "hex").reverse();
    let b: Buffer;
    try {
      b = await this.unary("GetTransaction", txFilter(wire), 30_000);
    } catch (e: any) {
      const msg = String(e?.details ?? e?.message ?? e).toLowerCase();
      if (e?.code === grpc.status.NOT_FOUND || msg.includes("not found") || msg.includes("no such") || msg.includes("invalid")) {
        throw new NotFound(txidDisplay);
      }
      throw e;
    }
    const r = core<{ hex: string; height: string }>("decode_raw_tx", { hex: toHex(b) });
    if (!r.hex) throw new NotFound(txidDisplay);
    return { hex: r.hex, height: Number(r.height) };
  }
}

/**
 * Several lightwalletd servers behind one interface. Each call goes to the current server and
 * moves on to the next one when it fails; `NotFound` is an answer, not a failure, and is returned
 * as is. The servers come from more than one operator so one outage does not stop the index.
 */
export class Upstream {
  private clients: Lightwalletd[];
  private current = 0;
  readonly urls: string[];

  constructor(urls: string[]) {
    if (urls.length === 0) throw new Error("no lightwalletd servers configured");
    this.urls = urls;
    this.clients = urls.map((u) => new Lightwalletd(u));
  }

  get url(): string {
    return this.urls[this.current];
  }

  close() {
    for (const c of this.clients) c.close();
  }

  /** A client for one specific server, for cross-checks. */
  at(i: number): Lightwalletd {
    return this.clients[i % this.clients.length];
  }

  private async run<T>(f: (l: Lightwalletd) => Promise<T>): Promise<T> {
    const errors: string[] = [];
    for (let k = 0; k < this.clients.length; k++) {
      const i = (this.current + k) % this.clients.length;
      try {
        const r = await f(this.clients[i]);
        this.current = i;
        return r;
      } catch (e: any) {
        if (e instanceof NotFound) throw e;
        errors.push(`${publicEndpoint(this.urls[i])}: request failed`);
      }
    }
    throw new Error(`every lightwalletd server failed: ${errors.join("; ")}`);
  }

  latestHeight() {
    return this.run((l) => l.latestHeight());
  }
  treeState(h: number) {
    return this.run((l) => l.treeState(h));
  }
  blockHeader(h: number) {
    return this.run((l) => l.blockHeader(h));
  }
  blockRange(a: number, b: number) {
    return this.run((l) => l.blockRange(a, b));
  }
  transaction(txid: string) {
    return this.run((l) => l.transaction(txid));
  }
  sendTransaction(raw: Buffer) {
    return this.run((l) => l.sendTransaction(raw));
  }
}
