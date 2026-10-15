//! Randomness on `wasm32-unknown-unknown`.
//!
//! The module has no imports, so it cannot ask the browser for randomness. Every export that may
//! need randomness takes 32 bytes of host entropy (from `crypto.getRandomValues`) and seeds a
//! ChaCha20 stream with it; `getrandom`'s custom backend draws from that stream. With no seed the
//! backend returns an error instead of inventing one.

use rand_chacha::ChaCha20Rng;
use rand_core::SeedableRng;
use std::sync::Mutex;

static POOL: Mutex<Option<ChaCha20Rng>> = Mutex::new(None);

pub fn seed(entropy: [u8; 32]) {
    // Domain-separate from the transaction builder's own RNG, which is seeded with the same bytes.
    let mut s = entropy;
    s[0] ^= 0x5a;
    *POOL.lock().unwrap() = Some(ChaCha20Rng::from_seed(s));
}

pub fn clear() {
    *POOL.lock().unwrap() = None;
}

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
#[no_mangle]
unsafe extern "Rust" fn __getrandom_v03_custom(dest: *mut u8, len: usize) -> Result<(), getrandom::Error> {
    let mut pool = POOL.lock().map_err(|_| getrandom::Error::new_custom(1))?;
    let rng = pool.as_mut().ok_or(getrandom::Error::new_custom(2))?;
    rand_core::Rng::fill_bytes(rng, core::slice::from_raw_parts_mut(dest, len));
    Ok(())
}
