"use node";
// Node actions: everything that talks to lightwalletd or runs the WebAssembly core.
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { core, CoreError } from "./lib/core";
import { NotFound, Upstream } from "./lib/lwd";
import { GRID, POOLS } from "./lib/constants";

// Mainnet lightwalletd servers from three operators. ALIBI_LWD_MAIN (comma separated) overrides.
const MAIN_SERVERS = [
  "https://zec.rocks:443",
  "https://us.zec.stardust.rest:443",
  "https://zcash.mysideoftheweb.com:9067",
  "https://na.zec.rocks:443",
  "https://eu.zec.rocks:443",
  "https://eu.zec.stardust.rest:443",
  "https://ap.zec.rocks:443",
  "https://sa.zec.rocks:443",
];
/** Index of a server run by a different operator than MAIN_SERVERS[0], for audit cross-checks. */
const CROSS_CHECK = 1;

const NETWORKS: Record<string, { servers: string[]; confirmations: number }> = {
  main: {
    servers: process.env.ALIBI_LWD_MAIN ? process.env.ALIBI_LWD_MAIN.split(",").map((s) => s.trim()).filter(Boolean) : MAIN_SERVERS,
    confirmations: 10,
  },
};
const BATCH = 150;
const STEP_BUDGET_MS = 4 * 60_000;
const NEAR_TIP_SCAN = 40;

type Reply = { status: number; body: unknown };
const fail = (status: number, error: string, message: string): Reply => ({ status, body: { error, message } });

// ------------------------------------------------------------------------------- indexing

export const indexStep = internalAction({
  args: { network: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const network = args.network ?? "main";
    const net = NETWORKS[network];
    const lwd = new Upstream(net.servers);
    const started = Date.now();
    let added = 0;
    try {
      while (Date.now() - started < STEP_BUDGET_MS) {
        const p = await ctx.runQuery(internal.ledger.progress, { network });
        if (!p) return { added, note: "no progress row: import the index first" };
        const tip = await lwd.latestHeight();
        const safe = tip - net.confirmations;
        const from = p.indexedHeight + 1;
        if (from > safe) break;
        const to = Math.min(from + BATCH - 1, safe);
        const { framed, count } = await lwd.blockRange(from, to);
        if (count !== to - from + 1) throw new Error(`GetBlockRange ${from}..${to} returned ${count} blocks`);
        const res = core("apply_blocks", { trees: p.trees, prev_hash: p.indexedHash, blocks: framed.toString("hex"), grid: GRID });
        if (res.reorg) {
          const back = Math.max(p.startHeight, p.indexedHeight - 50);
          const ts = await lwd.treeState(back);
          await ctx.runMutation(internal.ledger.rewind, { network, height: back, hash: ts.hash, trees: ts.trees });
          await ctx.runMutation(internal.ledger.noteError, { network, message: `reorg at ${res.reorg.height}; rewound to ${back}` });
          continue;
        }
        const w = await ctx.runMutation(internal.ledger.appendBlocks, {
          network,
          fromHeight: from,
          parentHash: p.indexedHash,
          blocks: res.blocks.map((b: any) => ({ height: Number(b.height), hash: b.hash, time: b.time, roots: b.roots })),
          trees: res.trees,
        });
        if (w.written === 0) break; // another run advanced the index
        added += w.written;
        for (const g of res.grid as { height: number; roots: Record<string, string> }[]) {
          // The roots must equal the tree state of the server we follow AND of a server run by a
          // different operator.
          const ts = await lwd.treeState(Number(g.height));
          let other = ts;
          try {
            other = await lwd.at(CROSS_CHECK).treeState(Number(g.height));
          } catch {
            other = ts; // second operator unreachable: fall back to the primary comparison
          }
          const results = POOLS.map((pool) => ({
            pool,
            computed: g.roots[pool],
            reported: ts.roots[pool] === other.roots[pool] ? ts.roots[pool] : `${ts.roots[pool]}|${other.roots[pool]}`,
          }));
          const a = await ctx.runMutation(internal.ledger.recordAudit, { network, height: Number(g.height), results });
          if (a.mismatches > 0) {
            const back = Math.max(p.startHeight, Number(g.height) - 50);
            const bts = await lwd.treeState(back);
            await ctx.runMutation(internal.ledger.rewind, { network, height: back, hash: bts.hash, trees: bts.trees });
            throw new Error(`root audit failed at ${g.height}; rewound to ${back}`);
          }
        }
      }
      return { added };
    } catch (e: any) {
      await ctx.runMutation(internal.ledger.noteError, { network, message: String(e?.message ?? e) });
      return { added, error: String(e?.message ?? e) };
    } finally {
      lwd.close();
    }
  },
});

