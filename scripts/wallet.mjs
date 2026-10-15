#!/usr/bin/env node
// Drives the browser wallet engine from the command line, against the live relay and verifier.
//
//   node scripts/wallet.mjs new                     create a wallet (seed stored in $ALIBI_WALLET_DIR)
//   node scripts/wallet.mjs sync                    scan to the confirmed tip
//   node scripts/wallet.mjs status                  balance, notes, checkpoints
//   node scripts/wallet.mjs send <to> <zats> <cutoff-height> [memo]
//   node scripts/wallet.mjs verify <txid> [cutoff]
//
// Environment: ALIBI_API (default https://alibi-zec.vercel.app), ALIBI_NETWORK (default test),
// ALIBI_WALLET_DIR (default ./.wallet). The seed file never leaves that directory.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WalletCore, Relay, createWallet, sync, balances, sendWithAlibi, checkpointFor, randomHex } from "../app/assets/js/wallet/engine.js";

const here = dirname(fileURLToPath(import.meta.url));
const API = process.env.ALIBI_API ?? "https://alibi-zec.vercel.app";
const NET = process.env.ALIBI_NETWORK ?? "test";
const DIR = process.env.ALIBI_WALLET_DIR ?? join(here, "..", ".wallet");
const SEED = join(DIR, `${NET}.seed`);
const STATE = join(DIR, `${NET}.state.json`);

const core = await WalletCore.load(readFileSync(join(here, "..", "app/assets/wasm/alibi_wallet.wasm")));
const relay = new Relay(API, NET);
const load = () => JSON.parse(readFileSync(STATE, "utf8"));
const save = (s) => writeFileSync(STATE, JSON.stringify(s));
const seed = () => readFileSync(SEED, "utf8").trim();
const zec = (z) => (z / 1e8).toFixed(8);

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case "new": {
    if (existsSync(SEED)) throw new Error(`${SEED} exists; refusing to overwrite a seed`);
    mkdirSync(DIR, { recursive: true, mode: 0o700 });
    const s = randomHex(32, webcrypto);
    writeFileSync(SEED, s + "\n", { mode: 0o600 });
    const { address, state } = await createWallet(core, relay, s);
    save(state);
    console.log(JSON.stringify({ network: NET, address, birthday: state.birthday }, null, 2));
    break;
  }
  case "address":
    console.log(core.call("wallet_address", { network: NET, seed: seed() }).address);
    break;
  case "sync": {
    const t0 = Date.now();
    const r = await sync(core, relay, seed(), load(), (st, rep, p) => {
      save(st);
      process.stderr.write(`scanned ${p.from}..${p.to} of ${p.target}: +${rep.received.length} notes, ${rep.spent.length} spent, checkpoints ${rep.checkpoints.join(",") || "-"}\n`);
    });
    save(r.state);
    console.log(JSON.stringify({ height: r.state.height, tip: r.tip, blocks: r.report.blocks, received: r.report.received.length, spent: r.report.spent.length, checkpoints: r.report.checkpoints, ms: Date.now() - t0, ...balances(r.state) }, null, 2));
    break;
  }
  case "status": {
    const s = load();
    console.log(JSON.stringify({
      height: s.height,
      birthday: s.birthday,
      ...balances(s),
      notes: s.notes.map((n) => ({ height: n.height, value: n.value, scope: n.scope, txid: n.txid, spent: n.spent, pending: n.pending ?? null })),
      checkpoints: s.checkpoints.map((c) => ({ height: c.height, notes: c.witnesses.length, verified: !!c.verified })),
    }, null, 2));
    break;
  }
  case "send": {
    const [to, amount, cutoff, memo] = args;
    const s = load();
    const t0 = Date.now();
    const { built, state } = await sendWithAlibi(core, relay, seed(), s, { to, amount: Number(amount), memo, cutoff: Number(cutoff) }, randomHex(32, webcrypto));
    save(state);
    console.log(JSON.stringify({ txid: built.txid, anchor_height: built.anchor_height, checkpoint_for_cutoff: checkpointFor(Number(cutoff)), fee: built.fee, change: built.change, inputs: built.inputs.length, bytes: built.hex.length / 2, ms: Date.now() - t0 }, null, 2));
    break;
  }
  case "verify": {
    const [txid, before] = args;
    const r = await relay.verify(txid, before);
    console.log(JSON.stringify({ status: r.status, mined: r.mined, verdict: { kind: r.verdict.kind, existed_by: r.verdict.existed_by, summary: r.verdict.summary } }, null, 2));
    break;
  }
  default:
    console.error("usage: wallet.mjs new | address | sync | status | send <to> <zats> <cutoff> [memo] | verify <txid> [cutoff]");
    process.exit(2);
}
