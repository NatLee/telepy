#!/usr/bin/env python3
"""
kasm-browser session-manager —— 跑在共用 kasm-browser 容器內的小型 HTTP API。

每個 remote-browser session,backend(services/kasm_client.py)POST /sessions 進來,這裡就:
  1. 配一個 X display 號 N 與 websocket 埠(ws_base + N,對齊 KasmVNC 的 auto = 8443 + display),
  2. 起 KasmVNC 的 Xkasmvnc :N(SecurityTypes None、disableBasicAuth、websocketPort N;TLS 由
     /etc/kasmvnc/kasmvnc.yaml 的 network.ssl.require_ssl:false 關掉,對內網開純 ws),
  3. 起視窗管理員(openbox)與 chromium(DISPLAY=:N,--proxy-server=該 session 的 SOCKS,
     首頁 Google、反自動化偵測旗標、**每 session 專屬的臨時設定檔**——session 結束即刪,
     不保留歷史;也避免 Chromium SingletonLock 讓並發 session 互相搶佔),
  4. 回 { session_id, ws_port }。

之後 Django 的 RemoteBrowserConsumer 會把 kasm-browser:<ws_port> 這條 **WebSocket**(KasmVNC 的
web-native 傳輸)中繼到既有的 /ws,前端用 KasmVNC 自家的 web client 呈現。DELETE /sessions/<id>
收掉該 session 的所有行程。

為什麼是 WebSocket 而不是 raw-RFB TCP:KasmVNC 已脫離 RFB 規範,**只開 websocket、不開傳統
raw-RFB TCP 埠**,且它的 web client 是 fork 過、baked 在它 server 裡的 noVNC —— 一般 noVNC/VNC
viewer 連不上。因此橋接層改成 WS↔WS,前端改用 KasmVNC 的 client(見 docs/plans 的修正版計畫)。

設計要點:
  - 不需 docker.sock:只是在「一顆長命容器」內起/停行程,不做容器編排。
  - 只在 telepy-network 內、X-Internal-Token(= INTERNAL_API_TOKEN)保護,絕不對外 publish。
  - 啟動指令用環境變數樣板化(VNC_CMD/WM_CMD/BROWSER_CMD),方便依 KasmVNC 版本/旗標微調而不改碼:
    若某旗標你的 KasmVNC build 不吃,直接用 env 覆寫 VNC_CMD 即可(auto ws 埠仍是 8443+display)。
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
import shutil
import signal
import socket
import logging
import tempfile
import threading
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

logging.basicConfig(level=logging.INFO, format="%(asctime)s [session-manager] %(message)s")
logger = logging.getLogger("session_manager")

# KasmVNC 的 X server 二進位是 Xkasmvnc(不是 TigerVNC 的 Xvnc);用 {vnc_bin} 佔位,實際名稱由
# _resolve_vnc_bin() 於啟動時偵測(可用 VNC_SERVER_BIN 覆寫)。
# 旗標說明:
#   -SecurityTypes None       RFB 層免驗證(驗證改由 Django 的 JWT+權限)。
#   -disableBasicAuth         嘗試關 web 層 Basic Auth(實測某些 build 無效 → 故仍設密碼檔+帶帳密)。
#   -KasmPasswordFile <path>  **固定路徑**的 Basic Auth 密碼檔;不設會用 ${HOME}/.kasmpasswd,而 PID1
#                             的 HOME 在容器內未必是 build 時的 /root → 會找不到使用者、一律 401。
#   -websocketPort {ws_port}  每個 session 專屬的 websocket 埠。
#   -httpd <dir>              serve KasmVNC 內建 web client;同時確保 /websockify 這類 ws 端點有註冊。
#   -interface 0.0.0.0        聽在所有介面,讓 backend 經 telepy-network 連得到。
#   TLS:Xkasmvnc 的 -sslOnly 預設關 → 內網是純 ws(不需 wss)。
DEFAULT_VNC_CMD = (
    "{vnc_bin} :{display} -geometry {geometry} -depth 24 -SecurityTypes None "
    "-disableBasicAuth -KasmPasswordFile {kasm_password_file} "
    "-websocketPort {ws_port} -httpd {httpd_dir} -interface 0.0.0.0 -desktop telepy"
)
DEFAULT_WM_CMD = "openbox"
# 瀏覽器指令:
#   {homepage}      首頁(預設 Google;env REMOTE_BROWSER_HOMEPAGE 可改)。
#   {profile_flag}  --user-data-dir=<每 session 專屬臨時目錄>(見 _make_profile_dir;session 停止
#                   即整個刪除 → 不保留歷史/cookie)。**必須每 session 一個目錄**:共用目錄(或
#                   不給 → chromium 用 ~/.config/chromium)會踩 SingletonLock,第二個 session 的
#                   chromium 只會「Opening in existing browser session」把分頁開到第一個 session
#                   的桌面上然後退出,連鎖把兩邊都弄壞。
#   {lang}          介面語系與 Accept-Language(反爬蟲:navigator.languages 空值是機器人特徵)。
#   --disable-blink-features=AutomationControlled  移除 navigator.webdriver 之類的自動化訊號。
# 注意:此瀏覽器是「真人透過 VNC 操作」且**經由目標機器出口 IP**(ssh -D),本身已是最強的反偵測
# 條件;這裡的旗標是加分,無法保證完全免除 Cloudflare/reCAPTCHA。詳見 docs/plans 修正版計畫。
DEFAULT_BROWSER_CMD = (
    "chromium --no-sandbox --no-first-run --no-default-browser-check "
    "--disable-dev-shm-usage --disable-features=TranslateUI "
    "--disable-blink-features=AutomationControlled "
    "--lang={lang} --accept-lang={accept_lang} {profile_flag} "
    "--proxy-server={proxy} --start-maximized {homepage}"
)

DEFAULT_HOMEPAGE = os.getenv("REMOTE_BROWSER_HOMEPAGE", "https://www.google.com")
DEFAULT_LANG = os.getenv("REMOTE_BROWSER_LANG", "zh-TW")
# 每 session 專屬臨時設定檔的父目錄(session 停止即刪,**不保留歷史**)。
PROFILE_TMP_BASE = os.getenv("REMOTE_BROWSER_PROFILE_TMP", "/tmp")
# KasmVNC web 層 Basic Auth 的密碼檔:固定路徑,不依賴 $HOME(Dockerfile 用 kasmvncpasswd 建於此)。
KASM_PASSWORD_FILE = os.getenv("KASM_PASSWORD_FILE", "/etc/kasmvnc/kasmpasswd")
# KasmVNC 內建 web server 要 serve 的 client 目錄(KasmVNC deb 內含 /usr/share/kasmvnc/www)。
HTTPD_DIR = os.getenv("HTTPD_DIR", "/usr/share/kasmvnc/www")


def _accept_lang(lang: str) -> str:
    """由 --lang 推出合理的 Accept-Language(例:zh-TW → 'zh-TW,zh;q=0.9,en;q=0.8')。"""
    base = (lang or "en-US").split("-")[0]
    parts = [lang, f"{base};q=0.9"]
    if base != "en":
        parts.append("en;q=0.8")
    return ",".join(p for p in parts if p)


def _resolve_vnc_bin():
    """
    找出可用的 VNC X server 二進位。KasmVNC 是 Xkasmvnc(本專案 KasmVNC 版採用)。
    優先序:VNC_SERVER_BIN(env)→ Xkasmvnc → 常見絕對路徑 →(相容)Xvnc/Xtigervnc。找不到就回
    預設,讓後續 spawn 丟出明確的 FileNotFoundError。
    """
    candidates = [os.getenv("VNC_SERVER_BIN"), "Xkasmvnc",
                  "/usr/bin/Xkasmvnc", "/usr/local/bin/Xkasmvnc",
                  "Xvnc", "Xtigervnc"]
    for cand in candidates:
        if cand and (shutil.which(cand) or os.path.exists(cand)):
            return cand
    return os.getenv("VNC_SERVER_BIN") or "Xkasmvnc"


class SessionManager:
    def __init__(self):
        self.vnc_bin = _resolve_vnc_bin()
        self.vnc_cmd = os.getenv("VNC_CMD", DEFAULT_VNC_CMD)
        self.wm_cmd = os.getenv("WM_CMD", DEFAULT_WM_CMD)
        self.browser_cmd = os.getenv("BROWSER_CMD", DEFAULT_BROWSER_CMD)
        self.display_base = int(os.getenv("DISPLAY_BASE", "10"))
        # KasmVNC 的 websocket 埠 auto = 8443 + display;ws_base 預設對齊,per-session 埠可預測。
        self.ws_base = int(os.getenv("WS_BASE", "8443"))
        self.ws_timeout = int(os.getenv("WS_TIMEOUT", os.getenv("RFB_TIMEOUT", "15")))
        self.homepage = DEFAULT_HOMEPAGE
        self.lang = DEFAULT_LANG
        self.kasm_password_file = KASM_PASSWORD_FILE
        self.httpd_dir = HTTPD_DIR
        self._sessions = {}          # sid -> {display, ws_port, procs, proxy, profile_dir}
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

    def _make_profile_dir(self):
        """
        建每 session 專屬的臨時設定檔目錄,回 (flag_str, profile_dir)。
        - 不保留歷史:session 停止時整個目錄刪除(見 stop)。
        - 完全並發隔離:Chromium 對同一 user-data-dir 有 SingletonLock;共用目錄(或不指定 →
          ~/.config/chromium)會讓第二個並發 session 的 chromium 委派給第一個後直接退出。
        """
        try:
            profile_dir = tempfile.mkdtemp(prefix="telepy-profile-", dir=PROFILE_TMP_BASE)
        except OSError:
            logger.warning("could not create ephemeral profile dir; chromium will use its default")
            return "", None
        return f"--user-data-dir={shlex.quote(profile_dir)}", profile_dir

    # --- lifecycle --------------------------------------------------------
    def create(self, proxy, geometry="1280x720", lang=None):
        if not proxy:
            raise ValueError("proxy required")
        with self._lock:
            display = self._alloc_display()
        ws_port = self.ws_base + display
        disp = f":{display}"
        lang = lang or self.lang
        profile_flag, profile_dir = self._make_profile_dir()
        vnc_log = f"/tmp/telepy-vnc-{display}.log"
        procs = []
        try:
            vnc_cmd = self.vnc_cmd.format(
                vnc_bin=self.vnc_bin, display=display, geometry=geometry, ws_port=ws_port,
                kasm_password_file=self.kasm_password_file, httpd_dir=self.httpd_dir)
            logger.info("spawn vnc: %s", vnc_cmd)   # 便於診斷實際旗標
            procs.append(self._spawn(vnc_cmd, log_path=vnc_log))
            if not self._wait_for_ws_port(ws_port, timeout=self.ws_timeout):
                # 把 VNC server 自己的錯誤訊息帶出來,讓「websocket 沒起來」可診斷(而非啞掉)。
                raise RuntimeError(
                    f"KasmVNC ({self.vnc_bin}) websocket port {ws_port} did not come up. "
                    f"Last log lines:\n{self._tail(vnc_log)}")
            if self.wm_cmd:
                procs.append(self._spawn(self.wm_cmd, display=disp))
            procs.append(self._spawn(self.browser_cmd.format(
                proxy=proxy, homepage=self.homepage, lang=lang,
                accept_lang=_accept_lang(lang), profile_flag=profile_flag),
                display=disp, lang=lang))
        except Exception:
            for p in procs:
                self._term(p)
            with self._lock:
                self._used_displays.discard(display)
            self._rm_profile_dir(profile_dir)
            raise
        sid = uuid.uuid4().hex
        with self._lock:
            self._sessions[sid] = {"display": display, "ws_port": ws_port,
                                   "procs": procs, "proxy": proxy,
                                   "profile_dir": profile_dir}
        logger.info("session %s up: display %s ws %s profile %s (ephemeral)",
                    sid, disp, ws_port, profile_dir or "(chromium default)")
        return {"session_id": sid, "ws_port": ws_port}

    def stop(self, session_id):
        with self._lock:
            sess = self._sessions.pop(session_id, None)
            if sess:
                self._used_displays.discard(sess["display"])
        if not sess:
            return False
        for p in sess["procs"]:
            self._term(p)
        self._rm_profile_dir(sess.get("profile_dir"))   # 不保留歷史:設定檔隨 session 刪除
        logger.info("session %s stopped", session_id)
        return True

    def _rm_profile_dir(self, profile_dir):
        if not profile_dir:
            return
        try:
            shutil.rmtree(profile_dir, ignore_errors=True)
        except Exception:
            pass

    def stop_all(self):
        for sid in list(self._sessions.keys()):
            self.stop(sid)

    # --- process helpers (mocked in tests) --------------------------------
    def _spawn(self, cmd, display=None, log_path=None, lang=None):
        env = dict(os.environ)
        if display:
            env["DISPLAY"] = display
        if lang:
            # 反爬蟲:讓 chromium 的 navigator.language(s) 與行程 locale 一致、非空。
            base = lang.replace("-", "_")
            env.setdefault("LANG", f"{base}.UTF-8")
            env.setdefault("LANGUAGE", f"{lang}:{lang.split('-')[0]}")
            env.setdefault("LC_ALL", f"{base}.UTF-8")
        out = None
        if log_path:
            try:
                out = open(log_path, "wb")
            except OSError:
                out = None
        return subprocess.Popen(shlex.split(cmd), env=env, start_new_session=True,
                                stdout=out, stderr=subprocess.STDOUT)

    def _tail(self, path, n=25):
        try:
            with open(path, "r", errors="replace") as f:
                return "".join(f.readlines()[-n:]).strip() or "(empty)"
        except OSError:
            return "(no log)"

    def _wait_for_ws_port(self, port, timeout=15):
        """等 KasmVNC 的 websocket 埠 TCP 層 listen(能連上即視為就緒)。"""
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
            out = self.manager.create(
                proxy,
                data.get("geometry", "1280x720"),
                lang=data.get("lang"),
            )
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
