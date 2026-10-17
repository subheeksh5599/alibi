#!/usr/bin/env python3
"""Drives the live dashboard in a real headless Chrome: restore the testnet wallet, send with
alibi, wait for the verifier's verdict, save screenshots. Run from the repo root.

    python3 scripts/live-send.py <cutoff-height> <amount-taz>
"""
import base64, json, os, subprocess, sys, time, urllib.request
import websocket

SITE = os.environ.get("ALIBI_SITE", "https://alibi-zec.vercel.app")
CHROME = os.environ.get("CHROME", "/usr/bin/google-chrome-stable")
PORT = 9333
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WDIR = os.path.join(ROOT, ".wallet")
OUT = os.path.join(ROOT, "evidence", "live-send")
cutoff, amount = sys.argv[1], sys.argv[2]
seed = open(os.path.join(WDIR, "test.seed")).read().strip()
birthday = json.load(open(os.path.join(WDIR, "test.state.json")))["birthday"]
os.makedirs(OUT, exist_ok=True)

chrome = subprocess.Popen([CHROME, "--headless=new", f"--remote-debugging-port={PORT}", f"--user-data-dir={WDIR}/chrome",
                           "--no-first-run", f"--remote-allow-origins=http://127.0.0.1:{PORT}", "--window-size=1364,900", "about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    page = None
    for _ in range(50):
        try:
            tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json"))
            page = next(t for t in tabs if t["type"] == "page")
            break
        except Exception:
            time.sleep(0.3)
    if page is None:
        sys.exit("Chrome did not start")
    ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=60, suppress_origin=True)
    n = [0]

    def cdp(method, **params):
        n[0] += 1
        ws.send(json.dumps({"id": n[0], "method": method, "params": params}))
        while True:
            m = json.loads(ws.recv())
            if m.get("id") == n[0]:
                if "error" in m:
                    raise RuntimeError(m["error"])
                return m.get("result", {})

    def js(expr):
        r = cdp("Runtime.evaluate", expression=expr, returnByValue=True, awaitPromise=True)
        if "exceptionDetails" in r:
            raise RuntimeError(r["exceptionDetails"].get("exception", {}).get("description", r["exceptionDetails"]))
        return r["result"].get("value")

    def until(expr, secs, step=2.0):
        t0 = time.time()
        while time.time() - t0 < secs:
            if js(expr):
                return True
            time.sleep(step)
        return False

    def shot(name):
        open(os.path.join(OUT, name + ".png"), "wb").write(base64.b64decode(cdp("Page.captureScreenshot", format="png", captureBeyondViewport=True)["data"]))

    def log(*a):
        print(time.strftime("%H:%M:%S"), *a, flush=True)

    cdp("Page.enable")
    cdp("Network.setCacheDisabled", cacheDisabled=True)
    cdp("Page.navigate", url=SITE + "/dashboard#/wallet")
    until("document.readyState==='complete' && !!document.getElementById('w-empty')", 30, 0.5)
    time.sleep(2)
    if js("!document.getElementById('w-empty').hidden"):
        js("document.getElementById('w-restore-open').click()")
        js(f"document.getElementById('w-seed').value={json.dumps(seed)};document.getElementById('w-birthday').value='{birthday}';document.getElementById('w-restore').requestSubmit()")
    until("!document.getElementById('w-main').hidden && document.getElementById('w-sync').innerText==='Sync'", 240)
    log("wallet:", js("document.getElementById('w-summary').innerText.replace(/\\n+/g,' | ')"))
    shot("1-wallet")

    js("location.hash='#/send'")
    time.sleep(3)
    js("document.getElementById('s-self').click()")
    js(f"document.getElementById('s-amount').value='{amount}';"
       f"document.getElementById('s-memo').value='alibi: sent after cut-off {cutoff}';"
       f"document.getElementById('s-cutoff').value='{cutoff}';document.getElementById('s-cutoff').dispatchEvent(new Event('input'))")
    if not until("!document.getElementById('s-go').disabled", 30, 1):
        log("send disabled:", js("document.getElementById('s-preview').innerText"))
        shot("2-send-disabled")
        sys.exit(1)
    log("preview:", js("document.getElementById('s-preview').innerText.replace(/\\n+/g,' | ')"))
    shot("2-preview")
    t0 = time.time()
    js("document.getElementById('s-form').requestSubmit()")
    if not until("!!document.querySelector('#s-out h2') || !document.getElementById('s-err').hidden", 600, 3):
        log("timed out while proving")
        sys.exit(1)
    err = js("document.getElementById('s-err').innerText")
    if err:
        log("send failed:", err)
        shot("3-error")
        sys.exit(1)
    log(f"sent in {int(time.time() - t0)}s:", js("document.querySelector('#s-out .res').innerText.replace(/\\n+/g,' | ')"))
    shot("3-sent")
    until("!!document.querySelector('#s-verdict .flow')", 600, 5)
    log("verdict:", js("(document.querySelector('#s-verdict')||{}).innerText.replace(/\\n+/g,' | ').slice(0,400)"))
    shot("4-verdict")
    if until("/CONFIRMED/i.test(document.querySelector('#s-verdict .chips')?.innerText||'')", 900, 20):
        log("mined:", js("document.querySelector('#s-verdict .flow').innerText.replace(/\\n+/g,' | ')"))
        shot("5-mined")
    txid = js("document.querySelector('#s-out .hashline').innerText.trim()")
    print("TXID", txid, flush=True)
finally:
    chrome.terminate()
