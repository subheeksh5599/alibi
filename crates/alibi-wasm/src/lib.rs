//! alibi-core as a WebAssembly module with no imports.
//!
//! Calling convention: the host writes a UTF-8 JSON request into memory obtained from `alloc`,
//! calls an exported function with `(ptr, len)`, and gets back a pointer to an 8-byte header
//! `[out_ptr: u32 LE, out_len: u32 LE]`; the output is UTF-8 JSON at `out_ptr`. Every response is
//! either `{"ok": ...}` or `{"error": "..."}`. The host frees the request, the output and the
//! header with `dealloc`.
//!
//! Binary inputs (raw transactions, protobuf messages) travel as hex inside the JSON.

use alibi_core::claim::AnchorLocation;
use alibi_core::tree::TREE_DEPTH;
use alibi_core::{evaluate, parse_transaction, root_from_tree_state, Pool, PoolTree};
use incrementalmerkletree::frontier::CommitmentTree;
use orchard::tree::MerkleHashOrchard;
use prost::Message;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use zcash_primitives::merkle_tree::write_commitment_tree;

pub mod rpc {
    include!(concat!(env!("OUT_DIR"), "/cash.z.wallet.sdk.rpc.rs"));
}

// ---------------------------------------------------------------------------------------- memory

#[no_mangle]
pub extern "C" fn alloc(len: u32) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len.max(1) as usize);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `ptr` must come from `alloc(len)` (or a response) and not be freed twice.
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: u32) {
    drop(Vec::from_raw_parts(ptr, 0, len.max(1) as usize));
}

fn respond(v: Value) -> *mut u8 {
    let out = serde_json::to_vec(&v).unwrap_or_else(|_| b"{\"error\":\"serialization failed\"}".to_vec());
    let len = out.len() as u32;
    let data = alloc(len);
    unsafe { std::ptr::copy_nonoverlapping(out.as_ptr(), data, out.len()) };
    let header = alloc(8);
    unsafe {
        std::ptr::copy_nonoverlapping((data as usize as u32).to_le_bytes().as_ptr(), header, 4);
        std::ptr::copy_nonoverlapping(len.to_le_bytes().as_ptr(), header.add(4), 4);
    }
    header
}

fn call<Req: for<'a> Deserialize<'a>, F: FnOnce(Req) -> Result<Value, String>>(ptr: *const u8, len: u32, f: F) -> *mut u8 {
    let input = unsafe { std::slice::from_raw_parts(ptr, len as usize) };
    let result = serde_json::from_slice::<Req>(input).map_err(|e| format!("bad request: {e}")).and_then(f);
    respond(match result {
        Ok(v) => json!({ "ok": v }),
        Err(e) => json!({ "error": e }),
    })
}

fn unhex(s: &str, what: &str) -> Result<Vec<u8>, String> {
    hex::decode(s.trim()).map_err(|_| format!("{what} is not hex"))
}

fn display(wire: &[u8]) -> String {
    let mut b = wire.to_vec();
    b.reverse();
    hex::encode(b)
}

// ---------------------------------------------------------------------------------------- tx

#[derive(Deserialize)]
struct HexReq {
    hex: String,
}

/// `{hex}` raw transaction -> TxAnchors.
#[no_mangle]
pub extern "C" fn parse_tx(ptr: *const u8, len: u32) -> *mut u8 {
    call(ptr, len, |r: HexReq| {
        let raw = unhex(&r.hex, "transaction")?;
        let tx = parse_transaction(&raw).map_err(|e| e.to_string())?;
        serde_json::to_value(tx).map_err(|e| e.to_string())
    })
}

#[derive(Deserialize)]
struct EvalReq {
    hex: String,
    /// Keyed by `"<pool>:<anchor hex>"`.
    locations: HashMap<String, AnchorLocation>,
    cutoff: Option<u32>,
}

/// Evaluates the claim for a raw transaction given the location of each of its anchors.
#[no_mangle]
pub extern "C" fn evaluate_tx(ptr: *const u8, len: u32) -> *mut u8 {
    call(ptr, len, |r: EvalReq| {
        let raw = unhex(&r.hex, "transaction")?;
        let tx = parse_transaction(&raw).map_err(|e| e.to_string())?;
        let mut missing = None;
        let v = evaluate(
            &tx,
            |pool, a| {
                let key = format!("{}:{}", pool.as_str(), hex::encode(a));
                match r.locations.get(&key) {
                    Some(l) => l.clone(),
                    None => {
                        missing = Some(key);
                        AnchorLocation::NotLocated { reason: "no location supplied".into() }
                    }
                }
            },
            r.cutoff,
        );
        if let Some(k) = missing {
            return Err(format!("no location supplied for {k}"));
        }
        Ok(json!({ "transaction": tx, "verdict": v }))
    })
}