// ------------------------------------------------------------------------------- verification

export function parseUtc(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?Z?$/i.exec(s.trim());
  if (!m) return null;
  const [y, mo, d, hh, mm, ss] = [m[1], m[2], m[3], m[4] ?? "0", m[5] ?? "0", m[6] ?? "0"].map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mm > 59 || ss > 60) return null;
  const t = Date.UTC(y, mo - 1, d, hh, mm, ss);
  const back = new Date(t);
  if (back.getUTCDate() !== d) return null;
  return Math.floor(t / 1000);
}

type Cutoff = { input: string; height: number; time: number | null; resolved_by: "height" | "date" };

async function resolveCutoff(ctx: ActionCtx, network: string, before: string): Promise<Cutoff | Reply> {
  const input = before.trim();
  if (/^\d+$/.test(input)) {
    const height = Number(input);
    if (!Number.isSafeInteger(height) || height <= 0 || height > 0xffffffff) return fail(400, "bad_request", "cut-off height out of range");
    const b = await ctx.runQuery(internal.ledger.block, { network, height });
    return { input, height, time: b?.time ?? null, resolved_by: "height" };
  }
  const t = parseUtc(input);
  if (t === null) return fail(400, "bad_request", "`before` must be a block height or a UTC date such as 2026-09-24 or 2026-09-24T18:30Z");
  const p = await ctx.runQuery(internal.ledger.progress, { network });
  if (!p) return fail(503, "index_not_ready", `the ${network} index has not started yet`);
  const start = await ctx.runQuery(internal.ledger.block, { network, height: p.startHeight });
  if (start && t <= start.time) {
    return fail(422, "unprocessable", `${input} is not after the first indexed block (${start.height}); use a block height instead`);
  }
  const b = await ctx.runQuery(internal.ledger.blockAtOrAfter, { network, time: t });
  if (!b) return fail(422, "unprocessable", `${input} is later than the last indexed block (${p.indexedHeight}); the cut-off cannot be resolved yet`);
  return { input, height: b.height, time: b.time, resolved_by: "date" };
}

const isReply = (x: any): x is Reply => x && typeof x.status === "number" && "body" in x;

async function locate(ctx: ActionCtx, lwd: Upstream, network: string, pool: string, root: string, below: number | null, p: any) {
  const hit = await ctx.runQuery(internal.ledger.locateRoot, { network, pool, root });
  if (hit) return { status: "located", height: hit.height, block_hash: hit.hash ?? "", block_time: hit.time ?? 0 };
  const upper = below !== null ? below - 1 : await lwd.latestHeight();
  let scanned: [number, number] | null = null;
  if (upper > p.indexedHeight) {
    const from = Math.max(p.indexedHeight + 1, upper - NEAR_TIP_SCAN + 1);
    for (let h = from; h <= upper; h++) {
      const ts = await lwd.treeState(h);
      if ((ts.roots as any)[pool] === root) return { status: "located", height: h, block_hash: ts.hash, block_time: ts.time };
    }
    scanned = [from, upper];
  }
  let reason = `not the ${pool} tree root at the end of any indexed block (${p.startHeight} to ${p.indexedHeight})`;
  if (scanned) reason += ` or of blocks ${scanned[0]} to ${scanned[1]}`;
  reason += `. An anchor older than block ${p.startHeight} is outside this index and is not evaluated.`;
  return { status: "not_located", reason };
}

