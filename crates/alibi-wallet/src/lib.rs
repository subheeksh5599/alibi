//! The alibi wallet as a WebAssembly module with a JSON calling convention.
//!
//! The host writes a UTF-8 JSON request into memory from `alloc`, calls an export with
//! `(ptr, len)` and receives a pointer to `[out_ptr: u32 LE, out_len: u32 LE]`; the output is
//! `{"ok": ...}` or `{"error": "..."}`. Randomness is supplied by the host (`entropy`, 32 bytes of
//! hex from a CSPRNG), so the module needs no imports.

pub mod entropy;
pub mod sapling_stub;
pub mod wallet;

pub mod rpc {
    include!(concat!(env!("OUT_DIR"), "/cash.z.wallet.sdk.rpc.rs"));
}

use orchard::keys::Scope;
use serde::Deserialize;
use serde_json::{json, Value};
use wallet::{Keys, SendRequest, State};

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

fn entropy(s: &str) -> Result<[u8; 32], String> {
    unhex(s, "entropy")?.try_into().map_err(|_| "entropy must be 32 bytes".to_string())
}

#[derive(Deserialize)]
struct KeyReq {
    network: String,
    seed: String,
}

impl KeyReq {
    fn keys(&self) -> Result<Keys, String> {
        Keys::from_seed(&unhex(&self.seed, "seed")?, wallet::network(&self.network)?)
    }
}

/// `{network, seed}` -> `{address}`: the wallet's unified address (Orchard receiver only).
#[no_mangle]
pub extern "C" fn wallet_address(ptr: *const u8, len: u32) -> *mut u8 {
    call(ptr, len, |r: KeyReq| {
        let k = r.keys()?;
        Ok(json!({ "address": wallet::encode_address(&k.address(Scope::External), wallet::network(&r.network)?)? }))
    })
}

#[derive(Deserialize)]
struct InitReq {
    network: String,
    height: u32,
    hash: String,
    /// Ironwood tree state at `height` from lightwalletd.
    tree: String,
}

/// Starts a wallet that follows the chain from `height + 1`.
#[no_mangle]
pub extern "C" fn wallet_init(ptr: *const u8, len: u32) -> *mut u8 {
    call(ptr, len, |r: InitReq| {
        wallet::network(&r.network)?;
        let s = State::new(&r.network, r.height, &r.hash, &r.tree)?;
        Ok(json!({ "state": s, "root": hex::encode(s.root()?) }))
    })
}

#[derive(Deserialize)]
struct ScanReq {
    #[serde(flatten)]
    key: KeyReq,
    state: State,
    /// `[u32 LE len][CompactBlock]...`, hex.
    blocks: String,
}

#[no_mangle]
pub extern "C" fn wallet_scan(ptr: *const u8, len: u32) -> *mut u8 {
    call(ptr, len, |mut r: ScanReq| {
        let keys = r.key.keys()?;
        let buf = unhex(&r.blocks, "blocks")?;
        let report = wallet::scan(&mut r.state, &keys, &buf)?;
        let root = hex::encode(r.state.root()?);
        Ok(json!({ "state": r.state, "report": report, "root": root }))
    })
}

#[derive(Deserialize)]
struct BuildReq {
    #[serde(flatten)]
    key: KeyReq,
    state: State,
    send: SendRequest,
    entropy: String,
}

/// Builds and proves a payment anchored at `send.anchor_height`. Returns the raw transaction.
#[no_mangle]
pub extern "C" fn wallet_build(ptr: *const u8, len: u32) -> *mut u8 {
    call(ptr, len, |r: BuildReq| {
        let keys = r.key.keys()?;
        let e = entropy(&r.entropy)?;
        entropy::seed(e);
        let built = wallet::build(&r.state, &keys, &r.send, e);
        entropy::clear();
        Ok(serde_json::to_value(built?).map_err(|e| e.to_string())?)
    })
}

#[derive(Deserialize)]
struct SpendableReq {
    state: State,
    anchor_height: u32,
}

/// `{state, anchor_height}` -> the notes an alibi spend at that checkpoint can use.
#[no_mangle]
pub extern "C" fn wallet_spendable(ptr: *const u8, len: u32) -> *mut u8 {
    call(ptr, len, |r: SpendableReq| {
        Ok(match wallet::spendable_at(&r.state, r.anchor_height) {
            None => json!({ "checkpoint": null, "notes": [], "total": 0 }),
            Some((cp, notes)) => json!({
                "checkpoint": { "height": cp.height, "root": cp.root },
                "notes": notes.iter().map(|(n, _)| json!({ "nf": n.nf, "value": n.value, "height": n.height })).collect::<Vec<_>>(),
                "total": notes.iter().map(|(n, _)| n.value).sum::<u64>(),
            }),
        })
    })
}
