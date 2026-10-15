//! Per-network settings.

use serde::Serialize;

/// The anchor retention grid ZIP 318 wallets keep checkpoints on: every multiple of 144 blocks
/// (about three hours). An alibi spend anchors to a boundary of this grid so that everyone
/// anchoring before the same cut-off shares one anchor.
pub const ANCHOR_GRID: u32 = 144;

#[derive(Clone, Debug, Serialize)]
pub struct NetworkConfig {
    /// `main` or `test`.
    pub name: String,
    pub lightwalletd: String,
    /// The index starts from the tree state at the end of this block.
    pub start_height: u32,
    /// Blocks this close to the tip are not indexed (they can still be reorganized away).
    pub confirmations: u32,
}

impl NetworkConfig {
    pub fn mainnet(lightwalletd: Option<String>, start: Option<u32>) -> Self {
        Self {
            name: "main".into(),
            lightwalletd: lightwalletd.unwrap_or_else(|| "https://zec.rocks:443".into()),
            // The block before NU6.3 (Ironwood) activated at 3,428,143.
            start_height: start.unwrap_or(3_428_142),
            confirmations: 10,
        }
    }

    pub fn testnet(lightwalletd: Option<String>, start: Option<u32>) -> Self {
        Self {
            name: "test".into(),
            lightwalletd: lightwalletd.unwrap_or_else(|| "https://testnet.zec.rocks:443".into()),
            // The block before NU6.3 activated on testnet at 4,134,000.
            start_height: start.unwrap_or(4_133_999),
            confirmations: 10,
        }
    }
}

/// The grid boundary an alibi spend for cut-off block `cutoff` anchors to: the greatest multiple
/// of [`ANCHOR_GRID`] strictly below `cutoff`.
pub fn boundary_before(cutoff: u32) -> Option<u32> {
    if cutoff == 0 {
        return None;
    }
    Some(((cutoff - 1) / ANCHOR_GRID) * ANCHOR_GRID)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boundary_is_strictly_before_the_cutoff() {
        assert_eq!(boundary_before(145), Some(144));
        assert_eq!(boundary_before(144), Some(0));
        assert_eq!(boundary_before(288), Some(144));
        assert_eq!(boundary_before(289), Some(288));
        assert_eq!(boundary_before(0), None);
    }
}
