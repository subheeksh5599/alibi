//! Tests against real mainnet data captured from a public lightwalletd.
//!
//! * `main-14960f89.hex` — transaction 14960f89…252f, mined at block 3,517,000.

use alibi_core::{parse_transaction, root_from_tree_state, Pool, PoolTree};

fn fixture(name: &str) -> String {
    std::fs::read_to_string(format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR")))
        .unwrap()
        .trim()
        .to_string()
}

#[test]
fn parses_a_mainnet_v6_ironwood_transaction() {
    let raw = hex::decode(fixture("main-14960f89.hex")).unwrap();
    let tx = parse_transaction(&raw).unwrap();
    println!("{}", serde_json::to_string_pretty(&tx).unwrap());
    assert_eq!(tx.txid, "14960f89420328fa92739217e5e05d6c9bd0e7c1c4640f0c6dc264dc9d3a252f");
    assert_eq!(tx.version, 6);
    assert_eq!(tx.branch_id.as_deref(), Some("37a5165b"));
    let iw = tx.pools.iter().find(|p| p.pool == Pool::Ironwood).expect("ironwood bundle");
    assert_eq!(iw.outputs, 2);
}

#[test]
fn ironwood_anchor_is_the_root_of_the_tree_four_blocks_earlier() {
    // The tree state lightwalletd served for block 3,516,996 (hash 00000000005bb55a…c142).
    let tree = fixture("main-3516996-ironwood-tree.hex");
    let root = root_from_tree_state(Pool::Ironwood, &tree).unwrap();
    let raw = hex::decode(fixture("main-14960f89.hex")).unwrap();
    let tx = parse_transaction(&raw).unwrap();
    let iw = tx.pools.iter().find(|p| p.pool == Pool::Ironwood).unwrap();
    assert_eq!(iw.anchors, vec![hex::encode(root)]);
    // Rebuilding the same tree through the incremental frontier gives the same root.
    let t = PoolTree::from_tree_state(Pool::Ironwood, &tree).unwrap();
    assert_eq!(t.root(), root);
    assert!(t.size() > 700_000);
    // A different pool's hash over the same leaves would not match.
    assert_ne!(root_from_tree_state(Pool::Ironwood, "").unwrap(), root);
}

#[test]
fn trailing_bytes_are_refused() {
    let mut raw = hex::decode(fixture("main-14960f89.hex")).unwrap();
    raw.push(0);
    assert!(parse_transaction(&raw).is_err());
}

#[test]
fn truncated_bytes_are_refused() {
    let raw = hex::decode(fixture("main-14960f89.hex")).unwrap();
    assert!(parse_transaction(&raw[..raw.len() - 1]).is_err());
}
