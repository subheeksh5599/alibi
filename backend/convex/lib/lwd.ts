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

export type TreeState = {
  network: string;
  height: number;
  hash: string;
  time: number;
  trees: { sapling: string; orchard: string; ironwood: string };
  roots: { sapling: string; orchard: string; ironwood: string };
};

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
