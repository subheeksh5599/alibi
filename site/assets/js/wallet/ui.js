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
  const D = window.AlibiDash;
  const behind = lastTip ? Math.max(0, lastTip - 10 - st.height) : null;
  $("w-summary").innerHTML =
    `<div class="box account">` +
    `<div><p class="acct-label">Shielded balance · Ironwood</p><p class="big">${taz(b.total)}</p>` +
    `<p class="acct-meta">${num(b.notes)} unspent note${b.notes === 1 ? "" : "s"}` +
    (b.available !== b.total ? ` · ${taz(b.available)} available, the rest is in a payment waiting to be mined` : "") + `</p></div>` +
    `<div><p class="acct-label">Address</p><div class="hashline" style="margin-top:8px">${esc(W.address)}${D.copyBtn(W.address)}</div>` +
    `<p class="acct-meta"><a class="link" href="https://faucet.testnet.valargroup.dev/" target="_blank" rel="noopener">Get testnet ZEC</a></p>` +
    `<p class="acct-label">Synced to</p><p class="acct-meta" style="color:var(--ink);font-family:var(--mono)">#${num(st.height)}` +
    (syncing ? ` <span class="warn-t">· ${esc(syncMsg || "syncing")}</span>` : syncMsg ? ` <span class="no-t">· ${esc(syncMsg)}</span>` : behind === 0 ? ` <span class="ok-t">· up to date</span>` : "") +
    `</p></div></div>`;

  const notes = st.notes.slice().reverse();
  $("w-notes").innerHTML = notes.length
    ? `<table class="tbl"><thead><tr><th>Received in</th><th class="r">Amount</th><th>Kind</th><th>State</th></tr></thead><tbody>` +
      notes
        .map(
          (n) =>
            `<tr><td>#${num(n.height)}</td><td class="r">${taz(n.value)}</td><td>${n.scope === "internal" ? "Change" : "Received"}</td><td>${
              n.spent ? `<span style="color:var(--faint)">Spent in #${num(n.spent.height)}</span>` : n.pending ? `<span class="warn-t">Being spent</span>` : `<span class="ok-t">Unspent</span>`
            }</td></tr>`,
        )
        .join("") +
      `</tbody></table>`
    : `<div class="empty" style="min-height:120px">No notes yet. Send testnet ZEC to the address above; it shows up about ten blocks after it is mined.</div>`;

  const cps = st.checkpoints.slice().reverse().slice(0, 12);
  $("w-cps").innerHTML = cps.length
    ? `<table class="tbl"><thead><tr><th>Checkpoint</th><th class="r">Unspent notes witnessed</th><th>Root matches the verifier</th></tr></thead><tbody>` +
      cps.map((c) => `<tr><td>#${num(c.height)}</td><td class="r">${c.witnesses.length}</td><td>${c.verified ? '<span class="ok-t">Yes</span>' : '<span style="color:var(--faint)">Not checked yet</span>'}</td></tr>`).join("") +
      `</tbody></table>`
    : `<div class="empty" style="min-height:120px">The first checkpoint is block #${num(Math.ceil(st.birthday / GRID) * GRID)}. Checkpoints come every ${GRID} blocks.</div>`;

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
  $("s-side").hidden = !W;
  $("s-split").hidden = !W;
}

