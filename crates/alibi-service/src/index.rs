//! Follows the chain and records, for every pool, the first block at which each tree root
//! appeared.
//!
//! The roots are recomputed locally from the note commitments in each compact block, never taken
//! from the server. Three checks keep the recomputation honest:
//!
//! 1. after every block, the leaf count of each pool must equal the tree size the block reports;
//! 2. every block must name the previous indexed block as its parent (otherwise the chain
//!    reorganized and the index rewinds);
//! 3. at every anchor-grid boundary, the locally computed roots are compared with the roots of the
//!    server's own serialized tree state for that block, and the comparison is stored.

use std::time::Duration;

use alibi_core::{root_from_tree_state, Pool, PoolTree};
use anyhow::{anyhow, bail, Context, Result};

use crate::lwd::{CompactBlock, Lightwalletd, TreeState};
use crate::network::{NetworkConfig, ANCHOR_GRID};
use crate::store::{BlockRow, RootRow, Store};

const BATCH: u32 = 400;
const REORG_REWIND: u32 = 50;

pub struct Indexer {
    store: Store,
    cfg: NetworkConfig,
    lwd: Lightwalletd,
    trees: Option<Vec<PoolTree>>,
}

fn display_hash(bytes: &[u8]) -> String {
    let mut b = bytes.to_vec();
    b.reverse();
    hex::encode(b)
}

fn tree_hex(ts: &TreeState, pool: Pool) -> &str {
    match pool {
        Pool::Sapling => &ts.sapling_tree,
        Pool::Orchard => &ts.orchard_tree,
        Pool::Ironwood => &ts.ironwood_tree,
    }
}

fn trees_from_state(ts: &TreeState) -> Result<Vec<PoolTree>> {
    Pool::ALL
        .iter()
        .map(|&p| PoolTree::from_tree_state(p, tree_hex(ts, p)).with_context(|| format!("{p} tree state at {}", ts.height)))
        .collect()
}

fn as32(bytes: &[u8], what: &str) -> Result<[u8; 32]> {
    bytes.try_into().map_err(|_| anyhow!("{what} is {} bytes, expected 32", bytes.len()))
}

impl Indexer {
    pub fn new(store: Store, cfg: NetworkConfig, lwd: Lightwalletd) -> Self {
        Self { store, cfg, lwd, trees: None }
    }

    /// Loads the trees at `height` from the server and checks them against what the index already
    /// holds for that block.
    async fn load_trees_at(&mut self, height: u32) -> Result<()> {
        let ts = self.lwd.tree_state(height).await?;
        let trees = trees_from_state(&ts)?;
        for t in &trees {
            let stored = self.store.root_at(&self.cfg.name, t.pool(), height)?;
            if let Some((root, _)) = stored {
                if root != t.root() {
                    bail!(
                        "{} root at {height} from the server ({}) differs from the indexed root ({})",
                        t.pool(),
                        hex::encode(t.root()),
                        hex::encode(root)
                    );
                }
            }
        }
        self.trees = Some(trees);
        Ok(())
    }

    pub async fn ensure_started(&mut self) -> Result<()> {
        if self.trees.is_some() {
            return Ok(());
        }
        match self.store.progress(&self.cfg.name)? {
            Some(p) => {
                tracing::info!(network = %self.cfg.name, height = p.indexed_height, "resuming index");
                self.load_trees_at(p.indexed_height).await
            }
            None => {
                let h = self.cfg.start_height;
                tracing::info!(network = %self.cfg.name, height = h, "starting a new index");
                let ts = self.lwd.tree_state(h).await?;
                let trees = trees_from_state(&ts)?;
                let block = self.lwd.block(h).await?;
                let hash = display_hash(&block.hash);
                if hash != ts.hash {
                    bail!("block {h}: compact block hash {hash} does not match tree state hash {}", ts.hash);
                }
                let roots: Vec<RootRow> = trees.iter().map(|t| RootRow { pool: t.pool(), root: t.root() }).collect();
                self.store.init(&self.cfg.name, &BlockRow { height: h, hash, time: block.time }, &roots)?;
                self.trees = Some(trees);
                Ok(())
            }
        }
    }

