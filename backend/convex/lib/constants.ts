export const POOLS = ["sapling", "orchard", "ironwood"] as const;
export type PoolName = (typeof POOLS)[number];
/** The ZIP 318 anchor grid: every multiple of 144 blocks. */
export const GRID = 144;