// ---------------------------------------------------------------------------------------- protobuf

fn pick(ts: &rpc::TreeState, pool: Pool) -> &str {
    match pool {
        Pool::Sapling => &ts.sapling_tree,
        Pool::Orchard => &ts.orchard_tree,
        Pool::Ironwood => &ts.ironwood_tree,
    }
}

/// `{hex}` TreeState protobuf -> its fields plus every pool's root.
#[no_mangle]
pub extern "C" fn decode_tree_state(ptr: *const u8, len: u32) -> *mut u8 {
    call(ptr, len, |r: HexReq| {
        let ts = rpc::TreeState::decode(&unhex(&r.hex, "tree state")?[..]).map_err(|e| e.to_string())?;
        let mut roots = serde_json::Map::new();
        for pool in Pool::ALL {
            let root = root_from_tree_state(pool, pick(&ts, pool)).map_err(|e| format!("{pool} tree at {}: {e}", ts.height))?;
            roots.insert(pool.as_str().into(), json!(hex::encode(root)));
        }
        Ok(json!({
            "network": ts.network, "height": ts.height, "hash": ts.hash, "time": ts.time,
            "trees": { "sapling": ts.sapling_tree, "orchard": ts.orchard_tree, "ironwood": ts.ironwood_tree },
            "roots": roots,
        }))
    })
}

/// `{hex}` RawTransaction protobuf -> `{hex, height}` (height as a decimal string).
#[no_mangle]
pub extern "C" fn decode_raw_tx(ptr: *const u8, len: u32) -> *mut u8 {
    call(ptr, len, |r: HexReq| {
        let t = rpc::RawTransaction::decode(&unhex(&r.hex, "raw transaction")?[..]).map_err(|e| e.to_string())?;
        Ok(json!({ "hex": hex::encode(&t.data), "height": t.height.to_string() }))
    })
}

/// `{hex}` BlockID protobuf -> height and display hash.
#[no_mangle]
pub extern "C" fn decode_block_id(ptr: *const u8, len: u32) -> *mut u8 {
    call(ptr, len, |r: HexReq| {
        let b = rpc::BlockId::decode(&unhex(&r.hex, "block id")?[..]).map_err(|e| e.to_string())?;
        Ok(json!({ "height": b.height, "hash": display(&b.hash) }))
    })
}

/// `{hex}` CompactBlock protobuf -> height, display hash, time.
#[no_mangle]
pub extern "C" fn decode_block_header(ptr: *const u8, len: u32) -> *mut u8 {
    call(ptr, len, |r: HexReq| {
        let b = rpc::CompactBlock::decode(&unhex(&r.hex, "compact block")?[..]).map_err(|e| e.to_string())?;
        Ok(json!({ "height": b.height, "hash": display(&b.hash), "time": b.time }))
    })
}

// ---------------------------------------------------------------------------------------- indexing

#[derive(Deserialize, Serialize, Clone)]
struct Trees {
    sapling: String,
    orchard: String,
    ironwood: String,
}

impl Trees {
    fn get(&self, p: Pool) -> &str {
        match p {
            Pool::Sapling => &self.sapling,
            Pool::Orchard => &self.orchard,
            Pool::Ironwood => &self.ironwood,
        }
    }
}

#[derive(Deserialize)]
struct ApplyReq {
    trees: Trees,
    /// Display hash of the last indexed block; the first block must name it as parent.
    prev_hash: String,
    /// Concatenation of `[u32 LE length][CompactBlock protobuf]`, hex.
    blocks: String,
    /// Return all three roots at heights that are multiples of this (0 = never).
    grid: u32,
}

fn tree_to_hex(t: &PoolTree) -> String {
    let mut out = Vec::new();
    match t {
        PoolTree::Sapling(f) => {
            let ct: CommitmentTree<sapling::Node, TREE_DEPTH> = CommitmentTree::from_frontier(f);
            write_commitment_tree(&ct, &mut out).expect("vec write");
        }
        PoolTree::Orchard(_, f) => {
            let ct: CommitmentTree<MerkleHashOrchard, TREE_DEPTH> = CommitmentTree::from_frontier(f);
            write_commitment_tree(&ct, &mut out).expect("vec write");
        }
    }
    hex::encode(out)
}

