# Alibi

**Status (backend): live on Convex** at https://compassionate-owl-414.convex.site
(`GET /v1/health`). Mainnet is indexed from block 3,428,142 (the block before Ironwood activated)
and followed by a Convex cron every 2 minutes. Every 144-block boundary is audited against the
server's own tree state: 1,881 audits so far, 0 mismatches. `scripts/e2e.py` passes 18/18 against
the live URL; the transcript is in `evidence/`. The wallet side ("send with alibi") is the next
stage and is not built yet.

Alibi proves that the shielded ZEC a transaction spends was already in the shielded pool before a
given block. The proof reveals one date and nothing else: no balance, no history, no addresses, no
viewing key.

## The problem

When stolen funds are moved into a shielded pool, every shielded coin looks the same from outside.
An exchange or swap service that wants to keep the thief out has no way to tell an honest holder
from the thief, so honest shielded users get delayed or refused. Today the only way out is to hand
over a viewing key and expose your whole history.

## The promise

For any Zcash transaction, Alibi reports the latest block **H** such that every note the
transaction spends from a shielded pool was already in that pool when block H closed. Given a
cut-off block **I** (say, the block that carried a theft), the inputs predate it exactly when
**H < I**.

## Why it holds

Every shielded spend names an *anchor*: the root of its pool's note commitment tree at the end of
some earlier block. The spend's zero-knowledge proof shows each spent note is a leaf of the tree
with that root, and consensus only accepts roots the chain actually produced. Consensus accepts any
earlier root, not just a recent one. A note created after block H is not in the tree at H, so no
valid proof against H's root can spend it.

Alibi adds no new cryptography and no trusted party. It reads the anchor from the transaction and
finds the block where that root first appeared.

## What the backend does

```
compact blocks ──► recompute Sapling / Orchard / Ironwood roots locally ──► roots(pool, root → first block)
                         │                                                        │
       leaf count vs block-reported tree size, parent hash, 144-block audits      │
                                                                                  ▼
txid ──► fetch raw tx from lightwalletd ──► parse v4–v6 tx, read anchors ──► locate each anchor ──► verdict
```

* **Index** (`crates/alibi-service/src/index.rs`). It streams compact blocks from lightwalletd and
  appends every note commitment to a local frontier per pool. After each block it records the root
  of every pool whose tree changed. Roots are recomputed locally and never taken from the server.
  Three checks keep the recomputation honest:
  1. after each block, the leaf count must equal the tree size that block reports;
  2. each block must name the previous indexed block as its parent, otherwise the index rewinds;
  3. at every 144-block boundary, the local roots are compared with roots derived from the
     server's own tree state, and each comparison is stored.
* **Verifier** (`verify.rs`). It fetches the transaction, reads its anchors and locates each one.
  The latest anchor across all pools decides. Anchors above the index (the last few blocks) are
  found by scanning tree states directly.
* **Core** (`crates/alibi-core`). Transaction parsing, root computation and the claim rules. No
  network access.

## API

| Request | Answer |
|---|---|
| `GET /v1/health` | chain tip, index height, roots per pool, audit count and mismatches |
| `GET /v1/tx/{txid}?network=main&before={height or date}` | verdict for a transaction |
| `POST /v1/verify` `{txid}` or `{hex}` (+ `before`, `network`) | same; raw bytes are only used to compute the txid |
| `GET /v1/anchor/{pool}/{anchor}` | the first block whose root equals this anchor |
| `GET /v1/checkpoint?before=…` | the shared 144-block grid boundary to anchor an alibi spend to, with every pool's root there |
| `GET /v1/cutoff?before=2026-09-24T18:30Z` | the first block at or after a UTC time |
| `GET /v1/chain/tip`, `/v1/chain/treestate?height=`, `/v1/chain/blocks?from=&to=` | relay for the wallet: tip, Ironwood tree state, up to 500 compact blocks |
| `POST /v1/chain/broadcast` `{network, hex}` | relay a finished transaction; bytes that do not parse as a transaction are never sent |

Every request takes `network=main` (default) or `network=test`.

