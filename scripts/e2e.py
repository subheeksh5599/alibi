#!/usr/bin/env python3
"""End-to-end checks against a running Alibi verifier, using real mainnet transactions.

    python3 scripts/e2e.py http://127.0.0.1:8790

Every request and response is written to evidence/e2e-<UTC timestamp>.json, and a pass/fail line
is printed per check. Exit status is non-zero if any check fails.
"""
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8790").rstrip("/")
ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "crates/alibi-core/tests/fixtures/main-14960f89.hex"

# Real mainnet transactions (display-order txids).
IRONWOOD_UNSHIELD = "14960f89420328fa92739217e5e05d6c9bd0e7c1c4640f0c6dc264dc9d3a252f"  # mined 3,517,000
SAPLING_SPEND = "c1889bb8cf94327b1b8fb90202eb946e82f48c40bbff93896b0d7de01b4faeae"  # mined 3,517,300
ORCHARD_SPEND = "8f94ba362d1e4da09cfb2768d41d94f423e8a2a29b1de7f4c23a84f8eec5cbca"  # mined 3,517,315
POOL_CROSSING = "0ba9fb6372d50b6999f1629ccc438b0d6fb090ead9c8cf655fb4e99457fb4214"  # Orchard -> Ironwood, 3,517,319
SHIELDED_COINBASE = "0c171e2a89395f734dbf3467d98f8fc2617d32171920ee3d9e6b05b0af4f4043"  # 3,517,302
TRANSPARENT_ONLY = "012b9655bf6df069e08fc77d130e52f973719c6f89184d2e4ecea641c3557ed5"  # 3,517,306
# Real testnet transactions (NU7, consensus branch 77190ad9).
# Sent from the live dashboard with "Send with alibi": mined at 4,511,031, after the cut-off 4,510,950,
# anchored at checkpoint 4,510,944 (root first seen at 4,510,942).
TEST_ALIBI_PAYMENT = "5232f22926fd7651fc4f2bd7b8098bc98d4243589aabf3bc9556e6e381726cc9"
TEST_FAUCET_PAYMENT = "fc1d127deaeecc90d03bb5bc37ef569f870d93ff6b9129278f805c64c641a73f"  # Ironwood, 4,504,356

log = []
failures = 0


def call(method, path, body=None):
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"content-type": "application/json"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            status, payload = r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        status, payload = e.code, json.loads(e.read() or b"{}")
    log.append({"request": f"{method} {path}", "body": body, "status": status, "ms": int((time.time() - t0) * 1000), "response": payload})
    return status, payload


def check(name, ok, detail=""):
    global failures
    failures += 0 if ok else 1
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail else ""))


s, h = call("GET", "/v1/health")
main = next((n for n in h.get("networks", []) if n["network"] == "main"), {})
check("health reports a mainnet index", s == 200 and main.get("index") is not None,
      f"indexed to {main.get('index', {}).get('indexed_height')}, lag {main.get('lag_blocks')}")
check("every root audit so far matched the server's tree state", main.get("audits", {}).get("mismatches") == 0,
      f"{main.get('audits', {}).get('checks')} audits")

s, r = call("GET", f"/v1/tx/{IRONWOOD_UNSHIELD}")
check("ironwood spend: anchor root first appeared at block 3,516,994 (tree unchanged to 3,516,996)", s == 200 and r["verdict"]["existed_by"] == 3516994,
      r.get("verdict", {}).get("summary", r))

s, r = call("GET", f"/v1/tx/{IRONWOOD_UNSHIELD}?before=3516995")
check("cut-off one block later: predates (transparent output only, no transparent inputs)",
      s == 200 and r["verdict"]["kind"] == "predates" and r["verdict"]["coverage"] == "all_inputs")

s, r = call("GET", f"/v1/tx/{IRONWOOD_UNSHIELD}?before=3516994")
check("cut-off at the anchor block itself: does not predate", s == 200 and r["verdict"]["kind"] == "does_not_predate")

s, r = call("GET", f"/v1/tx/{IRONWOOD_UNSHIELD}?before=2026-09-24")
check("date cut-off resolves to a block and the recent anchor does not predate it",
      s == 200 and r["cutoff"]["resolved_by"] == "date" and r["verdict"]["kind"] == "does_not_predate",
      f"2026-09-24 -> block {r.get('cutoff', {}).get('height')}")

for name, txid, pool in [("sapling spend", SAPLING_SPEND, "sapling"), ("orchard spend", ORCHARD_SPEND, "orchard")]:
    s, r = call("GET", f"/v1/tx/{txid}")
    ok = s == 200 and r["verdict"]["kind"] == "established" and any(f["pool"] == pool for f in r["verdict"]["findings"])
    age = (r["mined"]["height"] - r["verdict"]["existed_by"]) if ok else None
    check(f"{name}: {pool} anchor located", ok, f"anchor {age} blocks before mining" if ok else r)

s, r = call("GET", f"/v1/tx/{POOL_CROSSING}")
ok = s == 200 and r["verdict"]["kind"] == "established"
grid = [a["location"]["height"] % 144 == 0 for f in r.get("verdict", {}).get("findings", []) for a in f["anchors"]] if ok else []
check("Orchard -> Ironwood crossing: anchor located", ok, f"anchor on the 144-block grid: {grid}")

s, r = call("GET", f"/v1/tx/{SHIELDED_COINBASE}")
check("shielded coinbase: no shielded inputs, no claim", s == 200 and r["verdict"]["kind"] == "no_shielded_inputs")

s, r = call("GET", f"/v1/tx/{TRANSPARENT_ONLY}")
check("transparent-only transaction: no claim", s == 200 and r["verdict"]["kind"] == "no_shielded_inputs", r.get("verdict", {}).get("summary"))

