//! An Ironwood light wallet whose one distinctive ability is to spend against an OLD anchor.
//!
//! A normal wallet anchors a spend to a tree root a few blocks below the tip. This wallet keeps,
//! for every unspent note, the note's Merkle witness as it stood at the end of every block on the
//! 144-block grid. A payment can then be built against the grid root strictly before a chosen
//! cut-off: consensus accepts any past root as an anchor, and a valid spend against that root
//! proves every input was already in the pool when the cut-off block was mined.
//!
//! The wallet is pure: state goes in as JSON and comes back as JSON. Keys never leave the caller.

use incrementalmerkletree::frontier::CommitmentTree;
use incrementalmerkletree::witness::IncrementalWitness;
use orchard::keys::{FullViewingKey, PreparedIncomingViewingKey, Scope, SpendAuthorizingKey, SpendingKey};
use orchard::note::{ExtractedNoteCommitment, Note, NoteVersion, Nullifier, RandomSeed, Rho};
use orchard::note_encryption::{CompactAction, IronwoodVersion, NoteEncryptionDomain};
use orchard::tree::{MerkleHashOrchard, MerklePath};
use orchard::value::NoteValue;
use orchard::Address;
use prost::Message;
use rand_chacha::ChaCha20Rng;
use rand_core::SeedableRng;
use serde::{Deserialize, Serialize};
use zcash_address::unified::{self, Container, Encoding};
use zcash_note_encryption::{try_compact_note_decryption, EphemeralKeyBytes};
use zcash_primitives::merkle_tree::{
    read_commitment_tree, read_incremental_witness, write_commitment_tree, write_incremental_witness,
};
use zcash_primitives::transaction::builder::{BuildConfig, Builder, BundlePadding};
use zcash_primitives::transaction::fees::zip317;
use zcash_protocol::consensus::{BlockHeight, Network, NetworkType};
use zcash_protocol::memo::MemoBytes;
use zcash_protocol::value::Zatoshis;

use crate::rpc;
use crate::sapling_stub::NoSapling;

/// Distance between the anchors every alibi spend draws from (the ZIP 318 grid).
pub const GRID: u32 = 144;
/// How many grid checkpoints the wallet keeps witnesses for (about 7.5 days on testnet).
pub const KEEP_CHECKPOINTS: usize = 60;
/// ZIP 317 marginal fee per logical action, in zatoshis.
const MARGINAL_FEE: u64 = 5_000;
const GRACE_ACTIONS: u64 = 2;

type Tree = CommitmentTree<MerkleHashOrchard, 32>;
type Witness = IncrementalWitness<MerkleHashOrchard, 32>;

// ------------------------------------------------------------------------------------- network

pub fn network(name: &str) -> Result<Network, String> {
    match name {
        "main" | "mainnet" => Ok(Network::MainNetwork),
        "test" | "testnet" => Ok(Network::TestNetwork),
        other => Err(format!("unknown network `{other}`")),
    }
}

fn network_type(n: Network) -> NetworkType {
    match n {
        Network::MainNetwork => NetworkType::Main,
        Network::TestNetwork => NetworkType::Test,
    }
}

fn coin_type(n: Network) -> u32 {
    match n {
        Network::MainNetwork => 133,
        Network::TestNetwork => 1,
    }
}

// ----------------------------------------------------------------------------------------- keys

pub struct Keys {
    pub sk: SpendingKey,
    pub fvk: FullViewingKey,
}

impl Keys {
    pub fn from_seed(seed: &[u8], net: Network) -> Result<Self, String> {
        if seed.len() < 32 {
            return Err("seed must be at least 32 bytes".into());
        }
        let sk = SpendingKey::from_zip32_seed(seed, coin_type(net), zip32::AccountId::ZERO)
            .map_err(|e| format!("key derivation failed: {e:?}"))?;
        let fvk = FullViewingKey::from(&sk);
        Ok(Self { sk, fvk })
    }

    pub fn address(&self, scope: Scope) -> Address {
        self.fvk.address_at(0u32, scope)
    }
}

/// A unified address holding only an Orchard receiver. Since NU6.3 a payment to an Orchard
/// receiver is delivered into the Ironwood pool.
pub fn encode_address(addr: &Address, net: Network) -> Result<String, String> {
    let ua = unified::Address::try_from_items(
        unified::Revision::R0,
        vec![unified::Uitem::Data(unified::Receiver::Orchard(addr.to_raw_address_bytes()))],
    )
        .map_err(|e| format!("cannot build unified address: {e}"))?;
    Ok(ua.encode(&network_type(net)))
}

