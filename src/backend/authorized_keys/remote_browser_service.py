import os
import sys
import time
import json
import socket
import logging
import subprocess
import tempfile
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
#   - _store(Redis):存「跨 worker 要查的欄位」(server_id / ws_port / kasm_session_id /
#     proxy_port / last_seen)。prod 是 gunicorn 多 worker,`/start`(REST)與 VNC 橋接 WS
#     consumer 常落在不同 worker;consumer 必須能用 session_id 反查 ws_port 並重驗權限。
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


# 反向連線的硬化 SSH 選項(這條 -D 指令過去完全沒帶 -o,才會在冷啟時無限卡住):
#   BatchMode=yes           金鑰認證失敗絕不落到互動提示而卡死(daemon 沒有 tty)。
#   ExitOnForwardFailure=yes 綁不到本地 SOCKS 埠就立刻 exit → _wait_for_port 靠 proc.poll() 秒失敗。
#   ConnectTimeout=10        bound 住 ProxyCommand 第一跳的 TCP connect。
#   ServerAliveInterval/Max  兩跳中任一段死掉時 ~15s 內放棄,不無限等。
# 不加 -q:保留 stderr,失敗時記錄真正原因(過去 -q 把錯誤全吞了,完全無從偵錯)。
_SSH_HARDEN_OPTS = [
    "-o", "BatchMode=yes",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=5",
    "-o", "ServerAliveCountMax=3",
]


def _spawn_socks_proxy(proxy_port, target_reverse_port, target_username):
    """起 ssh -D SOCKS proxy(argv 形式,免 shell)。stderr 導到暫存檔供失敗診斷。回 (proc, stderr_path)。"""
    stderr_f = tempfile.NamedTemporaryFile(prefix="rb-ssh-", suffix=".log", delete=False)
    stderr_path = stderr_f.name
    ssh_cmd = [
        "ssh", "-N", *_SSH_HARDEN_OPTS,
        "-D", f"0.0.0.0:{proxy_port}",
        "-p", str(target_reverse_port),
        f"{target_username}@{SSH_HOST}",
    ]
    proc = subprocess.Popen(ssh_cmd, stdout=subprocess.DEVNULL, stderr=stderr_f)
    stderr_f.close()   # 子行程持有自己的 fd;父行程這個 handle 關掉,之後從路徑讀
    return proc, stderr_path


