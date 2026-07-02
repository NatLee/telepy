import os
import time
import socket
import logging
import subprocess
import uuid
import threading
import secrets
from typing import Dict, Any

from site_settings.models import SiteSettings
from services.neko_rooms_client import NekoRoomsClient, NekoRoomsError

logger = logging.getLogger(__name__)

# session_id -> { ssh_process, proxy_port, server_id, room_id, room_name, last_seen }
ACTIVE_SESSIONS: Dict[str, Dict[str, Any]] = {}
_SESSIONS_LOCK = threading.Lock()

SSH_HOST = "reverse"                 # 既有 reverse gateway,保持不變
LABEL_MANAGED = "telepy.managed"
LABEL_SESSION = "telepy.session-id"
LABEL_INSTANCE = "telepy.instance"   # PROJECT_NAME —— 對帳只認本部署的房間
INSTANCE = os.getenv("PROJECT_NAME", "main")

_neko = NekoRoomsClient()


def get_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('', 0))
        return s.getsockname()[1]


def _wait_for_port(host: str, port: int, timeout: float = 30.0, proc=None) -> bool:
    """
    等 SOCKS proxy listen。

    `reverse` 是兩跳連線(backend → telepy-ssh 的 ProxyCommand → 裝置反向隧道),
    兩跳都用 ControlMaster/ControlPersist。冷啟第一次要建立兩個 master socket 再對
    裝置認證,可能比舊的 8s 久;故預設放寬到 30s。ControlPersist=600 會讓後續啟動
    幾乎瞬間完成。若傳入 proc,ssh 進程一旦死掉就即刻失敗,不必空等到 timeout。
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc is not None and proc.poll() is not None:
            return False  # ssh 已退出(認證失敗/裝置離線)——真失敗,別再等
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.5)
            try:
                s.connect((host, port))
                return True
            except OSError:
                time.sleep(0.2)
    return False


def _count_active() -> int:
    with _SESSIONS_LOCK:
        return len(ACTIVE_SESSIONS)


def start_remote_browser(target_username, target_reverse_port, server_id):
    """
    Start a remote browser session.
    1. Start a local ssh -D SOCKS proxy to the target (unchanged behavior).
    2. Create a dedicated Neko room via neko-rooms, injecting the proxy by env.
    Returns: { "session_id": ..., "url": ..., "room_id": ... }
    """
    settings = SiteSettings.get_solo()
    # getattr 預設值:即使 SiteSettings 欄位尚未 migrate 也能運作(Task 5 加上可調欄位)
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

    # 等 SOCKS proxy listen;冷啟兩跳 ControlMaster 較慢,timeout 放寬(可經 SiteSettings 調)
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
    room_name = f"telepy-{session_id.split('-')[0]}"

    # 先登記(room_id=None),避免對帳 thread 在建立空窗期誤刪新房間
    with _SESSIONS_LOCK:
        ACTIVE_SESSIONS[session_id] = {
            "ssh_process": ssh_process,
            "proxy_port": proxy_port,
            "server_id": server_id,
            "room_id": None,
            "room_name": room_name,
            "last_seen": time.time(),
        }

    proxy_host = os.getenv("HOSTNAME", "backend")   # 後端容器名,房間經 telepy-network 解析
    user_pass = secrets.token_urlsafe(9)
    neko_image = getattr(settings, "remote_browser_neko_image", "telepy-neko-chromium:latest")
    room_settings = {
        "api_version": 3,                   # 顯式指定,跳過 neko-rooms 的 image 偵測(fallback v2 會壞)
        "name": room_name,
        "neko_image": neko_image,
        "max_connections": 0,               # mux 模式:一房一埠(此值於 mux 下被忽略)
        "control_protection": False,
        "implicit_control": True,
        "user_pass": user_pass,
        "admin_pass": secrets.token_urlsafe(9),
        "screen": "1280x720@30",
        "video_codec": "VP8",               # 顯式送預設值,避免產生空的 NEKO_CAPTURE_VIDEO_CODEC=
        "audio_codec": "OPUS",              # 同上
        "envs": {
            "PROXY_SERVER": f"socks5://{proxy_host}:{proxy_port}",
        },
        "labels": {
            LABEL_MANAGED: "true",
            LABEL_SESSION: session_id,
            LABEL_INSTANCE: INSTANCE,
            "telepy.server-id": str(server_id),
        },
    }

    try:
        room = _neko.create_room(room_settings)     # start=true
    except NekoRoomsError as e:
        stop_remote_browser(session_id)             # 收 ssh + 移除登記
        raise Exception(f"Failed to create Neko room: {e}")

    room_id = room.get("id")
    with _SESSIONS_LOCK:
        if session_id in ACTIVE_SESSIONS:
            ACTIVE_SESSIONS[session_id]["room_id"] = room_id

    # 盡量等到 ready 再回,iframe 就不會停在開機畫面(逾時也照回,neko-rooms 有等待頁)
    if room_id:
        _neko.wait_ready(room_id, timeout=20.0)

    # 房間 URL 用 path_prefix + name(與 origin 無關,前端會補 apiBase);usr/pwd 自動登入
    room_url = f"/neko/{room_name}/?usr=telepy&pwd={user_pass}"
    return {"session_id": session_id, "url": room_url, "room_id": room_id}


def ping_remote_browser(session_id):
    with _SESSIONS_LOCK:
        session = ACTIVE_SESSIONS.get(session_id)
        if not session:
            return False
        session["last_seen"] = time.time()
    return True


def stop_remote_browser(session_id):
    with _SESSIONS_LOCK:
        session = ACTIVE_SESSIONS.pop(session_id, None)
    if not session:
        return False

    room_id = session.get("room_id")
    if room_id:
        try:
            _neko.delete_room(room_id)
        except NekoRoomsError as e:
            logger.warning(f"Failed to delete Neko room {room_id}: {e}")

    ssh_process = session.get("ssh_process")
    if ssh_process:
        try:
            ssh_process.terminate()
            ssh_process.wait(timeout=5)
        except Exception:
            try:
                ssh_process.kill()
            except Exception:
                pass
    return True


def _reconcile_orphan_rooms():
    """刪掉 neko-rooms 內帶 telepy label、但本行程已無對應 session 的孤兒房間。"""
    try:
        # 只列本部署(PROJECT_NAME)的房間,避免多套 stack 共用 neko-rooms 時互刪
        rooms = _neko.list_rooms({LABEL_MANAGED: "true", LABEL_INSTANCE: INSTANCE})
    except NekoRoomsError:
        return
    with _SESSIONS_LOCK:
        known = set(ACTIVE_SESSIONS.keys())
    for room in rooms:
        labels = room.get("labels") or {}
        sid = labels.get(LABEL_SESSION)
        if sid and sid not in known:
            try:
                _neko.delete_room(room["id"])
                logger.info(f"Reaped orphan Neko room {room.get('id')} (session {sid})")
            except NekoRoomsError:
                pass


def cleanup_dead_sessions():
    while True:
        try:
            idle_timeout = SiteSettings.get_solo().remote_browser_session_idle_timeout
            now = time.time()
            dead = []
            with _SESSIONS_LOCK:
                for sid, sess in list(ACTIVE_SESSIONS.items()):
                    proc = sess.get("ssh_process")
                    if (proc and proc.poll() is not None) or (now - sess.get("last_seen", now)) > idle_timeout:
                        dead.append(sid)
            for sid in dead:
                stop_remote_browser(sid)
            _reconcile_orphan_rooms()
        except Exception:
            pass
        time.sleep(10)


threading.Thread(target=cleanup_dead_sessions, daemon=True).start()
