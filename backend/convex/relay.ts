"use node";
// Chain access for the browser wallet. The wallet holds its keys and does every trial decryption
// itself; this relay only forwards public chain data and broadcasts finished transactions, so it
// never sees a key, an address or a note. It does see which block ranges a wallet asks for and
// the raw transactions it broadcasts, exactly what any lightwalletd sees.
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { NETWORKS, fail, type Reply } from "./chain";
import { Upstream } from "./lib/lwd";
import { core } from "./lib/core";

/** Most blocks one request may fetch. */
const MAX_RANGE = 500;

function upstream(network: string): Upstream | Reply {
  const net = NETWORKS[network];
  if (!net) return fail(400, "bad_request", `unknown network \`${network}\``);
  return new Upstream(net.servers);
}

const isReply = (x: unknown): x is Reply => typeof (x as any)?.status === "number";

export const tip = internalAction({
  args: { network: v.string() },
  handler: async (_ctx, a): Promise<Reply> => {
    const up = upstream(a.network);
    if (isReply(up)) return up;
    try {
      const height = await up.latestHeight();
      return { status: 200, body: { network: a.network, height, confirmations: NETWORKS[a.network].confirmations } };
    } catch (e: any) {
      return fail(502, "upstream_error", String(e?.message ?? e));
    } finally {
      up.close();
    }
  },
});

export const treeState = internalAction({
  args: { network: v.string(), height: v.number() },
  handler: async (_ctx, a): Promise<Reply> => {
    if (!Number.isSafeInteger(a.height) || a.height < 1) return fail(400, "bad_request", "height must be a positive integer");
    const up = upstream(a.network);
    if (isReply(up)) return up;
    try {
      const t = await up.treeState(a.height);
      return { status: 200, body: { network: a.network, height: t.height, hash: t.hash, time: t.time, ironwood: { tree: t.trees.ironwood, root: t.roots.ironwood } } };
    } catch (e: any) {
      return fail(502, "upstream_error", String(e?.message ?? e));
    } finally {
      up.close();
    }
  },
});

export const blocks = internalAction({
  args: { network: v.string(), from: v.number(), to: v.number() },
  handler: async (_ctx, a): Promise<Reply> => {
    if (!Number.isSafeInteger(a.from) || !Number.isSafeInteger(a.to) || a.from < 1 || a.to < a.from) {
      return fail(400, "bad_request", "`from` and `to` must be heights with from <= to");
    }
    if (a.to - a.from + 1 > MAX_RANGE) return fail(400, "bad_request", `at most ${MAX_RANGE} blocks per request`);
    const up = upstream(a.network);
    if (isReply(up)) return up;
    try {
      const r = await up.blockRange(a.from, a.to);
      if (r.count !== a.to - a.from + 1) return fail(502, "upstream_error", `asked for ${a.to - a.from + 1} blocks, got ${r.count}`);
      return { status: 200, body: { network: a.network, from: a.from, to: a.to, count: r.count, framed: r.framed.toString("hex") } };
    } catch (e: any) {
      return fail(502, "upstream_error", String(e?.message ?? e));
    } finally {
      up.close();
    }
  },
});

export const broadcast = internalAction({
  args: { network: v.string(), hex: v.string() },
  handler: async (_ctx, a): Promise<Reply> => {
    if (!/^([0-9a-f]{2})+$/i.test(a.hex) || a.hex.length > 4_000_000) return fail(400, "bad_request", "`hex` must be a hex-encoded transaction, at most 2 MB");
    // Decode before relaying: the relay refuses anything that is not a well-formed transaction.
    let parsed: { txid: string };
    try {
      parsed = core("parse_tx", { hex: a.hex });
    } catch (e: any) {
      return fail(422, "unprocessable", e.message);
    }
    const up = upstream(a.network);
    if (isReply(up)) return up;
    try {
      const r = await up.sendTransaction(Buffer.from(a.hex, "hex"));
      if (r.errorCode !== 0) return fail(422, "rejected", `the node rejected the transaction (${r.errorCode}): ${r.errorMessage}`);
      return { status: 200, body: { network: a.network, txid: parsed.txid, accepted: true, message: r.errorMessage } };
    } catch (e: any) {
      return fail(502, "upstream_error", String(e?.message ?? e));
    } finally {
      up.close();
    }
  },
});
