import os
import sys
import time
import json
import socket
import logging
import subprocess
import uuid
import threading
from typing import Dict, Any, Optional

import redis

from site_settings.models import SiteSettings
from services.kasm_client import KasmClient, KasmError

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 兩層 session 記錄(與 CDP 版同一套骨架,只是瀏覽器端從 CDP context 換成 KasmVNC session):
#   - ACTIVE_SESSIONS(本行程記憶體):存 ssh 的 Popen handle —— subprocess 無法序列化,
#     只有啟動它的那個 gunicorn worker 能 terminate 它;GC 也在各 worker 掃自己這份。
#   - _store(Redis):存「跨 worker 要查的欄位」(server_id / rfb_port / kasm_session_id /
#     proxy_port / last_seen)。prod 是 gunicorn 多 worker,`/start`(REST)與 VNC 橋接 WS
#     consumer 常落在不同 worker;consumer 必須能用 session_id 反查 rfb_port 並重驗權限。
# ---------------------------------------------------------------------------
ACTIVE_SESSIONS: Dict[str, Dict[str, Any]] = {}
_SESSIONS_LOCK = threading.Lock()

SSH_HOST = "reverse"                 # 既有 reverse gateway,保持不變 / unchanged
INSTANCE = os.getenv("PROJECT_NAME", "main")
REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379")
_KEY_PREFIX = f"rb:{INSTANCE}:session:"

_kasm = KasmClient()


def _default_ttl() -> int:
    try:
        idle = SiteSettings.get_solo().remote_browser_session_idle_timeout
    except Exception:
        idle = 60
    return int(idle) + 30


class RedisSessionStore:
    """
    Session 查詢資料的共享儲存(Redis)。每筆 session 一個帶 TTL 的 key,外加一個 SET
    記錄所有 live session_id 供列舉。ping 續 TTL;key 過期(WS 斷線後不再 ping)= 該回收。
    """
    def __init__(self, url: Optional[str] = None):
        self._r = redis.Redis.from_url(url or REDIS_URL, decode_responses=True)
        self._set_key = f"rb:{INSTANCE}:sessions"

    def _k(self, session_id: str) -> str:
        return f"{_KEY_PREFIX}{session_id}"

    def put(self, session_id: str, payload: dict, ttl: Optional[int] = None) -> None:
        ttl = ttl or _default_ttl()
        pipe = self._r.pipeline()
        pipe.set(self._k(session_id), json.dumps(payload), ex=ttl)
        pipe.sadd(self._set_key, session_id)
        pipe.execute()

    def get(self, session_id: str) -> Optional[dict]:
        raw = self._r.get(self._k(session_id))
        return json.loads(raw) if raw else None

    def refresh(self, session_id: str, ttl: Optional[int] = None) -> bool:
        return bool(self._r.expire(self._k(session_id), ttl or _default_ttl()))

    def delete(self, session_id: str) -> None:
        pipe = self._r.pipeline()
        pipe.delete(self._k(session_id))
        pipe.srem(self._set_key, session_id)
        pipe.execute()

    def live_session_ids(self) -> set:
        ids = self._r.smembers(self._set_key) or set()
        alive = set()
        for sid in ids:
            if self._r.exists(self._k(sid)):
                alive.add(sid)
            else:
                self._r.srem(self._set_key, sid)
        return alive


_store = RedisSessionStore()


def get_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('', 0))
        return s.getsockname()[1]


