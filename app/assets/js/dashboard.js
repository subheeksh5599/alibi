(function () {
  "use strict";

  // The site proxies /v1 to the backend. A local static server has no proxy.
  var API = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? "https://compassionate-owl-414.convex.site" : "";
  var HEX64 = /^[0-9a-f]{64}$/;

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  var num = function (n) { return n == null ? "–" : Number(n).toLocaleString("en-US"); };
  var utc = function (t) { return t ? new Date(t * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC" : ""; };
  var loading = function (msg) { return '<div class="box loading"><span class="spin"></span>' + esc(msg) + "</div>"; };
  var failure = function (body) { return '<div class="box fail">' + esc(body.message || "Request failed.") + "</div>"; };
  var row = function (k, v) { return "<tr><th>" + esc(k) + "</th><td>" + v + "</td></tr>"; };
  var sub = function (s) { return s ? "<small>" + esc(s) + "</small>" : ""; };
  var tile = function (k, v, cls, note) { return '<div class="tile ' + (cls || "") + '"><dt>' + esc(k) + "</dt><dd>" + v + sub(note) + "</dd></div>"; };
  var pool = function (p) { return '<span class="pool ' + esc(p) + '">' + esc(p) + "</span>"; };
  var COPY_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="8.5" height="8.5" rx="1.5"/><path d="M10.5 5V3.5A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5H5"/></svg>';
  var copyBtn = function (text) { return '<button type="button" class="copy" data-copy="' + esc(text) + '" title="Copy" aria-label="Copy">' + COPY_ICON + "</button>"; };

  // Copy buttons and result tabs work anywhere on the page, including markup the wallet renders.
  document.addEventListener("click", function (e) {
    var c = e.target.closest("[data-copy]");
    if (c) {
      navigator.clipboard.writeText(c.getAttribute("data-copy")).then(function () { c.title = "Copied"; });
      return;
    }
    var t = e.target.closest(".tab");
    if (t) {
      var root = t.closest(".res");
      Array.prototype.forEach.call(root.querySelectorAll(".tab"), function (x) { x.classList.toggle("on", x === t); });
      Array.prototype.forEach.call(root.querySelectorAll(".pane"), function (p) { p.classList.toggle("on", p.getAttribute("data-pane") === t.getAttribute("data-tab")); });
      return;
    }
    var x = e.target.closest("[data-export]");
    if (x && lastResult) {
      var blob = new Blob([JSON.stringify(lastResult, null, 2)], { type: "application/json" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "alibi-" + lastResult.txid.slice(0, 12) + ".json";
      a.click();
      URL.revokeObjectURL(a.href);
    }
  });

  var NET = localStorage.getItem("alibi.net") === "test" ? "test" : "main";
  window.ALIBI_API = API;
  window.AlibiDash = { esc: esc, num: num, utc: utc, copyBtn: copyBtn, tile: tile, pool: pool, verdictBlock: null };

  function withNet(path) {
    return path + (path.indexOf("?") >= 0 ? "&" : "?") + "network=" + NET;
  }

  function api(path) {
    return fetch(API + withNet(path)).then(function (r) {
      return r.json().then(function (b) { return { status: r.status, body: b }; },
        function () { return { status: r.status, body: { message: "Unexpected response (HTTP " + r.status + ")." } }; });
    }, function () {
      return { status: 0, body: { message: "Could not reach the verifier." } };
    });
  }

  function setErr(el, msg) { el.textContent = msg || ""; el.hidden = !msg; }

  // ------------------------------------------------------------ router

  var VIEWS = ["verify", "checkpoint", "anchor", "index", "wallet", "send"];
  var TITLES = { verify: "Verify", checkpoint: "Checkpoint", anchor: "Anchor", index: "Index", wallet: "Wallet", send: "Send with alibi" };
  var EMPTY_CP = $("cp-out").innerHTML, EMPTY_AN = $("an-out").innerHTML;

  function setNet(n, quiet) {
    NET = n === "test" ? "test" : "main";
    localStorage.setItem("alibi.net", NET);
    Array.prototype.forEach.call(document.querySelectorAll(".seg button"), function (b) {
      b.classList.toggle("on", b.getAttribute("data-net") === NET);
    });
    if (!quiet) {
      $("vf-out").innerHTML = "";
      $("cp-out").innerHTML = EMPTY_CP;
      $("an-out").innerHTML = EMPTY_AN;
      lastRun = null;
      renderStatus();
    }
  }
  Array.prototype.forEach.call(document.querySelectorAll(".seg button"), function (b) {
    b.addEventListener("click", function () { setNet(b.getAttribute("data-net")); });
  });
  function route() {
    var parts = location.hash.replace(/^#\/?/, "").split("?");
    var view = VIEWS.indexOf(parts[0]) >= 0 ? parts[0] : "verify";
    VIEWS.forEach(function (v) { $("view-" + v).classList.toggle("on", v === view); });
    Array.prototype.forEach.call(document.querySelectorAll(".nav a"), function (a) {
      var on = a.getAttribute("data-view") === view;
      a.classList.toggle("on", on);
      if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    document.title = TITLES[view] + " | Alibi";
    var q = new URLSearchParams(parts[1] || "");
    if (q.get("net") && q.get("net") !== NET) setNet(q.get("net"));
    // The wallet is a testnet wallet; its views always show the testnet index.
    if ((view === "wallet" || view === "send") && NET !== "test") setNet("test");
    window.dispatchEvent(new CustomEvent("alibi:view", { detail: view }));
    if (view === "verify" && q.get("tx") && q.get("tx") !== lastRun) {
      $("vf-tx").value = q.get("tx");
      $("vf-before").value = q.get("before") || "";
      verify(false);
    }
    if (view === "index") loadIndex();
  }

  // ------------------------------------------------------------ verify

  var LABEL = {
    predates: ["Predates cut-off", "ok"],
    predates_shielded_only: ["Shielded inputs predate cut-off", "ok"],
    does_not_predate: ["No claim for this cut-off", "no"],
    established: ["Inputs dated", ""],
    unlocated: ["Anchor not located", "no"],
    no_shielded_inputs: ["No shielded inputs", ""],
  };
  var COVER = { all_inputs: "Every input", shielded_only: "Shielded only", none: "None" };
  var lastRun = null;
  var lastResult = null;

  /** The verdict page for one verifier response. Also used by the wallet after a send. */
  function verdictBlock(r, opts) {
    opts = opts || {};
    var v = r.verdict, t = r.transaction;
    var l = LABEL[v.kind] || [v.kind, ""];
    var net = r.network === "test" ? "Zcash testnet" : "Zcash mainnet";
    var status = { mined: ["Confirmed", "ok"], mempool: ["In mempool", ""] }[r.status] || ["Not in best chain", "no"];
    var chips = '<span class="chip plain">' + esc(net) + '</span><span class="chip ' + status[1] + '">' + esc(status[0]) + '</span><span class="chip ' + l[1] + '">' + esc(l[0]) + "</span>";
    (t.pools || []).forEach(function (p) {
      if (p.spends) chips += '<span class="chip plain">' + esc(p.pool) + " · " + num(p.spends) + " spend" + (p.spends === 1 ? "" : "s") + "</span>";
    });

    // Flow line: when the inputs existed, against the cut-off, and when the payment was mined.
    var nodes = [];
    if (v.existed_by != null) nodes.push('<span class="node ' + (l[1] === "ok" ? "hi" : "") + '"><small>Inputs existed by</small><b>#' + num(v.existed_by) + "</b></span>");
    if (r.cutoff && v.existed_by != null) {
      var before = v.existed_by < r.cutoff.height;
      nodes.push('<span class="rel">' + (before ? "before" : "not before") + "</span>");
      nodes.push('<span class="node ' + (before ? "" : "lo") + '"><small>Cut-off</small><b>#' + num(r.cutoff.height) + "</b></span>");
    }
    if (r.mined) nodes.push('<span class="arrow">→</span><span class="node"><small>Mined in</small><b>#' + num(r.mined.height) + "</b></span>");
    var flow = nodes.length
      ? '<div class="box flow"><div class="flow-line">' + nodes.join("") + '</div><p class="flow-text">' + esc(v.summary) + "</p></div>"
      : '<div class="box flow"><p class="flow-text" style="margin:0">' + esc(v.summary) + "</p></div>";

    var tiles = "";
    if (v.existed_by != null) tiles += tile("Inputs existed by", "#" + num(v.existed_by), l[1] === "ok" ? "ok" : "", r.mined ? num(r.mined.height - v.existed_by) + " blocks before it was mined" : "");
    if (r.cutoff) tiles += tile("Cut-off", "#" + num(r.cutoff.height), "", r.cutoff.resolved_by === "date" ? "first block at or after " + r.cutoff.input : "given as a height");
    if (r.cutoff && v.existed_by != null) {
      var margin = r.cutoff.height - v.existed_by;
      tiles += tile("Margin", (margin > 0 ? num(margin) : "0") + (margin === 1 ? " block" : " blocks"), margin > 0 ? "ok" : "no", margin > 0 ? "inputs are this far before the cut-off" : "inputs are not before the cut-off");
    }
    if (r.mined) tiles += tile("Mined in", "#" + num(r.mined.height), "", utc(r.mined.time));
    tiles += tile("Coverage", esc(COVER[v.coverage] || v.coverage), "", "");
    tiles += tile("Transparent inputs", num(t.transparent_inputs), "", t.transparent_inputs ? "never covered by an alibi" : "");

    var anchors = "";
    (v.findings || []).forEach(function (f) {
      f.anchors.forEach(function (a) {
        var loc = a.location.status === "located"
          ? "#" + num(a.location.height) + sub(utc(a.location.block_time))
          : '<span class="no-t">' + esc(a.location.reason) + "</span>";
        anchors += "<tr><td>" + pool(f.pool) + '</td><td class="r">' + num(f.spends) + '</td><td class="hex">' + esc(a.anchor) + copyBtn(a.anchor) + "</td><td>" + loc + "</td></tr>";
      });
    });
    var anchorsTable = anchors
      ? '<div class="box"><table class="tbl"><thead><tr><th>Pool</th><th class="r">Spends</th><th>Anchor</th><th>First block with this root</th></tr></thead><tbody>' + anchors + "</tbody></table></div>"
      : '<div class="box empty">This transaction spends no shielded notes, so there is no anchor to locate.</div>';

    return '<div class="res">' +
      '<div class="res-head"><div><p class="eyebrow">&gt; ' + esc(opts.eyebrow || "ALIBI_VERDICT") + "</p><h2>" + esc(opts.title || "Alibi verdict") + '</h2><div class="hashline">' + esc(r.txid) + copyBtn(r.txid) + "</div></div>" +
      (opts.noExport ? "" : '<button type="button" class="ghost" data-export>Export JSON</button>') + "</div>" +
      '<div class="chips">' + chips + "</div>" + flow +
      '<div class="tabs"><button type="button" class="tab on" data-tab="o">Overview</button><button type="button" class="tab" data-tab="a">Anchors</button><button type="button" class="tab" data-tab="r">Raw</button></div>' +
      '<div class="pane on" data-pane="o"><dl class="tiles t3">' + tiles + "</dl></div>" +
      '<div class="pane" data-pane="a">' + anchorsTable + "</div>" +
      '<div class="pane" data-pane="r"><pre class="pre">' + esc(JSON.stringify(r, null, 2)) + "</pre></div>" +
      "</div>";
  }
  window.AlibiDash.verdictBlock = verdictBlock;

  function verify(updateHash) {
    var tx = $("vf-tx").value.trim().toLowerCase(), before = $("vf-before").value.trim();
    if (!HEX64.test(tx)) { setErr($("vf-err"), "A transaction id is 64 hexadecimal characters."); return; }
    setErr($("vf-err"), "");
    lastRun = tx;
    if (updateHash) history.replaceState(null, "", "#/verify?tx=" + tx + (before ? "&before=" + encodeURIComponent(before) : "") + "&net=" + NET);
    var btn = $("vf-go");
    btn.disabled = true;
    $("vf-out").innerHTML = '<div class="res">' + loading("Fetching the transaction and locating its anchors") + "</div>";
    api("/v1/tx/" + tx + (before ? "?before=" + encodeURIComponent(before) : "")).then(function (res) {
      btn.disabled = false;
      if (res.status !== 200) { $("vf-out").innerHTML = '<div class="res">' + failure(res.body) + "</div>"; return; }
      lastResult = res.body;
      $("vf-out").innerHTML = verdictBlock(res.body);
    });
  }

  $("vf-form").addEventListener("submit", function (e) { e.preventDefault(); verify(true); });
  Array.prototype.forEach.call(document.querySelectorAll(".examples .chip-btn"), function (b) {
    b.addEventListener("click", function () {
      if (NET !== "main") setNet("main");
      $("vf-tx").value = b.getAttribute("data-tx");
      $("vf-before").value = b.getAttribute("data-before");
      verify(true);
    });
  });

  // ------------------------------------------------------------ checkpoint

  $("cp-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var b = $("cp-before").value.trim();
    if (!b) { setErr($("cp-err"), "Enter a date or a block height."); return; }
    setErr($("cp-err"), "");
    $("cp-out").innerHTML = '<div class="loading"><span class="spin"></span>Resolving the cut-off</div>';
    api("/v1/checkpoint?before=" + encodeURIComponent(b)).then(function (res) {
      if (res.status !== 200) { $("cp-out").innerHTML = '<div class="fail">' + esc(res.body.message || "Lookup failed.") + "</div>"; return; }
      var c = res.body;
      var roots = c.roots.map(function (r) {
        return "<tr><td>" + pool(r.pool) + '</td><td class="hex">' + esc(r.root) + copyBtn(r.root) + "</td><td>#" + num(r.since_height) + "</td></tr>";
      }).join("");
      $("cp-out").innerHTML =
        '<div class="inner"><p class="acct-label">Checkpoint block</p><p class="big">#' + num(c.height) + '</p><p class="acct-meta">' + esc(utc(c.block && c.block.time)) + "</p></div>" +
        '<table class="kv">' + row("Cut-off", "#" + num(c.cutoff.height) + sub(c.cutoff.resolved_by === "date" ? "first block at or after " + c.cutoff.input : utc(c.cutoff.time))) +
        row("Distance", num(c.cutoff.height - c.height) + " blocks before the cut-off") + row("Grid", "every " + num(c.grid) + " blocks") + "</table>" +
        '<table class="tbl" style="border-top:1px solid var(--line)"><thead><tr><th>Pool</th><th>Root at the checkpoint</th><th>Unchanged since</th></tr></thead><tbody>' + roots + "</tbody></table>";
    });
  });

  // ------------------------------------------------------------ anchor

  $("an-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var p = $("an-pool").value, hex = $("an-hex").value.trim().toLowerCase();
    if (!HEX64.test(hex)) { setErr($("an-err"), "An anchor is 64 hexadecimal characters."); return; }
    setErr($("an-err"), "");
    $("an-out").innerHTML = '<div class="loading"><span class="spin"></span>Searching the index</div>';
    api("/v1/anchor/" + p + "/" + hex).then(function (res) {
      if (res.status !== 200) { $("an-out").innerHTML = '<div class="fail">' + esc(res.body.message || "Lookup failed.") + "</div>"; return; }
      var l = res.body.location;
      if (l.status !== "located") {
        $("an-out").innerHTML = '<div class="inner"><div class="chips" style="margin-top:0"><span class="chip no">Not located</span>' +
          '<span class="chip plain">' + esc(res.body.pool) + '</span></div><p class="flow-text" style="text-align:left">' + esc(l.reason) + "</p></div>";
        return;
      }
      $("an-out").innerHTML =
        '<div class="inner"><div class="chips" style="margin-top:0"><span class="chip ok">Located</span><span class="chip plain">' + esc(res.body.pool) + "</span></div>" +
        '<p class="acct-label">First block with this root</p><p class="big">#' + num(l.height) + '</p><p class="acct-meta">' + esc(utc(l.block_time)) + "</p></div>" +
        '<table class="kv">' + row("Anchor", '<span class="hex">' + esc(res.body.anchor) + "</span>") + row("Block hash", '<span class="hex">' + esc(l.block_hash) + "</span>" + copyBtn(l.block_hash)) + "</table>";
    });
  });

  // ------------------------------------------------------------ index, strip and sidebar status

  var health = null;
  function current() {
    if (!health) return null;
    return health.networks.filter(function (n) { return n.network === NET; })[0] || null;
  }

  function renderStatus() {
    var dot = $("net-dot"), txt = $("net-text"), strip = $("strip");
    var n = current();
    var label = NET === "test" ? "Testnet" : "Mainnet";
    if (!n) {
      dot.className = "dot bad";
      txt.textContent = health ? "No index" : "Verifier unreachable";
      strip.innerHTML = '<span class="no-t">' + (health ? "There is no index for " + label.toLowerCase() + "." : "The verifier did not answer.") + "</span>";
      if (health) renderIndex();
      return;
    }
    var a = n.audits || {};
    var good = n.index && n.upstream.reachable > 0 && a.mismatches === 0;
    dot.className = "dot " + (good ? "ok" : "bad");
    txt.textContent = label + " · #" + num(n.index && n.index.indexed_height);
    strip.innerHTML =
      "<span>" + label + "</span>" +
      "<span>Block <b>#" + num(n.chain_tip) + "</b></span>" +
      "<span>Indexed <b>#" + num(n.index && n.index.indexed_height) + "</b></span>" +
      '<span>Root audits <b class="' + (a.mismatches === 0 ? "ok-t" : "no-t") + '">' + num(a.checks) + " · " + num(a.mismatches) + " mismatches</b></span>" +
      "<span>Servers <b>" + num(n.upstream.reachable) + "/" + num(n.upstream.configured) + "</b></span>" +
      "<span>Grid <b>144</b></span>";
    renderIndex();
  }

  function renderIndex() {
    var n = current();
    if (!n) { $("ix-out").innerHTML = failure({ message: health ? "There is no index for this network." : "Could not reach the verifier." }); return; }
    var a = n.audits || {};
    var tiles =
      tile("Chain tip", "#" + num(n.chain_tip), "", "highest block any server reports") +
      tile("Indexed to", "#" + num(n.index && n.index.indexed_height), "", num(n.lag_blocks) + " behind, " + num(n.confirmations) + " held back for reorgs") +
      tile("Indexed from", "#" + num(n.index && n.index.start_height), "", "older anchors are reported as outside the index") +
      tile("Root audits", num(a.checks), a.mismatches === 0 ? "ok" : "no", num(a.mismatches) + " mismatches" + (a.last_checked_height ? ", last at #" + num(a.last_checked_height) : "")) +
      tile("Servers", num(n.upstream.reachable) + " / " + num(n.upstream.configured), n.upstream.reachable ? "" : "no", "reachable now") +
      (n.last_error ? tile("Last error", '<span style="font-size:13px">' + esc(n.last_error.message) + "</span>", "no", "") : "");
    var pools = ["sapling", "orchard", "ironwood"].map(function (p) {
      return "<tr><td>" + pool(p) + '</td><td class="r">' + num(n.roots_indexed[p]) + "</td></tr>";
    }).join("");
    var servers = n.upstream.servers.map(function (s) {
      return "<tr><td>" + esc(s.url.replace(/^https:\/\//, "")) + '</td><td class="r">' + (s.tip == null ? '<span class="no-t">' + esc(s.error || "unreachable") + "</span>" : '<span class="ok-t">●</span> #' + num(s.tip)) + "</td></tr>";
    }).join("");
    $("ix-out").innerHTML = '<dl class="tiles">' + tiles + "</dl>" +
      '<p class="section-label"><span>&gt;</span> DISTINCT_ROOTS</p><div class="box"><table class="tbl"><thead><tr><th>Pool</th><th class="r">Roots indexed</th></tr></thead><tbody>' + pools + "</tbody></table></div>" +
      '<p class="section-label"><span>&gt;</span> UPSTREAM_SERVERS</p><div class="box"><table class="tbl"><thead><tr><th>lightwalletd</th><th class="r">Tip</th></tr></thead><tbody>' + servers + "</tbody></table></div>";
  }

  function loadIndex() {
    var b = $("ix-refresh");
    b.disabled = true;
    return fetch(API + "/v1/health").then(function (r) { return r.json().then(function (b) { return { status: r.status, body: b }; }); }, function () { return { status: 0, body: {} }; }).then(function (res) {
      b.disabled = false;
      health = res.status === 200 && res.body.networks ? res.body : null;
      renderStatus();
    });
  }
  $("ix-refresh").addEventListener("click", loadIndex);

  setNet(NET, true);
  window.addEventListener("hashchange", route);
  if (!location.hash) history.replaceState(null, "", "#/verify" + (location.search.indexOf("tx=") >= 0 ? location.search : ""));
  route();
  if (location.hash.indexOf("#/index") !== 0) loadIndex();
  setInterval(loadIndex, 60000);
})();