fn as32(b: &[u8], what: &str, h: u64) -> Result<[u8; 32], String> {
    b.try_into().map_err(|_| format!("block {h}: {what} is {} bytes, expected 32", b.len()))
}

/// Applies consecutive compact blocks to the three trees. Returns the new trees, one row per block
/// with the roots of the pools that changed, and all three roots at grid heights. A leaf count
/// different from what the block reports, or a malformed commitment, is an error. A block whose
/// parent is not the previous block stops processing and is reported as `reorg`.
#[no_mangle]
pub extern "C" fn apply_blocks(ptr: *const u8, len: u32) -> *mut u8 {
    call(ptr, len, |r: ApplyReq| {
        let mut trees: Vec<PoolTree> = Pool::ALL
            .iter()
            .map(|&p| PoolTree::from_tree_state(p, r.trees.get(p)).map_err(|e| format!("{p} tree: {e}")))
            .collect::<Result<_, _>>()?;
        let buf = unhex(&r.blocks, "blocks")?;
        let mut i = 0usize;
        let mut prev = r.prev_hash.clone();
        let mut rows = Vec::new();
        let mut grid_roots = Vec::new();
        while i < buf.len() {
            if i + 4 > buf.len() {
                return Err("truncated block frame".into());
            }
            let n = u32::from_le_bytes(buf[i..i + 4].try_into().unwrap()) as usize;
            i += 4;
            let b = rpc::CompactBlock::decode(buf.get(i..i + n).ok_or("truncated block")?).map_err(|e| e.to_string())?;
            i += n;
            let h = b.height;
            if display(&b.prev_hash) != prev {
                return Ok(json!({ "reorg": { "height": h, "expected_parent": prev, "got_parent": display(&b.prev_hash) } }));
            }
            let before: Vec<u64> = trees.iter().map(|t| t.size()).collect();
            for tx in &b.vtx {
                for o in &tx.outputs {
                    trees[0].append(&as32(&o.cmu, "sapling cmu", h)?).map_err(|e| format!("block {h}: {e}"))?;
                }
                for a in &tx.actions {
                    trees[1].append(&as32(&a.cmx, "orchard cmx", h)?).map_err(|e| format!("block {h}: {e}"))?;
                }
                for a in &tx.ironwood_actions {
                    trees[2].append(&as32(&a.cmx, "ironwood cmx", h)?).map_err(|e| format!("block {h}: {e}"))?;
                }
            }
            if let Some(m) = &b.chain_metadata {
                let expected = [
                    m.sapling_commitment_tree_size as u64,
                    m.orchard_commitment_tree_size as u64,
                    m.ironwood_commitment_tree_size as u64,
                ];
                for (t, e) in trees.iter().zip(expected) {
                    if t.size() != e {
                        return Err(format!("block {h}: {} tree has {} leaves after the block, the block reports {e}", t.pool(), t.size()));
                    }
                }
            }
            let changed: Vec<Value> = trees
                .iter()
                .zip(&before)
                .filter(|(t, b)| t.size() != **b)
                .map(|(t, _)| json!({ "pool": t.pool().as_str(), "root": hex::encode(t.root()) }))
                .collect();
            let hash = display(&b.hash);
            if r.grid > 0 && h % r.grid as u64 == 0 {
                let roots: serde_json::Map<String, Value> =
                    trees.iter().map(|t| (t.pool().as_str().to_string(), json!(hex::encode(t.root())))).collect();
                grid_roots.push(json!({ "height": h, "roots": roots }));
            }
            rows.push(json!({ "height": h, "hash": hash, "time": b.time, "roots": changed }));
            prev = hash;
        }
        let out = Trees { sapling: tree_to_hex(&trees[0]), orchard: tree_to_hex(&trees[1]), ironwood: tree_to_hex(&trees[2]) };
        Ok(json!({ "trees": out, "blocks": rows, "grid": grid_roots }))
    })
}

/// `{sapling, orchard, ironwood}` serialized trees -> root and size of each.
#[no_mangle]
pub extern "C" fn tree_roots(ptr: *const u8, len: u32) -> *mut u8 {
    call(ptr, len, |r: Trees| {
        let mut out = serde_json::Map::new();
        for p in Pool::ALL {
            let t = PoolTree::from_tree_state(p, r.get(p)).map_err(|e| format!("{p}: {e}"))?;
            out.insert(p.as_str().into(), json!({ "root": hex::encode(t.root()), "size": t.size() }));
        }
        Ok(Value::Object(out))
    })
}
