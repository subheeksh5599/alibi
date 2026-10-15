//! Verification: fetch a transaction, locate its anchors, evaluate the claim.

use std::collections::HashMap;
use std::sync::Arc;

use alibi_core::{evaluate, parse_transaction, root_from_tree_state, AnchorLocation, Pool, TxAnchors, Verdict};
use serde::Serialize;
use tokio::sync::Semaphore;

use crate::lwd::{FetchTxError, Lightwalletd, Mined};
use crate::network::{boundary_before, NetworkConfig, ANCHOR_GRID};
use crate::store::{AuditSummary, Progress, Store};

/// How many unindexed blocks below a transaction the verifier will scan for its anchor.
const NEAR_TIP_SCAN: u32 = 40;

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Unprocessable(String),
    #[error("{0}")]
    Unavailable(String),
    #[error("{0}")]
    Upstream(String),
}

impl ApiError {
    pub fn code(&self) -> &'static str {
        match self {
            ApiError::BadRequest(_) => "bad_request",
            ApiError::NotFound(_) => "not_found",
            ApiError::Unprocessable(_) => "unprocessable",
            ApiError::Unavailable(_) => "index_not_ready",
            ApiError::Upstream(_) => "upstream_error",
        }
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        ApiError::Upstream(format!("{e:#}"))
    }
}

pub struct Net {
    pub cfg: NetworkConfig,
    pub lwd: Lightwalletd,
}

#[derive(Clone)]
pub struct Verifier {
    pub store: Store,
    pub nets: Arc<HashMap<String, Net>>,
    upstream: Arc<Semaphore>,
}

#[derive(Clone, Debug, Serialize)]
pub struct BlockRef {
    pub height: u32,
    pub hash: String,
    pub time: u32,
}

#[derive(Clone, Debug, Serialize)]
pub struct Cutoff {
    /// What the caller passed.
    pub input: String,
    /// Block `I`: inputs predate the cut-off when they existed by a block strictly below it.
    pub height: u32,
    pub time: Option<u32>,
    /// `height` when given as a number, `date` when resolved from a timestamp.
    pub resolved_by: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TxStatus {
    Mined,
    Mempool,
    NotInBestChain,
}

#[derive(Clone, Debug, Serialize)]
pub struct IndexState {
    pub start_height: u32,
    pub indexed_height: u32,
}

#[derive(Clone, Debug, Serialize)]
pub struct TxReport {
    pub network: String,
    pub txid: String,
    pub status: TxStatus,
    pub mined: Option<BlockRef>,
    pub cutoff: Option<Cutoff>,
    pub transaction: TxAnchors,
    pub verdict: Verdict,
    pub index: IndexState,
    pub source: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct PoolRoot {
    pub pool: Pool,
    /// Root at the end of the checkpoint block, as a transaction serializes its anchor.
    pub root: String,
    /// The block at which this root first appeared.
    pub since_height: u32,
}

#[derive(Clone, Debug, Serialize)]
pub struct Checkpoint {
    pub network: String,
    pub cutoff: Cutoff,
    /// The anchor-grid boundary strictly below the cut-off.
    pub height: u32,
    pub block: BlockRef,
    pub grid: u32,
    pub roots: Vec<PoolRoot>,
}

#[derive(Clone, Debug, Serialize)]
pub struct NetHealth {
    pub network: String,
    pub lightwalletd: String,
    /// Blocks this close to the tip are left out of the index.
    pub confirmations: u32,
    pub chain_tip: Option<u32>,
    pub index: Option<Progress>,
    pub lag_blocks: Option<u32>,
    pub roots_indexed: HashMap<String, u64>,
    pub audits: AuditSummary,
}

#[derive(Clone, Debug, Serialize)]
pub struct AnchorReport {
    pub network: String,
    pub pool: Pool,
    pub anchor: String,
    pub location: AnchorLocation,
}

/// Parses `YYYY-MM-DD`, `YYYY-MM-DDTHH:MM` or `YYYY-MM-DDTHH:MM:SS`, optionally ending in `Z`,
/// as UTC. Returns Unix seconds.
pub fn parse_utc(s: &str) -> Option<i64> {
    let s = s.trim().trim_end_matches('Z').trim_end_matches('z');
    let (date, time) = match s.split_once(['T', ' ']) {
        Some((d, t)) => (d, Some(t)),
        None => (s, None),
    };
    let mut dp = date.split('-');
    let y: i64 = dp.next()?.parse().ok()?;
    let m: i64 = dp.next()?.parse().ok()?;
    let d: i64 = dp.next()?.parse().ok()?;
    if dp.next().is_some() || !(1..=12).contains(&m) || !(1..=31).contains(&d) || !(1970..=9999).contains(&y) {
        return None;
    }
    let (hh, mm, ss) = match time {
        None => (0, 0, 0),
        Some(t) => {
            let mut tp = t.split(':');
            let hh: i64 = tp.next()?.parse().ok()?;
            let mm: i64 = tp.next()?.parse().ok()?;
            let ss: i64 = match tp.next() {
                Some(v) => v.parse().ok()?,
                None => 0,
            };
            if tp.next().is_some() || hh > 23 || mm > 59 || ss > 60 {
                return None;
            }
            (hh, mm, ss)
        }
    };
    // Days from civil (Howard Hinnant).
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = if y2 >= 0 { y2 } else { y2 - 399 } / 400;
    let yoe = y2 - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(days * 86400 + hh * 3600 + mm * 60 + ss)
}

pub fn parse_txid(s: &str) -> Result<[u8; 32], ApiError> {
    let s = s.trim();
    let mut out = [0u8; 32];
    if s.len() != 64 || hex::decode_to_slice(s, &mut out).is_err() {
        return Err(ApiError::BadRequest("txid must be 64 hex characters".into()));
    }
    Ok(out)
}

impl Verifier {
    pub fn new(store: Store, nets: HashMap<String, Net>) -> Self {
        Self { store, nets: Arc::new(nets), upstream: Arc::new(Semaphore::new(8)) }
    }