async function verifyById(ctx: ActionCtx, network: string, txid: string, before: string | undefined): Promise<Reply> {
  const net = NETWORKS[network];
  if (!net) return fail(400, "bad_request", `unknown network \`${network}\`; this server serves main`);
  txid = txid.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(txid)) return fail(400, "bad_request", "txid must be 64 hex characters");
  const p = await ctx.runQuery(internal.ledger.progress, { network });
  if (!p) return fail(503, "index_not_ready", `the ${network} index has not started yet`);
  let cutoff: Cutoff | null = null;
  if (before && before.trim()) {
    const c = await resolveCutoff(ctx, network, before);
    if (isReply(c)) return c;
    cutoff = c;
  }
  const lwd = new Upstream(net.servers);
  try {
    let tx;
    try {
      tx = await lwd.transaction(txid);
    } catch (e) {
      if (e instanceof NotFound) return fail(404, "not_found", `transaction ${txid} is not known to the ${network} network's lightwalletd`);
      throw e;
    }
    let status = "mined";
    let mined: { height: number; hash: string; time: number } | null = null;
    if (tx.height === 0) status = "mempool";
    else if (tx.height >= 0xffffffff) status = "not_in_best_chain";
    else {
      const b = await ctx.runQuery(internal.ledger.block, { network, height: tx.height });
      mined = b ? { height: b.height, hash: b.hash, time: b.time } : await lwd.blockHeader(tx.height);
    }
    const parsed = core("parse_tx", { hex: tx.hex });
    if (parsed.txid !== txid) return fail(502, "upstream_error", `server returned transaction ${parsed.txid}, not ${txid}`);
    const locations: Record<string, unknown> = {};
    for (const pool of parsed.pools) {
      if (pool.spends === 0) continue;
      for (const a of pool.anchors as string[]) {
        const key = `${pool.pool}:${a}`;
        if (!(key in locations)) locations[key] = await locate(ctx, lwd, network, pool.pool, a, mined?.height ?? null, p);
      }
    }
    const ev = core("evaluate_tx", { hex: tx.hex, locations, cutoff: cutoff?.height ?? null });
    const fresh = await ctx.runQuery(internal.ledger.progress, { network });
    return {
      status: 200,
      body: {
        network,
        txid,
        status,
        mined,
        cutoff,
        transaction: ev.transaction,
        verdict: ev.verdict,
        index: { start_height: fresh!.startHeight, indexed_height: fresh!.indexedHeight },
        source: lwd.url,
      },
    };
  } catch (e: any) {
    if (e instanceof CoreError) return fail(422, "unprocessable", e.message);
    return fail(502, "upstream_error", String(e?.message ?? e));
  } finally {
    lwd.close();
  }
}

export const verifyTx = internalAction({
  args: { network: v.string(), txid: v.string(), before: v.optional(v.string()) },
  handler: async (ctx, a): Promise<Reply> => verifyById(ctx, a.network, a.txid, a.before),
});

/**
 * Raw bytes are used only to compute the txid; everything else comes from the network's copy.
 * Anchors in bytes the network never accepted prove nothing (their proof was never checked), and
 * since the txid does not commit to the anchor, the submitted shielded data must equal the
 * network's copy.
 */
export const verifyRaw = internalAction({
  args: { network: v.string(), hex: v.string(), before: v.optional(v.string()) },
  handler: async (ctx, a): Promise<Reply> => {
    const hex = a.hex.trim();
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 || hex.length > 4_000_000) {
      return fail(400, "bad_request", "`hex` must be the transaction in hex, at most 2 MB");
    }
    let submitted;
    try {
      submitted = core("parse_tx", { hex });
    } catch (e: any) {
      return fail(422, "unprocessable", e.message);
    }
    const r = await verifyById(ctx, a.network, submitted.txid, a.before);
    if (r.status === 404) {
      return fail(
        422,
        "unprocessable",
        `transaction ${submitted.txid} is not in the ${a.network} mempool or chain. Its proofs have not been checked by the network, so its anchors prove nothing yet; broadcast it first.`,
      );
    }
    if (r.status === 200 && JSON.stringify((r.body as any).transaction.pools) !== JSON.stringify(submitted.pools)) {
      return fail(422, "unprocessable", `the network's copy of ${submitted.txid} commits to different shielded data than the submitted bytes`);
    }
    return r;
  },
});

