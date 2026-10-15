//! SQLite persistence for the anchor index.
//!
//! * `blocks` — height, hash and time of every indexed block (hash in display order).
//! * `roots`  — for each pool, the first height at which a tree root appeared. A root keeps its
//!   first height when later blocks leave the tree unchanged.
//! * `audits` — every comparison between a locally recomputed root and the root derived from the
//!   server's own tree state for the same block.
//! * `progress` — the last fully indexed height and the height indexing started from.

use std::path::Path;
use std::sync::{Arc, Mutex};

use alibi_core::Pool;
use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};

#[derive(Clone)]
pub struct Store {
    conn: Arc<Mutex<Connection>>,
}

#[derive(Clone, Debug)]
pub struct BlockRow {
    pub height: u32,
    pub hash: String,
    pub time: u32,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct Progress {
    pub start_height: u32,
    pub indexed_height: u32,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct AuditSummary {
    pub checks: u64,
    pub mismatches: u64,
    pub last_checked_height: Option<u32>,
}

#[derive(Debug)]
pub struct RootRow {
    pub pool: Pool,
    pub root: [u8; 32],
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path).with_context(|| format!("opening {}", path.display()))?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             CREATE TABLE IF NOT EXISTS blocks (
                network TEXT NOT NULL, height INTEGER NOT NULL, hash TEXT NOT NULL, time INTEGER NOT NULL,
                PRIMARY KEY (network, height));
             CREATE INDEX IF NOT EXISTS blocks_time ON blocks(network, time);
             CREATE TABLE IF NOT EXISTS roots (
                network TEXT NOT NULL, pool INTEGER NOT NULL, root BLOB NOT NULL, height INTEGER NOT NULL,
                PRIMARY KEY (network, pool, root));
             CREATE INDEX IF NOT EXISTS roots_height ON roots(network, height);
             CREATE TABLE IF NOT EXISTS audits (
                network TEXT NOT NULL, height INTEGER NOT NULL, pool INTEGER NOT NULL, ok INTEGER NOT NULL,
                computed BLOB NOT NULL, reported BLOB NOT NULL,
                PRIMARY KEY (network, height, pool));
             CREATE TABLE IF NOT EXISTS progress (
                network TEXT PRIMARY KEY, start_height INTEGER NOT NULL, indexed_height INTEGER NOT NULL);",
        )?;
        Ok(Self { conn: Arc::new(Mutex::new(conn)) })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().expect("store mutex poisoned")
    }

    pub fn progress(&self, network: &str) -> Result<Option<Progress>> {
        Ok(self
            .lock()
            .query_row(
                "SELECT start_height, indexed_height FROM progress WHERE network = ?1",
                params![network],
                |r| Ok(Progress { start_height: r.get(0)?, indexed_height: r.get(1)? }),
            )
            .optional()?)
    }

    /// Records the starting block of an index: its block row, the roots of every pool at that
    /// block, and the progress marker.
    pub fn init(&self, network: &str, block: &BlockRow, roots: &[RootRow]) -> Result<()> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT OR REPLACE INTO blocks (network, height, hash, time) VALUES (?1, ?2, ?3, ?4)",
            params![network, block.height, block.hash, block.time],
        )?;
        for r in roots {
            tx.execute(
                "INSERT OR IGNORE INTO roots (network, pool, root, height) VALUES (?1, ?2, ?3, ?4)",
                params![network, r.pool.code(), &r.root[..], block.height],
            )?;
        }
        tx.execute(
            "INSERT OR REPLACE INTO progress (network, start_height, indexed_height) VALUES (?1, ?2, ?2)",
            params![network, block.height],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Appends one batch of consecutive blocks atomically.
    pub fn append_batch(&self, network: &str, blocks: &[(BlockRow, Vec<RootRow>)]) -> Result<()> {
        if blocks.is_empty() {
            return Ok(());
        }
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        {
            let mut ins_block = tx.prepare_cached(
                "INSERT OR REPLACE INTO blocks (network, height, hash, time) VALUES (?1, ?2, ?3, ?4)",
            )?;
            let mut ins_root = tx.prepare_cached(
                "INSERT OR IGNORE INTO roots (network, pool, root, height) VALUES (?1, ?2, ?3, ?4)",
            )?;
            for (b, roots) in blocks {
                ins_block.execute(params![network, b.height, b.hash, b.time])?;
                for r in roots {
                    ins_root.execute(params![network, r.pool.code(), &r.root[..], b.height])?;
                }
            }
        }
        let last = blocks.last().unwrap().0.height;
        tx.execute("UPDATE progress SET indexed_height = ?2 WHERE network = ?1", params![network, last])?;
        tx.commit()?;
        Ok(())
    }

    /// Forgets everything at or above `height` (used when the chain reorganizes).
    pub fn rewind(&self, network: &str, height: u32) -> Result<()> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM blocks WHERE network = ?1 AND height >= ?2", params![network, height])?;
        tx.execute("DELETE FROM roots WHERE network = ?1 AND height >= ?2", params![network, height])?;
        tx.execute("DELETE FROM audits WHERE network = ?1 AND height >= ?2", params![network, height])?;
        tx.execute(
            "UPDATE progress SET indexed_height = MAX(start_height, ?2 - 1) WHERE network = ?1",
            params![network, height],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn record_audit(&self, network: &str, height: u32, pool: Pool, computed: &[u8; 32], reported: &[u8; 32]) -> Result<()> {
        self.lock().execute(
            "INSERT OR REPLACE INTO audits (network, height, pool, ok, computed, reported) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![network, height, pool.code(), (computed == reported) as i64, &computed[..], &reported[..]],
        )?;
        Ok(())
    }

    pub fn audit_summary(&self, network: &str) -> Result<AuditSummary> {
        Ok(self.lock().query_row(
            "SELECT COUNT(*), COALESCE(SUM(1 - ok), 0), MAX(height) FROM audits WHERE network = ?1",
            params![network],
            |r| Ok(AuditSummary { checks: r.get::<_, i64>(0)? as u64, mismatches: r.get::<_, i64>(1)? as u64, last_checked_height: r.get(2)? }),
        )?)
    }

    pub fn block(&self, network: &str, height: u32) -> Result<Option<BlockRow>> {
        Ok(self
            .lock()
            .query_row(
                "SELECT height, hash, time FROM blocks WHERE network = ?1 AND height = ?2",
                params![network, height],
                |r| Ok(BlockRow { height: r.get(0)?, hash: r.get(1)?, time: r.get(2)? }),
            )
            .optional()?)
    }

    /// First indexed block whose time is at or after `time`.
    pub fn first_block_at_or_after(&self, network: &str, time: u32) -> Result<Option<BlockRow>> {
        Ok(self
            .lock()
            .query_row(
                "SELECT height, hash, time FROM blocks WHERE network = ?1 AND time >= ?2 ORDER BY height LIMIT 1",
                params![network, time],
                |r| Ok(BlockRow { height: r.get(0)?, hash: r.get(1)?, time: r.get(2)? }),
            )
            .optional()?)
    }

    /// Height at which `root` first became the root of `pool`'s tree.
    pub fn root_height(&self, network: &str, pool: Pool, root: &[u8; 32]) -> Result<Option<u32>> {
        Ok(self
            .lock()
            .query_row(
                "SELECT height FROM roots WHERE network = ?1 AND pool = ?2 AND root = ?3",
                params![network, pool.code(), &root[..]],
                |r| r.get(0),
            )
            .optional()?)
    }

    /// The root of `pool` at the end of `height`: the root that first appeared at the greatest
    /// height not above `height`.
    pub fn root_at(&self, network: &str, pool: Pool, height: u32) -> Result<Option<([u8; 32], u32)>> {
        Ok(self
            .lock()
            .query_row(
                "SELECT root, height FROM roots WHERE network = ?1 AND pool = ?2 AND height <= ?3 ORDER BY height DESC LIMIT 1",
                params![network, pool.code(), height],
                |r| {
                    let v: Vec<u8> = r.get(0)?;
                    let mut out = [0u8; 32];
                    out.copy_from_slice(&v);
                    Ok((out, r.get(1)?))
                },
            )
            .optional()?)
    }

    pub fn root_counts(&self, network: &str) -> Result<Vec<(Pool, u64)>> {
        let conn = self.lock();
        let mut st = conn.prepare("SELECT pool, COUNT(*) FROM roots WHERE network = ?1 GROUP BY pool ORDER BY pool")?;
        let rows = st
            .query_map(params![network], |r| Ok((r.get::<_, u8>(0)?, r.get::<_, i64>(1)? as u64)))?
            .filter_map(|r| r.ok())
            .filter_map(|(p, n)| Pool::from_code(p).map(|p| (p, n)))
            .collect();
        Ok(rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store(tag: &str) -> Store {
        let p = std::env::temp_dir().join(format!("alibi-store-{tag}-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&p);
        Store::open(&p).unwrap()
    }

    fn block(h: u32, t: u32) -> BlockRow {
        BlockRow { height: h, hash: format!("{h:064x}"), time: t }
    }

    fn root(b: u8) -> [u8; 32] {
        [b; 32]
    }

    #[test]
    fn first_appearance_wins_and_root_at_follows_the_chain() {
        let s = temp_store("first");
        s.init("main", &block(100, 1000), &[RootRow { pool: Pool::Ironwood, root: root(1) }]).unwrap();
        s.append_batch(
            "main",
            &[
                (block(101, 1075), vec![]),
                (block(102, 1150), vec![RootRow { pool: Pool::Ironwood, root: root(2) }]),
                (block(103, 1225), vec![]),
            ],
        )
        .unwrap();
        assert_eq!(s.progress("main").unwrap().unwrap().indexed_height, 103);
        assert_eq!(s.root_height("main", Pool::Ironwood, &root(1)).unwrap(), Some(100));
        assert_eq!(s.root_height("main", Pool::Ironwood, &root(2)).unwrap(), Some(102));
        assert_eq!(s.root_at("main", Pool::Ironwood, 101).unwrap(), Some((root(1), 100)));
        assert_eq!(s.root_at("main", Pool::Ironwood, 103).unwrap(), Some((root(2), 102)));
        // A root never seen in another pool is not confused with this one.
        assert_eq!(s.root_height("main", Pool::Orchard, &root(2)).unwrap(), None);
        // Nor on another network.
        assert_eq!(s.root_height("test", Pool::Ironwood, &root(2)).unwrap(), None);
        assert_eq!(s.first_block_at_or_after("main", 1100).unwrap().unwrap().height, 102);
    }

    #[test]
    fn rewind_forgets_orphaned_roots() {
        let s = temp_store("rewind");
        s.init("main", &block(10, 0), &[RootRow { pool: Pool::Sapling, root: root(1) }]).unwrap();
        s.append_batch(
            "main",
            &[(block(11, 1), vec![RootRow { pool: Pool::Sapling, root: root(2) }]), (block(12, 2), vec![])],
        )
        .unwrap();
        s.rewind("main", 11).unwrap();
        assert_eq!(s.progress("main").unwrap().unwrap().indexed_height, 10);
        assert_eq!(s.root_height("main", Pool::Sapling, &root(2)).unwrap(), None);
        assert!(s.block("main", 11).unwrap().is_none());
        assert_eq!(s.root_height("main", Pool::Sapling, &root(1)).unwrap(), Some(10));
    }

    #[test]
    fn audits_count_mismatches() {
        let s = temp_store("audit");
        s.record_audit("main", 144, Pool::Ironwood, &root(1), &root(1)).unwrap();
        s.record_audit("main", 288, Pool::Ironwood, &root(1), &root(2)).unwrap();
        let a = s.audit_summary("main").unwrap();
        assert_eq!((a.checks, a.mismatches, a.last_checked_height), (2, 1, Some(288)));
    }
}
