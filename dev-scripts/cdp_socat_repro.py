#!/usr/bin/env python3
"""
Reproduce the chromedp/headless-shell container topology (run.sh) and prove the fix:
  - headless-shell on 127.0.0.1:9223  (exactly run.sh's flags + our extra flags)
  - socat TCP-LISTEN:9222,fork TCP:127.0.0.1:9223   (the image's bridge)
Then:
  A) show Chrome REJECTS a hostname Host header (the latent 403/500 we fixed)
  B) show our cdp_client._browser_ws (IP-resolved) + full streaming works through 9222->9223
"""
import asyncio, http.client, os, subprocess, sys, time, urllib.request

sys.path.insert(0, "/sessions/sharp-youthful-brahmagupta/mnt/telepy/src/backend")
from services.cdp_client import CdpClient  # noqa: E402

BIN = os.environ["CHROME_BIN"]
ok = []
def rec(n, cond, d=""): ok.append(cond); print(f"  [{'PASS' if cond else 'FAIL'}] {n}  {d}")

# run.sh: headless-shell on 9223 + our appended flags
chrome = subprocess.Popen([BIN, "--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader",
    "--remote-debugging-address=0.0.0.0", "--remote-debugging-port=9223",
    "--proxy-server=socks5://127.0.0.1:1", "--remote-allow-origins=*",
    "--disable-dev-shm-usage", "--user-data-dir=/tmp/socatrepro", "about:blank"],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
# wait for 9223
for _ in range(80):
    try: urllib.request.urlopen("http://127.0.0.1:9223/json/version", timeout=1); break
    except Exception: time.sleep(0.25)
# socat bridge 9222 -> 9223 (exactly like the image)
socat = subprocess.Popen(["socat", "TCP4-LISTEN:9222,fork,reuseaddr", "TCP4:127.0.0.1:9223"],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)

# --- A) hostname Host header is rejected by Chrome (the latent bug) ---
def get_version(host_header):
    c = http.client.HTTPConnection("127.0.0.1", 9222, timeout=5)
    c.request("GET", "/json/version", headers={"Host": host_header})
    r = c.getresponse(); body = r.read(); c.close()
    return r.status, body
try:
    st_name, _ = get_version("chromium:9222")   # hostname -> Chrome should reject
except Exception as e:
    st_name = f"exc:{e}"
st_ip, _ = get_version("127.0.0.1:9222")          # IP -> accepted
rec("Chrome rejects hostname Host header (bug is real)", st_name != 200, f"hostname status={st_name}")
rec("Chrome accepts IP Host header (the fix's basis)", st_ip == 200, f"ip status={st_ip}")

# --- B) our client (IP-resolving) streams end-to-end through socat 9222->9223 ---
async def run():
    client = CdpClient(base_url="http://127.0.0.1:9222")
    ws = await asyncio.to_thread(client._browser_ws)     # must resolve + rewrite to IP:9222
    rec("_browser_ws returns reachable IP-form ws URL", ws.startswith("ws://127.0.0.1:9222/devtools"), ws)
    ids = await client.create_session("socks5://127.0.0.1:1")
    rec("create_session via socat bridge", bool(ids.get("target_id")), str(ids))
    frames = []
    def on_ev(m):
        if m.get("method") == "Page.screencastFrame":
            p = m["params"]
            async def fwd():
                frames.append(len(p["data"]))
                await conn.call("Page.screencastFrameAck", {"sessionId": p["sessionId"]},
                                session_id=sid, timeout=5)
            asyncio.create_task(fwd())
    conn = await client.connect(event_handler=on_ev)      # WS upgrade must pass Host+origin checks
    att = await conn.call("Target.attachToTarget", {"targetId": ids["target_id"], "flatten": True})
    sid = att["sessionId"]
    await conn.call("Page.enable", session_id=sid)
    await conn.call("Runtime.evaluate", {"expression":
        "setInterval(()=>document.body.style.background='#'+((Math.random()*0xffffff)|0).toString(16),100)"},
        session_id=sid)
    await conn.call("Page.startScreencast", {"format":"jpeg","quality":50,"maxWidth":800,"maxHeight":600},
                    session_id=sid)
    await asyncio.sleep(2.5)
    await conn.call("Page.stopScreencast", session_id=sid)
    rec("streaming works through the socat bridge", len(frames) >= 4, f"{len(frames)} frames")
    await conn.close()
    await client.dispose_context(ids["context_id"])
await_res = asyncio.run(run())

socat.terminate(); chrome.terminate()
try: socat.wait(timeout=5); chrome.wait(timeout=5)
except Exception: pass
print(f"\nRESULT: {'ALL PASS' if all(ok) else 'FAILURES'} ({sum(ok)}/{len(ok)})")
sys.exit(0 if all(ok) else 1)