Verdict kinds:

| Kind | Meaning |
|---|---|
| `predates` | every input is shielded and existed by a block before the cut-off |
| `predates_shielded_only` | the shielded inputs predate the cut-off; the transparent inputs are not covered |
| `does_not_predate` | the inputs are only shown to exist by a block at or after the cut-off (not evidence of anything) |
| `established` | no cut-off was given; reports the block the inputs existed by |
| `unlocated` | an anchor is not a root the index knows; no claim |
| `no_shielded_inputs` | coinbase or transparent-only; nothing to claim |

Example:

```console
$ curl -s 'https://compassionate-owl-414.convex.site/v1/tx/14960f89420328fa92739217e5e05d6c9bd0e7c1c4640f0c6dc264dc9d3a252f?before=3516995' | jq .verdict.summary
"Every shielded input was already in its pool at the end of block 3516994, before block 3516995. None of them can be value created in block 3516995 or later."
```

## Attacks it refuses

| Attempt | Result |
|---|---|
| Put an old root in a transaction's bytes and show it to a checker | `POST /v1/verify` uses the bytes only to compute the txid and reads everything else from the network. Bytes the network never accepted give 422. Tested live: swapping an old root into a real transaction keeps the same txid, because the txid does not commit to the anchor. The verifier therefore compares the submitted shielded data with the network's copy and refuses the mismatch (422). |
| Serve a compact block with a commitment withheld | The leaf count no longer matches the block's reported tree size, so the batch is rejected. |
| Serve compact blocks that disagree with the server's own tree state | The 144-block audit fails and the index rewinds instead of building on the mismatch. |
| Reorganize the chain under the index | A parent-hash mismatch rewinds 50 blocks and reloads the trees from tree state. |
| Claim an anchor older than the index | Reported as `unlocated`. Alibi never infers "older" from "not found". |
| Spend an old note and a new note together | One anchor per pool, and the latest anchor across pools decides. |

## Send with alibi (the wallet)

A verifier alone cannot help someone paying *after* an incident: ordinary wallets anchor about ten
blocks below the tip, so their spends only prove the coins existed a few minutes ago. The wallet in
`crates/alibi-wallet` does the other half. It runs in the browser as an import-free WebAssembly
module (in a Web Worker) and:

1. derives an Orchard/Ironwood key from a seed generated in the browser (ZIP 32, account 0);
2. scans compact blocks itself, trial-decrypting every Ironwood action with its own viewing key;
3. at the end of every block on the 144-block grid, stores the root and every unspent note's
   Merkle witness, and checks that root against the verifier's independently computed one;
4. for a cut-off block **I**, builds the payment against the grid checkpoint strictly below **I**,
   spending only notes that were already in the tree there, proves it with halo2 in the browser,
   and broadcasts it;
5. asks the verifier for the verdict of its own transaction.

A note received after the checkpoint can never fund the payment: it has no witness at that root,
and a proof against that root for it cannot exist. The wallet refuses rather than falling back to
a recent anchor (`tests/build.rs`).

## What it reveals

* **The claim itself.** An alibi payment says "my inputs were in the pool by checkpoint C". The
  inputs hide among every note in the Ironwood tree at C, not among the notes of one user.
  Everyone proving against the same incident uses the same C, so the anchor does not single
  anyone out among them.
* **That the payment carries an old anchor.** An anchor more than a few blocks old marks the
  payment as deliberate. Grid-aligned old anchors are also what ZIP 318 migration transfers use.
* **To the relay.** The block ranges a wallet syncs (which implies roughly when it was created),
  its IP address, and the raw transaction it broadcasts, the same as any lightwalletd sees. It
  never sees a key, an address or a note. Run your own lightwalletd to remove that.
* **In the browser.** The seed and wallet state are kept in `localStorage`, unencrypted. This is a
  testnet wallet.

## Limitations

* Anchors older than the index start (block 3,428,142 on mainnet) are not evaluated.
* Transparent inputs are reported but never covered.
* Orchard-protocol bundles pad with dummy spends. These are zero-value and counted as spends,
  because they cannot be told apart from outside. The claim concerns value, and dummies carry none.
