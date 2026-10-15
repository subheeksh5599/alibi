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
  var loading = function (msg) { return '<div class="panel muted block"><span class="spin"></span>' + esc(msg) + "</div>"; };
  var failure = function (body) { return '<div class="panel muted block no-t">' + esc(body.message || "Request failed.") + "</div>"; };
  var row = function (k, v) { return "<tr><th>" + esc(k) + "</th><td>" + v + "</td></tr>"; };
  var sub = function (s) { return s ? "<br><small>" + esc(s) + "</small>" : ""; };

  var NET = localStorage.getItem("alibi.net") === "test" ? "test" : "main";
  window.ALIBI_API = API;

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

  function setNet(n, quiet) {
    NET = n === "test" ? "test" : "main";
    localStorage.setItem("alibi.net", NET);
    Array.prototype.forEach.call(document.querySelectorAll(".seg button"), function (b) {
      b.classList.toggle("on", b.getAttribute("data-net") === NET);
    });
    if (!quiet) {
      ["vf-out", "cp-out", "an-out"].forEach(function (id) { $(id).innerHTML = ""; });
      lastRun = null;
      sideStatus();
      if (health) renderIndex();
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
  var COVER = { all_inputs: "Every input", shielded_only: "Shielded inputs only", none: "None" };
  var lastRun = null;

  function verify(updateHash) {
    var tx = $("vf-tx").value.trim().toLowerCase(), before = $("vf-before").value.trim();
    if (!HEX64.test(tx)) { setErr($("vf-err"), "A transaction id is 64 hexadecimal characters."); return; }
    setErr($("vf-err"), "");
    lastRun = tx;
    if (updateHash) history.replaceState(null, "", "#/verify?tx=" + tx + (before ? "&before=" + encodeURIComponent(before) : "") + "&net=" + NET);
    var btn = $("vf-go");
    btn.disabled = true;
    $("vf-out").innerHTML = loading("Fetching the transaction and locating its anchors");
    api("/v1/tx/" + tx + (before ? "?before=" + encodeURIComponent(before) : "")).then(function (res) {
      btn.disabled = false;
      if (res.status !== 200) { $("vf-out").innerHTML = failure(res.body); return; }
      var r = res.body, v = r.verdict, t = r.transaction;
      var l = LABEL[v.kind] || [v.kind, ""];
      var rows = row("Status", esc({ mined: "Mined", mempool: "In mempool" }[r.status] || "Not in best chain"));
      if (r.mined) rows += row("Mined in block", '<span class="num">' + num(r.mined.height) + "</span>" + sub(utc(r.mined.time)));
      if (v.existed_by != null) rows += row("Inputs existed by", '<span class="num">block ' + num(v.existed_by) + "</span>" + sub(r.mined ? num(r.mined.height - v.existed_by) + " blocks before it was mined" : ""));
      if (r.cutoff) rows += row("Cut-off", '<span class="num">block ' + num(r.cutoff.height) + "</span>" + sub(r.cutoff.resolved_by === "date" ? "first block at or after " + r.cutoff.input : ""));
      rows += row("Coverage", esc(COVER[v.coverage] || v.coverage));
      rows += row("Transparent inputs", '<span class="num">' + num(t.transparent_inputs) + "</span>");

      var anchors = "";
      (v.findings || []).forEach(function (f) {
        f.anchors.forEach(function (a) {
          var loc = a.location.status === "located"
            ? '<span class="num">' + num(a.location.height) + "</span>" + sub(utc(a.location.block_time))
            : '<span class="no-t">' + esc(a.location.reason) + "</span>";
          anchors += '<tr><td class="cap">' + esc(f.pool) + '</td><td class="num">' + num(f.spends) + '</td><td class="hex">' + esc(a.anchor) + "</td><td>" + loc + "</td></tr>";
        });
      });

      $("vf-out").innerHTML =
        '<div class="panel verdict block"><span class="pill ' + l[1] + '">' + esc(l[0]) + '</span><p class="summary">' + esc(v.summary) + "</p></div>" +
        '<div class="panel block"><table class="kv">' + rows + "</table></div>" +
        (anchors ? '<p class="section-label">Anchors</p><div class="panel"><table class="tbl"><thead><tr><th>Pool</th><th>Spends</th><th>Anchor</th><th>First block</th></tr></thead><tbody>' + anchors + "</tbody></table></div>" : "") +
        '<details class="raw"><summary>Response JSON</summary><pre>' + esc(JSON.stringify(r, null, 2)) + "</pre></details>";
    });
  }

  $("vf-form").addEventListener("submit", function (e) { e.preventDefault(); verify(true); });
  Array.prototype.forEach.call(document.querySelectorAll(".examples .link"), function (b) {
    b.addEventListener("click", function () {
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
    $("cp-out").innerHTML = loading("Resolving the cut-off");
    api("/v1/checkpoint?before=" + encodeURIComponent(b)).then(function (res) {
      if (res.status !== 200) { $("cp-out").innerHTML = failure(res.body); return; }
      var c = res.body;
      var rows = row("Cut-off", '<span class="num">block ' + num(c.cutoff.height) + "</span>" + sub(utc(c.cutoff.time)));
      rows += row("Anchor block", '<span class="num">' + num(c.height) + "</span>" + sub(utc(c.block && c.block.time)));
      rows += row("Grid", num(c.grid) + " blocks");
      var roots = c.roots.map(function (r) {
        return '<tr><td class="cap">' + esc(r.pool) + '</td><td class="hex">' + esc(r.root) + '</td><td class="num">' + num(r.since_height) + "</td></tr>";
      }).join("");
      $("cp-out").innerHTML = '<div class="panel block"><table class="kv">' + rows + "</table></div>" +
        '<p class="section-label">Roots at the anchor block</p><div class="panel"><table class="tbl"><thead><tr><th>Pool</th><th>Root</th><th>Unchanged since</th></tr></thead><tbody>' + roots + "</tbody></table></div>";
    });
  });

  // ------------------------------------------------------------ anchor

  $("an-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var pool = $("an-pool").value, hex = $("an-hex").value.trim().toLowerCase();
    if (!HEX64.test(hex)) { setErr($("an-err"), "An anchor is 64 hexadecimal characters."); return; }
    setErr($("an-err"), "");
    $("an-out").innerHTML = loading("Searching the index");
    api("/v1/anchor/" + pool + "/" + hex).then(function (res) {
      if (res.status !== 200) { $("an-out").innerHTML = failure(res.body); return; }
      var l = res.body.location;
      if (l.status !== "located") {
        $("an-out").innerHTML = '<div class="panel verdict block"><span class="pill no">Not located</span><p class="summary">' + esc(l.reason) + "</p></div>";
        return;
      }
      $("an-out").innerHTML = '<div class="panel verdict block"><span class="pill ok">Located</span></div>' +
        '<div class="panel block"><table class="kv">' +
        row("Pool", '<span class="cap">' + esc(res.body.pool) + "</span>") +
        row("First block", '<span class="num">' + num(l.height) + "</span>" + sub(utc(l.block_time))) +
        row("Block hash", '<span class="hex">' + esc(l.block_hash) + "</span>") +
        "</table></div>";
    });
  });

  // ------------------------------------------------------------ index + sidebar status

  var health = null;
  function current() {
    if (!health) return null;
    return health.networks.filter(function (n) { return n.network === NET; })[0] || null;
  }
  function sideStatus() {
    var dot = $("net-dot"), txt = $("net-text");
    var n = current();
    if (!n) { dot.className = "dot bad"; txt.textContent = health ? "No index for this network" : "Verifier unreachable"; return; }
    var good = n.index && n.upstream.reachable > 0 && n.audits && n.audits.mismatches === 0;
    dot.className = "dot " + (good ? "ok" : "bad");
    txt.textContent = (NET === "test" ? "Testnet" : "Mainnet") + " · " + num(n.index && n.index.indexed_height);
  }

  function renderIndex() {
    var n = current();
    if (!n) { $("ix-out").innerHTML = failure({ message: health ? "There is no index for this network." : "Could not reach the verifier." }); return; }
    var a = n.audits || {};
    var rows = row("Chain tip", '<span class="num">' + num(n.chain_tip) + "</span>") +
      row("Indexed to", '<span class="num">' + num(n.index && n.index.indexed_height) + "</span>" + sub(num(n.lag_blocks) + " behind, " + num(n.confirmations) + " held back for reorgs")) +
      row("Indexed from", '<span class="num">block ' + num(n.index && n.index.start_height) + "</span>") +
      row("Root audits", '<span class="num ' + (a.mismatches === 0 ? "ok-t" : "no-t") + '">' + num(a.checks) + " checks, " + num(a.mismatches) + " mismatches</span>" + sub(a.last_checked_height ? "last at block " + num(a.last_checked_height) : "")) +
      (n.last_error ? row("Last error", '<span class="no-t">' + esc(n.last_error.message) + "</span>") : "");
    var pools = ["sapling", "orchard", "ironwood"].map(function (p) {
      return '<tr><td class="cap">' + p + '</td><td class="num">' + num(n.roots_indexed[p]) + "</td></tr>";
    }).join("");
    var servers = n.upstream.servers.map(function (s) {
      return "<tr><td>" + esc(s.url.replace(/^https:\/\//, "")) + '</td><td class="num">' + (s.tip == null ? '<span class="no-t">' + esc(s.error || "unreachable") + "</span>" : num(s.tip)) + "</td></tr>";
    }).join("");
    $("ix-out").innerHTML = '<div class="panel"><table class="kv">' + rows + "</table></div>" +
      '<p class="section-label">Distinct roots indexed</p><div class="panel"><table class="tbl"><thead><tr><th>Pool</th><th>Roots</th></tr></thead><tbody>' + pools + "</tbody></table></div>" +
      '<p class="section-label">Servers · ' + num(n.upstream.reachable) + " of " + num(n.upstream.configured) + ' reachable</p><div class="panel"><table class="tbl"><thead><tr><th>Server</th><th>Tip</th></tr></thead><tbody>' + servers + "</tbody></table></div>";
  }

  function loadIndex() {
    var b = $("ix-refresh");
    b.disabled = true;
    return fetch(API + "/v1/health").then(function (r) { return r.json().then(function (b) { return { status: r.status, body: b }; }); }, function () { return { status: 0, body: {} }; }).then(function (res) {
      b.disabled = false;
      health = res.status === 200 && res.body.networks ? res.body : null;
      sideStatus();
      renderIndex();
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