/// Parses a unified address and returns its Orchard receiver.
pub fn decode_address(s: &str, net: Network) -> Result<Address, String> {
    let (nt, _revision, ua) = unified::Address::decode(s.trim()).map_err(|e| format!("not a unified address: {e}"))?;
    if nt != network_type(net) {
        return Err("the address is for a different network".into());
    }
    for item in ua.items() {
        if let unified::Receiver::Orchard(bytes) = item {
            return Option::from(Address::from_raw_address_bytes(&bytes)).ok_or_else(|| "invalid Orchard receiver".into());
        }
    }
    Err("the address has no Orchard receiver; an alibi spend pays into the Ironwood pool".into())
}

// ---------------------------------------------------------------------------------------- state

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Spent {
    pub txid: String,
    pub height: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct NoteRec {
    /// Block the note was mined in.
    pub height: u32,
    pub txid: String,
    pub position: u64,
    pub value: u64,
    pub scope: String,
    pub recipient: String,
    pub rho: String,
    pub rseed: String,
    pub nf: String,
    /// The note's witness as of the wallet's current height (`State::height`).
    pub witness: String,
    pub spent: Option<Spent>,
    /// Set when the wallet broadcast a spend of this note that is not mined yet.
    #[serde(default)]
    pub pending: Option<String>,
    /// Last block the pending spend can be mined in (its expiry height). Past it, the note is
    /// released: the transaction can no longer be mined.
    #[serde(default)]
    pub pending_until: Option<u32>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Checkpoint {
    pub height: u32,
    /// Ironwood root at the end of `height`, in transaction byte order.
    pub root: String,
    /// `(nullifier, witness)` for every note unspent at the end of `height`.
    pub witnesses: Vec<(String, String)>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct State {
    pub network: String,
    pub birthday: u32,
    pub height: u32,
    pub hash: String,
    /// Ironwood tree at the end of `height` (legacy `CommitmentTree` encoding, hex).
    pub tree: String,
    pub notes: Vec<NoteRec>,
    pub checkpoints: Vec<Checkpoint>,
}

fn tree_hex(t: &Tree) -> String {
    let mut out = Vec::new();
    write_commitment_tree(t, &mut out).expect("vec write");
    hex::encode(out)
}

fn read_tree(h: &str) -> Result<Tree, String> {
    let b = hex::decode(h.trim()).map_err(|_| "tree is not hex")?;
    if b.is_empty() {
        return Ok(CommitmentTree::empty());
    }
    read_commitment_tree(&b[..]).map_err(|e| format!("bad tree: {e}"))
}

fn witness_hex(w: &Witness) -> String {
    let mut out = Vec::new();
    write_incremental_witness(w, &mut out).expect("vec write");
    hex::encode(out)
}

fn read_witness(h: &str) -> Result<Witness, String> {
    let b = hex::decode(h).map_err(|_| "witness is not hex")?;
    read_incremental_witness(&b[..]).map_err(|e| format!("bad witness: {e}"))
}

fn display(wire: &[u8]) -> String {
    let mut b = wire.to_vec();
    b.reverse();
    hex::encode(b)
}

fn arr32(b: &[u8], what: &str) -> Result<[u8; 32], String> {
    b.try_into().map_err(|_| format!("{what} is {} bytes, expected 32", b.len()))
}

impl State {
    /// A wallet that starts following the chain after block `height`, whose Ironwood tree state
    /// (from lightwalletd `GetTreeState`) is `tree`.
    pub fn new(network: &str, height: u32, hash: &str, tree: &str) -> Result<Self, String> {
        let t = read_tree(tree)?;
        Ok(Self {
            network: network.into(),
            birthday: height + 1,
            height,
            hash: hash.into(),
            tree: tree_hex(&t),
            notes: Vec::new(),
            checkpoints: Vec::new(),
        })
    }

    pub fn root(&self) -> Result<[u8; 32], String> {
        Ok(read_tree(&self.tree)?.root().to_bytes())
    }

    pub fn balance(&self) -> u64 {
        self.notes.iter().filter(|n| n.spent.is_none()).map(|n| n.value).sum()
    }
}

// ----------------------------------------------------------------------------------------- scan

#[derive(Serialize, Debug, Default)]
pub struct ScanReport {
    pub blocks: u32,
    pub received: Vec<NoteRec>,
    pub spent: Vec<(String, Spent)>,
    pub checkpoints: Vec<u32>,
    pub reorg: Option<u32>,
}

/// Applies consecutive compact blocks (`[u32 LE len][CompactBlock]...`) to the wallet.
///
/// For each Ironwood action: a nullifier of one of our notes marks it spent; the output is
/// trial-decrypted with both scopes; its commitment is appended to the tree and to every witness.
/// At every grid height the root and every unspent note's witness are checkpointed. The tree size
/// must equal what the block reports, or the scan stops with an error rather than producing
/// witnesses for a tree that is not the chain's.
pub fn scan(state: &mut State, keys: &Keys, framed: &[u8]) -> Result<ScanReport, String> {
    let ivks = [
        (Scope::External, PreparedIncomingViewingKey::new(&keys.fvk.to_ivk(Scope::External))),
        (Scope::Internal, PreparedIncomingViewingKey::new(&keys.fvk.to_ivk(Scope::Internal))),
    ];
    let mut tree = read_tree(&state.tree)?;
    let mut live: Vec<(usize, Witness)> = state
        .notes
        .iter()
        .enumerate()
        .filter(|(_, n)| n.spent.is_none())
        .map(|(i, n)| read_witness(&n.witness).map(|w| (i, w)))
        .collect::<Result<_, _>>()?;
    let mut report = ScanReport::default();

    let mut i = 0usize;
    while i < framed.len() {
        if i + 4 > framed.len() {
            return Err("truncated block frame".into());
        }
        let n = u32::from_le_bytes(framed[i..i + 4].try_into().unwrap()) as usize;
        i += 4;
        let b = rpc::CompactBlock::decode(framed.get(i..i + n).ok_or("truncated block")?).map_err(|e| e.to_string())?;
        i += n;
        let h = b.height as u32;
        if h != state.height + 1 {
            return Err(format!("expected block {}, got {h}", state.height + 1));
        }
        if display(&b.prev_hash) != state.hash {
            report.reorg = Some(h);
            break;
        }

        for tx in &b.vtx {
            let txid = display(&tx.txid);
            for a in &tx.ironwood_actions {
                let nf_bytes = arr32(&a.nullifier, "nullifier")?;
                let nf_hex = hex::encode(nf_bytes);
                for (idx, _) in &live {
                    let note = &mut state.notes[*idx];
                    if note.nf == nf_hex && note.spent.is_none() {
                        let s = Spent { txid: txid.clone(), height: h };
                        note.spent = Some(s.clone());
                        note.pending = None;
                        note.pending_until = None;
                        report.spent.push((nf_hex.clone(), s));
                    }
                }
                live.retain(|(idx, _)| state.notes[*idx].spent.is_none());

                let cmx_bytes = arr32(&a.cmx, "cmx")?;
                let cmx: ExtractedNoteCommitment =
                    Option::from(ExtractedNoteCommitment::from_bytes(&cmx_bytes)).ok_or("invalid cmx")?;
                let leaf = MerkleHashOrchard::from_cmx(&cmx);
                tree.append(leaf).map_err(|_| "Ironwood tree is full")?;
                for (_, w) in live.iter_mut() {
                    w.append(leaf).map_err(|_| "witness is full")?;
                }

                let nf: Nullifier = Option::from(Nullifier::from_bytes(&nf_bytes)).ok_or("invalid nullifier")?;
                let epk = EphemeralKeyBytes(arr32(&a.ephemeral_key, "ephemeral key")?);
                let ct: [u8; 52] = a.ciphertext.as_slice().try_into().map_err(|_| "compact ciphertext is not 52 bytes")?;
                let ca = CompactAction::from_parts(nf, cmx, epk, ct);
                let domain = NoteEncryptionDomain::<IronwoodVersion>::for_compact_action(&ca);
                for (scope, ivk) in &ivks {
                    if let Some((note, _addr)) = try_compact_note_decryption(&domain, ivk, &ca) {
                        let w = Witness::from_tree(tree.clone()).ok_or("cannot witness an empty tree")?;
                        let rec = NoteRec {
                            height: h,
                            txid: txid.clone(),
                            position: u64::from(w.witnessed_position()),
                            value: note.value().inner(),
                            scope: if *scope == Scope::External { "external" } else { "internal" }.into(),
                            recipient: hex::encode(note.recipient().to_raw_address_bytes()),
                            rho: hex::encode(note.rho().to_bytes()),
                            rseed: hex::encode(note.rseed().as_bytes()),
                            nf: hex::encode(note.nullifier(&keys.fvk).to_bytes()),
                            witness: String::new(),
                            spent: None,
                            pending: None,
                            pending_until: None,
                        };
                        report.received.push(rec.clone());
                        state.notes.push(rec);
                        live.push((state.notes.len() - 1, w));
                        break;
                    }
                }
            }
        }

        if let Some(m) = &b.chain_metadata {
            if tree.size() as u64 != m.ironwood_commitment_tree_size as u64 {
                return Err(format!(
                    "block {h}: Ironwood tree has {} leaves after the block, the block reports {}",
                    tree.size(),
                    m.ironwood_commitment_tree_size
                ));
            }
        }

        state.height = h;
        state.hash = display(&b.hash);
        for n in state.notes.iter_mut() {
            if n.spent.is_none() && n.pending_until.is_some_and(|u| h > u) {
                n.pending = None;
                n.pending_until = None;
            }
        }
        if h % GRID == 0 {
            state.checkpoints.push(Checkpoint {
                height: h,
                root: hex::encode(tree.root().to_bytes()),
                witnesses: live.iter().map(|(idx, w)| (state.notes[*idx].nf.clone(), witness_hex(w))).collect(),
            });
            if state.checkpoints.len() > KEEP_CHECKPOINTS {
                let drop = state.checkpoints.len() - KEEP_CHECKPOINTS;
                state.checkpoints.drain(..drop);
            }
            report.checkpoints.push(h);
        }
        report.blocks += 1;
    }

    for (idx, w) in &live {
        state.notes[*idx].witness = witness_hex(w);
    }
    for n in report.received.iter_mut() {
        if let Some(s) = state.notes.iter().find(|x| x.nf == n.nf) {
            n.witness = s.witness.clone();
        }
    }
    state.tree = tree_hex(&tree);
    Ok(report)
}

// ---------------------------------------------------------------------------------------- build

#[derive(Deserialize)]
pub struct SendRequest {
    pub to: String,
    pub amount: u64,
    #[serde(default)]
    pub memo: Option<String>,
    /// The grid checkpoint to anchor to. Every input must already be in the tree at its end.
    pub anchor_height: u32,
    /// The block the transaction is built for (normally tip + 1).
    pub target_height: u32,
}

#[derive(Serialize, Debug)]
pub struct Built {
    pub txid: String,
    pub hex: String,
    pub fee: u64,
    pub anchor_height: u32,
    pub anchor: String,
    pub inputs: Vec<String>,
    pub change: u64,
    pub expiry_height: u32,
}

fn fee_for(actions: u64) -> u64 {
    MARGINAL_FEE * actions.max(GRACE_ACTIONS)
}

fn note_from(rec: &NoteRec) -> Result<Note, String> {
    let recipient: [u8; 43] = hex::decode(&rec.recipient).map_err(|_| "bad recipient")?.try_into().map_err(|_| "bad recipient")?;
    let recipient: Address = Option::from(Address::from_raw_address_bytes(&recipient)).ok_or("bad recipient")?;
    let rho: Rho = Option::from(Rho::from_bytes(&arr32(&hex::decode(&rec.rho).map_err(|_| "bad rho")?, "rho")?)).ok_or("bad rho")?;
    let rseed: RandomSeed =
        Option::from(RandomSeed::from_bytes(arr32(&hex::decode(&rec.rseed).map_err(|_| "bad rseed")?, "rseed")?, &rho)).ok_or("bad rseed")?;
    Option::from(Note::from_parts(recipient, NoteValue::from_raw(rec.value), rho, rseed, NoteVersion::V3)).ok_or_else(|| "note does not reconstruct".into())
}

/// Notes that can fund a spend anchored at `anchor_height`: unspent, not already being spent,
/// and present in the tree at the end of that checkpoint.
pub fn spendable_at<'a>(state: &'a State, anchor_height: u32) -> Option<(&'a Checkpoint, Vec<(&'a NoteRec, Witness)>)> {
    let cp = state.checkpoints.iter().find(|c| c.height == anchor_height)?;
    let mut out = Vec::new();
    for (nf, w) in &cp.witnesses {
        if let Some(n) = state.notes.iter().find(|n| &n.nf == nf && n.spent.is_none() && n.pending.is_none()) {
            if let Ok(w) = read_witness(w) {
                out.push((n, w));
            }
        }
    }
    out.sort_by(|a, b| b.0.value.cmp(&a.0.value));
    Some((cp, out))
}

pub fn build(state: &State, keys: &Keys, req: &SendRequest, entropy: [u8; 32]) -> Result<Built, String> {
    let net = network(&state.network)?;
    if req.anchor_height % GRID != 0 {
        return Err(format!("the anchor must be a multiple of {GRID}"));
    }
    if req.target_height <= req.anchor_height {
        return Err("the anchor must be below the target height".into());
    }
    let recipient = decode_address(&req.to, net)?;
    let (cp, candidates) = spendable_at(state, req.anchor_height)
        .ok_or_else(|| format!("the wallet holds no checkpoint at block {}; it only keeps grid blocks it scanned", req.anchor_height))?;
    let anchor_bytes = arr32(&hex::decode(&cp.root).map_err(|_| "bad root")?, "root")?;

    // Pick the fewest largest notes that cover amount + fee.
    let mut chosen = Vec::new();
    let mut total = 0u64;
    let mut need = req.amount + fee_for(2);
    for c in candidates {
        if total >= need {
            break;
        }
        total += c.0.value;
        chosen.push(c);
        need = req.amount + fee_for(chosen.len().max(2) as u64);
    }
    let mut fee = fee_for((chosen.len() as u64).max(2));
    if total < req.amount + fee {
        return Err(format!(
            "notes that existed at block {} hold {} zatoshis; the payment needs {} plus a {} fee",
            req.anchor_height, total, req.amount, fee
        ));
    }
    let mut change = total - req.amount - fee;
    let outputs = if change > 0 { 2 } else { 1 };
    let actions = (chosen.len() as u64).max(outputs).max(GRACE_ACTIONS);
    if fee_for(actions) != fee {
        fee = fee_for(actions);
        if total < req.amount + fee {
            return Err("insufficient funds once change is added".into());
        }
        change = total - req.amount - fee;
    }

    let anchor: orchard::Anchor = Option::from(orchard::Anchor::from_bytes(anchor_bytes)).ok_or("checkpoint root is not a valid anchor")?;
    let mut builder = Builder::new(
        net,
        BlockHeight::from_u32(req.target_height),
        BuildConfig::Standard {
            sapling_anchor: None,
            orchard_anchor: None,
            ironwood_anchor: Some(anchor),
            orchard_padding: BundlePadding::DEFAULT,
            ironwood_padding: BundlePadding::DEFAULT,
        },
    );
    let mut inputs = Vec::new();
    for (rec, w) in &chosen {
        let path: MerklePath = w.path().ok_or("witness has no path")?.into();
        let note = note_from(rec)?;
        if path.root(note.commitment().into()).to_bytes() != anchor_bytes {
            return Err(format!("note {} does not hash to the checkpoint root", rec.nf));
        }
        builder
            .add_ironwood_spend::<zip317::FeeError>(keys.fvk.clone(), note, path)
            .map_err(|e| format!("cannot add spend: {e:?}"))?;
        inputs.push(rec.nf.clone());
    }
    let memo = match &req.memo {
        Some(m) if !m.is_empty() => MemoBytes::from_bytes(m.as_bytes()).map_err(|_| "memo is longer than 512 bytes")?,
        _ => MemoBytes::empty(),
    };
    let ovk = Some(keys.fvk.to_ovk(Scope::External));
    builder
        .add_ironwood_output::<zip317::FeeError>(ovk.clone(), recipient, Zatoshis::from_u64(req.amount).map_err(|_| "bad amount")?, memo)
        .map_err(|e| format!("cannot add output: {e:?}"))?;
    if change > 0 {
        builder
            .add_ironwood_output::<zip317::FeeError>(
                Some(keys.fvk.to_ovk(Scope::Internal)),
                keys.address(Scope::Internal),
                Zatoshis::from_u64(change).map_err(|_| "bad change")?,
                MemoBytes::empty(),
            )
            .map_err(|e| format!("cannot add change: {e:?}"))?;
    }

    let rng = ChaCha20Rng::from_seed(entropy);
    let ask = SpendAuthorizingKey::from(&keys.sk);
    let result = builder
        .build(
            &Default::default(),
            &[],
            &[ask],
            rng,
            &NoSapling,
            &NoSapling,
            &zip317::FeeRule::standard(),
        )
        .map_err(|e| format!("build failed: {e:?}"))?;
    let tx = result.transaction();
    let expiry_height = u32::from(tx.expiry_height());
    let mut raw = Vec::new();
    tx.write(&mut raw).map_err(|e| e.to_string())?;
    Ok(Built {
        txid: tx.txid().to_string(),
        hex: hex::encode(raw),
        fee,
        anchor_height: cp.height,
        anchor: cp.root.clone(),
        inputs,
        change,
        expiry_height,
    })
}