    async fn rewind_to(&mut self, height: u32) -> Result<()> {
        let start = self.store.progress(&self.cfg.name)?.map(|p| p.start_height).unwrap_or(self.cfg.start_height);
        let height = height.max(start);
        tracing::warn!(network = %self.cfg.name, height, "chain reorganized, rewinding index");
        self.store.rewind(&self.cfg.name, height + 1)?;
        self.trees = None;
        self.load_trees_at(height).await
    }

    fn apply_block(trees: &mut [PoolTree], block: &CompactBlock) -> Result<Vec<RootRow>> {
        let before: Vec<u64> = trees.iter().map(|t| t.size()).collect();
        for tx in &block.vtx {
            for out in &tx.outputs {
                trees[0].append(&as32(&out.cmu, "sapling cmu")?)?;
            }
            for act in &tx.actions {
                trees[1].append(&as32(&act.cmx, "orchard cmx")?)?;
            }
            for act in &tx.ironwood_actions {
                trees[2].append(&as32(&act.cmx, "ironwood cmx")?)?;
            }
        }
        if let Some(meta) = &block.chain_metadata {
            let expected = [
                meta.sapling_commitment_tree_size as u64,
                meta.orchard_commitment_tree_size as u64,
                meta.ironwood_commitment_tree_size as u64,
            ];
            for (t, e) in trees.iter().zip(expected) {
                if t.size() != e {
                    bail!(
                        "block {}: {} tree has {} leaves after applying the block, the block reports {e}",
                        block.height,
                        t.pool(),
                        t.size()
                    );
                }
            }
        }
        Ok(trees
            .iter()
            .zip(before)
            .filter(|(t, b)| t.size() != *b)
            .map(|(t, _)| RootRow { pool: t.pool(), root: t.root() })
            .collect())
    }

    /// Indexes up to one batch of blocks. Returns how many blocks were added.
    pub async fn step(&mut self) -> Result<u32> {
        self.ensure_started().await?;
        let net = self.cfg.name.clone();
        let progress = self.store.progress(&net)?.ok_or_else(|| anyhow!("index not initialized"))?;
        let latest = self.lwd.latest_height().await?;
        let safe_tip = latest.saturating_sub(self.cfg.confirmations);
        let next = progress.indexed_height + 1;
        if next > safe_tip {
            return Ok(0);
        }
        let end = (next + BATCH - 1).min(safe_tip);
        let blocks = self.lwd.block_range(next, end).await?;

        let mut prev_hash = self
            .store
            .block(&net, progress.indexed_height)?
            .ok_or_else(|| anyhow!("missing block row at {}", progress.indexed_height))?
            .hash;
        let mut trees = self.trees.clone().expect("started");
        let mut rows = Vec::with_capacity(blocks.len());
        let mut audits: Vec<(u32, Vec<[u8; 32]>)> = Vec::new();

        for b in &blocks {
            let h = b.height as u32;
            if display_hash(&b.prev_hash) != prev_hash {
                let to = progress.indexed_height.saturating_sub(REORG_REWIND);
                self.rewind_to(to).await?;
                return Ok(0);
            }
            let roots = Self::apply_block(&mut trees, b)?;
            let hash = display_hash(&b.hash);
            if h % ANCHOR_GRID == 0 {
                audits.push((h, trees.iter().map(|t| t.root()).collect()));
            }
            rows.push((BlockRow { height: h, hash: hash.clone(), time: b.time }, roots));
            prev_hash = hash;
        }

        self.store.append_batch(&net, &rows)?;
        self.trees = Some(trees);

        for (h, ours) in audits {
            self.audit(h, &ours).await?;
        }
        Ok(rows.len() as u32)
    }