    pub fn net(&self, name: &str) -> Result<&Net, ApiError> {
        self.nets.get(name).ok_or_else(|| {
            let known: Vec<&str> = self.nets.keys().map(|s| s.as_str()).collect();
            ApiError::BadRequest(format!("unknown network `{name}`; this server serves {}", known.join(", ")))
        })
    }

    fn progress(&self, net: &str) -> Result<Progress, ApiError> {
        self.store
            .progress(net)
            .map_err(ApiError::from)?
            .ok_or_else(|| ApiError::Unavailable(format!("the {net} index has not started yet")))
    }

    fn block_ref(&self, net: &str, height: u32) -> Result<Option<BlockRef>, ApiError> {
        Ok(self.store.block(net, height)?.map(|b| BlockRef { height: b.height, hash: b.hash, time: b.time }))
    }

    pub fn resolve_cutoff(&self, net: &str, before: &str) -> Result<Cutoff, ApiError> {
        let input = before.trim().to_string();
        if !input.is_empty() && input.chars().all(|c| c.is_ascii_digit()) {
            let height: u32 = input.parse().map_err(|_| ApiError::BadRequest("cut-off height is too large".into()))?;
            if height == 0 {
                return Err(ApiError::BadRequest("cut-off height must be above 0".into()));
            }
            let time = self.store.block(net, height)?.map(|b| b.time);
            return Ok(Cutoff { input, height, time, resolved_by: "height" });
        }
        let t = parse_utc(&input).ok_or_else(|| {
            ApiError::BadRequest("`before` must be a block height or a UTC date such as 2026-09-24 or 2026-09-24T18:30Z".into())
        })?;
        if t < 0 || t > u32::MAX as i64 {
            return Err(ApiError::BadRequest("date out of range".into()));
        }
        let p = self.progress(net)?;
        let start = self.store.block(net, p.start_height)?.ok_or_else(|| ApiError::Unavailable("index start block missing".into()))?;
        if (t as u32) <= start.time {
            return Err(ApiError::Unprocessable(format!(
                "{input} is not after the first indexed block ({} at unix time {}); use a block height instead",
                start.height, start.time
            )));
        }
        match self.store.first_block_at_or_after(net, t as u32)? {
            Some(b) => Ok(Cutoff { input, height: b.height, time: Some(b.time), resolved_by: "date" }),
            None => Err(ApiError::Unprocessable(format!(
                "{input} is later than the last indexed block ({}); the cut-off cannot be resolved yet",
                p.indexed_height
            ))),
        }
    }

