#!/usr/bin/env python3
"""
Phase 0 gate — CDP remote-browser migration (Telepy). 取代 Neko 前的放行閘門.

Verifies against a real headless Chromium over *raw CDP*:

  G1  Target.createBrowserContext({proxyServer:"socks5://..."}) routes that
      context's traffic through its own SOCKS proxy
  G2  Two contexts in the SAME browser use DIFFERENT proxies, no cross-talk
  G3  Chrome sends hostnames to the SOCKS proxy (remote DNS, ATYP=3) —
      required so DNS resolves on the *target* side of ssh -D
  G4  Cookie isolation between contexts
  G5  Contexts/targets survive after the creating CDP connection closes
      (required: /start creates them synchronously, consumer attaches later)
  G6  Page.startScreencast delivers JPEG frames; ack flow works
  G7  Input.insertText (CJK) + Input.dispatchKeyEvent work headless
  G8  Fail-closed launch: --proxy-server=socks5://127.0.0.1:1 (dead) as
      browser default still lets per-context proxyServer override work,
      while default-context egress fails (no leak via server IP)

Modes:
  local (default): launches a chromium/headless_shell found in the
      ms-playwright cache, or $CHROME_BIN.
  external: --cdp-url http://host:9222 to verify a running container
      (e.g. chromedp/headless-shell). G8 is skipped (needs relaunch).
      --socks-host <addr> = how the *browser container* reaches this
      script's mock SOCKS servers (for docker: host IP or 172.17.0.1;
      or run this script inside the backend container).

The mock SOCKS5 servers answer every CONNECT themselves and serve an HTTP
response "VIA-<NAME>" — so whichever body text a page shows tells you
exactly which proxy that context used. No external network needed.
"""
import argparse
import asyncio
import base64
import glob
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

import websockets

RESULTS = []


