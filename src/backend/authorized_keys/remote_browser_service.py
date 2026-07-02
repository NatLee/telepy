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
from asgiref.sync import async_to_sync

from site_settings.models import SiteSettings
from services.cdp_client import CdpClient, CdpError

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 為什麼有「兩層」session 記錄:
#   - ACTIVE_SESSIONS(本行程記憶體):存 ssh 的 Popen handle —— subprocess 無法序列化,
#     只有啟動它的那個 gunicorn worker 能 terminate 它。GC 也在各 worker 掃自己這份。
#   - _store(Redis):存「跨 worker 要查的欄位」(server_id / target_id / context_id /
#     proxy_port / last_seen)。prod 是 gunicorn 多 worker,`/start`(REST)與串流 WS
#     consumer 很可能落在不同 worker;consumer 必須能用 session_id 反查 target_id 並
#     重驗權限,故這份查詢資料一定要放共享儲存,不能只留在單一行程的 dict 裡。
# Two-tier session bookkeeping: in-process dict holds the un-serialisable ssh Popen
# (only its owner worker can terminate it); Redis holds the cross-worker lookup fields
# (the streaming consumer usually lands on a different worker than /start and must map
# session_id -> target_id + re-check permission).
# ---------------------------------------------------------------------------
ACTIVE_SESSIONS: Dict[str, Dict[str, Any]] = {}
_SESSIONS_LOCK = threading.Lock()

SSH_HOST = "reverse"                 # 既有 reverse gateway,保持不變 / unchanged
INSTANCE = os.getenv("PROJECT_NAME", "main")
# 與 CACHES 同一顆 Redis;session store 用獨立 keyspace 前綴,和 cache/channels 不衝突。
REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379")
_KEY_PREFIX = f"rb:{INSTANCE}:session:"

_cdp = CdpClient()


def _default_ttl() -> int:
    """Redis 存活 TTL:略大於 idle timeout,讓 ping 停止後很快自然過期。"""
    try:
        idle = SiteSettings.get_solo().remote_browser_session_idle_timeout
    except Exception:
        idle = 60
    return int(idle) + 30


class RedisSessionStore:
    """
    Session 查詢資料的共享儲存(Redis)。每筆 session 一個帶 TTL 的 key,外加一個 SET
    (`rb:<instance>:sessions`)記錄所有 live session_id 供對帳列舉。ping 續 TTL;
    key 過期(WS 斷線後不再 ping)即代表 session 該回收。
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
                self._r.srem(self._set_key, sid)   # 自我修復:清掉過期成員
        return alive

    def live_context_ids(self) -> set:
        ctxs = set()
        for sid in self.live_session_ids():
            data = self.get(sid)
            if data and data.get("context_id"):
                ctxs.add(data["context_id"])
        return ctxs


_store = RedisSessionStore()


def get_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('', 0))
        return s.getsockname()[1]


def _wait_for_port(host: str, port: int, timeout: float = 30.0, proc=None) -> bool:
    """
    等 SOCKS proxy listen。`reverse` 是兩跳連線(backend → telepy-ssh 的 ProxyCommand →
    裝置反向隧道),兩跳都用 ControlMaster/ControlPersist。冷啟第一次要建立兩個 master
    socket 再對裝置認證,可能較久,故預設放寬到 30s;傳入 proc 時 ssh 一死即刻失敗,不空等。
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
      1. 起 ssh -D SOCKS proxy 連到目標(行為與 Neko 版完全一致)。
      2. 在共用 headless Chromium 內建立「專屬該 SOCKS 的 browser context + 首個分頁」。
    回傳 { "session_id", "ws_path" }。畫面與輸入之後走既有 Channels /ws(不再是 iframe)。
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
    # 先登記 in-process(context/target=None),避免 GC 在建立空窗期誤收 ssh。
    with _SESSIONS_LOCK:
        ACTIVE_SESSIONS[session_id] = {
            "ssh_process": ssh_process,
            "proxy_port": proxy_port,
            "server_id": server_id,
            "context_id": None,
            "target_id": None,
            "last_seen": time.time(),
        }

    proxy_host = os.getenv("HOSTNAME", "backend")   # chromium 容器經 telepy-network 連回本後端
    try:
        ids = async_to_sync(_cdp.create_session)(f"socks5://{proxy_host}:{proxy_port}")
    except CdpError as e:
        stop_remote_browser(session_id)             # 收 ssh + 清登記
        raise Exception(f"Failed to create CDP session: {e}")

    with _SESSIONS_LOCK:
        if session_id in ACTIVE_SESSIONS:
            ACTIVE_SESSIONS[session_id]["context_id"] = ids["context_id"]
            ACTIVE_SESSIONS[session_id]["target_id"] = ids["target_id"]
    # 寫入共享 store —— consumer(可能在別的 worker)靠這查 target_id 並重驗權限。
    _store.put(session_id, {
        "server_id": server_id,
        "target_id": ids["target_id"],
        "context_id": ids["context_id"],
        "proxy_port": proxy_port,
        "last_seen": time.time(),
    })
    logger.info(f"Remote browser session {session_id} ready (target {ids['target_id']})")
    return {"session_id": session_id, "ws_path": f"/ws/remote-browser/{session_id}/"}


