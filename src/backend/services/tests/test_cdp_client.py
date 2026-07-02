import asyncio
import json
from unittest import IsolatedAsyncioTestCase, mock

from services.cdp_client import CdpClient, CdpConnection, CdpError


class FakeCdpSocket:
    """
    可腳本化的假 `websockets` 連線:依 method 自動回覆 CDP 回應,支援亂序回覆與
    事件推送。/ Scriptable fake of a websockets connection: auto-responds per
    method, supports out-of-order replies and pushed events.
    """

    def __init__(self, responders=None, auto_respond=True):
        self.sent = []                     # parsed request dicts, in order
        self.responders = responders or {}  # method -> result | Exception | callable(msg)
        self.auto_respond = auto_respond
        self.closed = False
        self._queue = asyncio.Queue()

    # --- test helpers -----------------------------------------------------
    def push_raw(self, msg: dict):
        self._queue.put_nowait(msg)

    def push_event(self, method, params=None, session_id=None):
        ev = {"method": method, "params": params or {}}
        if session_id is not None:
            ev["sessionId"] = session_id
        self.push_raw(ev)

    # --- websockets interface ----------------------------------------------
    async def send(self, raw):
        msg = json.loads(raw)
        self.sent.append(msg)
        if not self.auto_respond:
            return
        r = self.responders.get(msg.get("method"), {})
        if callable(r):
            r = r(msg)
        if isinstance(r, Exception):
            self.push_raw({"id": msg["id"],
                           "error": {"code": -32000, "message": str(r)}})
        else:
            self.push_raw({"id": msg["id"], "result": r})

    async def close(self):
        self.closed = True
        self._queue.put_nowait(None)

    def __aiter__(self):
        return self

    async def __anext__(self):
        item = await self._queue.get()
        if item is None:
            raise StopAsyncIteration
        return json.dumps(item)


def _patched_client(fake):
    """回傳 (client, patchers):_browser_ws 與 websockets.connect 都換成假件。"""
    client = CdpClient(base_url="http://chromium-test:9222")
    p1 = mock.patch.object(CdpClient, "_browser_ws", return_value="ws://fake/devtools")
    p2 = mock.patch("services.cdp_client.websockets.connect",
                    new=mock.AsyncMock(return_value=fake))
    return client, (p1, p2)


class CdpClientSessionTest(IsolatedAsyncioTestCase):
    async def test_create_session_creates_proxied_context_then_target(self):
        fake = FakeCdpSocket(responders={
            "Target.createBrowserContext": {"browserContextId": "ctx-1"},
            "Target.createTarget": {"targetId": "tgt-1"},
        })
        client, patchers = _patched_client(fake)
        with patchers[0], patchers[1]:
            result = await client.create_session("socks5://backend:12345")

        self.assertEqual(result, {"context_id": "ctx-1", "target_id": "tgt-1"})
        create_ctx, create_tgt = fake.sent[0], fake.sent[1]
        # context 帶 per-context proxy,且連 loopback 都不准繞過 proxy
        self.assertEqual(create_ctx["method"], "Target.createBrowserContext")
        self.assertEqual(create_ctx["params"]["proxyServer"], "socks5://backend:12345")
        self.assertEqual(create_ctx["params"]["proxyBypassList"], "<-loopback>")
        # target 掛在剛建立的 context 底下
        self.assertEqual(create_tgt["method"], "Target.createTarget")
        self.assertEqual(create_tgt["params"]["browserContextId"], "ctx-1")
        self.assertEqual(create_tgt["params"]["url"], "about:blank")
        # 一次性操作用完即關
        self.assertTrue(fake.closed)

    async def test_create_session_raises_cdp_error_and_closes_on_protocol_error(self):
        fake = FakeCdpSocket(responders={
            "Target.createBrowserContext": RuntimeError("proxy rejected"),
        })
        client, patchers = _patched_client(fake)
        with patchers[0], patchers[1]:
            with self.assertRaises(CdpError):
                await client.create_session("socks5://backend:1")
        self.assertTrue(fake.closed)

    async def test_create_session_disposes_context_if_target_creation_fails(self):
        fake = FakeCdpSocket(responders={
            "Target.createBrowserContext": {"browserContextId": "ctx-orphan"},
            "Target.createTarget": RuntimeError("boom"),
            "Target.disposeBrowserContext": {},
        })
        client, patchers = _patched_client(fake)
        with patchers[0], patchers[1]:
            with self.assertRaises(CdpError):
                await client.create_session("socks5://backend:1")
        disposed = [m for m in fake.sent if m["method"] == "Target.disposeBrowserContext"]
        self.assertEqual(len(disposed), 1)
        self.assertEqual(disposed[0]["params"]["browserContextId"], "ctx-orphan")

    async def test_dispose_context_sends_dispose(self):
        fake = FakeCdpSocket(responders={"Target.disposeBrowserContext": {}})
        client, patchers = _patched_client(fake)
        with patchers[0], patchers[1]:
            await client.dispose_context("ctx-9")
        self.assertEqual(fake.sent[0]["method"], "Target.disposeBrowserContext")
        self.assertEqual(fake.sent[0]["params"]["browserContextId"], "ctx-9")
        self.assertTrue(fake.closed)

    async def test_list_context_ids(self):
        fake = FakeCdpSocket(responders={
            "Target.getBrowserContexts": {"browserContextIds": ["a", "b"]},
        })
        client, patchers = _patched_client(fake)
        with patchers[0], patchers[1]:
            ids = await client.list_context_ids()
        self.assertEqual(ids, {"a", "b"})

    def test_base_url_from_env(self):
        with mock.patch.dict("os.environ", {"CHROMIUM_CDP_URL": "http://elsewhere:9333/"}):
            self.assertEqual(CdpClient().base_url, "http://elsewhere:9333")

    def test_browser_ws_uses_resolved_ip_for_host_header_and_ws_url(self):
        """
        Chrome DevTools 拒絕非 IP/localhost 的 Host header,且 chromedp image 用 socat 轉 9222→9223。
        _browser_ws 必須:用解析後的 IP 去打 /json/version,並把回傳 ws URL 的 host 改寫成該 IP:port。
        """
        client = CdpClient(base_url="http://chromium:9222")
        fake_resp = mock.Mock()
        fake_resp.json.return_value = {
            # Chrome 常回綁定位址;不論它回什麼,我們都要改寫成可達的 <ip>:<port>
            "webSocketDebuggerUrl": "ws://127.0.0.1:9223/devtools/browser/abc-123",
        }
        fake_resp.raise_for_status = lambda: None
        with mock.patch("services.cdp_client.socket.gethostbyname", return_value="10.1.2.3") as gh, \
             mock.patch("services.cdp_client.requests.get", return_value=fake_resp) as rg:
            ws = client._browser_ws()
        gh.assert_called_once_with("chromium")
        # HTTP 用 IP 去問(Host=IP → 通過 Chrome 檢查)
        self.assertEqual(rg.call_args[0][0], "http://10.1.2.3:9222/json/version")
        # ws URL 的 host 被改寫為 10.1.2.3:9222(可達 + IP 形式),但保留 devtools 路徑
        self.assertEqual(ws, "ws://10.1.2.3:9222/devtools/browser/abc-123")


