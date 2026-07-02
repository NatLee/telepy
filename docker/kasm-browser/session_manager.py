#!/usr/bin/env python3
"""
kasm-browser session-manager —— 跑在共用 kasm-browser 容器內的小型 HTTP API。

每個 remote-browser session,backend(services/kasm_client.py)POST /sessions 進來,這裡就:
  1. 配一個 X display 號 N 與 RFB 埠(rfb_base + N),
  2. 起 KasmVNC 的 Xvnc :N(SecurityTypes None、rfbport N、bind 0.0.0.0 供 backend 連),
  3. 起視窗管理員(openbox)與 chromium(DISPLAY=:N,--proxy-server=該 session 的 SOCKS),
  4. 回 { session_id, rfb_port }。

之後 Django 的 RemoteBrowserConsumer 會把 kasm-browser:<rfb_port> 這條 RFB(VNC)橋接到
既有的 /ws,前端用 noVNC 呈現。DELETE /sessions/<id> 收掉該 session 的所有行程。

設計要點:
  - 不需 docker.sock:只是在「一顆長命容器」內起/停行程,不做容器編排。
  - 只在 telepy-network 內、X-Internal-Token(= INTERNAL_API_TOKEN)保護,絕不對外 publish。
  - 啟動指令用環境變數樣板化(VNC_CMD/WM_CMD/BROWSER_CMD),方便依 KasmVNC 版本微調而不改碼。
  - 每個 session 的行程都開新 process group(start_new_session),停止時整組 kill,確保 chromium
    的子行程一起收掉。
只用標準函式庫,可獨立於 Django 執行與測試。
"""
import os
import sys
import json
import time
import uuid
import shlex
import signal
import socket
import logging
import threading
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

logging.basicConfig(level=logging.INFO, format="%(asctime)s [session-manager] %(message)s")
logger = logging.getLogger("session_manager")

DEFAULT_VNC_CMD = (
    "Xvnc :{display} -geometry {geometry} -depth 24 -SecurityTypes None "
    "-rfbport {rfbport} -interface 0.0.0.0 -AlwaysShared -desktop telepy -verbose"
)
DEFAULT_WM_CMD = "openbox"
DEFAULT_BROWSER_CMD = (
    "chromium --no-sandbox --no-first-run --no-default-browser-check "
    "--disable-dev-shm-usage --disable-features=TranslateUI "
    "--proxy-server={proxy} --start-maximized about:blank"
)


