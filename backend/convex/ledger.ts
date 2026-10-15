// Queries and mutations over the anchor index. Runs in the default Convex runtime.
import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";

import { POOLS, type PoolName } from "./lib/constants";

async function progressRow(ctx: QueryCtx, network: string) {
  return ctx.db
    .query("progress")
    .withIndex("by_network", (q) => q.eq("network", network))
    .unique();
}

export const progress = internalQuery({
  args: { network: v.string() },
  handler: async (ctx, { network }) => progressRow(ctx, network),
});

export const block = internalQuery({
  args: { network: v.string(), height: v.number() },
  handler: async (ctx, { network, height }) =>
    ctx.db
      .query("blocks")
      .withIndex("by_height", (q) => q.eq("network", network).eq("height", height))
      .unique(),
});

/** First block at or after a unix time. */
export const blockAtOrAfter = internalQuery({
  args: { network: v.string(), time: v.number() },
  handler: async (ctx, { network, time }) =>
    ctx.db
      .query("blocks")
      .withIndex("by_time", (q) => q.eq("network", network).gte("time", time))
      .first(),
});

/** The block at which `root` first became the root of `pool`'s tree, with that block's row. */
export const locateRoot = internalQuery({
  args: { network: v.string(), pool: v.string(), root: v.string() },
  handler: async (ctx, { network, pool, root }) => {
    const r = await ctx.db
      .query("roots")
      .withIndex("by_root", (q) => q.eq("network", network).eq("pool", pool).eq("root", root))
      .unique();
    if (!r) return null;
    const b = await ctx.db
      .query("blocks")
      .withIndex("by_height", (q) => q.eq("network", network).eq("height", r.height))
      .unique();
    return { height: r.height, hash: b?.hash ?? null, time: b?.time ?? null };
  },
});

/** Every pool's root at the end of `height`, with the block it first appeared at. */
export const rootsAt = internalQuery({
  args: { network: v.string(), height: v.number() },
  handler: async (ctx, { network, height }) => {
    const out = [];
    for (const pool of POOLS) {
      const r = await ctx.db
        .query("roots")
        .withIndex("by_pool_height", (q) => q.eq("network", network).eq("pool", pool).lte("height", height))
        .order("desc")
        .first();
      if (r) out.push({ pool, root: r.root, since_height: r.height });
    }
    return out;
  },
});

/** Public, cheap status for the site. */
export const status = query({
  args: {},
  handler: async (ctx) => {
    const p = await progressRow(ctx, "main");
    if (!p) return null;
    const { trees: _t, ...rest } = p;
    return rest;
  },
});

const blockRow = v.object({
  height: v.number(),
  hash: v.string(),
  time: v.number(),
  roots: v.array(v.object({ pool: v.string(), root: v.string() })),
});

/**
 * Appends consecutive blocks. Optimistic concurrency: the batch must start right after the
 * stored progress and name the stored tip as parent, otherwise nothing is written (another run
 * got there first).
 */
export const appendBlocks = internalMutation({
  args: {
    network: v.string(),
    fromHeight: v.number(),
    parentHash: v.string(),
    blocks: v.array(blockRow),
    trees: v.object({ sapling: v.string(), orchard: v.string(), ironwood: v.string() }),
  },
  handler: async (ctx, a) => {
    const p = await progressRow(ctx, a.network);
    if (!p) throw new Error(`no progress row for ${a.network}`);
    if (p.indexedHeight + 1 !== a.fromHeight || p.indexedHash !== a.parentHash) {
      return { written: 0, reason: `stale batch: index is at ${p.indexedHeight}` };
    }
    const counts = { ...p.rootCounts };
    let expect = a.fromHeight;
    for (const b of a.blocks) {
      if (b.height !== expect) throw new Error(`non-consecutive block ${b.height}, expected ${expect}`);
      expect++;
      await ctx.db.insert("blocks", { network: a.network, height: b.height, hash: b.hash, time: b.time });
      for (const r of b.roots) {
        const seen = await ctx.db
          .query("roots")
          .withIndex("by_root", (q) => q.eq("network", a.network).eq("pool", r.pool).eq("root", r.root))
          .unique();
        if (!seen) {
          await ctx.db.insert("roots", { network: a.network, pool: r.pool, root: r.root, height: b.height });
          counts[r.pool as PoolName]++;
        }
      }
    }
    const last = a.blocks[a.blocks.length - 1];
    if (last) {
      await ctx.db.patch(p._id, {
        indexedHeight: last.height,
        indexedHash: last.hash,
        trees: a.trees,
        rootCounts: counts,
        updatedAt: Date.now(),
        lastError: undefined,
        lastErrorAt: undefined,
      });
    }
    return { written: a.blocks.length };
  },
});

