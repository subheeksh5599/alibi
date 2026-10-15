(function () {
  "use strict";

  // Same origin in production (the site proxies /v1 to the backend). A local static server has no
  // proxy, so it talks to the backend directly.
  var LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  var API = LOCAL ? "https://compassionate-owl-414.convex.site" : "";

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  var num = function (n) { return n == null ? "–" : Number(n).toLocaleString("en-US"); };
  var when = function (t) {
    if (!t) return "";
    return new Date(t * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  };

  var LABELS = {
    predates: "PREDATES THE CUT-OFF",
    predates_shielded_only: "SHIELDED INPUTS PREDATE THE CUT-OFF",
    does_not_predate: "NO CLAIM FOR THIS CUT-OFF",
    established: "INPUTS DATED",
    unlocated: "ANCHOR NOT LOCATED",
    no_shielded_inputs: "NOTHING TO PROVE",
  };

  function api(path, opts) {
    return fetch(API + path, opts).then(function (r) {
      return r.text().then(function (t) {
        var body;
        try { body = JSON.parse(t); } catch (e) { body = { error: "bad_response", message: "The server answered with something that is not JSON (status " + r.status + ")." }; }
        return { status: r.status, body: body };
      });
    }, function () {
      return { status: 0, body: { error: "network", message: "Could not reach the verifier. Check your connection and try again." } };
    });
  }

  // ------------------------------------------------------------------ verify

  var form = $("vf-form"), txIn = $("vf-txid"), beforeIn = $("vf-before"), btn = $("vf-submit");
  var formErr = $("vf-form-error"), out = $("vf-result");

  function showFormError(msg) {
    formErr.textContent = msg;
    formErr.hidden = !msg;
  }

  function fact(label, value) {
    return "<div><dt>" + esc(label) + "</dt><dd>" + value + "</dd></div>";
  }

  function render(r) {
    var v = r.verdict, tx = r.transaction;
    var facts = [];
    facts.push(fact("Status", esc(r.status === "mined" ? "Mined" : r.status === "mempool" ? "In mempool" : "Not in best chain")));
    if (r.mined) facts.push(fact("Mined in block", num(r.mined.height) + '<br><span class="vf-muted" style="color:rgba(255,255,255,.6)">' + esc(when(r.mined.time)) + "</span>"));
    if (v.existed_by != null) {
      var age = r.mined ? " (" + num(r.mined.height - v.existed_by) + " blocks earlier)" : "";
      facts.push(fact("Inputs existed by block", num(v.existed_by) + '<br><span class="vf-muted" style="color:rgba(255,255,255,.6)">' + esc(age.trim()) + "</span>"));
    }
    if (r.cutoff) {
      facts.push(fact("Cut-off block", num(r.cutoff.height) + '<br><span class="vf-muted" style="color:rgba(255,255,255,.6)">' + esc(r.cutoff.resolved_by === "date" ? "first block at or after " + r.cutoff.input : "given as a height") + "</span>"));
    }
    facts.push(fact("Coverage", esc({ all_inputs: "Every input", shielded_only: "Shielded inputs only", none: "None" }[v.coverage] || v.coverage)));
    facts.push(fact("Transparent inputs", num(tx.transparent_inputs)));

    var pools = (v.findings || []).map(function (f) {
      var anchors = f.anchors.map(function (a) {
        var loc = a.location.status === "located"
          ? "first appeared in block <b>" + num(a.location.height) + "</b> " + esc(when(a.location.block_time))
          : "<span>" + esc(a.location.reason) + "</span>";
        return '<div class="vf-hex">' + esc(a.anchor) + "</div><div>" + loc + "</div>";
      }).join("");
      return '<div class="vf-pool"><b>' + esc(f.pool) + "</b> · " + num(f.spends) + " spend" + (f.spends === 1 ? "" : "s") + "<div style=\"margin-top:8px\">" + anchors + "</div></div>";
    }).join("");

    out.innerHTML =
      '<div class="vf-verdict k-' + esc(v.kind) + '">' +
      '<span class="vf-badge">' + esc(LABELS[v.kind] || v.kind) + "</span>" +
      '<p class="vf-summary">' + esc(v.summary) + "</p>" +
      '<dl class="vf-facts">' + facts.join("") + "</dl>" +
      (pools ? '<div class="vf-pools">' + pools + "</div>" : "") +
      '<details class="vf-raw"><summary>Full response · txid ' + esc(r.txid.slice(0, 12)) + "… · index " + num(r.index.indexed_height) + "</summary><pre>" + esc(JSON.stringify(r, null, 2)) + "</pre></details>" +
      "</div>";
    out.hidden = false;
  }

  function renderFailure(res) {
    var titles = {
      bad_request: "That request is not valid",
      not_found: "Transaction not found",
      unprocessable: "Cannot evaluate this transaction",
      index_not_ready: "The index is not ready",
      upstream_error: "The Zcash servers did not answer",
      network: "Connection problem",
    };
    out.innerHTML = '<div class="vf-fail"><h3>' + esc(titles[res.body.error] || "Something went wrong") + "</h3><p class=\"vf-muted\">" + esc(res.body.message || "") + "</p></div>";
    out.hidden = false;
  }

  function run(tx, before, push) {
    tx = tx.trim().toLowerCase();
    before = before.trim();
    if (!/^[0-9a-f]{64}$/.test(tx)) {
      showFormError("A transaction id is 64 hexadecimal characters.");
      txIn.focus();
      return;
    }
    showFormError("");
    if (push) {
      var q = "?tx=" + tx + (before ? "&before=" + encodeURIComponent(before) : "");
      history.replaceState(null, "", location.pathname + q);
    }
    btn.disabled = true;
    btn.textContent = "Verifying…";
    out.innerHTML = '<div class="vf-loading"><span class="vf-spin"></span>Fetching the transaction and locating its anchors…</div>';
    out.hidden = false;
    var path = "/v1/tx/" + tx + (before ? "?before=" + encodeURIComponent(before) : "");
    api(path).then(function (res) {
      if (res.status === 200) render(res.body);
      else renderFailure(res);
    }).then(function () {
      btn.disabled = false;
      btn.textContent = "Verify";
      out.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    run(txIn.value, beforeIn.value, true);
  });

  Array.prototype.forEach.call(document.querySelectorAll(".vf-chip"), function (c) {
    c.addEventListener("click", function () {
      txIn.value = c.getAttribute("data-tx");
      beforeIn.value = c.getAttribute("data-before") || "";
      run(txIn.value, beforeIn.value, true);
    });
  });

  // ------------------------------------------------------------------ checkpoint

  var cpForm = $("vf-cp-form"), cpIn = $("vf-cp-before"), cpOut = $("vf-cp-result");
  cpForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var b = cpIn.value.trim();
    if (!b) { cpOut.innerHTML = '<span class="vf-bad">Enter a date or a block height.</span>'; return; }
    cpOut.innerHTML = '<span class="vf-spin"></span>Looking up…';
    api("/v1/checkpoint?before=" + encodeURIComponent(b)).then(function (res) {
      if (res.status !== 200) { cpOut.innerHTML = '<span class="vf-bad">' + esc(res.body.message || "Lookup failed") + "</span>"; return; }
      var c = res.body;
      var rows = "<tr><td>Cut-off</td><td>block " + num(c.cutoff.height) + (c.cutoff.time ? " · " + esc(when(c.cutoff.time)) : "") + "</td></tr>" +
        "<tr><td>Anchor block</td><td><b>" + num(c.height) + "</b> · " + esc(when(c.block && c.block.time)) + "</td></tr>";
      c.roots.forEach(function (r) {
        rows += "<tr><td>" + esc(r.pool) + " root</td><td class=\"vf-mono\" style=\"word-break:break-all;font-size:12px\">" + esc(r.root) + "</td></tr>";
      });
      cpOut.innerHTML = "<table>" + rows + "</table>";
    });
  });

  // ------------------------------------------------------------------ status

  function loadStatus() {
    api("/v1/health").then(function (res) {
      var el = $("vf-status");
      if (res.status !== 200 || !res.body.networks) {
        el.innerHTML = '<dt>Status</dt><dd class="vf-bad">' + esc((res.body && res.body.message) || "unavailable") + "</dd>";
        return;
      }
      var n = res.body.networks[0];
      var a = n.audits || {};
      el.innerHTML =
        "<dt>Network</dt><dd>Zcash mainnet</dd>" +
        "<dt>Chain tip</dt><dd>" + num(n.chain_tip) + "</dd>" +
        "<dt>Indexed to</dt><dd>" + num(n.index && n.index.indexed_height) + ' <span class="vf-muted">(' + num(n.lag_blocks) + " behind; " + num(n.confirmations) + " kept back on purpose)</span></dd>" +
        "<dt>Indexed since</dt><dd>block " + num(n.index && n.index.start_height) + "</dd>" +
        "<dt>Roots indexed</dt><dd>" + ["sapling", "orchard", "ironwood"].map(function (p) { return p + " " + num(n.roots_indexed[p]); }).join(" · ") + "</dd>" +
        "<dt>Root audits</dt><dd class=\"" + (a.mismatches === 0 ? "vf-ok" : "vf-bad") + "\">" + num(a.checks) + " checks, " + num(a.mismatches) + " mismatches</dd>" +
        "<dt>Servers reachable</dt><dd>" + num(n.upstream.reachable) + " of " + num(n.upstream.configured) + "</dd>";
    });
  }
  loadStatus();
  setInterval(loadStatus, 60000);

  // ------------------------------------------------------------------ deep links

  var params = new URLSearchParams(location.search);
  if (params.get("tx")) {
    txIn.value = params.get("tx");
    beforeIn.value = params.get("before") || "";
    run(txIn.value, beforeIn.value, false);
  }
})();
