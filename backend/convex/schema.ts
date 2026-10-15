import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const trees = v.object({ sapling: v.string(), orchard: v.string(), ironwood: v.string() });

export default defineSchema({
  /** One row per network: how far the index reaches and the trees at that height. */
  progress: defineTable({
    network: v.string(),
    startHeight: v.number(),
    indexedHeight: v.number(),
    indexedHash: v.string(),
    trees,
    rootCounts: v.object({ sapling: v.number(), orchard: v.number(), ironwood: v.number() }),
    auditChecks: v.number(),
    auditMismatches: v.number(),
    lastAuditHeight: v.optional(v.number()),
    lastError: v.optional(v.string()),
    lastErrorAt: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_network", ["network"]),

  blocks: defineTable({
    network: v.string(),
    height: v.number(),
    hash: v.string(),
    time: v.number(),
  })
    .index("by_height", ["network", "height"])
    .index("by_time", ["network", "time"]),

  /** First block at which each root of each pool's note commitment tree appeared. */
  roots: defineTable({
    network: v.string(),
    pool: v.string(),
    root: v.string(),
    height: v.number(),
  })
    .index("by_root", ["network", "pool", "root"])
    .index("by_pool_height", ["network", "pool", "height"]),

  /** Locally recomputed roots compared with roots of the server's own tree state. */
  audits: defineTable({
    network: v.string(),
    height: v.number(),
    pool: v.string(),
    ok: v.boolean(),
    computed: v.string(),
    reported: v.string(),
  }).index("by_height", ["network", "height"]),
});
