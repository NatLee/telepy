import asyncio
import json
from unittest import mock, IsolatedAsyncioTestCase

import authorized_keys.remote_browser_service as svc
from tunnels.consumers import RemoteBrowserConsumer


class MockRfbServer:
    """
    最小 RFB 假伺服器:連上即送 greeting(server 先說話),之後把收到的位元組原樣回送(echo)。
    用來端到端驗證 consumer 的雙向 byte-pump,不需真的 KasmVNC。
    """
    GREETING = b"RFB 003.008\n"

    def __init__(self):
        self._server = None
        self.port = None
        self.received = bytearray()

    async def start(self):
        self._server = await asyncio.start_server(self._handle, "127.0.0.1", 0)
        self.port = self._server.sockets[0].getsockname()[1]

    async def _handle(self, reader, writer):
        writer.write(self.GREETING)
        await writer.drain()
        try:
            while True:
                d = await reader.read(4096)
                if not d:
                    break
                self.received.extend(d)
                writer.write(d)          # echo
                await writer.drain()
        except Exception:
            pass
        finally:
            try:
                writer.close()
            except Exception:
                pass

    async def stop(self):
        if self._server:
            self._server.close()   # 不等 wait_closed:連線可能還在收尾,會卡住


class _FakeStore:
    def __init__(self):
        self.data = {}
    def get(self, sid):
        return dict(self.data[sid]) if sid in self.data else None
    def delete(self, sid):
        self.data.pop(sid, None)
    def live_session_ids(self):
        return set(self.data)


def _make_consumer(rfb_port, server_id=5):
    c = RemoteBrowserConsumer()
    c.scope = {"url_route": {"kwargs": {"session_id": "sess-1"}}}
    c.KASM_HOST = "127.0.0.1"
    c._ws_closed = False
    c._authed = True
    c._auth_timeout_task = None
    c.send = mock.AsyncMock()
    c.close = mock.AsyncMock()             # _safe_close 呼叫真 close 會碰 channel 機制,mock 掉
    c._verify_access = mock.AsyncMock(return_value=True)
    return c


def _binary_sends(send_mock):
    out = []
    for call in send_mock.await_args_list:
        if "bytes_data" in call.kwargs:
            out.append(call.kwargs["bytes_data"])
    return out


def _text_sends(send_mock):
    out = []
    for call in send_mock.await_args_list:
        if "text_data" in call.kwargs:
            out.append(json.loads(call.kwargs["text_data"]))
    return out


class RemoteBrowserVncBridgeTest(IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.rfb = MockRfbServer()
        await self.rfb.start()
        # 讓真實 stop_remote_browser 不去碰 Redis/kasm(沙箱無此二者,否則 disconnect 會卡住)。
        self._store_patch = mock.patch.object(svc, "_store", _FakeStore())
        self._kasm_patch = mock.patch.object(svc, "_kasm", mock.Mock())
        self._store_patch.start()
        self._kasm_patch.start()

    async def asyncTearDown(self):
        self._store_patch.stop()
        self._kasm_patch.stop()
        svc.ACTIVE_SESSIONS.clear()
        await self.rfb.stop()

    async def test_after_auth_connects_rfb_and_signals_ready(self):
        c = _make_consumer(self.rfb.port)
        with mock.patch.object(svc, "get_session",
                               return_value={"rfb_port": self.rfb.port, "server_id": 5}):
            code = await c.after_auth(user=mock.Mock(), message={})
        self.assertIsNone(code)                      # 成功
        self.assertIn({"type": "ready"}, _text_sends(c.send))   # 先送 ready,還沒 pump
        self.assertEqual(_binary_sends(c.send), [])  # begin 之前不送 RFB 位元組
        await c.disconnect(1000)

    async def test_begin_starts_pump_and_forwards_server_greeting(self):
        c = _make_consumer(self.rfb.port)
        with mock.patch.object(svc, "get_session",
                               return_value={"rfb_port": self.rfb.port, "server_id": 5}):
            await c.after_auth(user=mock.Mock(), message={})
        await c.on_message(text_data=json.dumps({"type": "begin"}))
        await asyncio.sleep(0.1)                      # 讓 pump 讀到 greeting
        self.assertIn(MockRfbServer.GREETING, _binary_sends(c.send))
        with mock.patch.object(svc, "stop_remote_browser"):
            await c.disconnect(1000)

    async def test_client_binary_is_written_to_rfb_and_echo_returns(self):
        c = _make_consumer(self.rfb.port)
        with mock.patch.object(svc, "get_session",
                               return_value={"rfb_port": self.rfb.port, "server_id": 5}):
            await c.after_auth(user=mock.Mock(), message={})
        await c.on_message(text_data=json.dumps({"type": "begin"}))
        await c.on_message(bytes_data=b"CLIENT-RFB-BYTES")
        await asyncio.sleep(0.1)
        self.assertIn(b"CLIENT-RFB-BYTES", bytes(self.rfb.received))   # 到了 RFB server
        self.assertIn(b"CLIENT-RFB-BYTES", _binary_sends(c.send))      # echo 回到 client
        with mock.patch.object(svc, "stop_remote_browser"):
            await c.disconnect(1000)

    async def test_after_auth_rejects_unknown_session(self):
        c = _make_consumer(self.rfb.port)
        with mock.patch.object(svc, "get_session", return_value=None):
            code = await c.after_auth(user=mock.Mock(), message={})
        self.assertEqual(code, 4404)

    async def test_after_auth_rejects_when_permission_denied(self):
        c = _make_consumer(self.rfb.port)
        c._verify_access = mock.AsyncMock(return_value=False)
        with mock.patch.object(svc, "get_session",
                               return_value={"rfb_port": self.rfb.port, "server_id": 5}):
            code = await c.after_auth(user=mock.Mock(), message={})
        self.assertEqual(code, 4403)

    async def test_disconnect_stops_session_and_closes_writer(self):
        c = _make_consumer(self.rfb.port)
        with mock.patch.object(svc, "get_session",
                               return_value={"rfb_port": self.rfb.port, "server_id": 5}):
            await c.after_auth(user=mock.Mock(), message={})
        with mock.patch.object(svc, "stop_remote_browser") as stop:
            await c.disconnect(1000)
            stop.assert_called_once_with("sess-1")
        self.assertIsNone(c._writer)

    async def test_binary_before_begin_still_forwards_to_rfb(self):
        """client→RFB 方向不需等 begin(RFB client 本就等 server greeting)。"""
        c = _make_consumer(self.rfb.port)
        with mock.patch.object(svc, "get_session",
                               return_value={"rfb_port": self.rfb.port, "server_id": 5}):
            await c.after_auth(user=mock.Mock(), message={})
        await c.on_message(bytes_data=b"EARLY")
        await asyncio.sleep(0.05)
        self.assertIn(b"EARLY", bytes(self.rfb.received))
        with mock.patch.object(svc, "stop_remote_browser"):
            await c.disconnect(1000)
