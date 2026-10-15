// The alibi wallet engine: the WebAssembly wallet plus the chain relay, with no DOM.
// Runs in a Web Worker on the site and under Node for the scripted end-to-end run.
//
// Everything secret (the seed) stays in the caller. The relay sees block ranges and finished
// transactions only.

export const GRID = 144;

export class WalletCore {
  constructor(instance) {
    this.x = instance.exports;
  }

  static async load(bytes) {
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return new WalletCore(instance);
  }

  call(fn, req) {
    const x = this.x;
    const input = new TextEncoder().encode(JSON.stringify(req));
    const ptr = x.alloc(input.length);
    new Uint8Array(x.memory.buffer, ptr, input.length).set(input);
    const header = x[fn](ptr, input.length);
    const view = new DataView(x.memory.buffer);
    const outPtr = view.getUint32(header, true);
    const outLen = view.getUint32(header + 4, true);
    const text = new TextDecoder().decode(new Uint8Array(x.memory.buffer, outPtr, outLen).slice());
    x.dealloc(ptr, input.length);
    x.dealloc(outPtr, outLen);
    x.dealloc(header, 8);
    const res = JSON.parse(text);
    if (res.error !== undefined) throw new Error(res.error);
    return res.ok;
  }
}

export const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export function randomHex(n, cryptoImpl = globalThis.crypto) {
  const b = new Uint8Array(n);
  cryptoImpl.getRandomValues(b);
  return hex(b);
}

/** The grid checkpoint an alibi spend for a cut-off block anchors to: the last multiple of 144
 * strictly below it. */
export const checkpointFor = (cutoff) => Math.floor((cutoff - 1) / GRID) * GRID;

export class Relay {
  constructor(base, network, fetchImpl = globalThis.fetch.bind(globalThis)) {
    this.base = base;
    this.network = network;
    this.fetch = fetchImpl;
  }

  async get(path) {
    const r = await this.fetch(this.base + path + (path.includes("?") ? "&" : "?") + "network=" + this.network);
    const body = await r.json().catch(() => ({ message: `HTTP ${r.status}` }));
    if (!r.ok) throw Object.assign(new Error(body.message || `HTTP ${r.status}`), { status: r.status, body });
    return body;
  }

  async post(path, payload) {
    const r = await this.fetch(this.base + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ network: this.network, ...payload }),
    });
    const body = await r.json().catch(() => ({ message: `HTTP ${r.status}` }));
    if (!r.ok) throw Object.assign(new Error(body.message || `HTTP ${r.status}`), { status: r.status, body });
    return body;
  }

  tip() { return this.get("/v1/chain/tip"); }
  treeState(height) { return this.get(`/v1/chain/treestate?height=${height}`); }
  blocks(from, to) { return this.get(`/v1/chain/blocks?from=${from}&to=${to}`); }
  broadcast(hexTx) { return this.post("/v1/chain/broadcast", { hex: hexTx }); }
  checkpoint(before) { return this.get(`/v1/checkpoint?before=${encodeURIComponent(before)}`); }
  verify(txid, before) {
    return this.get(`/v1/tx/${txid}` + (before != null && before !== "" ? `?before=${encodeURIComponent(before)}` : ""));
  }
}

/** Creates a wallet that starts at the current tip minus the confirmation depth. */
export async function createWallet(core, relay, seedHex) {
  const tip = await relay.tip();
  const start = tip.height - tip.confirmations;
  const ts = await relay.treeState(start);
  const { address } = core.call("wallet_address", { network: relay.network, seed: seedHex });
  const { state, root } = core.call("wallet_init", { network: relay.network, height: ts.height, hash: ts.hash, tree: ts.ironwood.tree });
  if (root !== ts.ironwood.root) throw new Error("the wallet's own root for the start block differs from the server's");
  return { address, state };
}

/**
 * Scans from the wallet height to the confirmed tip in batches. `onProgress(state, report)` runs
 * after every batch. Every grid checkpoint the scan passes is compared with the verifier's own
 * index root at that height; a mismatch stops the sync.
 */
export async function sync(core, relay, seedHex, state, onProgress = () => {}, batch = 400) {
  const tip = await relay.tip();
  const target = tip.height - tip.confirmations;
  let total = { blocks: 0, received: [], spent: [], checkpoints: [] };
  while (state.height < target) {
    const from = state.height + 1;
    const to = Math.min(target, from + batch - 1);
    const b = await relay.blocks(from, to);
    const r = core.call("wallet_scan", { network: relay.network, seed: seedHex, state, blocks: b.framed });
    if (r.report.reorg) throw new Error(`chain reorganised at block ${r.report.reorg}; restore the wallet from its seed`);
    state = r.state;
    for (const h of r.report.checkpoints) {
      const mine = state.checkpoints.find((c) => c.height === h);
      let theirs;
      try {
        theirs = await relay.checkpoint(String(h + 1));
      } catch (e) {
        theirs = null; // older than the verifier's index: nothing to compare against
      }
      if (theirs && theirs.height === h) {
        const iw = theirs.roots.find((x) => x.pool === "ironwood");
        if (iw && iw.root !== mine.root) throw new Error(`checkpoint ${h}: the wallet computed ${mine.root}, the verifier has ${iw.root}`);
        mine.verified = true;
      }
    }
    total.blocks += r.report.blocks;
    total.received.push(...r.report.received);
    total.spent.push(...r.report.spent);
    total.checkpoints.push(...r.report.checkpoints);
    onProgress(state, r.report, { from, to, target });
  }
  return { state, report: total, tip: tip.height };
}

export function balances(state) {
  const unspent = state.notes.filter((n) => !n.spent);
  return {
    total: unspent.reduce((s, n) => s + n.value, 0),
    available: unspent.filter((n) => !n.pending).reduce((s, n) => s + n.value, 0),
    notes: unspent.length,
  };
}

/** Builds, broadcasts and returns an alibi payment anchored at the checkpoint for `cutoff`. */
export async function sendWithAlibi(core, relay, seedHex, state, { to, amount, memo, cutoff }, entropyHex) {
  const tip = await relay.tip();
  const anchorHeight = checkpointFor(cutoff);
  const built = core.call("wallet_build", {
    network: relay.network,
    seed: seedHex,
    state,
    send: { to, amount, memo: memo || null, anchor_height: anchorHeight, target_height: tip.height + 1 },
    entropy: entropyHex,
  });
  const sent = await relay.broadcast(built.hex);
  if (sent.txid !== built.txid) throw new Error("the relay reports a different txid than the wallet built");
  for (const n of state.notes) {
    if (built.inputs.includes(n.nf)) {
      n.pending = built.txid;
      n.pending_until = built.expiry_height;
    }
  }
  return { built, state };
}