    /// Finds the first block whose `pool` tree root equals `root`.
    pub async fn locate(&self, net: &str, pool: Pool, root: &[u8; 32], below: Option<u32>) -> Result<AnchorLocation, ApiError> {
        let p = self.progress(net)?;
        if let Some(h) = self.store.root_height(net, pool, root)? {
            let b = self.block_ref(net, h)?.ok_or_else(|| ApiError::Upstream(format!("indexed root at {h} has no block row")))?;
            return Ok(AnchorLocation::Located { height: b.height, block_hash: b.hash, block_time: b.time });
        }
        // Not indexed: scan the few blocks between the index and the transaction, if any.
        let n = self.net(net)?;
        let upper = match below {
            Some(m) => m.saturating_sub(1),
            None => n.lwd.latest_height().await?,
        };
        let mut scanned = None;
        if upper > p.indexed_height {
            let from = (p.indexed_height + 1).max(upper.saturating_sub(NEAR_TIP_SCAN - 1));
            let _permit = self.upstream.acquire().await.expect("semaphore open");
            for h in from..=upper {
                let ts = n.lwd.tree_state(h).await?;
                let tree = match pool {
                    Pool::Sapling => &ts.sapling_tree,
                    Pool::Orchard => &ts.orchard_tree,
                    Pool::Ironwood => &ts.ironwood_tree,
                };
                let r = root_from_tree_state(pool, tree).map_err(|e| ApiError::Upstream(e.to_string()))?;
                if &r == root {
                    return Ok(AnchorLocation::Located { height: h, block_hash: ts.hash, block_time: ts.time });
                }
            }
            scanned = Some((from, upper));
        }
        let mut reason = format!(
            "not the {pool} tree root at the end of any indexed block ({} to {})",
            p.start_height, p.indexed_height
        );
        if let Some((a, b)) = scanned {
            reason.push_str(&format!(" or of blocks {a} to {b}"));
        }
        reason.push_str(&format!(
            ". An anchor older than block {} is outside this index and is not evaluated.",
            p.start_height
        ));
        Ok(AnchorLocation::NotLocated { reason })
    }

    async fn report(
        &self,
        net: &str,
        raw: &[u8],
        status: TxStatus,
        mined: Option<BlockRef>,
        before: Option<&str>,
    ) -> Result<TxReport, ApiError> {
        let n = self.net(net)?;
        let tx = parse_transaction(raw).map_err(|e| ApiError::Unprocessable(e.to_string()))?;
        let cutoff = match before {
            Some(b) if !b.trim().is_empty() => Some(self.resolve_cutoff(net, b)?),
            _ => None,
        };
        let below = mined.as_ref().map(|m| m.height);
        let mut located: HashMap<(Pool, [u8; 32]), AnchorLocation> = HashMap::new();
        for p in tx.spending_pools() {
            for a in p.anchor_bytes() {
                if !located.contains_key(&(p.pool, a)) {
                    let loc = self.locate(net, p.pool, &a, below).await?;
                    located.insert((p.pool, a), loc);
                }
            }
        }
        let verdict = evaluate(&tx, |pool, a| located[&(pool, *a)].clone(), cutoff.as_ref().map(|c| c.height));
        let p = self.progress(net)?;
        Ok(TxReport {
            network: net.to_string(),
            txid: tx.txid.clone(),
            status,
            mined,
            cutoff,
            transaction: tx,
            verdict,
            index: IndexState { start_height: p.start_height, indexed_height: p.indexed_height },
            source: n.lwd.url.clone(),
        })
    }

    pub async fn verify_txid(&self, net: &str, txid: &str, before: Option<&str>) -> Result<TxReport, ApiError> {
        let id = parse_txid(txid)?;
        let n = self.net(net)?;
        self.progress(net)?;
        let fetched = {
            let _permit = self.upstream.acquire().await.expect("semaphore open");
            n.lwd.transaction(&id).await
        };
        let (raw, mined) = match fetched {
            Ok(v) => v,
            Err(FetchTxError::NotFound) => {
                return Err(ApiError::NotFound(format!("transaction {txid} is not known to the {net} network's lightwalletd")))
            }
            Err(FetchTxError::Other(e)) => return Err(e.into()),
        };
        let (status, block) = match mined {
            Mined::At(h) => {
                let b = match self.block_ref(net, h)? {
                    Some(b) => b,
                    None => {
                        let cb = n.lwd.block(h).await?;
                        let mut hash = cb.hash.clone();
                        hash.reverse();
                        BlockRef { height: h, hash: hex::encode(hash), time: cb.time }
                    }
                };
                (TxStatus::Mined, Some(b))
            }
            Mined::Unmined => (TxStatus::Mempool, None),
            Mined::NotInBestChain => (TxStatus::NotInBestChain, None),
        };
        let report = self.report(net, &raw, status, block, before).await?;
        if !report.txid.eq_ignore_ascii_case(txid.trim()) {
            return Err(ApiError::Upstream(format!(
                "server returned a transaction whose id is {}, not {txid}",
                report.txid
            )));
        }
        Ok(report)
    }