def _wait_for_port(host: str, port: int, timeout: float = 30.0, proc=None) -> bool:
    """
    等 SOCKS proxy listen。`reverse` 是兩跳連線(backend → telepy-ssh 的 ProxyCommand →
    裝置反向隧道),兩跳都用 ControlMaster/ControlPersist,冷啟較久,故預設放寬到 30s;
    傳入 proc 時 ssh 一死即刻失敗,不空等。
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc is not None and proc.poll() is not None:
            return False
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.5)
            try:
                s.connect((host, port))
                return True
            except OSError:
                time.sleep(0.2)
    return False


def _count_active() -> int:
    try:
        return len(_store.live_session_ids())
    except Exception:
        with _SESSIONS_LOCK:
            return len(ACTIVE_SESSIONS)


def start_remote_browser(target_username, target_reverse_port, server_id):
    """
    啟動一個 remote browser session:
      1. 起 ssh -D SOCKS proxy 連到目標(行為與 Neko/CDP 版完全一致)。
      2. 呼叫 kasm-browser 的 session-manager 起「Xvnc 顯示 + 綁定該 SOCKS 的 chromium」。
    回傳 { "session_id", "ws_path" }。畫面與輸入之後走既有 /ws 的 VNC 橋接。
    """
    settings = SiteSettings.get_solo()
    max_sessions = getattr(settings, "remote_browser_max_sessions", 10)
    if max_sessions and _count_active() >= max_sessions:
        raise Exception(
            "The Proxy Browser has reached its maximum concurrent user limit. "
            "Please wait for someone to disconnect and try again."
        )

    proxy_port = get_free_port()
    ssh_cmd = f"ssh -N -q -D 0.0.0.0:{proxy_port} -p {target_reverse_port} {target_username}@{SSH_HOST}"
    logger.info(f"Starting SSH proxy for target {server_id} on port {proxy_port}")
    ssh_process = subprocess.Popen(ssh_cmd, shell=True)

    ssh_timeout = getattr(settings, "remote_browser_ssh_timeout", 30)
    if not _wait_for_port("127.0.0.1", proxy_port, timeout=ssh_timeout, proc=ssh_process):
        try:
            ssh_process.terminate()
        except Exception:
            pass
        raise Exception(
            f"Failed to start SSH proxy for target {server_id} "
            f"(no SOCKS listener within {ssh_timeout}s — is the device online?)."
        )

    session_id = str(uuid.uuid4())
    with _SESSIONS_LOCK:
        ACTIVE_SESSIONS[session_id] = {
            "ssh_process": ssh_process,
            "proxy_port": proxy_port,
            "server_id": server_id,
            "rfb_port": None,
            "kasm_session_id": None,
            "last_seen": time.time(),
        }

    proxy_host = os.getenv("HOSTNAME", "backend")   # kasm-browser 經 telepy-network 連回本後端
    geometry = getattr(settings, "remote_browser_geometry", "1280x720") or "1280x720"
    try:
        ids = _kasm.create_session(f"socks5://{proxy_host}:{proxy_port}", geometry=geometry)
    except KasmError as e:
        stop_remote_browser(session_id)             # 收 ssh + 清登記
        raise Exception(f"Failed to create VNC browser session: {e}")

    with _SESSIONS_LOCK:
        if session_id in ACTIVE_SESSIONS:
            ACTIVE_SESSIONS[session_id]["rfb_port"] = ids["rfb_port"]
            ACTIVE_SESSIONS[session_id]["kasm_session_id"] = ids["session_id"]
    _store.put(session_id, {
        "server_id": server_id,
        "rfb_port": ids["rfb_port"],
        "kasm_session_id": ids["session_id"],
        "proxy_port": proxy_port,
        "last_seen": time.time(),
    })
    logger.info(f"Remote browser session {session_id} ready (rfb {ids['rfb_port']})")
    return {"session_id": session_id, "ws_path": f"/ws/remote-browser/{session_id}/"}


def get_session(session_id):
    """跨 worker 查詢:先讀共享 store(權威),回不到再退回本行程 dict。回 dict 或 None。"""
    data = None
    try:
        data = _store.get(session_id)
    except Exception:
        logger.warning("session store lookup failed for %s", session_id, exc_info=True)
    if data:
        return data
    with _SESSIONS_LOCK:
        sess = ACTIVE_SESSIONS.get(session_id)
        if not sess:
            return None
        return {
            "server_id": sess.get("server_id"),
            "rfb_port": sess.get("rfb_port"),
            "kasm_session_id": sess.get("kasm_session_id"),
            "proxy_port": sess.get("proxy_port"),
        }


def ping_remote_browser(session_id):
    """心跳:續 Redis TTL 並更新本行程 last_seen。任一存在即算數。"""
    refreshed = False
    try:
        refreshed = _store.refresh(session_id)
    except Exception:
        logger.warning("session store refresh failed for %s", session_id, exc_info=True)
    with _SESSIONS_LOCK:
        sess = ACTIVE_SESSIONS.get(session_id)
        if sess:
            sess["last_seen"] = time.time()
            return True
    return bool(refreshed)


def stop_remote_browser(session_id):
    """
    結束 session。任一 worker 都能收 kasm session(經 session-manager API)與 store 記錄;
    ssh 的 Popen 只有 owner worker 持有 —— 非 owner 呼叫時 ssh 交給 owner 的 GC 回收。
    """
    with _SESSIONS_LOCK:
        session = ACTIVE_SESSIONS.pop(session_id, None)

    kasm_session_id = session.get("kasm_session_id") if session else None
    if not kasm_session_id:
        try:
            stored = _store.get(session_id)
        except Exception:
            stored = None
        if stored:
            kasm_session_id = stored.get("kasm_session_id")

    existed = bool(session) or bool(kasm_session_id)

    try:
        _store.delete(session_id)
    except Exception:
        logger.warning("session store delete failed for %s", session_id, exc_info=True)

    if kasm_session_id:
        try:
            _kasm.stop_session(kasm_session_id)
        except Exception:
            logger.warning("kasm stop_session %s errored", kasm_session_id, exc_info=True)

    if session:
        proc = session.get("ssh_process")
        if proc:
            try:
                proc.terminate()
                proc.wait(timeout=5)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
    return existed


def cleanup_dead_sessions():
    while True:
        try:
            idle_timeout = SiteSettings.get_solo().remote_browser_session_idle_timeout
            now = time.time()
            dead = []
            with _SESSIONS_LOCK:
                for sid, sess in list(ACTIVE_SESSIONS.items()):
                    proc = sess.get("ssh_process")
                    proc_dead = proc and proc.poll() is not None
                    idle = (now - sess.get("last_seen", now)) > idle_timeout
                    if proc_dead or idle:
                        dead.append(sid)
            # store key 已消失(在別的 worker 被 stop,或 TTL 過期)也要回收本行程的 ssh。
            try:
                live_ids = _store.live_session_ids()
                with _SESSIONS_LOCK:
                    for sid in list(ACTIVE_SESSIONS.keys()):
                        if sid not in live_ids and sid not in dead:
                            dead.append(sid)
            except Exception:
                pass
            for sid in dead:
                stop_remote_browser(sid)
        except Exception:
            pass
        time.sleep(10)


# 測試環境不啟背景 GC(會打真實 Redis/session-manager)。
if "test" not in sys.argv and os.getenv("REMOTE_BROWSER_GC", "1") != "0":
    threading.Thread(target=cleanup_dead_sessions, daemon=True).start()