s, r = call("GET", "/v1/tx/" + "00" * 32)
check("unknown txid: 404", s == 404, r.get("message"))

s, r = call("GET", "/v1/tx/not-a-txid")
check("malformed txid: 400", s == 400)

s, r = call("GET", f"/v1/tx/{IRONWOOD_UNSHIELD}?before=yesterday")
check("unparseable cut-off: 400", s == 400)

raw = FIXTURE.read_text().strip()
s, r = call("POST", "/v1/verify", {"hex": raw, "before": "3516995"})
check("raw bytes of a mined transaction: evaluated from the network's copy", s == 200 and r["verdict"]["kind"] == "predates")

# Forge an old anchor: swap the Ironwood anchor for the root of an earlier grid block. The bytes
# still parse, but the network has never accepted them (the txid changes and the proof no longer
# matches), so the verifier must refuse to evaluate them.
s, cp = call("GET", "/v1/checkpoint?before=2026-09-24")
iw_root = next((x["root"] for x in cp.get("roots", []) if x["pool"] == "ironwood"), None)
check("checkpoint for 2026-09-24: a grid block strictly before the cut-off, with every pool's root",
      s == 200 and cp["height"] % 144 == 0 and cp["height"] < cp["cutoff"]["height"] and iw_root is not None,
      f"anchor block {cp.get('height')} for cut-off {cp.get('cutoff', {}).get('height')}")
real_anchor = "b0c03d5aeb68d2cb006f633b79ab99cfd1b0ba9dcfb90dbd8d3542a4621ce02f"
if iw_root and real_anchor in raw:
    forged = raw.replace(real_anchor, iw_root)
    s, r = call("POST", "/v1/verify", {"hex": forged, "before": "2026-09-24"})
    check("forged old anchor in raw bytes: refused, never evaluated", s == 422, r.get("message"))
    s, r = call("GET", f"/v1/anchor/ironwood/{iw_root}")
    check("the forged anchor itself is a real old root (so only the proof check stops it)",
          s == 200 and r["location"]["status"] == "located" and r["location"]["height"] <= cp["height"])
else:
    check("forged-anchor test could run", False, "fixture anchor not found in raw bytes")

s, r = call("GET", "/v1/anchor/ironwood/" + "11" * 32)
check("random 32 bytes as an anchor: not located", s == 200 and r["location"]["status"] == "not_located")

# ------------------------------------------------------------------ testnet (NU7) and the wallet relay

s, r = call("GET", "/v1/health")
test = next((n for n in r.get("networks", []) if n["network"] == "test"), {})
check("health reports a testnet index with no audit mismatches", test.get("index") is not None and test.get("audits", {}).get("mismatches") == 0,
      f"indexed to {test.get('index', {}).get('indexed_height')}, {test.get('audits', {}).get('checks')} audits")

s, r = call("GET", f"/v1/tx/{TEST_FAUCET_PAYMENT}?network=test")
check("testnet NU7 transaction parses: Ironwood spend with one anchor",
      s == 200 and r["transaction"]["branch_id"] == "77190ad9" and r["transaction"]["pools"][0]["pool"] == "ironwood")

s, r = call("GET", f"/v1/tx/{TEST_ALIBI_PAYMENT}?network=test&before=4510950")
check("alibi payment mined AFTER the cut-off still predates it (inputs existed by 4,510,942)",
      s == 200 and r["mined"]["height"] > 4510950 and r["verdict"]["kind"] == "predates" and r["verdict"]["existed_by"] == 4510942,
      f"mined {r.get('mined', {}).get('height')}")

s, r = call("GET", f"/v1/tx/{TEST_ALIBI_PAYMENT}?network=test&before=4510942")
check("the same payment makes no claim for a cut-off at its anchor block", s == 200 and r["verdict"]["kind"] == "does_not_predate")

s, r = call("GET", "/v1/chain/tip?network=test")
tip = r.get("height", 0)
check("relay: testnet tip", s == 200 and tip > 4_504_000, tip)

s, r = call("GET", f"/v1/chain/treestate?network=test&height={tip - 20}")
check("relay: tree state returns the Ironwood tree and its root", s == 200 and len(r["ironwood"]["root"]) == 64 and r["ironwood"]["tree"])

s, r = call("GET", f"/v1/chain/blocks?network=test&from={tip - 30}&to={tip - 21}")
check("relay: ten compact blocks, framed", s == 200 and r["count"] == 10 and len(r["framed"]) > 0)

s, r = call("GET", f"/v1/chain/blocks?network=test&from={tip - 1000}&to={tip}")
check("relay: more than 500 blocks in one request is refused", s == 400, r.get("message"))

s, r = call("GET", "/v1/chain/blocks?network=test&from=10&to=5")
check("relay: reversed range is refused", s == 400)

s, r = call("POST", "/v1/chain/broadcast", {"network": "test", "hex": "00" * 40})
check("relay: bytes that are not a transaction are never broadcast", s == 422, r.get("message"))

s, r = call("POST", "/v1/chain/broadcast", {"network": "test", "hex": "not hex"})
check("relay: non-hex body refused", s == 400)

s, r = call("GET", "/v1/chain/tip?network=nope")
check("relay: unknown network refused", s == 400)

out = ROOT / "evidence" / f"e2e-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}.json"
out.parent.mkdir(exist_ok=True)
out.write_text(json.dumps({"base": BASE, "failures": failures, "calls": log}, indent=2))
print(f"\n{len(log)} calls, {failures} failing checks; transcript: {out.relative_to(ROOT)}")
sys.exit(1 if failures else 0)