def get_session(session_id):
    """
    給 consumer / views 用的跨 worker 查詢。先讀共享 store(權威),回不到再退回本行程 dict。
    回 dict(含 server_id / target_id / context_id / proxy_port)或 None。
    """
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
            "target_id": sess.get("target_id"),
            "context_id": sess.get("context_id"),
            "proxy_port": sess.get("proxy_port"),
        }


def ping_remote_browser(session_id):
    """心跳:續 Redis TTL(權威)並更新本行程 last_seen。任一存在即算數。"""
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
    結束 session。任一 worker 都能收 CDP context(經 chromium)與 store 記錄;ssh 的 Popen
    只有 owner worker 持有 —— 非 owner 呼叫時 ssh 交給 owner 的 GC(見 store TTL 消失)回收。
    """
    with _SESSIONS_LOCK:
        session = ACTIVE_SESSIONS.pop(session_id, None)

    # context_id:優先用本行程的,沒有再問 store(非 owner worker 的情況)。
    context_id = session.get("context_id") if session else None
    if not context_id:
        stored = None
        try:
            stored = _store.get(session_id)
        except Exception:
            pass
        if stored:
            context_id = stored.get("context_id")

    existed = bool(session) or bool(context_id)

    try:
        _store.delete(session_id)
    except Exception:
        logger.warning("session store delete failed for %s", session_id, exc_info=True)

    if context_id:
        try:
            async_to_sync(_cdp.dispose_context)(context_id)
        except CdpError as e:
            logger.warning(f"dispose context {context_id} failed: {e}")
        except Exception:
            logger.warning("dispose context %s errored", context_id, exc_info=True)

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


# 對帳用:上一輪被視為「疑似孤兒」的 context id(需連兩輪都是孤兒才 dispose,避開
# 「A worker 剛 createBrowserContext、還沒寫進 store」被 B worker 的 GC 誤殺的競速)。
_suspected_orphans: set = set()


def _reconcile_orphan_contexts():
    """
    收掉 Chrome 內存在、但 store 已無對應 session 的孤兒 context(例如某 worker 被 SIGKILL
    來不及跑 stop)。共用 Chrome 的爆炸半徑防護:避免死 context 累積吃記憶體。
    """
    global _suspected_orphans
    try:
        chrome_ctxs = async_to_sync(_cdp.list_context_ids)()
    except Exception:
        return
    try:
        live = _store.live_context_ids()
    except Exception:
        return
    current_orphans = set(chrome_ctxs) - set(live)
    # 只處理「這輪與上輪都是孤兒」的,給剛建立的 context 一輪寬限。
    confirmed = current_orphans & _suspected_orphans
    for ctx in confirmed:
        try:
            async_to_sync(_cdp.dispose_context)(ctx)
            logger.info(f"Reaped orphan CDP context {ctx}")
        except Exception:
            logger.warning("failed to reap orphan context %s", ctx, exc_info=True)
    _suspected_orphans = current_orphans - confirmed


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
                    dead.append(sid) if (proc_dead or idle) else None
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
            _reconcile_orphan_contexts()
        except Exception:
            pass
        time.sleep(10)


# 測試環境不啟背景 GC(會打真實 Redis/CDP,且干擾對帳的兩輪狀態斷言)。
# Don't spin the GC thread under the test runner (it would hit real Redis/CDP and
# perturb the reconcile's cross-pass state assertions).
if "test" not in sys.argv and os.getenv("REMOTE_BROWSER_GC", "1") != "0":
    threading.Thread(target=cleanup_dead_sessions, daemon=True).start()
