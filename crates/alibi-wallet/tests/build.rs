//! End-to-end checks of the wallet's distinctive operation: a payment anchored at a grid
//! checkpoint, proved, and readable by the verifier as committing to that checkpoint.
//!
//! The note lives in a synthetic Ironwood tree (no chain access); everything else is the real
//! path: real keys, a real V3 note to the wallet's own address, real witnesses, the real builder,
//! a real halo2 proof checked against the circuit's verifying key.

use alibi_core::parse_transaction;
use alibi_wallet::wallet::{self, Checkpoint, Keys, NoteRec, SendRequest, State, GRID};
use incrementalmerkletree::frontier::CommitmentTree;
use incrementalmerkletree::witness::IncrementalWitness;
use orchard::circuit::{OrchardCircuitVersion, VerifyingKey};
use orchard::keys::Scope;
use orchard::note::{ExtractedNoteCommitment, Note, NoteVersion, RandomSeed, Rho};
use orchard::tree::MerkleHashOrchard;
use orchard::value::NoteValue;
use rand_chacha::ChaCha20Rng;
use rand_core::{Rng, SeedableRng};
use std::sync::OnceLock;
use zcash_primitives::merkle_tree::{write_commitment_tree, write_incremental_witness};
use zcash_primitives::transaction::Transaction;
use zcash_protocol::consensus::{BlockHeight, BranchId, Network};

type Tree = CommitmentTree<MerkleHashOrchard, 32>;
type Witness = IncrementalWitness<MerkleHashOrchard, 32>;

const SEED: [u8; 32] = [7u8; 32];
/// A grid height on testnet after NU7 activated (4,465,026).
const CHECKPOINT: u32 = 4_504_464;
const TARGET: u32 = 4_504_500;

fn keys() -> Keys {
    Keys::from_seed(&SEED, Network::TestNetwork).unwrap()
}

fn random_note(rng: &mut ChaCha20Rng, keys: &Keys, value: u64) -> Note {
    loop {
        let mut rho = [0u8; 32];
        rng.fill_bytes(&mut rho);
        rho[31] &= 0x3f; // below the Pallas base modulus
        let Some(rho) = Option::<Rho>::from(Rho::from_bytes(&rho)) else { continue };
        let mut rseed = [0u8; 32];
        rng.fill_bytes(&mut rseed);
        let Some(rseed) = Option::<RandomSeed>::from(RandomSeed::from_bytes(rseed, &rho)) else { continue };
        let note = Note::from_parts(keys.address(Scope::External), NoteValue::from_raw(value), rho, rseed, NoteVersion::V3);
        if let Some(n) = Option::<Note>::from(note) {
            return n;
        }
    }
}

fn leaf(n: &Note) -> MerkleHashOrchard {
    MerkleHashOrchard::from_cmx(&ExtractedNoteCommitment::from(n.commitment()))
}

fn hexs<F: FnOnce(&mut Vec<u8>)>(f: F) -> String {
    let mut v = Vec::new();
    f(&mut v);
    hex::encode(v)
}

fn rec(n: &Note, keys: &Keys, height: u32, w: &Witness) -> NoteRec {
    NoteRec {
        height,
        txid: "00".repeat(32),
        position: u64::from(w.witnessed_position()),
        value: n.value().inner(),
        scope: "external".into(),
        recipient: hex::encode(n.recipient().to_raw_address_bytes()),
        rho: hex::encode(n.rho().to_bytes()),
        rseed: hex::encode(n.rseed().as_bytes()),
        nf: hex::encode(n.nullifier(&keys.fvk).to_bytes()),
        witness: hexs(|v| write_incremental_witness(w, v).unwrap()),
        spent: None,
        pending: None,
        pending_until: None,
    }
}

/// A wallet with `old` (received before the checkpoint) and `young` (received after it).
/// Returns the state and the checkpoint root.
fn fixture(rng: &mut ChaCha20Rng, old_value: u64, young_value: u64) -> (State, [u8; 32]) {
    let k = keys();
    let mut tree = Tree::empty();
    for _ in 0..5 {
        tree.append(leaf(&random_note(rng, &k, 1))).unwrap();
    }
    let old = random_note(rng, &k, old_value);
    tree.append(leaf(&old)).unwrap();
    let mut w_old = Witness::from_tree(tree.clone()).unwrap();
    for _ in 0..3 {
        let l = leaf(&random_note(rng, &k, 1));
        tree.append(l).unwrap();
        w_old.append(l).unwrap();
    }
    // The checkpoint: end of block CHECKPOINT.
    let root = tree.root().to_bytes();
    let cp = Checkpoint {
        height: CHECKPOINT,
        root: hex::encode(root),
        witnesses: vec![(rec(&old, &k, CHECKPOINT - 50, &w_old).nf, hexs(|v| write_incremental_witness(&w_old, v).unwrap()))],
    };
    // A note received after the checkpoint.
    let young = random_note(rng, &k, young_value);
    tree.append(leaf(&young)).unwrap();
    w_old.append(leaf(&young)).unwrap();
    let w_young = Witness::from_tree(tree.clone()).unwrap();

    let state = State {
        network: "test".into(),
        birthday: CHECKPOINT - 100,
        height: CHECKPOINT + 20,
        hash: "00".repeat(32),
        tree: hexs(|v| write_commitment_tree(&tree, v).unwrap()),
        notes: vec![rec(&old, &k, CHECKPOINT - 50, &w_old), rec(&young, &k, CHECKPOINT + 10, &w_young)],
        checkpoints: vec![cp],
    };
    (state, root)
}

