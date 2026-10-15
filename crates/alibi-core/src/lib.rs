//! Turn a Zcash transaction into a provenance claim about the notes it spends.
//!
//! Every shielded spend names an *anchor*: the root of its pool's note commitment tree at the end
//! of some earlier block. The spend's zero-knowledge proof shows that each spent note is a leaf of
//! the tree with that root, and consensus only accepts roots that the chain actually produced. So
//! if an anchor is the root at the end of block `H`, every note the transaction spends from that
//! pool was already in the pool when block `H` closed.
//!
//! This crate does the pure part of that argument:
//!
//! * [`tx`] reads the anchors (and the counts needed to qualify a claim) out of raw transaction
//!   bytes;
//! * [`tree`] recomputes note commitment tree roots, either from a serialized tree state or
//!   incrementally from the leaves of each block;
//! * [`claim`] turns located anchors and an optional cut-off height into a verdict.
//!
//! Locating an anchor (root -> height) needs chain data and lives in the service crate.

pub mod claim;
pub mod pool;
pub mod tree;
pub mod tx;

pub use claim::{evaluate, AnchorFinding, AnchorLocation, Coverage, PoolFinding, Verdict, VerdictKind};
pub use pool::Pool;
pub use tree::{root_from_tree_state, PoolTree, TreeError};
pub use tx::{parse_transaction, PoolSpends, TxAnchors, TxError};