* The index trusts the server only for what it can check: leaf counts, parent hashes and the
  periodic tree-state audit. Running against your own lightwalletd/Zaino removes that trust.
* Testnet runs NU7 (branch `77190ad9`). The workspace builds on the pre-release zcash crates
  that support it (`zcash_primitives 0.31.0-pre.2`, `zcash_protocol 0.11.0-pre.1`).
* Testnet has one public lightwalletd that answers (`testnet.zec.rocks`), so the testnet index and
  the wallet relay have no fallback server.
* The wallet spends Ironwood notes only. Proving runs single-threaded in WebAssembly: about two
  minutes on a 2-core 2017 laptop, 28 s natively on the same machine.
* The wallet keeps witnesses for the last 60 checkpoints (about 7.5 days on testnet); a cut-off
  older than that needs a restore from the seed with an earlier birthday.

## Verify it yourself

```console
cargo test --release                      # core + service tests (real mainnet fixtures included)
./target/release/alibi check-root --pool ironwood --height 3516996 \
    --anchor b0c03d5aeb68d2cb006f633b79ab99cfd1b0ba9dcfb90dbd8d3542a4621ce02f
python3 scripts/e2e.py http://127.0.0.1:8790   # live checks, transcript written to evidence/
cargo test --release -p alibi-wallet      # builds and proves a checkpoint-anchored spend, verifies the proof
sh scripts/build-wallet.sh                # the browser wallet module, checked to have no imports
node scripts/wallet.mjs new|sync|status|send|verify   # the same wallet engine from the command line
```

`check-root` recomputes a root straight from the server's tree state, with no index involved.

## Run

```console
cargo build --release
./target/release/alibi --db data/alibi.db index      # build the index (about an hour for mainnet)
./target/release/alibi --db data/alibi.db serve --bind 127.0.0.1:8790
```

Environment: `ALIBI_DB`, `ALIBI_BIND`, `ALIBI_NETWORKS` (`main`, `test`), `ALIBI_LWD_MAIN`,
`ALIBI_LWD_TEST`, `RUST_LOG`. The default upstream is a public lightwalletd. Point it at your own
for zero trust.

## Deploy

**Convex (production).** `backend/` holds a Convex app:

* `alibi-core` compiles to a 866 KB WebAssembly module with no imports
  (`crates/alibi-wasm`); `npm run wasm` embeds it into `convex/lib/wasmBytes.ts`;
* Node actions (`convex/chain.ts`) talk gRPC to lightwalletd and run the core in WebAssembly;
* `convex/ledger.ts` holds the index (blocks, roots, audits, progress), `convex/http.ts` serves the
  same API as the Rust server, and `convex/crons.ts` follows the chain;
* the historical index was imported from the Rust indexer's SQLite file
  (`npx convex import`). `scripts/init-progress.ts` refuses to start the Convex index unless the
  server's tree state at the imported height has exactly the roots the local index computed.

```console
cargo build --release -p alibi-wasm --target wasm32-unknown-unknown
cd backend && npm install && npm run wasm && npx convex deploy
```

**Self-hosted.** `deploy/install.sh` installs the binary, an optional pre-built index and a systemd unit under
`/opt/alibi`, `/etc/alibi` and `alibi.service`. It touches nothing else. The binary needs glibc 2.34
or newer.

## Layout

```
crates/alibi-core      tx parsing, tree roots, claim rules (no network)
crates/alibi-service   lightwalletd client, SQLite index, verifier, HTTP API, CLI
crates/alibi-wasm      the core as an import-free WebAssembly module
crates/alibi-wallet    the alibi wallet: scan, checkpoint witnesses, build and prove (wasm)
app/                   dashboard and wallet UI (overlaid onto site/ by the site build)
backend/               Convex deployment: index, cron, HTTP API
proto/                 lightwalletd protocol
scripts/e2e.py         live end-to-end checks
deploy/                systemd unit and installer
site/                  the deployed site: landing page, /dashboard, the wallet module
```

MIT licensed.
