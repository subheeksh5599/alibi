// Wallet and Send views. The seed and the wallet state live in this browser's localStorage; the
// worker does the scanning and proving.
import { checkpointFor, randomHex, balances, GRID } from "./engine.js";

const NETWORK = "test";
const KEY = "alibi.wallet." + NETWORK;
const API = window.ALIBI_API || "";
const FEE_ESTIMATE = 10_000; // ZIP 317 minimum (two logical actions), in zatoshis

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const num = (n) => (n == null ? "–" : Number(n).toLocaleString("en-US"));
const taz = (z) => (z / 1e8).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 8 }) + " TAZ";
const row = (k, v) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`;

// ------------------------------------------------------------------ worker

const worker = new Worker("/assets/js/wallet/worker.js", { type: "module" });
let nextId = 1;
const pending = new Map();
worker.onmessage = (e) => {
  const p = pending.get(e.data.id);
  if (!p) return;
  if (e.data.progress) return p.onProgress && p.onProgress(e.data.progress);
  pending.delete(e.data.id);
  if (e.data.error !== undefined) p.reject(new Error(e.data.error));
  else p.resolve(e.data.ok);
};
function run(op, args, onProgress) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, onProgress });
    worker.postMessage({ id, op, args: { api: API, network: NETWORK, ...args } });
  });
}

// ------------------------------------------------------------------ storage

let W = load();
function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "null");
  } catch {
    return null;
  }
}
function save() {
  if (W) localStorage.setItem(KEY, JSON.stringify(W));
  else localStorage.removeItem(KEY);
}

// ------------------------------------------------------------------ wallet view

let syncing = null;
let lastTip = null;
let syncMsg = "";

function showErr(id, msg) {
  $(id).textContent = msg || "";
  $(id).hidden = !msg;
}

function renderWallet() {
  $("w-empty").hidden = !!W;
  $("w-main").hidden = !W;
  $("w-sync").hidden = !W;
  if (!W) return;
  const b = balances(W.state);
  const st = W.state;
  $("w-sync").disabled = !!syncing;
  $("w-sync").textContent = syncing ? "Syncing…" : "Sync";
  $("w-summary").innerHTML =
    row("Address", `<span class="hex">${esc(W.address)}</span><br><small><button type="button" class="link" id="w-copy">Copy</button> · <a class="link" href="https://faucet.testnet.valargroup.dev/" target="_blank" rel="noopener">Testnet faucet</a></small>`) +
    row("Balance", `<span class="num">${taz(b.total)}</span>` + (b.available !== b.total ? `<br><small>${taz(b.available)} available, the rest is in a payment waiting to be mined</small>` : "")) +
    row("Synced to", `<span class="num">block ${num(st.height)}</span>` + (lastTip ? `<br><small>chain tip ${num(lastTip)}${syncMsg ? " · " + esc(syncMsg) : ""}</small>` : syncMsg ? `<br><small>${esc(syncMsg)}</small>` : ""));
  $("w-copy").onclick = () => navigator.clipboard.writeText(W.address).then(() => ($("w-copy").textContent = "Copied"));

  const notes = st.notes.slice().reverse();
  $("w-notes").innerHTML = notes.length
    ? `<table class="tbl"><thead><tr><th>Received in block</th><th>Amount</th><th>Kind</th><th>State</th></tr></thead><tbody>` +
      notes
        .map(
          (n) =>
            `<tr><td class="num">${num(n.height)}</td><td class="num">${taz(n.value)}</td><td>${n.scope === "internal" ? "Change" : "Received"}</td><td>${
              n.spent ? `Spent in block ${num(n.spent.height)}` : n.pending ? `<span class="soft">Being spent</span>` : `<span class="ok-t">Unspent</span>`
            }</td></tr>`,
        )
        .join("") +
      `</tbody></table>`
    : `<div class="muted">No notes yet. Send testnet ZEC to the address above; it shows up about ten blocks after it is mined.</div>`;

  const cps = st.checkpoints.slice().reverse().slice(0, 12);
  $("w-cps").innerHTML = cps.length
    ? `<table class="tbl"><thead><tr><th>Block</th><th>Unspent notes witnessed</th><th>Root matches the verifier</th></tr></thead><tbody>` +
      cps.map((c) => `<tr><td class="num">${num(c.height)}</td><td class="num">${c.witnesses.length}</td><td>${c.verified ? '<span class="ok-t">Yes</span>' : '<span class="soft">Not checked</span>'}</td></tr>`).join("") +
      `</tbody></table>`
    : `<div class="muted">The first checkpoint is block ${num(Math.ceil(st.birthday / GRID) * GRID)}. Checkpoints come every ${GRID} blocks.</div>`;

  $("w-seedbox").innerHTML =
    row("Seed", `<span class="hex" id="w-seedval">••••••••</span><br><small><button type="button" class="link" id="w-reveal">Reveal</button></small>`) + row("Birthday block", `<span class="num">${num(st.birthday)}</span>`);
  $("w-reveal").onclick = () => {
    $("w-seedval").textContent = W.seed;
    $("w-reveal").remove();
  };
}

async function doSync() {
  if (!W || syncing) return syncing;
  syncMsg = "";
  syncing = run("sync", { seed: W.seed, state: W.state }, (p) => {
    W.state = p.state;
    save();
    syncMsg = `scanning ${num(p.to)} of ${num(p.target)}`;
    renderWallet();
  })
    .then((r) => {
      W.state = r.state;
      lastTip = r.tip;
      syncMsg = "";
      save();
    })
    .catch((e) => {
      syncMsg = e.message;
    })
    .finally(() => {
      syncing = null;
      renderWallet();
      renderSendGate();
    });
  renderWallet();
  return syncing;
}

$("w-create").onclick = async () => {
  showErr("w-err", "");
  $("w-create").disabled = true;
  try {
    const seed = randomHex(32);
    const { address, state } = await run("create", { seed });
    W = { seed, address, state };
    save();
    renderWallet();
  } catch (e) {
    showErr("w-err", e.message);
  } finally {
    $("w-create").disabled = false;
  }
};
$("w-restore-open").onclick = () => ($("w-restore").hidden = !$("w-restore").hidden);
$("w-restore").onsubmit = async (e) => {
  e.preventDefault();
  const seed = $("w-seed").value.trim().toLowerCase();
  const birthday = Number($("w-birthday").value.trim());
  if (!/^[0-9a-f]{64}$/.test(seed)) return showErr("w-err", "The seed is 64 hexadecimal characters.");
  if (!Number.isInteger(birthday) || birthday < 2) return showErr("w-err", "Enter the block the wallet was created at.");
  showErr("w-err", "");
  try {
    const { address, state } = await run("restore", { seed, birthday });
    W = { seed, address, state };
    save();
    renderWallet();
    doSync();
  } catch (err) {
    showErr("w-err", err.message);
  }
};
$("w-sync").onclick = doSync;
$("w-forget").onclick = () => {
  if (!confirm("Remove this wallet from the browser? Without the seed its funds cannot be recovered.")) return;
  W = null;
  save();
  renderWallet();
  renderSendGate();
};

// ------------------------------------------------------------------ send view

let cutoffHeight = null;
let preview = null;
let previewSeq = 0;

function renderSendGate() {
  $("s-nowallet").hidden = !!W;
  $("s-form").hidden = !W;
}

function parseAmount() {
  const s = $("s-amount").value.trim();
  if (!/^\d+(\.\d{1,8})?$/.test(s)) return null;
  const [i, f = ""] = s.split(".");
  return Number(i) * 1e8 + Number((f + "00000000").slice(0, 8));
}

async function resolveCutoff(text) {
  if (/^\d+$/.test(text)) return Number(text);
  const r = await fetch(`${API}/v1/cutoff?network=${NETWORK}&before=${encodeURIComponent(text)}`);
  const b = await r.json();
  if (!r.ok) throw new Error(b.message || "cannot resolve the cut-off");
  return b.height;
}

async function updatePreview() {
  const seq = ++previewSeq;
  const el = $("s-preview");
  $("s-go").disabled = true;
  preview = null;
  const text = $("s-cutoff").value.trim();
  if (!W || !text) {
    el.innerHTML = "";
    return;
  }
  let h;
  try {
    h = await resolveCutoff(text);
  } catch (e) {
    if (seq === previewSeq) el.innerHTML = `<span class="no-t">${esc(e.message)}</span>`;
    return;
  }
  if (seq !== previewSeq) return;
  cutoffHeight = h;
  const cp = checkpointFor(h);
  const sp = await run("spendable", { state: W.state, anchorHeight: cp });
  if (seq !== previewSeq) return;
  const amount = parseAmount();
  if (!sp.checkpoint) {
    const held = W.state.checkpoints.map((c) => c.height);
    el.innerHTML = `<span class="no-t">The spend would anchor at block ${num(cp)}, and this wallet holds no checkpoint there. ${
      held.length ? `It holds checkpoints from block ${num(held[0])} to ${num(held[held.length - 1])}.` : `Its first checkpoint will be block ${num(Math.ceil(W.state.birthday / GRID) * GRID)}.`
    }</span>`;
    return;
  }
  preview = { cutoff: h, checkpoint: cp, total: sp.total };
  const enough = amount !== null && amount > 0 && sp.total >= amount + FEE_ESTIMATE;
  el.innerHTML =
    `Cut-off block <b>${num(h)}</b> · anchors at checkpoint <b>${num(cp)}</b> · ` +
    `<b>${sp.notes.length}</b> note${sp.notes.length === 1 ? "" : "s"} existed by then, <b>${taz(sp.total)}</b>` +
    (amount !== null && amount > 0 && !enough ? `<br><span class="no-t">Not enough: the payment plus a ${taz(FEE_ESTIMATE)} fee needs ${taz(amount + FEE_ESTIMATE)}.</span>` : "");
  $("s-go").disabled = !enough || !$("s-to").value.trim();
}

let debounce;
["s-to", "s-amount", "s-cutoff"].forEach((id) =>
  $(id).addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(updatePreview, 350);
  }),
);
$("s-self").onclick = () => {
  if (W) $("s-to").value = W.address;
  updatePreview();
};

$("s-form").onsubmit = async (e) => {
  e.preventDefault();
  showErr("s-err", "");
  const amount = parseAmount();
  const to = $("s-to").value.trim();
  if (!preview || amount === null || !to) return;
  const out = $("s-out");
  const go = $("s-go");
  go.disabled = true;
  const t0 = Date.now();
  out.innerHTML = `<div class="panel muted block"><span class="spin"></span>Building and proving the transaction in this browser <span id="s-elapsed">0s</span></div>`;
  const tick = setInterval(() => {
    const el = $("s-elapsed");
    if (el) el.textContent = Math.round((Date.now() - t0) / 1000) + "s";
  }, 1000);
  try {
    const r = await run("send", {
      seed: W.seed,
      state: W.state,
      send: { to, amount, memo: $("s-memo").value, cutoff: preview.cutoff },
      entropy: randomHex(32),
    });
    clearInterval(tick);
    W.state = r.state;
    save();
    renderWallet();
    showResult(r.built, preview.cutoff, Math.round((Date.now() - t0) / 1000));
  } catch (err) {
    clearInterval(tick);
    out.innerHTML = "";
    showErr("s-err", err.message);
  } finally {
    go.disabled = false;
  }
};

function showResult(built, cutoff, secs) {
  const verifyLink = `#/verify?tx=${built.txid}&before=${cutoff}&net=${NETWORK}`;
  $("s-out").innerHTML =
    `<div class="panel block"><table class="kv">` +
    row("Transaction", `<span class="hex">${esc(built.txid)}</span><br><small>broadcast · built and proved in ${secs}s</small>`) +
    row("Anchor", `<span class="num">checkpoint block ${num(built.anchor_height)}</span><br><small class="hex">${esc(built.anchor)}</small>`) +
    row("Fee", `<span class="num">${taz(built.fee)}</span>`) +
    `</table></div><div id="s-verdict">${verdictPending()}</div>`;
  pollVerdict(built.txid, cutoff, verifyLink, 0);
}