class SessionManager:
    def __init__(self):
        self.vnc_cmd = os.getenv("VNC_CMD", DEFAULT_VNC_CMD)
        self.wm_cmd = os.getenv("WM_CMD", DEFAULT_WM_CMD)
        self.browser_cmd = os.getenv("BROWSER_CMD", DEFAULT_BROWSER_CMD)
        self.display_base = int(os.getenv("DISPLAY_BASE", "10"))
        self.rfb_base = int(os.getenv("RFB_BASE", "5900"))
        self.rfb_timeout = int(os.getenv("RFB_TIMEOUT", "15"))
        self._sessions = {}          # sid -> {display, rfb_port, procs, proxy}
        self._used_displays = set()
        self._lock = threading.Lock()

    # --- allocation -------------------------------------------------------
    def _alloc_display(self):
        n = self.display_base
        while n in self._used_displays:
            n += 1
        self._used_displays.add(n)
        return n

    def count(self):
        with self._lock:
            return len(self._sessions)

    # --- lifecycle --------------------------------------------------------
    def create(self, proxy, geometry="1280x720"):
        if not proxy:
            raise ValueError("proxy required")
        with self._lock:
            display = self._alloc_display()
        rfb_port = self.rfb_base + display
        disp = f":{display}"
        procs = []
        try:
            procs.append(self._spawn(self.vnc_cmd.format(
                display=display, geometry=geometry, rfbport=rfb_port)))
            if not self._wait_for_rfb(rfb_port, timeout=self.rfb_timeout):
                raise RuntimeError(f"Xvnc RFB port {rfb_port} did not come up")
            if self.wm_cmd:
                procs.append(self._spawn(self.wm_cmd, display=disp))
            procs.append(self._spawn(self.browser_cmd.format(proxy=proxy), display=disp))
        except Exception:
            for p in procs:
                self._term(p)
            with self._lock:
                self._used_displays.discard(display)
            raise
        sid = uuid.uuid4().hex
        with self._lock:
            self._sessions[sid] = {"display": display, "rfb_port": rfb_port,
                                   "procs": procs, "proxy": proxy}
        logger.info("session %s up: display %s rfb %s", sid, disp, rfb_port)
        return {"session_id": sid, "rfb_port": rfb_port}

    def stop(self, session_id):
        with self._lock:
            sess = self._sessions.pop(session_id, None)
            if sess:
                self._used_displays.discard(sess["display"])
        if not sess:
            return False
        for p in sess["procs"]:
            self._term(p)
        logger.info("session %s stopped", session_id)
        return True

    def stop_all(self):
        for sid in list(self._sessions.keys()):
            self.stop(sid)

    # --- process helpers (mocked in tests) --------------------------------
    def _spawn(self, cmd, display=None):
        env = dict(os.environ)
        if display:
            env["DISPLAY"] = display
        return subprocess.Popen(shlex.split(cmd), env=env, start_new_session=True)

    def _wait_for_rfb(self, port, timeout=15):
        deadline = time.time() + timeout
        while time.time() < deadline:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.settimeout(0.5)
                try:
                    s.connect(("127.0.0.1", port))
                    return True
                except OSError:
                    time.sleep(0.2)
        return False

    def _term(self, p):
        # 整個 process group 一起收(chromium 會 fork 一堆子行程)。
        try:
            os.killpg(os.getpgid(p.pid), signal.SIGTERM)
        except Exception:
            try:
                p.terminate()
            except Exception:
                pass
        try:
            p.wait(timeout=5)
        except Exception:
            try:
                os.killpg(os.getpgid(p.pid), signal.SIGKILL)
            except Exception:
                try:
                    p.kill()
                except Exception:
                    pass


class _Handler(BaseHTTPRequestHandler):
    manager = None
    token = ""

    def _auth_ok(self):
        return self.headers.get("X-Internal-Token", "") == self.token

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/healthz":
            return self._send(200, {"status": "ok", "active": self.manager.count()})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self._auth_ok():
            return self._send(403, {"error": "forbidden"})
        if self.path != "/sessions":
            return self._send(404, {"error": "not found"})
        length = int(self.headers.get("Content-Length", 0) or 0)
        try:
            data = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return self._send(400, {"error": "bad json"})
        proxy = data.get("proxy")
        if not proxy:
            return self._send(400, {"error": "proxy required"})
        try:
            out = self.manager.create(proxy, data.get("geometry", "1280x720"))
        except Exception as e:
            logger.exception("create failed")
            return self._send(500, {"error": str(e)})
        self._send(201, out)

    def do_DELETE(self):
        if not self._auth_ok():
            return self._send(403, {"error": "forbidden"})
        if self.path.startswith("/sessions/"):
            sid = self.path.split("/", 2)[2]
            ok = self.manager.stop(sid)
            return self._send(200 if ok else 404,
                              {"status": "stopped" if ok else "unknown"})
        self._send(404, {"error": "not found"})

    def log_message(self, *args):
        pass  # 靜音預設 access log(用自己的 logger)


def main():
    mgr = SessionManager()
    _Handler.manager = mgr
    _Handler.token = os.getenv("INTERNAL_API_TOKEN", "")
    port = int(os.getenv("SESSION_MANAGER_PORT", "7000"))

    def _graceful(*_a):
        logger.info("shutting down; stopping all sessions")
        mgr.stop_all()
        sys.exit(0)
    signal.signal(signal.SIGTERM, _graceful)
    signal.signal(signal.SIGINT, _graceful)

    logger.info("listening on :%d", port)
    ThreadingHTTPServer(("0.0.0.0", port), _Handler).serve_forever()


if __name__ == "__main__":
    main()