def _drain_ssh_stderr(stderr_path):
    """讀取並刪除 ssh stderr 暫存檔,回內容(用於失敗時記錄真正原因)。"""
    txt = ""
    try:
        with open(stderr_path, "r", errors="replace") as fh:
            txt = fh.read().strip()
    except OSError:
        pass
    try:
        os.unlink(stderr_path)
    except OSError:
        pass
    return txt


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

    # 冷啟第一次常失敗、重試就成功:第一次連線暖了 ProxyCommand 的 telepy-ssh master
    # (ControlPersist)與裝置端的路由/DNS 快取,第二次(fresh 埠、暖 hop1)通常就起得來。
    # 故自動重試,把使用者原本手動再點一次的動作內建起來。每次取「新的」free port:上一輪被
    # kill 的 ssh 可能還占著舊埠。genuinely offline 的裝置靠上面的硬化選項會快速失敗、不會空等滿。
    ssh_timeout = getattr(settings, "remote_browser_ssh_timeout", 30)
    attempts = max(1, int(getattr(settings, "remote_browser_ssh_attempts", 2)))
    ssh_process = None
    proxy_port = None
    for attempt in range(1, attempts + 1):
        proxy_port = get_free_port()
        logger.info(f"Starting SSH proxy for target {server_id} on port {proxy_port} "
                    f"(attempt {attempt}/{attempts})")
        ssh_process, stderr_path = _spawn_socks_proxy(proxy_port, target_reverse_port, target_username)
        if _wait_for_port("127.0.0.1", proxy_port, timeout=ssh_timeout, proc=ssh_process):
            _drain_ssh_stderr(stderr_path)   # 成功也清掉暫存檔
            break
        # 這一輪沒起來:收掉 ssh,記錄 stderr 的真正原因供偵錯。
        try:
            ssh_process.terminate()
            ssh_process.wait(timeout=3)
        except Exception:
            try:
                ssh_process.kill()
            except Exception:
                pass
        err = _drain_ssh_stderr(stderr_path)
        logger.warning(
            f"SSH proxy attempt {attempt}/{attempts} for target {server_id} did not bind "
            f"a SOCKS listener within {ssh_timeout}s"
            + (f"; ssh stderr: {err[-500:]}" if err else " (ssh produced no stderr)")
        )
        ssh_process = None
    else:
        raise Exception(
            f"Failed to start SSH proxy for target {server_id} after {attempts} attempts "
            f"(no SOCKS listener within {ssh_timeout}s each — is the device online?)."
        )

    session_id = str(uuid.uuid4())
    with _SESSIONS_LOCK:
        ACTIVE_SESSIONS[session_id] = {
            "ssh_process": ssh_process,
            "proxy_port": proxy_port,
            "server_id": server_id,
            "ws_port": None,
            "kasm_session_id": None,
            "last_seen": time.time(),
        }

    proxy_host = os.getenv("HOSTNAME", "backend")   # kasm-browser 經 telepy-network 連回本後端
    geometry = getattr(settings, "remote_browser_geometry", "1280x720") or "1280x720"
    homepage = getattr(settings, "remote_browser_homepage", "") or None
    lang = getattr(settings, "remote_browser_language", "") or None
    kasm_timeout = int(getattr(settings, "remote_browser_kasm_create_timeout", 30) or 30)
    try:
        # 設定檔每 session 臨時、停止即刪(不保留歷史;同目標並發 session 也不會踩 SingletonLock)。
        # homepage/lang 為 None 時,session-manager 退回它自己的 env 預設。
        ids = _kasm.create_session(f"socks5://{proxy_host}:{proxy_port}",
                                   geometry=geometry, lang=lang, homepage=homepage,
                                   timeout=kasm_timeout)
    except KasmError as e:
        stop_remote_browser(session_id)             # 收 ssh + 清登記
        raise Exception(f"Failed to create VNC browser session: {e}")

    with _SESSIONS_LOCK:
        if session_id in ACTIVE_SESSIONS:
            ACTIVE_SESSIONS[session_id]["ws_port"] = ids["ws_port"]
            ACTIVE_SESSIONS[session_id]["kasm_session_id"] = ids["session_id"]
    _store.put(session_id, {
        "server_id": server_id,
        "ws_port": ids["ws_port"],
        "kasm_session_id": ids["session_id"],
        "proxy_port": proxy_port,
        "last_seen": time.time(),
    })
    logger.info(f"Remote browser session {session_id} ready (ws {ids['ws_port']})")
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
            "ws_port": sess.get("ws_port"),
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


def _dead_session_ids(now, live_ids, redis_ok, idle_timeout):
    """
    決定哪些本行程 session 該回收。回收條件:
      - ssh 行程已死;或
      - Redis 可用時:該 session 的 Redis key 已消失(= 任一 worker 都沒在 TTL 內續命)。
      - Redis 掛掉時:退回本行程 last_seen 的 idle 判斷(僅單 worker 準)。

    **關鍵**:Redis 可用時**不**看本行程 last_seen —— 多 worker 下 ping/keepalive 可能落在
    非 owner worker,owner 的 last_seen 永不更新,拿它判 idle 會把還活著的 session 誤收。
    """
    dead = []
    with _SESSIONS_LOCK:
        for sid, sess in list(ACTIVE_SESSIONS.items()):
            proc = sess.get("ssh_process")
            if proc and proc.poll() is not None:
                dead.append(sid)
            elif redis_ok:
                if sid not in live_ids:
                    dead.append(sid)
            elif (now - sess.get("last_seen", now)) > idle_timeout:
                dead.append(sid)
    return dead


def cleanup_dead_sessions():
    while True:
        try:
            now = time.time()
            # Redis TTL 是跨 worker 的心跳權威:ping(REST)與 VNC WS 的 keepalive 都經
            # `_store.refresh` 續 Redis TTL,不論落在哪個 gunicorn worker。
            try:
                live_ids = _store.live_session_ids()
                redis_ok = True
            except Exception:
                live_ids, redis_ok = set(), False
            idle_timeout = 60
            if not redis_ok:
                try:
                    idle_timeout = int(SiteSettings.get_solo().remote_browser_session_idle_timeout)
                except Exception:
                    idle_timeout = 60
            for sid in _dead_session_ids(now, live_ids, redis_ok, idle_timeout):
                stop_remote_browser(sid)
        except Exception:
            pass
        time.sleep(10)


# 測試環境不啟背景 GC(會打真實 Redis/session-manager)。
if "test" not in sys.argv and os.getenv("REMOTE_BROWSER_GC", "1") != "0":
    threading.Thread(target=cleanup_dead_sessions, daemon=True).start()
