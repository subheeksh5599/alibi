//! From located anchors to a verdict.
//!
//! The claim a transaction can support is: "every note this transaction spends from a shielded pool
//! was already in that pool when block `H` closed", where `H` is the latest of the heights its
//! anchors were located at. Given a cut-off block `I` (for example, the block that carried a
//! theft), the notes predate it exactly when `H < I`: the tree state at the end of block `I`
//! already includes the outputs created in block `I`.

use serde::Serialize;

use crate::pool::Pool;
use crate::tx::TxAnchors;

/// Where an anchor was found in chain history.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum AnchorLocation {
    /// The anchor is the pool's tree root at the end of `height`, and the root first appeared in
    /// that block (every later block that left the tree unchanged has the same root).
    Located { height: u32, block_hash: String, block_time: u32 },
    /// The anchor is not a root the locator knows. `reason` says what was searched.
    NotLocated { reason: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AnchorFinding {
    pub anchor: String,
    pub location: AnchorLocation,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PoolFinding {
    pub pool: Pool,
    pub spends: usize,
    pub anchors: Vec<AnchorFinding>,
    /// Latest located height across this pool's anchors, when all of them were located.
    pub existed_by: Option<u32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VerdictKind {
    /// Every shielded input existed before the cut-off and there are no transparent inputs.
    Predates,
    /// Every shielded input existed before the cut-off, but transparent inputs are present and
    /// are not covered by any anchor.
    PredatesShieldedOnly,
    /// The inputs are only known to exist by a block at or after the cut-off.
    DoesNotPredate,
    /// No cut-off was given: the verdict only reports the block the inputs existed by.
    Established,
    /// At least one anchor could not be located, so no claim is made.
    Unlocated,
    /// The transaction spends no shielded notes, so there is nothing to claim.
    NoShieldedInputs,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Coverage {
    /// Every input is a shielded spend covered by an anchor.
    AllInputs,
    /// Transparent inputs are present and not covered.
    ShieldedOnly,
    /// Nothing is covered.
    None,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Verdict {
    pub kind: VerdictKind,
    pub coverage: Coverage,
    /// Every covered input was in its pool at the end of this block.
    pub existed_by: Option<u32>,
    /// The cut-off block the claim was tested against, if any.
    pub cutoff: Option<u32>,
    pub findings: Vec<PoolFinding>,
    pub summary: String,
}

/// Evaluates a parsed transaction. `locate` resolves one anchor of one pool.
pub fn evaluate<F>(tx: &TxAnchors, mut locate: F, cutoff: Option<u32>) -> Verdict
where
    F: FnMut(Pool, &[u8; 32]) -> AnchorLocation,
{
    let mut findings = Vec::new();
    for p in tx.spending_pools() {
        let mut anchors = Vec::new();
        let mut latest: Option<u32> = Some(0);
        for (hex, bytes) in p.anchors.iter().zip(p.anchor_bytes()) {
            let location = locate(p.pool, &bytes);
            latest = match (&location, latest) {
                (AnchorLocation::Located { height, .. }, Some(l)) => Some(l.max(*height)),
                _ => None,
            };
            anchors.push(AnchorFinding { anchor: hex.clone(), location });
        }
        findings.push(PoolFinding { pool: p.pool, spends: p.spends, anchors, existed_by: latest });
    }

    let coverage = if findings.is_empty() {
        Coverage::None
    } else if tx.transparent_inputs > 0 {
        Coverage::ShieldedOnly
    } else {
        Coverage::AllInputs
    };

    if findings.is_empty() {
        let summary = if tx.is_coinbase {
            "Coinbase transaction: it creates new coins and spends no shielded notes.".to_string()
        } else if tx.transparent_inputs > 0 {
            format!(
                "This transaction spends only transparent inputs ({}); their history is already public and no anchor covers them.",
                tx.transparent_inputs
            )
        } else {
            "This transaction spends no shielded notes.".to_string()
        };
        return Verdict { kind: VerdictKind::NoShieldedInputs, coverage, existed_by: None, cutoff, findings, summary };
    }

    let unlocated: Vec<Pool> = findings.iter().filter(|f| f.existed_by.is_none()).map(|f| f.pool).collect();
    if !unlocated.is_empty() {
        let pools = unlocated.iter().map(|p| p.as_str()).collect::<Vec<_>>().join(", ");
        let summary = format!(
            "The {pools} anchor could not be located in the indexed chain history, so no claim is made about when those inputs entered the pool."
        );
        return Verdict { kind: VerdictKind::Unlocated, coverage, existed_by: None, cutoff, findings, summary };
    }

    let existed_by = findings.iter().filter_map(|f| f.existed_by).max().expect("non-empty, all located");
    let transparent_note = if tx.transparent_inputs > 0 {
        format!(" {} transparent input(s) are not covered.", tx.transparent_inputs)
    } else {
        String::new()
    };

    let (kind, summary) = match cutoff {
        None => (
            VerdictKind::Established,
            format!("Every shielded input was already in its pool at the end of block {existed_by}.{transparent_note}"),
        ),
        Some(i) if existed_by < i => {
            let kind = if tx.transparent_inputs > 0 { VerdictKind::PredatesShieldedOnly } else { VerdictKind::Predates };
            (
                kind,
                format!(
                    "Every shielded input was already in its pool at the end of block {existed_by}, before block {i}. None of them can be value created in block {i} or later.{transparent_note}"
                ),
            )
        }
        Some(i) => (
            VerdictKind::DoesNotPredate,
            format!(
                "The inputs are only shown to exist by the end of block {existed_by}, which is not before block {i}. This is not evidence of wrongdoing: the transaction simply makes no claim about block {i}."
            ),
        ),
    };

    Verdict { kind, coverage, existed_by: Some(existed_by), cutoff, findings, summary }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tx::PoolSpends;

    fn tx(pools: Vec<PoolSpends>, transparent_inputs: usize) -> TxAnchors {
        TxAnchors {
            txid: "00".repeat(32),
            version: 6,
            branch_id: Some("37a5165b".into()),
            expiry_height: 0,
            transparent_inputs,
            transparent_outputs: 0,
            is_coinbase: false,
            pools,
        }
    }

    fn spend(pool: Pool, anchor_byte: u8) -> PoolSpends {
        PoolSpends { pool, spends: 2, outputs: 2, anchors: vec![hex::encode([anchor_byte; 32])] }
    }

    fn at(height: u32) -> AnchorLocation {
        AnchorLocation::Located { height, block_hash: "ab".repeat(32), block_time: 0 }
    }

    #[test]
    fn strictly_before_the_cutoff_predates() {
        let t = tx(vec![spend(Pool::Ironwood, 1)], 0);
        let v = evaluate(&t, |_, _| at(99), Some(100));
        assert_eq!(v.kind, VerdictKind::Predates);
        assert_eq!(v.existed_by, Some(99));
        assert_eq!(v.coverage, Coverage::AllInputs);
    }

    #[test]
    fn anchor_at_the_cutoff_block_does_not_predate() {
        // The root at the end of block I already contains notes created in block I.
        let t = tx(vec![spend(Pool::Ironwood, 1)], 0);
        let v = evaluate(&t, |_, _| at(100), Some(100));
        assert_eq!(v.kind, VerdictKind::DoesNotPredate);
    }

    #[test]
    fn latest_anchor_across_pools_decides() {
        let t = tx(vec![spend(Pool::Sapling, 1), spend(Pool::Ironwood, 2)], 0);
        let v = evaluate(&t, |p, _| if p == Pool::Sapling { at(10) } else { at(150) }, Some(100));
        assert_eq!(v.kind, VerdictKind::DoesNotPredate);
        assert_eq!(v.existed_by, Some(150));
    }

    #[test]
    fn one_unlocated_anchor_withdraws_the_claim() {
        let t = tx(vec![spend(Pool::Sapling, 1), spend(Pool::Ironwood, 2)], 0);
        let v = evaluate(
            &t,
            |p, _| if p == Pool::Sapling { at(10) } else { AnchorLocation::NotLocated { reason: "x".into() } },
            Some(100),
        );
        assert_eq!(v.kind, VerdictKind::Unlocated);
        assert_eq!(v.existed_by, None);
    }

    #[test]
    fn transparent_inputs_are_flagged_not_covered() {
        let t = tx(vec![spend(Pool::Ironwood, 1)], 3);
        let v = evaluate(&t, |_, _| at(5), Some(100));
        assert_eq!(v.kind, VerdictKind::PredatesShieldedOnly);
        assert_eq!(v.coverage, Coverage::ShieldedOnly);
        assert!(v.summary.contains("3 transparent input"));
    }

    #[test]
    fn outputs_only_make_no_claim() {
        let mut p = spend(Pool::Ironwood, 1);
        p.spends = 0;
        p.anchors.clear();
        let t = tx(vec![p], 1);
        let v = evaluate(&t, |_, _| unreachable!("nothing to locate"), Some(100));
        assert_eq!(v.kind, VerdictKind::NoShieldedInputs);
    }

    #[test]
    fn no_cutoff_only_establishes() {
        let t = tx(vec![spend(Pool::Orchard, 1)], 0);
        let v = evaluate(&t, |_, _| at(42), None);
        assert_eq!(v.kind, VerdictKind::Established);
        assert_eq!(v.existed_by, Some(42));
    }
}
