import asyncio
import json
import socket
from unittest import mock, IsolatedAsyncioTestCase

import websockets


def _closed_port():
    """拿一個「沒人聽」的 port(綁了拿號就關),讓上游連線必定 refuse。"""
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p

import authorized_keys.remote_browser_service as svc
from tunnels.consumers import RemoteBrowserConsumer


class MockKasmWsServer:
    """
    最小 KasmVNC 假 websocket 伺服器:連上即送 greeting(server 先說話),之後把收到的二進位
    訊息原樣回送(echo)。用來端到端驗證 consumer 的 WS↔WS 中繼,不需真的 KasmVNC。
    """
    GREETING = b"RFB 003.008\n"

    def __init__(self):
        self._server = None
        self.port = None
        self.received = bytearray()

    async def start(self):
        # subprotocols=["binary"]:配合 consumer 要求的二進位子協定。
        self._server = await websockets.serve(
            self._handle, "127.0.0.1", 0, subprotocols=["binary"])
        self.port = self._server.sockets[0].getsockname()[1]

    async def _handle(self, ws, *args):     # *args:相容不同 websockets 版本的 handler 簽名
        await ws.send(self.GREETING)        # server 先說話
        try:
            async for msg in ws:
                if isinstance(msg, (bytes, bytearray)):
                    self.received.extend(msg)
                    await ws.send(bytes(msg))   # echo
        except Exception:
            pass

    async def stop(self):
        if self._server:
            self._server.close()
            try:
                await asyncio.wait_for(self._server.wait_closed(), timeout=1)
            except Exception:
                pass


class _FakeStore:
    def __init__(self):
        self.data = {}
    def get(self, sid):
        return dict(self.data[sid]) if sid in self.data else None
    def delete(self, sid):
        self.data.pop(sid, None)
    def live_session_ids(self):
        return set(self.data)


def _make_consumer(server_id=5):
    c = RemoteBrowserConsumer()
    c.scope = {"url_route": {"kwargs": {"session_id": "sess-1"}}}
    c.KASM_HOST = "127.0.0.1"
    c.KASM_WS_PATH = "/"          # 測試伺服器不看路徑
    c.KASM_WS_SCHEME = "ws"       # 純 ws(內網;kasmvnc.yaml require_ssl:false)
    c.KASM_WS_SUBPROTOCOL = "binary"
    c._ws_closed = False
    c._authed = True
    c._auth_timeout_task = None
    c.send = mock.AsyncMock()
    c.close = mock.AsyncMock()             # _safe_close 呼叫真 close 會碰 channel 機制,mock 掉
    c._verify_access = mock.AsyncMock(return_value=True)
    return c


def _binary_sends(send_mock):
    return [call.kwargs["bytes_data"] for call in send_mock.await_args_list
            if "bytes_data" in call.kwargs]


def _text_sends(send_mock):
    return [json.loads(call.kwargs["text_data"]) for call in send_mock.await_args_list
            if "text_data" in call.kwargs]