export const recordAudit = internalMutation({
  args: {
    network: v.string(),
    height: v.number(),
    results: v.array(v.object({ pool: v.string(), computed: v.string(), reported: v.string() })),
  },
  handler: async (ctx, a) => {
    const p = await progressRow(ctx, a.network);
    if (!p) throw new Error(`no progress row for ${a.network}`);
    let mismatches = 0;
    for (const r of a.results) {
      const ok = r.computed === r.reported;
      if (!ok) mismatches++;
      await ctx.db.insert("audits", { network: a.network, height: a.height, pool: r.pool, ok, computed: r.computed, reported: r.reported });
    }
    await ctx.db.patch(p._id, {
      auditChecks: p.auditChecks + a.results.length,
      auditMismatches: p.auditMismatches + mismatches,
      lastAuditHeight: Math.max(p.lastAuditHeight ?? 0, a.height),
    });
    return { mismatches };
  },
});

/** Forgets blocks above `height` and resets the trees to the server's state there. */
export const rewind = internalMutation({
  args: {
    network: v.string(),
    height: v.number(),
    hash: v.string(),
    trees: v.object({ sapling: v.string(), orchard: v.string(), ironwood: v.string() }),
  },
  handler: async (ctx, a) => {
    const p = await progressRow(ctx, a.network);
    if (!p) throw new Error(`no progress row for ${a.network}`);
    const counts = { ...p.rootCounts };
    let removed = 0;
    for (const pool of POOLS) {
      const rows = await ctx.db
        .query("roots")
        .withIndex("by_pool_height", (q) => q.eq("network", a.network).eq("pool", pool).gt("height", a.height))
        .collect();
      for (const r of rows) {
        await ctx.db.delete(r._id);
        counts[pool]--;
      }
    }
    const blocks = await ctx.db
      .query("blocks")
      .withIndex("by_height", (q) => q.eq("network", a.network).gt("height", a.height))
      .collect();
    for (const b of blocks) {
      await ctx.db.delete(b._id);
      removed++;
    }
    await ctx.db.patch(p._id, { indexedHeight: a.height, indexedHash: a.hash, trees: a.trees, rootCounts: counts, updatedAt: Date.now() });
    return { removed };
  },
});

export const noteError = internalMutation({
  args: { network: v.string(), message: v.string() },
  handler: async (ctx, { network, message }) => {
    const p = await progressRow(ctx, network);
    if (p) await ctx.db.patch(p._id, { lastError: message.slice(0, 500), lastErrorAt: Date.now() });
  },
});

/** One-time setup after importing the historical index: the progress row. */
export const initProgress = internalMutation({
  args: {
    network: v.string(),
    startHeight: v.number(),
    indexedHeight: v.number(),
    indexedHash: v.string(),
    trees: v.object({ sapling: v.string(), orchard: v.string(), ironwood: v.string() }),
    rootCounts: v.object({ sapling: v.number(), orchard: v.number(), ironwood: v.number() }),
    auditChecks: v.number(),
    auditMismatches: v.number(),
    lastAuditHeight: v.optional(v.number()),
  },
  handler: async (ctx, a) => {
    const p = await progressRow(ctx, a.network);
    if (p) throw new Error(`progress for ${a.network} already exists at ${p.indexedHeight}`);
    await ctx.db.insert("progress", { ...a, updatedAt: Date.now() });
  },
});
