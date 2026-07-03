"""
Backend → kasm-browser session-manager 的薄 client(同步 requests)。

kasm-browser 是一顆共用容器,內含 KasmVNC(Xkasmvnc)+ Chromium + 一個小型 session-manager
HTTP API。每個 remote-browser session,backend 呼叫這支 API 起一組「Xkasmvnc 顯示 + 綁定該
session SOCKS proxy 的 chromium」,拿回 **websocket** 埠;consumer 之後把該 ws 埠中繼到 /ws。

- 不需 docker.sock:只是對「一個長命容器」呼叫 HTTP 起/停行程,不做容器編排。
- 認證:X-Internal-Token(= INTERNAL_API_TOKEN),只在 telepy-network 內,API 不對外。
- 同步即可:一次性控制(start/stop)在同步 DRF view / service 內呼叫(串流走 consumer 的
  asyncio WebSocket 中繼,不經這裡)。
"""
import os
import logging

import requests

logger = logging.getLogger(__name__)


class KasmError(Exception):
    """session-manager API 呼叫失敗。/ session-manager API call failed."""


class KasmClient:
    def __init__(self, base_url=None, token=None):
        self.base_url = (
            base_url or os.getenv("KASM_BROWSER_API", "http://kasm-browser:7000")
        ).rstrip("/")
        self.token = token if token is not None else os.getenv("INTERNAL_API_TOKEN", "")

    def _headers(self):
        return {"X-Internal-Token": self.token}

    def create_session(self, proxy: str, geometry: str = "1280x720",
                       lang=None) -> dict:
        """
        起一個 KasmVNC 瀏覽器 session。回 {session_id, ws_port}。
        proxy 形如 socks5://backend:<ssh -D 埠>;chromium 會以此為出口(= 目標機器身分)。
        設定檔一律「每 session 臨時、停止即刪」:不保留歷史,也避免 Chromium SingletonLock
        讓同目標並發 session 互搶(session-manager 端實作)。
        """
        payload = {"proxy": proxy, "geometry": geometry}
        if lang is not None:
            payload["lang"] = lang
        try:
            r = requests.post(
                f"{self.base_url}/sessions",
                json=payload,
                headers=self._headers(),
                timeout=30,
            )
            r.raise_for_status()
            data = r.json()
        except requests.RequestException as e:
            raise KasmError(f"create_session failed: {e}")
        except ValueError as e:
            raise KasmError(f"create_session: bad JSON response: {e}")
        if not data.get("session_id") or not data.get("ws_port"):
            raise KasmError(f"create_session: incomplete response {data!r}")
        return {"session_id": data["session_id"], "ws_port": int(data["ws_port"])}

    def stop_session(self, session_id: str) -> None:
        """停掉一個 session(kill Xvnc+chromium)。best-effort:失敗只記錄,不往外丟。"""
        try:
            requests.delete(
                f"{self.base_url}/sessions/{session_id}",
                headers=self._headers(),
                timeout=10,
            )
        except requests.RequestException as e:
            logger.warning(f"kasm stop_session {session_id} failed: {e}")