    /// Compares locally computed roots at `height` with the server's tree state.
    async fn audit(&mut self, height: u32, ours: &[[u8; 32]]) -> Result<()> {
        let ts = self.lwd.tree_state(height).await?;
        let mut bad = Vec::new();
        for (pool, computed) in Pool::ALL.iter().zip(ours) {
            let reported = root_from_tree_state(*pool, tree_hex(&ts, *pool))?;
            self.store.record_audit(&self.cfg.name, height, *pool, computed, &reported)?;
            if &reported != computed {
                bad.push(*pool);
            }
        }
        if !bad.is_empty() {
            // Our recomputation and the server disagree. Do not keep building on either.
            let to = height.saturating_sub(REORG_REWIND);
            self.rewind_to(to).await?;
            bail!("root audit failed at block {height} for {bad:?}; rewound to {to}");
        }
        Ok(())
    }

    /// Runs forever, backing off when caught up or when the server misbehaves.
    pub async fn run(mut self) {
        let mut failures = 0u32;
        loop {
            match self.step().await {
                Ok(0) => {
                    failures = 0;
                    tokio::time::sleep(Duration::from_secs(30)).await;
                }
                Ok(n) => {
                    failures = 0;
                    if let Ok(Some(p)) = self.store.progress(&self.cfg.name) {
                        tracing::info!(network = %self.cfg.name, added = n, height = p.indexed_height, "indexed");
                    }
                }
                Err(e) => {
                    failures += 1;
                    tracing::error!(network = %self.cfg.name, error = %format!("{e:#}"), "index step failed");
                    self.trees = None;
                    tokio::time::sleep(Duration::from_secs((5 * failures as u64).min(120))).await;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lwd::rpc::{ChainMetadata, CompactOrchardAction, CompactTx};

    fn leaf(n: u8) -> Vec<u8> {
        let mut b = vec![0u8; 32];
        b[0] = n;
        b
    }

    fn block(height: u64, ironwood_leaves: &[u8], reported_ironwood: u32) -> CompactBlock {
        CompactBlock {
            height,
            vtx: vec![CompactTx {
                ironwood_actions: ironwood_leaves
                    .iter()
                    .map(|n| CompactOrchardAction { cmx: leaf(*n), ..Default::default() })
                    .collect(),
                ..Default::default()
            }],
            chain_metadata: Some(ChainMetadata {
                sapling_commitment_tree_size: 0,
                orchard_commitment_tree_size: 0,
                ironwood_commitment_tree_size: reported_ironwood,
            }),
            ..Default::default()
        }
    }

    fn empty_trees() -> Vec<PoolTree> {
        Pool::ALL.iter().map(|p| PoolTree::empty(*p)).collect()
    }

    #[test]
    fn records_a_root_only_for_pools_that_changed() {
        let mut trees = empty_trees();
        let roots = Indexer::apply_block(&mut trees, &block(1, &[1, 2], 2)).unwrap();
        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0].pool, Pool::Ironwood);
        assert_eq!(roots[0].root, trees[2].root());
        let unchanged = Indexer::apply_block(&mut trees, &block(2, &[], 2)).unwrap();
        assert!(unchanged.is_empty());
    }

    #[test]
    fn a_block_whose_leaf_count_disagrees_is_rejected() {
        // The server claims two Ironwood leaves but only sent one: a withheld commitment would
        // otherwise shift every later root.
        let mut trees = empty_trees();
        let err = Indexer::apply_block(&mut trees, &block(7, &[1], 2)).unwrap_err();
        assert!(err.to_string().contains("ironwood tree has 1 leaves"), "{err}");
    }

    #[test]
    fn a_malformed_commitment_is_rejected() {
        let mut trees = empty_trees();
        let mut b = block(3, &[1], 1);
        b.vtx[0].ironwood_actions[0].cmx = vec![0xff; 32];
        assert!(Indexer::apply_block(&mut trees, &b).is_err());
        b.vtx[0].ironwood_actions[0].cmx = vec![1; 31];
        assert!(Indexer::apply_block(&mut trees, &b).is_err());
    }

    #[test]
    fn display_hash_reverses_wire_order() {
        assert_eq!(display_hash(&[1, 2, 3]), "030201");
    }
}
