//! Reading anchors out of raw transaction bytes.

use serde::Serialize;
use zcash_primitives::transaction::{Transaction, TxVersion};
use zcash_protocol::consensus::BranchId;

use crate::pool::Pool;

#[derive(Debug, thiserror::Error)]
pub enum TxError {
    #[error("transaction bytes could not be parsed: {0}")]
    Parse(#[from] std::io::Error),
    #[error("{0} trailing bytes after the transaction")]
    Trailing(usize),
}

/// What one pool contributes to a transaction.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PoolSpends {
    pub pool: Pool,
    /// Number of spend slots. For Orchard-protocol pools this is the number of actions when the
    /// bundle enables spends; padding actions spend zero-value dummy notes and are counted here
    /// because they cannot be told apart from the outside.
    pub spends: usize,
    /// Number of new notes the transaction creates in this pool.
    pub outputs: usize,
    /// Every distinct anchor the pool's spends commit to, as serialized in the transaction
    /// (little-endian field element bytes, hex). Version 5 and later transactions carry one anchor
    /// per pool; version 4 Sapling spends each carry their own.
    pub anchors: Vec<String>,
}

impl PoolSpends {
    pub fn anchor_bytes(&self) -> Vec<[u8; 32]> {
        self.anchors
            .iter()
            .map(|h| {
                let mut out = [0u8; 32];
                hex::decode_to_slice(h, &mut out).expect("anchors are produced as 32-byte hex");
                out
            })
            .collect()
    }
}

/// Everything about a transaction that an anchor claim depends on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TxAnchors {
    /// Transaction id in the usual display (byte-reversed) order.
    pub txid: String,
    pub version: u32,
    /// Hex of the consensus branch id the transaction commits to (v5 and later).
    pub branch_id: Option<String>,
    pub expiry_height: u32,
    /// Transparent inputs are public and not covered by an anchor claim.
    pub transparent_inputs: usize,
    pub transparent_outputs: usize,
    pub is_coinbase: bool,
    /// Pools in which the transaction spends or creates notes, in protocol order.
    pub pools: Vec<PoolSpends>,
}

impl TxAnchors {
    /// Pools whose spends the claim has to cover.
    pub fn spending_pools(&self) -> impl Iterator<Item = &PoolSpends> {
        self.pools.iter().filter(|p| p.spends > 0)
    }
}

fn hex32(bytes: [u8; 32]) -> String {
    hex::encode(bytes)
}

fn version_number(v: TxVersion) -> u32 {
    match v {
        TxVersion::Sprout(n) => n,
        TxVersion::V3 => 3,
        TxVersion::V4 => 4,
        TxVersion::V5 => 5,
        TxVersion::V6 => 6,
    }
}

fn orchard_like(pool: Pool, bundle: &orchard::Bundle<orchard::bundle::Authorized, zcash_protocol::value::ZatBalance>) -> PoolSpends {
    let actions = bundle.actions().len();
    let spends = if bundle.flags().spends_enabled() { actions } else { 0 };
    let outputs = if bundle.flags().outputs_enabled() { actions } else { 0 };
    PoolSpends {
        pool,
        spends,
        outputs,
        anchors: if spends > 0 { vec![hex32(bundle.anchor().to_bytes())] } else { vec![] },
    }
}

/// Parses a serialized transaction (any version from 4 up to 6) and extracts its anchors.
pub fn parse_transaction(raw: &[u8]) -> Result<TxAnchors, TxError> {
    let mut cursor = std::io::Cursor::new(raw);
    // The branch id argument is only consulted for pre-v5 transactions, whose encoding is the same
    // for every branch from Sapling onward.
    let tx = Transaction::read(&mut cursor, BranchId::Nu6_3)?;
    let consumed = cursor.position() as usize;
    if consumed != raw.len() {
        return Err(TxError::Trailing(raw.len() - consumed));
    }

    let version = version_number(tx.version());
    let mut pools = Vec::new();

    if let Some(bundle) = tx.sapling_bundle() {
        let mut anchors: Vec<String> = Vec::new();
        for spend in bundle.shielded_spends() {
            let a = hex32(spend.anchor().to_bytes());
            if !anchors.contains(&a) {
                anchors.push(a);
            }
        }
        let spends = bundle.shielded_spends().len();
        let outputs = bundle.shielded_outputs().len();
        if spends + outputs > 0 {
            pools.push(PoolSpends { pool: Pool::Sapling, spends, outputs, anchors });
        }
    }
    if let Some(bundle) = tx.orchard_bundle() {
        pools.push(orchard_like(Pool::Orchard, bundle));
    }
    if let Some(bundle) = tx.ironwood_bundle() {
        pools.push(orchard_like(Pool::Ironwood, bundle));
    }

    let (transparent_inputs, transparent_outputs, is_coinbase) = match tx.transparent_bundle() {
        Some(b) => (b.vin.len(), b.vout.len(), b.is_coinbase()),
        None => (0, 0, false),
    };

    let branch_id = if version >= 5 {
        Some(format!("{:08x}", u32::from(tx.consensus_branch_id())))
    } else {
        None
    };

    Ok(TxAnchors {
        txid: tx.txid().to_string(),
        version,
        branch_id,
        expiry_height: u32::from(tx.expiry_height()),
        transparent_inputs: if is_coinbase { 0 } else { transparent_inputs },
        transparent_outputs,
        is_coinbase,
        pools,
    })
}