export const anchor = internalAction({
  args: { network: v.string(), pool: v.string(), anchor: v.string() },
  handler: async (ctx, a): Promise<Reply> => {
    const net = NETWORKS[a.network];
    if (!net) return fail(400, "bad_request", `unknown network \`${a.network}\``);
    if (!(POOLS as readonly string[]).includes(a.pool)) return fail(400, "bad_request", "pool must be sapling, orchard or ironwood");
    const anchor = a.anchor.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(anchor)) return fail(400, "bad_request", "anchor must be 64 hex characters, in transaction byte order");
    const p = await ctx.runQuery(internal.ledger.progress, { network: a.network });
    if (!p) return fail(503, "index_not_ready", "index not started");
    const lwd = new Upstream(net.servers);
    try {
      const location = await locate(ctx, lwd, a.network, a.pool, anchor, null, p);
      return { status: 200, body: { network: a.network, pool: a.pool, anchor, location } };
    } catch (e: any) {
      return fail(502, "upstream_error", String(e?.message ?? e));
    } finally {
      lwd.close();
    }
  },
});

export const checkpoint = internalAction({
  args: { network: v.string(), before: v.string() },
  handler: async (ctx, a): Promise<Reply> => {
    if (!NETWORKS[a.network]) return fail(400, "bad_request", `unknown network \`${a.network}\``);
    const c = await resolveCutoff(ctx, a.network, a.before);
    if (isReply(c)) return c;
    const p = (await ctx.runQuery(internal.ledger.progress, { network: a.network }))!;
    const height = Math.floor((c.height - 1) / GRID) * GRID;
    if (height < p.startHeight) return fail(422, "unprocessable", `the grid boundary before ${c.height} is block ${height}, before the index start (${p.startHeight})`);
    if (height > p.indexedHeight) return fail(503, "index_not_ready", `block ${height} is not indexed yet (indexed to ${p.indexedHeight})`);
    const block = await ctx.runQuery(internal.ledger.block, { network: a.network, height });
    const roots = await ctx.runQuery(internal.ledger.rootsAt, { network: a.network, height });
    return { status: 200, body: { network: a.network, cutoff: c, height, block, grid: GRID, roots } };
  },
});

export const cutoff = internalAction({
  args: { network: v.string(), before: v.string() },
  handler: async (ctx, a): Promise<Reply> => {
    if (!NETWORKS[a.network]) return fail(400, "bad_request", `unknown network \`${a.network}\``);
    const c = await resolveCutoff(ctx, a.network, a.before);
    return isReply(c) ? c : { status: 200, body: c };
  },
});

export const health = internalAction({
  args: {},
  handler: async (ctx): Promise<Reply> => {
    const networks = [];
    for (const [network, net] of Object.entries(NETWORKS)) {
      const up = new Upstream(net.servers);
      let servers: { url: string; tip: number | null; error?: string }[] = [];
      try {
        servers = await Promise.all(
          net.servers.map(async (url, i) => {
            try {
              const tip = await Promise.race([
                up.at(i).latestHeight(),
                new Promise<number>((_, rej) => setTimeout(() => rej(new Error("timeout")), 8000)),
              ]);
              return { url, tip };
            } catch (e: any) {
              return { url, tip: null, error: String(e?.message ?? e).slice(0, 120) };
            }
          }),
        );
      } finally {
        up.close();
      }
      const tips = servers.map((s) => s.tip).filter((t): t is number => t !== null);
      const tip = tips.length ? Math.max(...tips) : null;
      const p = await ctx.runQuery(internal.ledger.progress, { network });
      networks.push({
        network,
        confirmations: net.confirmations,
        chain_tip: tip,
        upstream: { reachable: tips.length, configured: servers.length, servers },
        index: p ? { start_height: p.startHeight, indexed_height: p.indexedHeight } : null,
        lag_blocks: p && tip !== null ? Math.max(0, tip - p.indexedHeight) : null,
        roots_indexed: p?.rootCounts ?? {},
        audits: p ? { checks: p.auditChecks, mismatches: p.auditMismatches, last_checked_height: p.lastAuditHeight ?? null } : null,
        last_error: p?.lastError ? { message: p.lastError, at: p.lastErrorAt } : null,
      });
    }
    return { status: 200, body: { ok: networks.every((n) => n.index !== null && n.upstream.reachable > 0), networks } };
  },
});
