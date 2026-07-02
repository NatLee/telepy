"""
薄 async CDP(Chrome DevTools Protocol)client。

CDP = WebSocket 上的 JSON-RPC:請求 {"id": N, "method": ..., "params": ...},回應帶
相同 id;事件沒有 id、只有 "method"/"params"。對已 attach 的 target 下指令要在信封
帶 "sessionId"(Target.attachToTarget flatten:true 的 flat session 模式)。browser 端
endpoint 由 GET /json/version 的 webSocketDebuggerUrl 取得。

設計說明 / Design notes:
- CdpConnection 是 Future-based:背景 reader task 以 id 對應解決各請求的 Future,
  事件交給 event_handler。串流(Page.screencastFrame 與指令回應交錯抵達)必須這樣做,
  一次性操作也同樣正確——一套實作、兩種用途共用,不寫第二份「線性讀」版本。
- 一次性 helper(create_session / dispose_context / ...)開短命連線用完即關;
  consumer 用 CdpClient.connect(event_handler=...) 開長命連線自己下 attach/screencast。
- websockets.connect 帶 ping_interval=None:Chrome 的 DevTools endpoint 不玩 ws 層
  ping/pong,預設 20s ping timeout 會誤殺健康的閒置連線。max_size=None:screencast
  幀(base64 JPEG)可超過預設 1MB 上限。
- proxyBypassList "<-loopback>":連 localhost 都不准繞過 proxy——所有流量一律走
  目標機器出口,這是「以目標身分上網」的正確性要求。
"""
import asyncio
import json
import logging
import os

import requests
import websockets

logger = logging.getLogger(__name__)

DEFAULT_CALL_TIMEOUT = 30.0


class CdpError(Exception):
    """CDP 協定錯誤、傳輸錯誤或逾時。/ Protocol, transport, or timeout failure."""


class CdpConnection:
    """
    一條活的 CDP WebSocket(browser endpoint)。

    背景 reader 把「有 id 的回應」解給對應 Future、「沒 id 的事件」交給 event_handler
    (同步函式或 coroutine function 皆可)。連線死亡時所有 pending call 立即以 CdpError
    失敗(fail-fast,不讓 consumer 空等到 timeout)。
    """

    def __init__(self, ws, event_handler=None):
        self._ws = ws
        self._event_handler = event_handler
        self._pending = {}
        self._next_id = 0
        self.closed = False
        self._reader_task = asyncio.ensure_future(self._read_loop())

    @classmethod
    async def connect(cls, ws_url, event_handler=None):
        ws = await websockets.connect(ws_url, max_size=None, ping_interval=None)
        return cls(ws, event_handler=event_handler)

    async def _read_loop(self):
        try:
            async for raw in self._ws:
                try:
                    msg = json.loads(raw)
                except (TypeError, ValueError):
                    continue
                mid = msg.get("id")
                if mid is not None and mid in self._pending:
                    fut = self._pending.pop(mid)
                    if not fut.done():
                        fut.set_result(msg)
                elif "method" in msg and self._event_handler is not None:
                    # 事件 handler 的例外不可殺死 reader(否則所有 pending 卡死)。
                    # An exception in the handler must not kill the reader.
                    try:
                        result = self._event_handler(msg)
                        if asyncio.iscoroutine(result):
                            await result
                    except Exception:
                        logger.exception("CDP event handler failed")
        except Exception:
            # 連線層錯誤(對端關閉/網路)走 finally 的統一收尾。
            pass
        finally:
            self.closed = True
            pending, self._pending = self._pending, {}
            for fut in pending.values():
                if not fut.done():
                    fut.set_exception(CdpError("CDP connection closed"))

    async def call(self, method, params=None, session_id=None,
                   timeout=DEFAULT_CALL_TIMEOUT):
        if self.closed:
            raise CdpError(f"CDP connection closed (before {method})")
        self._next_id += 1
        mid = self._next_id
        msg = {"id": mid, "method": method, "params": params or {}}
        if session_id is not None:
            msg["sessionId"] = session_id
        fut = asyncio.get_running_loop().create_future()
        self._pending[mid] = fut
        try:
            await self._ws.send(json.dumps(msg))
            resp = await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            self._pending.pop(mid, None)
            raise CdpError(f"CDP call timed out after {timeout}s: {method}")
        except CdpError:
            raise
        except Exception as e:
            self._pending.pop(mid, None)
            raise CdpError(f"CDP transport error on {method}: {e}")
        if "error" in resp:
            err = resp["error"]
            raise CdpError(f"{method}: {err.get('message')} (code {err.get('code')})")
        return resp.get("result", {})

    async def close(self):
        self.closed = True
        try:
            await self._ws.close()
        except Exception:
            pass
        # reader 會因 socket 關閉自然結束並收尾 pending;cancel 是保險。
        if self._reader_task is not None and not self._reader_task.done():
            self._reader_task.cancel()


class CdpClient:
    """對單一 Chromium CDP endpoint 的操作入口。"""

    def __init__(self, base_url=None):
        self.base_url = (
            base_url or os.getenv("CHROMIUM_CDP_URL", "http://chromium:9222")
        ).rstrip("/")

    def _browser_ws(self) -> str:
        """同步取得 browser-level WebSocket URL(呼叫端負責丟進 thread)。"""
        r = requests.get(f"{self.base_url}/json/version", timeout=5)
        r.raise_for_status()
        return r.json()["webSocketDebuggerUrl"]

    async def connect(self, event_handler=None) -> CdpConnection:
        """開長命連線(consumer 串流用)。requests 走 to_thread 不卡 event loop。"""
        try:
            ws_url = await asyncio.to_thread(self._browser_ws)
        except Exception as e:
            raise CdpError(f"cannot reach CDP endpoint {self.base_url}: {e}")
        return await CdpConnection.connect(ws_url, event_handler=event_handler)

    async def create_session(self, proxy_server: str) -> dict:
        """
        建立「一個 session 的瀏覽器端資源」:專屬 proxy 的 browser context + 首個分頁。
        context/target 是 browser 層級物件,本連線關閉後持續存在(Phase 0 G5 已驗證),
        consumer 之後再 attach 接手串流。
        """
        conn = await self.connect()
        try:
            ctx = await conn.call("Target.createBrowserContext", {
                "proxyServer": proxy_server,
                "proxyBypassList": "<-loopback>",
            })
            context_id = ctx["browserContextId"]
            try:
                tgt = await conn.call("Target.createTarget", {
                    "url": "about:blank",
                    "browserContextId": context_id,
                })
            except CdpError:
                # 分頁建失敗:立刻收掉剛開的 context,不留孤兒。
                try:
                    await conn.call("Target.disposeBrowserContext",
                                    {"browserContextId": context_id})
                except CdpError:
                    logger.warning("failed to dispose context %s after "
                                   "createTarget failure", context_id)
                raise
            return {"context_id": context_id, "target_id": tgt["targetId"]}
        finally:
            await conn.close()

    async def dispose_context(self, context_id: str) -> None:
        """關閉 context(連同其所有分頁)。/ Dispose a context and all its targets."""
        conn = await self.connect()
        try:
            await conn.call("Target.disposeBrowserContext",
                            {"browserContextId": context_id})
        finally:
            await conn.close()

    async def list_context_ids(self) -> set:
        """列出 Chrome 內現存的 browser context id(孤兒對帳用)。"""
        conn = await self.connect()
        try:
            result = await conn.call("Target.getBrowserContexts")
            return set(result.get("browserContextIds", []))
        finally:
            await conn.close()