class CdpConnectionTest(IsolatedAsyncioTestCase):
    async def test_concurrent_calls_resolve_out_of_order_responses(self):
        """Future-based 硬要求:回應亂序時仍各自對到正確的呼叫(串流場景的地基)。"""
        fake = FakeCdpSocket(auto_respond=False)
        conn = CdpConnection(fake)
        t1 = asyncio.ensure_future(conn.call("Cmd.one"))
        t2 = asyncio.ensure_future(conn.call("Cmd.two"))
        await asyncio.sleep(0)  # 讓兩個請求都送出
        self.assertEqual([m["method"] for m in fake.sent], ["Cmd.one", "Cmd.two"])
        # 故意先回第二個
        fake.push_raw({"id": fake.sent[1]["id"], "result": {"who": "two"}})
        fake.push_raw({"id": fake.sent[0]["id"], "result": {"who": "one"}})
        self.assertEqual(await t1, {"who": "one"})
        self.assertEqual(await t2, {"who": "two"})
        await conn.close()

    async def test_events_dispatched_to_handler_interleaved_with_calls(self):
        fake = FakeCdpSocket(auto_respond=False)
        events = []
        conn = CdpConnection(fake, event_handler=events.append)
        t = asyncio.ensure_future(conn.call("Page.startScreencast"))
        await asyncio.sleep(0)
        fake.push_event("Page.screencastFrame", {"data": "abc", "sessionId": 7},
                        session_id="SESS")
        fake.push_raw({"id": fake.sent[0]["id"], "result": {}})
        await t
        await asyncio.sleep(0.01)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["method"], "Page.screencastFrame")
        self.assertEqual(events[0]["sessionId"], "SESS")
        await conn.close()

    async def test_call_includes_session_id_envelope(self):
        fake = FakeCdpSocket(responders={"Input.insertText": {}})
        conn = CdpConnection(fake)
        await conn.call("Input.insertText", {"text": "嗨"}, session_id="SESS-1")
        self.assertEqual(fake.sent[0]["sessionId"], "SESS-1")
        await conn.close()

    async def test_call_raises_cdp_error_on_error_response(self):
        fake = FakeCdpSocket(responders={"Bad.cmd": RuntimeError("nope")})
        conn = CdpConnection(fake)
        with self.assertRaises(CdpError):
            await conn.call("Bad.cmd")
        await conn.close()

    async def test_pending_calls_fail_fast_when_connection_dies(self):
        fake = FakeCdpSocket(auto_respond=False)
        conn = CdpConnection(fake)
        t = asyncio.ensure_future(conn.call("Cmd.hang"))
        await asyncio.sleep(0)
        await fake.close()  # 模擬 Chrome 掛掉/斷線
        with self.assertRaises(CdpError):
            await t
        self.assertTrue(conn.closed)

    async def test_call_timeout_raises_cdp_error(self):
        fake = FakeCdpSocket(auto_respond=False)
        conn = CdpConnection(fake)
        with self.assertRaises(CdpError):
            await conn.call("Cmd.slow", timeout=0.05)
        await conn.close()