fn own_address() -> String {
    wallet::encode_address(&keys().address(Scope::External), Network::TestNetwork).unwrap()
}

fn vk() -> &'static VerifyingKey {
    static VK: OnceLock<VerifyingKey> = OnceLock::new();
    VK.get_or_init(|| VerifyingKey::build(OrchardCircuitVersion::PostNu6_3))
}

#[test]
fn spend_anchors_at_the_checkpoint_and_the_proof_verifies() {
    let mut rng = ChaCha20Rng::from_seed([1u8; 32]);
    let (state, root) = fixture(&mut rng, 1_000_000, 5_000_000);
    if let Ok(path) = std::env::var("ALIBI_WALLET_FIXTURE") {
        std::fs::write(path, serde_json::to_string(&state).unwrap()).unwrap();
    }

    let t0 = std::time::Instant::now();
    let built = wallet::build(
        &state,
        &keys(),
        &SendRequest { to: own_address(), amount: 400_000, memo: Some("alibi".into()), anchor_height: CHECKPOINT, target_height: TARGET },
        [9u8; 32],
    )
    .expect("build");
    eprintln!("built and proved in {:?}", t0.elapsed());

    // Only the old note can fund it; the larger young note postdates the checkpoint.
    assert_eq!(built.inputs, vec![state.notes[0].nf.clone()]);
    assert_eq!(built.fee, 10_000);
    assert_eq!(built.change, 1_000_000 - 400_000 - 10_000);
    assert_eq!(built.anchor, hex::encode(root));

    let raw = hex::decode(&built.hex).unwrap();
    let branch = BranchId::for_height(&Network::TestNetwork, BlockHeight::from_u32(TARGET));
    let tx = Transaction::read(&raw[..], branch).expect("parses");
    assert_eq!(tx.txid().to_string(), built.txid);
    let bundle = tx.ironwood_bundle().expect("an Ironwood bundle");
    assert_eq!(bundle.anchor().to_bytes(), root, "the transaction commits to the checkpoint root");
    bundle.verify_proof(vk()).expect("the halo2 proof verifies");

    // The verifier's own parser reads the same single anchor.
    let parsed = parse_transaction(&raw).expect("verifier parses it");
    let pools = serde_json::to_value(&parsed).unwrap();
    let iw = pools["pools"].as_array().unwrap().iter().find(|p| p["pool"] == "ironwood").unwrap().clone();
    assert_eq!(iw["anchors"], serde_json::json!([hex::encode(root)]));
}

#[test]
fn a_note_newer_than_the_checkpoint_is_never_used() {
    let mut rng = ChaCha20Rng::from_seed([2u8; 32]);
    // Old note too small for the payment; the young note could pay, but must not.
    let (state, _) = fixture(&mut rng, 50_000, 5_000_000);
    let err = wallet::build(
        &state,
        &keys(),
        &SendRequest { to: own_address(), amount: 400_000, memo: None, anchor_height: CHECKPOINT, target_height: TARGET },
        [9u8; 32],
    )
    .unwrap_err();
    assert!(err.contains("existed at block 4504464 hold 50000"), "{err}");
}

#[test]
fn an_anchor_the_wallet_did_not_checkpoint_is_refused() {
    let mut rng = ChaCha20Rng::from_seed([3u8; 32]);
    let (state, _) = fixture(&mut rng, 1_000_000, 0);
    let req = |h| SendRequest { to: own_address(), amount: 1_000, memo: None, anchor_height: h, target_height: TARGET };
    let off_grid = wallet::build(&state, &keys(), &req(CHECKPOINT - 1), [9u8; 32]).unwrap_err();
    assert!(off_grid.contains("multiple of 144"), "{off_grid}");
    let unheld = wallet::build(&state, &keys(), &req(CHECKPOINT - GRID), [9u8; 32]).unwrap_err();
    assert!(unheld.contains("no checkpoint at block"), "{unheld}");
}

#[test]
fn a_note_being_spent_is_not_offered_again() {
    let mut rng = ChaCha20Rng::from_seed([4u8; 32]);
    let (mut state, _) = fixture(&mut rng, 1_000_000, 0);
    state.notes[0].pending = Some("ab".repeat(32));
    assert!(wallet::spendable_at(&state, CHECKPOINT).unwrap().1.is_empty());
}

#[test]
fn addresses_round_trip_and_reject_the_wrong_network() {
    let a = own_address();
    assert!(a.starts_with("utest1"));
    let back = wallet::decode_address(&a, Network::TestNetwork).unwrap();
    assert_eq!(back.to_raw_address_bytes(), keys().address(Scope::External).to_raw_address_bytes());
    assert!(wallet::decode_address(&a, Network::MainNetwork).is_err());
}