    /// Verifies a transaction the caller holds as raw bytes.
    ///
    /// The submitted bytes are only used to compute the transaction id. Everything after that is
    /// read from the network: an anchor proves nothing until the spend proof that commits to it has
    /// been checked, and only the network (mempool admission or a mined block) checks it. Bytes the
    /// network has never seen are refused instead of evaluated.
    pub async fn verify_raw(&self, net: &str, hex_tx: &str, before: Option<&str>) -> Result<TxReport, ApiError> {
        let raw = hex::decode(hex_tx.trim()).map_err(|_| ApiError::BadRequest("`hex` must be the transaction in hex".into()))?;
        if raw.is_empty() || raw.len() > 2_000_000 {
            return Err(ApiError::BadRequest("transaction must be between 1 byte and 2 MB".into()));
        }
        let submitted = parse_transaction(&raw).map_err(|e| ApiError::Unprocessable(e.to_string()))?;
        match self.verify_txid(net, &submitted.txid, before).await {
            Err(ApiError::NotFound(_)) => Err(ApiError::Unprocessable(format!(
                "transaction {} is not in the {net} mempool or chain. Its proofs have not been checked by the network, so its anchors prove nothing yet; broadcast it first.",
                submitted.txid
            ))),
            Ok(report) => {
                if report.transaction.pools != submitted.pools {
                    return Err(ApiError::Unprocessable(format!(
                        "the network's copy of {} commits to different shielded data than the submitted bytes",
                        submitted.txid
                    )));
                }
                Ok(report)
            }
            Err(e) => Err(e),
        }
    }

    pub async fn anchor(&self, net: &str, pool: Pool, anchor_hex: &str) -> Result<AnchorReport, ApiError> {
        let mut a = [0u8; 32];
        hex::decode_to_slice(anchor_hex.trim(), &mut a)
            .map_err(|_| ApiError::BadRequest("anchor must be 64 hex characters, in transaction byte order".into()))?;
        let location = self.locate(net, pool, &a, None).await?;
        Ok(AnchorReport { network: net.to_string(), pool, anchor: hex::encode(a), location })
    }

    pub fn checkpoint(&self, net: &str, before: &str) -> Result<Checkpoint, ApiError> {
        self.net(net)?;
        let cutoff = self.resolve_cutoff(net, before)?;
        let p = self.progress(net)?;
        let height = boundary_before(cutoff.height).ok_or_else(|| ApiError::BadRequest("cut-off must be above block 0".into()))?;
        if height < p.start_height {
            return Err(ApiError::Unprocessable(format!(
                "the grid boundary before {} is block {height}, which is before the index start ({})",
                cutoff.height, p.start_height
            )));
        }
        if height > p.indexed_height {
            return Err(ApiError::Unavailable(format!(
                "block {height} is not indexed yet (indexed to {})",
                p.indexed_height
            )));
        }
        let block = self.block_ref(net, height)?.ok_or_else(|| ApiError::Upstream(format!("no block row at {height}")))?;
        let mut roots = Vec::new();
        for pool in Pool::ALL {
            if let Some((root, since)) = self.store.root_at(net, pool, height)? {
                roots.push(PoolRoot { pool, root: hex::encode(root), since_height: since });
            }
        }
        Ok(Checkpoint { network: net.to_string(), cutoff, height, block, grid: ANCHOR_GRID, roots })
    }

    pub async fn health(&self) -> Vec<NetHealth> {
        let mut out = Vec::new();
        let mut names: Vec<&String> = self.nets.keys().collect();
        names.sort();
        for name in names {
            let n = &self.nets[name];
            let tip = n.lwd.latest_height().await.ok();
            let index = self.store.progress(name).ok().flatten();
            let lag = match (&index, tip) {
                (Some(p), Some(t)) => Some(t.saturating_sub(p.indexed_height)),
                _ => None,
            };
            let roots_indexed = self
                .store
                .root_counts(name)
                .unwrap_or_default()
                .into_iter()
                .map(|(p, c)| (p.as_str().to_string(), c))
                .collect();
            let audits = self
                .store
                .audit_summary(name)
                .unwrap_or(AuditSummary { checks: 0, mismatches: 0, last_checked_height: None });
            out.push(NetHealth {
                network: name.clone(),
                lightwalletd: n.lwd.url.clone(),
                confirmations: n.cfg.confirmations,
                chain_tip: tip,
                index,
                lag_blocks: lag,
                roots_indexed,
                audits,
            });
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utc_parsing() {
        assert_eq!(parse_utc("1970-01-01"), Some(0));
        assert_eq!(parse_utc("2026-09-24"), Some(1_790_208_000));
        assert_eq!(parse_utc("2026-09-24T18:30Z"), Some(1_790_208_000 + 18 * 3600 + 30 * 60));
        assert_eq!(parse_utc("2026-09-24T18:30:15"), Some(1_790_208_000 + 18 * 3600 + 30 * 60 + 15));
        assert_eq!(parse_utc("2024-02-29"), Some(1_709_164_800));
        assert_eq!(parse_utc("2026-13-01"), None);
        assert_eq!(parse_utc("yesterday"), None);
        assert_eq!(parse_utc("2026-09-24T25:00"), None);
    }

    #[test]
    fn txid_validation() {
        assert!(parse_txid(&"ab".repeat(32)).is_ok());
        assert!(parse_txid("abc").is_err());
        assert!(parse_txid(&"zz".repeat(32)).is_err());
    }
}