const EMPTY_PREVIEW = `<div class="empty"><span class="empty-icon">&gt;_</span>Enter a cut-off to see which of your notes can pay.</div>`;
function previewPanel({ cutoff, cp, notes, total, amount, problem }) {
  const D = window.AlibiDash;
  const enough = amount !== null && amount > 0 && total >= amount + FEE_ESTIMATE;
  const flow =
    `<div class="flow-line" style="justify-content:flex-start">` +
    `<span class="node hi"><small>Notes existed by</small><b>#${num(cp)}</b></span><span class="rel">before</span>` +
    `<span class="node"><small>Cut-off</small><b>#${num(cutoff)}</b></span></div>`;
  const rows = notes.length
    ? `<table class="tbl" style="border-top:1px solid var(--line)"><thead><tr><th>Note received in</th><th class="r">Amount</th></tr></thead><tbody>` +
      notes.map((n) => `<tr><td>#${num(n.height)}</td><td class="r">${taz(n.value)}</td></tr>`).join("") +
      `</tbody></table>`
    : "";
  return (
    `<div class="inner"><p class="box-title"><span>&gt;</span> ALIBI_PREVIEW</p>${flow}` +
    `<dl class="tiles tight" style="margin-top:18px">` +
    D.tile("Checkpoint anchor", "#" + num(cp), "", num(cutoff - cp) + " blocks before the cut-off") +
    D.tile("Can pay", taz(total), total > 0 ? "ok" : "no", `${notes.length} note${notes.length === 1 ? "" : "s"} already in the pool there`) +
    `</dl>` +
    (problem ? `<p class="err">${esc(problem)}</p>` : amount !== null && amount > 0 && !enough ? `<p class="err">Not enough: ${taz(amount)} plus a ${taz(FEE_ESTIMATE)} fee needs ${taz(amount + FEE_ESTIMATE)}.</p>` : "") +
    `</div>` + rows
  );
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
    el.innerHTML = EMPTY_PREVIEW;
    return;
  }
  let h;
  try {
    h = await resolveCutoff(text);
  } catch (e) {
    if (seq === previewSeq) el.innerHTML = `<div class="inner"><p class="err" style="margin:0">${esc(e.message)}</p></div>`;
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
    el.innerHTML = previewPanel({
      cutoff: h, cp, notes: [], total: 0, amount,
      problem: cp > W.state.height
        ? `Checkpoint #${num(cp)} is not reached yet. It becomes usable once block #${num(cp + 10)} is mined and the wallet syncs.`
        : `This wallet holds no checkpoint at #${num(cp)}. ` +
          (held.length ? `It holds #${num(held[0])} to #${num(held[held.length - 1])}.` : `It was created after that block; restore it with an earlier birthday.`),
    });
    return;
  }
  preview = { cutoff: h, checkpoint: cp, total: sp.total };
  el.innerHTML = previewPanel({ cutoff: h, cp, notes: sp.notes, total: sp.total, amount });
  const enough = amount !== null && amount > 0 && sp.total >= amount + FEE_ESTIMATE;
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
  out.innerHTML = `<div class="res"><div class="box loading"><span class="spin"></span>Building and proving the transaction in this browser · <span id="s-elapsed">0s</span></div></div>`;
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
  const D = window.AlibiDash;
  $("s-out").innerHTML =
    `<div class="res"><div class="res-head"><div><p class="eyebrow">&gt; PAYMENT_BROADCAST</p><h2>Alibi payment sent</h2>` +
    `<div class="hashline">${esc(built.txid)}${D.copyBtn(built.txid)}</div></div></div>` +
    `<dl class="tiles" style="margin-top:18px">` +
    D.tile("Anchored at", "#" + num(built.anchor_height), "ok", "the checkpoint before cut-off #" + num(cutoff)) +
    D.tile("Proved in browser", secs + " s", "", "halo2, single thread, no server") +
    D.tile("Fee", taz(built.fee), "", "ZIP 317") +
    D.tile("Change", taz(built.change), "", "back to this wallet") +
    `</dl></div><div id="s-verdict">${verdictPending()}</div>`;
  pollVerdict(built.txid, cutoff, 0);
}

const verdictPending = () => `<div class="res"><div class="box loading"><span class="spin"></span>Waiting for the verifier to see the transaction on the network</div></div>`;

async function pollVerdict(txid, cutoff, attempt) {
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
    el.innerHTML = window.AlibiDash.verdictBlock(r.body, { eyebrow: "INDEPENDENT_VERDICT", title: "What the verifier sees", noExport: true });
    if (r.body.status !== "mined" && attempt < 60) setTimeout(() => pollVerdict(txid, cutoff, attempt + 1), 20000);
    return;
  }
  if (attempt < 30) setTimeout(() => pollVerdict(txid, cutoff, attempt + 1), 5000);
  else el.innerHTML = `<div class="res"><div class="box fail">${esc((r.body && r.body.message) || "The verifier has not seen the transaction yet.")}</div></div>`;
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
