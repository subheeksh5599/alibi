// Runs the wallet engine off the main thread: scanning and proving would otherwise freeze the page.
// Messages in:  {id, op, args}. Messages out: {id, ok} | {id, error} | {id, progress}.
// The worker keeps no secrets between calls; the page passes the seed with each request.
import { WalletCore, Relay, createWallet, sync, sendWithAlibi } from "./engine.js";

let core = null;
async function engine() {
  if (!core) {
    const bytes = await (await fetch("/assets/wasm/alibi_wallet.wasm")).arrayBuffer();
    core = await WalletCore.load(bytes);
  }
  return core;
}

const ops = {
  async create({ api, network, seed }) {
    return createWallet(await engine(), new Relay(api, network), seed);
  },
  async address({ network, seed }) {
    return (await engine()).call("wallet_address", { network, seed });
  },
  async restore({ api, network, seed, birthday }) {
    const c = await engine();
    const relay = new Relay(api, network);
    const ts = await relay.treeState(birthday - 1);
    const { state, root } = c.call("wallet_init", { network, height: ts.height, hash: ts.hash, tree: ts.ironwood.tree });
    if (root !== ts.ironwood.root) throw new Error("the wallet's own root for the start block differs from the server's");
    return { address: c.call("wallet_address", { network, seed }).address, state };
  },
  async sync({ api, network, seed, state }, id) {
    const r = await sync(await engine(), new Relay(api, network), seed, state, (st, rep, p) => {
      postMessage({ id, progress: { state: st, from: p.from, to: p.to, target: p.target, received: rep.received.length } });
    });
    return r;
  },
  async spendable({ state, anchorHeight }) {
    return (await engine()).call("wallet_spendable", { state, anchor_height: anchorHeight });
  },
  async send({ api, network, seed, state, send, entropy }) {
    return sendWithAlibi(await engine(), new Relay(api, network), seed, state, send, entropy);
  },
};

onmessage = async (e) => {
  const { id, op, args } = e.data;
  try {
    if (!ops[op]) throw new Error(`unknown operation ${op}`);
    postMessage({ id, ok: await ops[op](args, id) });
  } catch (err) {
    postMessage({ id, error: String(err && err.message ? err.message : err) });
  }
};