def record(gate, ok, detail=""):
    RESULTS.append((gate, ok, detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {gate}  {detail}")


# --------------------------------------------------------------------------
# Mock SOCKS5 server: logs CONNECTs, then acts as the target HTTP server.
# --------------------------------------------------------------------------
class MockSocks:
    def __init__(self, name, host, port):
        self.name, self.host, self.port = name, host, port
        self.connects = []  # (atyp, host, port)
        self._server = None

    async def _handle(self, r, w):
        try:
            ver, nmethods = await r.readexactly(2)
            await r.readexactly(nmethods)
            w.write(b"\x05\x00")  # no-auth
            ver, cmd, _rsv, atyp = await r.readexactly(4)
            if atyp == 1:
                host = socket.inet_ntoa(await r.readexactly(4))
            elif atyp == 3:
                ln = (await r.readexactly(1))[0]
                host = (await r.readexactly(ln)).decode()
            elif atyp == 4:
                host = socket.inet_ntop(socket.AF_INET6, await r.readexactly(16))
            else:
                w.close(); return
            port = int.from_bytes(await r.readexactly(2), "big")
            self.connects.append((atyp, host, port))
            w.write(b"\x05\x00\x00\x01" + socket.inet_aton("0.0.0.0") + b"\x00\x00")
            # Now pretend to be the target HTTP server.
            await asyncio.wait_for(r.readuntil(b"\r\n\r\n"), 10)
            body = f"VIA-{self.name}".encode()
            w.write(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: "
                + str(len(body)).encode() + b"\r\nConnection: close\r\n\r\n" + body
            )
            await w.drain()
        except Exception:
            pass
        finally:
            try:
                w.close()
            except Exception:
                pass

    async def start(self):
        self._server = await asyncio.start_server(self._handle, self.host, self.port)

    def saw_host(self, host):
        return any(h == host for _a, h, _p in self.connects)

    async def stop(self):
        if self._server:
            self._server.close()


# --------------------------------------------------------------------------
# Minimal raw-CDP client: background reader + Future-per-id + event buffer.
# (Same shape the production consumer needs — NOT linear send/recv.)
# --------------------------------------------------------------------------
class CDP:
    def __init__(self, ws):
        self.ws = ws
        self._id = 0
        self._pending = {}
        self.events = []
        self._reader = asyncio.create_task(self._read_loop())

    async def _read_loop(self):
        try:
            async for raw in self.ws:
                m = json.loads(raw)
                if "id" in m and m["id"] in self._pending:
                    self._pending.pop(m["id"]).set_result(m)
                else:
                    self.events.append(m)
        except Exception:
            pass

    async def call(self, method, params=None, session_id=None, timeout=20):
        self._id += 1
        mid = self._id
        msg = {"id": mid, "method": method, "params": params or {}}
        if session_id:
            msg["sessionId"] = session_id
        fut = asyncio.get_event_loop().create_future()
        self._pending[mid] = fut
        await self.ws.send(json.dumps(msg))
        m = await asyncio.wait_for(fut, timeout)
        if "error" in m:
            raise RuntimeError(f"{method} -> {m['error']}")
        return m.get("result", {})

    async def wait_event(self, method, session_id=None, timeout=25):
        deadline = time.time() + timeout
        seen = 0
        while time.time() < deadline:
            while seen < len(self.events):
                ev = self.events[seen]; seen += 1
                if ev.get("method") == method and (
                    session_id is None or ev.get("sessionId") == session_id
                ):
                    return ev
            await asyncio.sleep(0.03)
        raise TimeoutError(f"no {method} within {timeout}s")

    async def close(self):
        self._reader.cancel()
        try:
            await self.ws.close()
        except Exception:
            pass


async def cdp_connect(http_base):
    with urllib.request.urlopen(f"{http_base}/json/version", timeout=5) as r:
        info = json.loads(r.read())
    ws = await websockets.connect(
        info["webSocketDebuggerUrl"], max_size=None, ping_interval=None
    )
    return CDP(ws), info


# --------------------------------------------------------------------------
# Browser launcher (local mode)
# --------------------------------------------------------------------------
def find_chrome():
    if os.getenv("CHROME_BIN"):
        return os.getenv("CHROME_BIN")
    pats = [
        "~/.cache/ms-playwright/chromium_headless_shell-*/chrome-linux*/headless_shell",
        "~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome",
    ]
    for p in pats:
        hits = sorted(glob.glob(os.path.expanduser(p)))
        if hits:
            return hits[-1]
    sys.exit("No chromium found (set CHROME_BIN or `playwright install chromium --only-shell`)")


def launch(binary, port, extra=()):
    profile = tempfile.mkdtemp(prefix="cdp0-")
    args = [binary]
    if os.path.basename(binary) == "chrome":
        args.append("--headless")
    args += [
        f"--remote-debugging-port={port}",
        "--remote-debugging-address=127.0.0.1",
        "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
        f"--user-data-dir={profile}",
        "--no-first-run", "--no-default-browser-check",
        "--disable-background-networking", "--disable-component-update",
        "--disable-sync",
        # Chrome 117+ can auto-upgrade http->https navigations; our mock hosts
        # are http-only, so disable to keep the test deterministic.
        "--disable-features=HttpsUpgrades,HttpsFirstBalancedMode",
        *extra,
        "about:blank",
    ]
    proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    base = f"http://127.0.0.1:{port}"
    deadline = time.time() + 20
    while time.time() < deadline:
        if proc.poll() is not None:
            sys.exit(f"chrome died: {proc.stderr.read().decode()[:2000]}")
        try:
            urllib.request.urlopen(f"{base}/json/version", timeout=1)
            return proc, base, profile
        except Exception:
            time.sleep(0.25)
    proc.kill()
    sys.exit("chrome did not open CDP port in 20s")


# --------------------------------------------------------------------------
# Test steps
# --------------------------------------------------------------------------
async def new_proxied_page(cdp, socks_url):
    ctx = await cdp.call("Target.createBrowserContext", {
        "proxyServer": socks_url,
        "proxyBypassList": "<-loopback>",
    })
    cid = ctx["browserContextId"]
    tgt = await cdp.call("Target.createTarget", {"url": "about:blank", "browserContextId": cid})
    tid = tgt["targetId"]
    att = await cdp.call("Target.attachToTarget", {"targetId": tid, "flatten": True})
    sid = att["sessionId"]
    await cdp.call("Page.enable", session_id=sid)
    return cid, tid, sid


async def nav_and_read(cdp, sid, url, timeout=25):
    res = await cdp.call("Page.navigate", {"url": url}, session_id=sid)
    if res.get("errorText"):
        return None, res["errorText"]
    await cdp.wait_event("Page.loadEventFired", session_id=sid, timeout=timeout)
    ev = await cdp.call("Runtime.evaluate", {
        "expression": "document.body.innerText", "returnByValue": True,
    }, session_id=sid)
    return ev.get("result", {}).get("value"), None


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cdp-url", help="external CDP endpoint, e.g. http://localhost:9222")
    ap.add_argument("--socks-host", default="127.0.0.1",
                    help="address at which the BROWSER can reach this script's mock SOCKS")
    a = ap.parse_args()

    def freeport():
        with socket.socket() as s:
            s.bind(("", 0)); return s.getsockname()[1]

    pa, pb = freeport(), freeport()
    sA = MockSocks("A", "0.0.0.0", pa)
    sB = MockSocks("B", "0.0.0.0", pb)
    await sA.start(); await sB.start()
    urlA = f"socks5://{a.socks_host}:{pa}"
    urlB = f"socks5://{a.socks_host}:{pb}"

    proc = profile = None
    if a.cdp_url:
        base = a.cdp_url.rstrip("/")
        binary = None
    else:
        binary = find_chrome()
        print(f"chromium binary: {binary}")
        proc, base, profile = launch(binary, freeport())

    cdp, info = await cdp_connect(base)
    print(f"browser: {info.get('Browser')}  protocol {info.get('Protocol-Version')}\n")

    t0 = time.time()
    # --- G1/G3: context A through SOCKS A ---
    cidA, tidA, sidA = await new_proxied_page(cdp, urlA)
    body, err = await nav_and_read(cdp, sidA, "http://probe-a.internal/")
    record("G1 per-context proxy routes traffic", body == "VIA-A",
           f"body={body!r} err={err!r} ({time.time()-t0:.1f}s from context-create)")
    atyps = {at for at, h, _p in sA.connects if h == "probe-a.internal"}
    record("G3 remote DNS via SOCKS (ATYP=3 domain)", 3 in atyps,
           f"connects={sA.connects[:3]}")

    # --- G2: context B through SOCKS B, same browser, no cross-talk ---
    cidB, tidB, sidB = await new_proxied_page(cdp, urlB)
    bodyB, errB = await nav_and_read(cdp, sidB, "http://probe-b.internal/")
    cross = sB.saw_host("probe-a.internal") or sA.saw_host("probe-b.internal")
    record("G2 two contexts, two proxies, isolated", bodyB == "VIA-B" and not cross,
           f"body={bodyB!r} err={errB!r} cross_talk={cross}")

    # --- G4: cookie isolation ---
    await nav_and_read(cdp, sidA, "http://shared.internal/")
    await cdp.call("Runtime.evaluate", {"expression": "document.cookie='who=A;path=/'"},
                   session_id=sidA)
    await nav_and_read(cdp, sidB, "http://shared.internal/")
    ck = await cdp.call("Runtime.evaluate", {
        "expression": "document.cookie", "returnByValue": True}, session_id=sidB)
    ckB = ck.get("result", {}).get("value")
    record("G4 cookie isolation between contexts", ckB == "", f"ctxB sees {ckB!r}")

    # --- G5: contexts survive the creating CDP connection ---
    await cdp.close()
    cdp2, _ = await cdp_connect(base)
    targets = (await cdp2.call("Target.getTargets")).get("targetInfos", [])
    alive = {t["targetId"] for t in targets}
    surv = tidA in alive and tidB in alive
    att = await cdp2.call("Target.attachToTarget", {"targetId": tidA, "flatten": True})
    sidA2 = att["sessionId"]
    await cdp2.call("Page.enable", session_id=sidA2)
    body2, err2 = await nav_and_read(cdp2, sidA2, "http://persist.internal/")
    record("G5 context+proxy survive CDP reconnect", surv and body2 == "VIA-A",
           f"targets_alive={surv} body={body2!r} err={err2!r}")

    # --- G6: screencast ---
    await cdp2.call("Runtime.evaluate", {"expression":
        "setInterval(()=>{document.body.style.background="
        "'#'+((Math.random()*0xffffff)|0).toString(16).padStart(6,'0')},150)"},
        session_id=sidA2)
    await cdp2.call("Page.startScreencast", {
        "format": "jpeg", "quality": 60, "maxWidth": 1280, "maxHeight": 720,
        "everyNthFrame": 1}, session_id=sidA2)
    sizes = []
    t1 = time.time()
    try:
        while len(sizes) < 5 and time.time() - t1 < 8:
            ev = await cdp2.wait_event("Page.screencastFrame", session_id=sidA2, timeout=8)
            p = ev["params"]
            sizes.append(len(base64.b64decode(p["data"])))
            await cdp2.call("Page.screencastFrameAck",
                            {"sessionId": p["sessionId"]}, session_id=sidA2)
    except TimeoutError:
        pass
    await cdp2.call("Page.stopScreencast", session_id=sidA2)
    record("G6 screencast frames + ack", len(sizes) >= 3,
           f"{len(sizes)} frames in {time.time()-t1:.1f}s, "
           f"sizes={[f'{s//1024}KB' for s in sizes]}")

    # --- G7: text input incl. CJK ---
    await cdp2.call("Emulation.setFocusEmulationEnabled", {"enabled": True},
                    session_id=sidA2)
    await nav_and_read(cdp2, sidA2, "data:text/html,<input id=i>")
    await cdp2.call("Runtime.evaluate", {"expression":
        "document.getElementById('i').focus()"}, session_id=sidA2)
    await cdp2.call("Input.insertText", {"text": "中文測試"}, session_id=sidA2)
    for typ in ("keyDown", "keyUp"):
        await cdp2.call("Input.dispatchKeyEvent", {
            "type": typ, "key": "a", "code": "KeyA",
            "windowsVirtualKeyCode": 65,
            **({"text": "a", "unmodifiedText": "a"} if typ == "keyDown" else {}),
        }, session_id=sidA2)
    val = await cdp2.call("Runtime.evaluate", {
        "expression": "document.getElementById('i').value", "returnByValue": True,
    }, session_id=sidA2)
    got = val.get("result", {}).get("value")
    record("G7 insertText(CJK) + dispatchKeyEvent", got == "中文測試a", f"value={got!r}")

    await cdp2.call("Target.disposeBrowserContext", {"browserContextId": cidA})
    await cdp2.call("Target.disposeBrowserContext", {"browserContextId": cidB})
    await cdp2.close()

    # --- G8: fail-closed default proxy (local mode only) ---
    if binary:
        proc.kill(); proc.wait()
        shutil.rmtree(profile, ignore_errors=True)
        proc, base, profile = launch(binary, freeport(),
                                     extra=("--proxy-server=socks5://127.0.0.1:1",))
        cdp3, _ = await cdp_connect(base)
        # default context: must FAIL (no leak through server's own egress)
        tgt = await cdp3.call("Target.createTarget", {"url": "about:blank"})
        att = await cdp3.call("Target.attachToTarget",
                              {"targetId": tgt["targetId"], "flatten": True})
        sidD = att["sessionId"]
        await cdp3.call("Page.enable", session_id=sidD)
        bodyD, errD = await nav_and_read(cdp3, sidD, "http://leak.internal/", timeout=12)
        # per-context proxy: must still WORK (override the dead default)
        _c, _t, sidP = await new_proxied_page(cdp3, urlA)
        bodyP, errP = await nav_and_read(cdp3, sidP, "http://override.internal/")
        record("G8 fail-closed default + per-context override",
               (bodyD != "VIA-A") and bool(errD) and bodyP == "VIA-A",
               f"default: body={bodyD!r} err={errD!r} | override: body={bodyP!r} err={errP!r}")
        await cdp3.close()
        proc.kill(); proc.wait(); shutil.rmtree(profile, ignore_errors=True)
    else:
        print("  [SKIP] G8 fail-closed (external mode; rerun locally or relaunch container "
              "with --proxy-server=socks5://127.0.0.1:1 and re-check)")

    if proc and proc.poll() is None:
        proc.kill(); proc.wait()
        if profile:
            shutil.rmtree(profile, ignore_errors=True)
    await sA.stop(); await sB.stop()

    print("\n==== SUMMARY ====")
    ok = all(r[1] for r in RESULTS)
    for g, o, _d in RESULTS:
        print(f"  {'PASS' if o else 'FAIL'}  {g}")
    print(f"\nGATE: {'GO — per-context proxy 成立' if ok else 'NO-GO — 見上方 FAIL 項'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