const verdictPending = () => `<div class="panel muted block"><span class="spin"></span>Waiting for the verifier to see the transaction</div>`;

async function pollVerdict(txid, cutoff, link, attempt) {
  let r;
  try {
    const res = await fetch(`${API}/v1/tx/${txid}?network=${NETWORK}&before=${cutoff}`);
    r = { status: res.status, body: await res.json() };
  } catch {
    r = { status: 0 };
  }
  const el = $("s-verdict");
  if (!el) return;
  if (r.status === 200) {
    const v = r.body.verdict;
    const ok = v.kind === "predates" || v.kind === "predates_shielded_only";
    el.innerHTML =
      `<div class="panel verdict block"><span class="pill ${ok ? "ok" : "no"}">${ok ? "Predates cut-off" : esc(v.kind)}</span>` +
      `<p class="summary">${esc(v.summary)}</p>` +
      `<p class="soft small">${r.body.status === "mined" ? `Mined in block ${num(r.body.mined.height)}.` : "In the mempool; the verdict holds once it is mined."} <a class="link" href="${link}">Open in Verify</a></p></div>`;
    if (r.body.status !== "mined" && attempt < 60) setTimeout(() => pollVerdict(txid, cutoff, link, attempt + 1), 20000);
    return;
  }
  if (attempt < 30) setTimeout(() => pollVerdict(txid, cutoff, link, attempt + 1), 5000);
  else el.innerHTML = `<div class="panel muted block no-t">${esc((r.body && r.body.message) || "The verifier has not seen the transaction yet.")}</div>`;
}

// ------------------------------------------------------------------ wiring

window.addEventListener("alibi:view", (e) => {
  if (e.detail === "wallet") {
    renderWallet();
    doSync();
  }
  if (e.detail === "send") {
    renderSendGate();
    if (W) doSync().then(updatePreview);
  }
});
renderWallet();
renderSendGate();
const initial = location.hash.replace(/^#\/?/, "").split("?")[0];
if (initial === "wallet" || initial === "send") window.dispatchEvent(new CustomEvent("alibi:view", { detail: initial }));
setInterval(() => {
  const v = location.hash.replace(/^#\/?/, "").split("?")[0];
  if (W && (v === "wallet" || v === "send")) doSync();
}, 120000);