class RemoteBrowserVncBridgeTest(IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.kasm = MockKasmWsServer()
        await self.kasm.start()
        # 讓真實 stop_remote_browser 不去碰 Redis/kasm(沙箱無此二者,否則 disconnect 會卡住)。
        self._store_patch = mock.patch.object(svc, "_store", _FakeStore())
        self._kasm_patch = mock.patch.object(svc, "_kasm", mock.Mock())
        self._store_patch.start()
        self._kasm_patch.start()

    async def asyncTearDown(self):
        self._store_patch.stop()
        self._kasm_patch.stop()
        svc.ACTIVE_SESSIONS.clear()
        await self.kasm.stop()

    def _session(self):
        return {"ws_port": self.kasm.port, "server_id": 5}

    async def test_after_auth_connects_upstream_and_signals_ready(self):
        c = _make_consumer()
        with mock.patch.object(svc, "get_session", return_value=self._session()):
            code = await c.after_auth(user=mock.Mock(), message={})
        self.assertIsNone(code)                                  # 成功
        self.assertIn({"type": "ready"}, _text_sends(c.send))    # 先送 ready,還沒 pump
        self.assertEqual(_binary_sends(c.send), [])              # begin 之前不送位元組
        await c.disconnect(1000)

    async def test_begin_starts_pump_and_forwards_server_greeting(self):
        c = _make_consumer()
        with mock.patch.object(svc, "get_session", return_value=self._session()):
            await c.after_auth(user=mock.Mock(), message={})
        await c.on_message(text_data=json.dumps({"type": "begin"}))
        await asyncio.sleep(0.15)                                # 讓 pump 讀到 greeting
        self.assertIn(MockKasmWsServer.GREETING, _binary_sends(c.send))
        await c.disconnect(1000)

    async def test_client_binary_is_sent_upstream_and_echo_returns(self):
        c = _make_consumer()
        with mock.patch.object(svc, "get_session", return_value=self._session()):
            await c.after_auth(user=mock.Mock(), message={})
        await c.on_message(text_data=json.dumps({"type": "begin"}))
        await c.on_message(bytes_data=b"CLIENT-KASM-BYTES")
        await asyncio.sleep(0.15)
        self.assertIn(b"CLIENT-KASM-BYTES", bytes(self.kasm.received))   # 到了上游
        self.assertIn(b"CLIENT-KASM-BYTES", _binary_sends(c.send))       # echo 回到 client
        await c.disconnect(1000)

    async def test_after_auth_rejects_unknown_session(self):
        c = _make_consumer()
        with mock.patch.object(svc, "get_session", return_value=None):
            code = await c.after_auth(user=mock.Mock(), message={})
        self.assertEqual(code, 4404)

    async def test_after_auth_rejects_when_permission_denied(self):
        c = _make_consumer()
        c._verify_access = mock.AsyncMock(return_value=False)
        with mock.patch.object(svc, "get_session", return_value=self._session()):
            code = await c.after_auth(user=mock.Mock(), message={})
        self.assertEqual(code, 4403)

    async def test_disconnect_stops_session_and_closes_upstream(self):
        c = _make_consumer()
        with mock.patch.object(svc, "get_session", return_value=self._session()):
            await c.after_auth(user=mock.Mock(), message={})
        with mock.patch.object(svc, "stop_remote_browser") as stop:
            await c.disconnect(1000)
            stop.assert_called_once_with("sess-1")
        self.assertIsNone(c._upstream)

    async def test_binary_before_begin_still_forwards_upstream(self):
        """client→上游 方向不需等 begin(VNC client 本就等 server greeting)。"""
        c = _make_consumer()
        with mock.patch.object(svc, "get_session", return_value=self._session()):
            await c.after_auth(user=mock.Mock(), message={})
        await c.on_message(bytes_data=b"EARLY")
        await asyncio.sleep(0.1)
        self.assertIn(b"EARLY", bytes(self.kasm.received))
        await c.disconnect(1000)

    async def test_scheme_and_path_fallback_when_env_hint_wrong(self):
        """env 提示 scheme=wss/path=/nope 都不對 → 自動退回 ws + 其他 path,仍連上並送 ready。"""
        c = _make_consumer()
        c.KASM_WS_SCHEME = "wss"      # 錯:mock 是純 ws → wss 交握會失敗,應退回 ws
        c.KASM_WS_PATH = "/nope"      # mock 不看 path,退回時任一 ws path 都會成功
        with mock.patch.object(svc, "get_session", return_value=self._session()):
            code = await c.after_auth(user=mock.Mock(), message={})
        self.assertIsNone(code)
        self.assertIn({"type": "ready"}, _text_sends(c.send))
        await c.disconnect(1000)

    async def test_after_auth_returns_4011_when_upstream_unreachable(self):
        """所有 scheme/path 候選都連不上 → 回 4011(不是崩潰)。"""
        c = _make_consumer()
        with mock.patch.object(svc, "get_session",
                               return_value={"ws_port": _closed_port(), "server_id": 5}):
            code = await c.after_auth(user=mock.Mock(), message={})
        self.assertEqual(code, 4011)

    async def test_auth_headers_built_from_creds(self):
        """帶 KasmVNC web 層 Basic Auth(server 端 WS client 可帶 header)。"""
        import base64
        c = _make_consumer()
        c.KASM_WS_USER = "telepy"
        c.KASM_WS_PASSWORD = "telepyvnc"
        h = c._auth_headers()
        self.assertEqual(h["Authorization"],
                         "Basic " + base64.b64encode(b"telepy:telepyvnc").decode())

    async def test_auth_headers_disabled_when_user_empty(self):
        """KASM_WS_USER 空 → 不帶 auth(供 -disableBasicAuth 真的生效的 build)。"""
        c = _make_consumer()
        c.KASM_WS_USER = ""
        self.assertIsNone(c._auth_headers())
