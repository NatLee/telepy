#!/usr/bin/env python3
"""
Integration check for the real CDP client + consumer streaming path against a live
headless Chromium (no Django). Exercises the exact code in services/cdp_client.py and
the consumer's frame-forward/ack loop shape — especially the reader-loop-vs-ack
deadlock that unit tests (which mock CDP) can't catch.
"""
import asyncio, glob, os, subprocess, sys, tempfile, time, urllib.request, socket

sys.path.insert(0, "/sessions/sharp-youthful-brahmagupta/mnt/telepy/src/backend")
from services.cdp_client import CdpClient, CdpConnection, CdpError  # noqa: E402

BIN = os.environ["CHROME_BIN"]
results = []
def rec(name, ok, detail=""):
    results.append(ok); print(f"  [{'PASS' if ok else 'FAIL'}] {name}  {detail}")

def launch():
    port = _free()
    prof = tempfile.mkdtemp(prefix="cdpint-")
    p = subprocess.Popen([BIN, f"--remote-debugging-port={port}",
        "--remote-debugging-address=127.0.0.1", "--no-sandbox", "--disable-gpu",
        "--disable-dev-shm-usage", f"--user-data-dir={prof}", "about:blank",
        "--proxy-server=socks5://127.0.0.1:1"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = f"http://127.0.0.1:{port}"
    for _ in range(80):
        try: urllib.request.urlopen(f"{base}/json/version", timeout=1); return p, base
        except Exception: time.sleep(0.25)
    p.kill(); sys.exit("chrome no CDP")

def _free():
    with socket.socket() as s: s.bind(("",0)); return s.getsockname()[1]

async def main():
    proc, base = launch()
    os.environ["CHROMIUM_CDP_URL"] = base
    client = CdpClient(base_url=base)

    # 1) create_session + G5-style survival: dispose only the creating conn, reconnect
    ids = await client.create_session("socks5://127.0.0.1:1")
    rec("create_session returns context+target",
        bool(ids.get("context_id") and ids.get("target_id")), str(ids))

    # 2) consumer-style streaming: attach, screencast, forward+ack via SEPARATE tasks
    frames = []
    async def stream_like_consumer():
        # mirrors RemoteBrowserConsumer: event handler schedules tasks, never awaits in-loop
        conn_holder = {}
        cdp_session = {}
        def on_event(msg):
            if msg.get("method") == "Page.screencastFrame":
                p = msg["params"]
                async def fwd():
                    frames.append(len(p["data"]))
                    # THE deadlock test: ack awaits a Future resolved by the same reader loop
                    await conn_holder["c"].call("Page.screencastFrameAck",
                        {"sessionId": p["sessionId"]}, session_id=cdp_session["id"], timeout=5)
                asyncio.create_task(fwd())
        c = await client.connect(event_handler=on_event)
        conn_holder["c"] = c
        att = await c.call("Target.attachToTarget", {"targetId": ids["target_id"], "flatten": True})
        cdp_session["id"] = att["sessionId"]
        await c.call("Page.enable", session_id=cdp_session["id"])
        await c.call("Emulation.setDeviceMetricsOverride",
            {"width":1024,"height":768,"deviceScaleFactor":1,"mobile":False}, session_id=cdp_session["id"])
        await c.call("Runtime.evaluate", {"expression":
            "setInterval(()=>document.body.style.background='#'+((Math.random()*0xffffff)|0).toString(16),100)"},
            session_id=cdp_session["id"])
        await c.call("Page.startScreencast",
            {"format":"jpeg","quality":50,"everyNthFrame":1,"maxWidth":1024,"maxHeight":768},
            session_id=cdp_session["id"])
        await asyncio.sleep(3)   # if ack deadlocked, frames would stall at ~1
        await c.call("Page.stopScreencast", session_id=cdp_session["id"])
        await c.close()
    await asyncio.wait_for(stream_like_consumer(), timeout=15)
    rec("streaming: frames keep flowing (no ack deadlock)", len(frames) >= 5,
        f"{len(frames)} frames, sizes~{frames[:3]}")

    # 3) input on the attached target actually mutates the page
    c2 = await client.connect()
    att = await c2.call("Target.attachToTarget", {"targetId": ids["target_id"], "flatten": True})
    s = att["sessionId"]
    await c2.call("Runtime.evaluate", {"expression":
        "document.body.innerHTML='<input id=i>';document.getElementById('i').focus()"}, session_id=s)
    await c2.call("Input.insertText", {"text": "中文abc"}, session_id=s)
    val = await c2.call("Runtime.evaluate",
        {"expression":"document.getElementById('i').value","returnByValue":True}, session_id=s)
    rec("insertText reaches focused input", val["result"]["value"] == "中文abc",
        f"value={val['result']['value']!r}")

    # 4) tab isolation: a second context's target must NOT appear as ours
    ids2 = await client.create_session("socks5://127.0.0.1:1")
    tgts = await c2.call("Target.getTargets")
    ours = {t["targetId"] for t in tgts["targetInfos"]
            if t.get("browserContextId") == ids["context_id"] and t.get("type")=="page"}
    theirs = ids2["target_id"]
    rec("context target-list excludes other session's tab",
        ids["target_id"] in ours and theirs not in ours,
        f"ours={len(ours)} theirs_leaked={theirs in ours}")
    await c2.close()

    # 5) dispose_context tears down the context's targets
    await client.dispose_context(ids["context_id"])
    await client.dispose_context(ids2["context_id"])
    c3 = await client.connect()
    remaining = await c3.call("Target.getBrowserContexts")
    gone = ids["context_id"] not in remaining["browserContextIds"]
    rec("dispose_context removes the context", gone,
        f"remaining={remaining['browserContextIds']}")
    await c3.close()

    proc.kill(); proc.wait()
    print(f"\nRESULT: {'ALL PASS' if all(results) else 'FAILURES ABOVE'} ({sum(results)}/{len(results)})")
    return 0 if all(results) else 1

if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
