//! Sapling provers that are never invoked. The wallet builds transactions with no Sapling bundle,
//! so the builder never asks for a Sapling proof; these satisfy its type parameters without
//! shipping the Sapling parameter files.

use rand_core::Rng;
use sapling::bundle::GrothProofBytes;
use sapling::circuit;
use sapling::keys::EphemeralSecretKey;
use sapling::prover::{OutputProver, SpendProver};
use sapling::value::{NoteValue, ValueCommitTrapdoor};
use sapling::{Diversifier, MerklePath, PaymentAddress, ProofGenerationKey, Rseed};

pub struct NoSapling;

impl SpendProver for NoSapling {
    type Proof = GrothProofBytes;

    fn prepare_circuit(
        _: ProofGenerationKey,
        _: Diversifier,
        _: Rseed,
        _: NoteValue,
        _: jubjub::Fr,
        _: ValueCommitTrapdoor,
        _: bls12_381::Scalar,
        _: MerklePath,
    ) -> Option<circuit::Spend> {
        None
    }

    fn create_proof<R: Rng>(&self, _: circuit::Spend, _: &mut R) -> Self::Proof {
        unreachable!("the wallet never builds a Sapling spend")
    }

    fn encode_proof(proof: Self::Proof) -> GrothProofBytes {
        proof
    }
}

impl OutputProver for NoSapling {
    type Proof = GrothProofBytes;

    fn prepare_circuit(
        _: &EphemeralSecretKey,
        _: PaymentAddress,
        _: jubjub::Fr,
        _: NoteValue,
        _: ValueCommitTrapdoor,
    ) -> circuit::Output {
        unreachable!("the wallet never builds a Sapling output")
    }

    fn create_proof<R: Rng>(&self, _: circuit::Output, _: &mut R) -> Self::Proof {
        unreachable!("the wallet never builds a Sapling output")
    }

    fn encode_proof(proof: Self::Proof) -> GrothProofBytes {
        proof
    }
}
