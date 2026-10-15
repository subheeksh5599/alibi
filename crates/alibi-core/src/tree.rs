//! Note commitment tree roots.
//!
//! Sapling uses a Pedersen-hash tree over Jubjub; Orchard and Ironwood both use the Sinsemilla
//! tree over Pallas (Ironwood reuses the Orchard action and tree construction but keeps a separate
//! tree). All three have depth 32.

use incrementalmerkletree::frontier::{CommitmentTree, Frontier};
use orchard::tree::MerkleHashOrchard;
use zcash_primitives::merkle_tree::read_commitment_tree;

use crate::pool::Pool;

pub const TREE_DEPTH: u8 = 32;

#[derive(Debug, thiserror::Error)]
pub enum TreeError {
    #[error("tree state is not valid hex: {0}")]
    Hex(#[from] hex::FromHexError),
    #[error("tree state could not be decoded: {0}")]
    Decode(#[from] std::io::Error),
    #[error("{0} commitment is not a valid field element")]
    BadLeaf(Pool),
    #[error("{0} tree is full")]
    Full(Pool),
}

fn sapling_leaf(bytes: &[u8; 32]) -> Option<sapling::Node> {
    Option::from(sapling::Node::from_bytes(*bytes))
}

fn orchard_leaf(bytes: &[u8; 32]) -> Option<MerkleHashOrchard> {
    Option::from(MerkleHashOrchard::from_bytes(bytes))
}

/// Computes the root of a pool's tree from the legacy serialized `CommitmentTree` that
/// lightwalletd returns in `TreeState` (hex). An empty string is the empty tree.
///
/// The returned bytes are in the order a transaction serializes its anchor.
pub fn root_from_tree_state(pool: Pool, tree_hex: &str) -> Result<[u8; 32], TreeError> {
    let bytes = hex::decode(tree_hex.trim())?;
    Ok(match pool {
        Pool::Sapling => {
            let tree: CommitmentTree<sapling::Node, TREE_DEPTH> = if bytes.is_empty() {
                CommitmentTree::empty()
            } else {
                read_commitment_tree(&bytes[..])?
            };
            tree.root().to_bytes()
        }
        Pool::Orchard | Pool::Ironwood => {
            let tree: CommitmentTree<MerkleHashOrchard, TREE_DEPTH> = if bytes.is_empty() {
                CommitmentTree::empty()
            } else {
                read_commitment_tree(&bytes[..])?
            };
            tree.root().to_bytes()
        }
    })
}

/// Number of leaves in a serialized tree state.
pub fn size_from_tree_state(pool: Pool, tree_hex: &str) -> Result<u64, TreeError> {
    let bytes = hex::decode(tree_hex.trim())?;
    if bytes.is_empty() {
        return Ok(0);
    }
    Ok(match pool {
        Pool::Sapling => {
            let t: CommitmentTree<sapling::Node, TREE_DEPTH> = read_commitment_tree(&bytes[..])?;
            t.size() as u64
        }
        Pool::Orchard | Pool::Ironwood => {
            let t: CommitmentTree<MerkleHashOrchard, TREE_DEPTH> = read_commitment_tree(&bytes[..])?;
            t.size() as u64
        }
    })
}

/// An append-only view of one pool's tree: enough to follow the chain block by block and
/// recompute the root after every block without trusting anyone's reported root.
#[derive(Clone, Debug)]
pub enum PoolTree {
    Sapling(Frontier<sapling::Node, TREE_DEPTH>),
    Orchard(Pool, Frontier<MerkleHashOrchard, TREE_DEPTH>),
}

impl PoolTree {
    pub fn empty(pool: Pool) -> Self {
        match pool {
            Pool::Sapling => PoolTree::Sapling(Frontier::empty()),
            p => PoolTree::Orchard(p, Frontier::empty()),
        }
    }

    /// Starts from a serialized tree state, as returned by lightwalletd for some height.
    pub fn from_tree_state(pool: Pool, tree_hex: &str) -> Result<Self, TreeError> {
        let bytes = hex::decode(tree_hex.trim())?;
        if bytes.is_empty() {
            return Ok(Self::empty(pool));
        }
        Ok(match pool {
            Pool::Sapling => {
                let t: CommitmentTree<sapling::Node, TREE_DEPTH> = read_commitment_tree(&bytes[..])?;
                PoolTree::Sapling(t.to_frontier())
            }
            p => {
                let t: CommitmentTree<MerkleHashOrchard, TREE_DEPTH> = read_commitment_tree(&bytes[..])?;
                PoolTree::Orchard(p, t.to_frontier())
            }
        })
    }

    pub fn pool(&self) -> Pool {
        match self {
            PoolTree::Sapling(_) => Pool::Sapling,
            PoolTree::Orchard(p, _) => *p,
        }
    }

    /// Appends one note commitment (Sapling `cmu` or Orchard-protocol `cmx`, as serialized).
    pub fn append(&mut self, commitment: &[u8; 32]) -> Result<(), TreeError> {
        let pool = self.pool();
        let ok = match self {
            PoolTree::Sapling(f) => {
                let leaf = sapling_leaf(commitment).ok_or(TreeError::BadLeaf(pool))?;
                f.append(leaf)
            }
            PoolTree::Orchard(_, f) => {
                let leaf = orchard_leaf(commitment).ok_or(TreeError::BadLeaf(pool))?;
                f.append(leaf)
            }
        };
        if ok {
            Ok(())
        } else {
            Err(TreeError::Full(pool))
        }
    }

    pub fn size(&self) -> u64 {
        match self {
            PoolTree::Sapling(f) => f.tree_size(),
            PoolTree::Orchard(_, f) => f.tree_size(),
        }
    }

    /// Root in transaction-anchor byte order.
    pub fn root(&self) -> [u8; 32] {
        match self {
            PoolTree::Sapling(f) => f.root().to_bytes(),
            PoolTree::Orchard(_, f) => f.root().to_bytes(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_tree_state_matches_empty_frontier() {
        for pool in Pool::ALL {
            assert_eq!(root_from_tree_state(pool, "").unwrap(), PoolTree::empty(pool).root());
            // lightwalletd encodes an empty legacy tree as three zero bytes.
            assert_eq!(root_from_tree_state(pool, "000000").unwrap(), PoolTree::empty(pool).root());
            assert_eq!(size_from_tree_state(pool, "000000").unwrap(), 0);
        }
    }

    #[test]
    fn invalid_leaf_is_refused() {
        let mut t = PoolTree::empty(Pool::Ironwood);
        // 0xff.. is larger than the Pallas base field modulus.
        assert!(matches!(t.append(&[0xff; 32]), Err(TreeError::BadLeaf(Pool::Ironwood))));
        assert_eq!(t.size(), 0);
    }
}
