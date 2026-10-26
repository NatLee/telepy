"""cdp.py：WebSocket frame、動作的 CDP 呼叫順序、session-manager 的 /cdp 路由。
cdp.py: WebSocket frames, the CDP calls each action makes, and the session-manager's /cdp route."""
import os
import socket
import sys
import threading
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import cdp  # noqa: E402
import session_manager as sm  # noqa: E402


class FakeCdp:
    """記下呼叫、照表回答的假 CDP 連線。/ Records calls and answers from a table."""

    def __init__(self, answers=None, page=None):
        self.calls = []
        self.answers = answers or {}
        self.page = page or {"url": "https://example.com/", "title": "Example", "ready": "complete"}
        self.deadline = time.monotonic() + 30

    def call(self, method, params=None):
        self.calls.append((method, params or {}))
        return self.answers.get(method, {})

    def evaluate(self, expression):
        self.calls.append(("evaluate", expression))
        if expression == cdp.PAGE_INFO_JS:
            return self.page
        return self.answers.get("evaluate", {})


class FrameTest(unittest.TestCase):
    def test_round_trip_through_a_socket(self):
        a, b = socket.socketpair()
        try:
            for size in (5, 300, 70000):
                text = "x" * size
                # 大的 frame 會塞滿 socket 緩衝：另一條執行緒送。/ A big frame fills the buffer: send from a thread.
                sender = threading.Thread(target=a.sendall, args=(cdp.encode_frame(text, mask_key=b"\x01\x02\x03\x04"),))
                sender.start()
                fin, op, data = cdp.read_frame(b)
                sender.join()
                self.assertTrue(fin)
                self.assertEqual(op, 1)
                self.assertEqual(data.decode(), text)
        finally:
            a.close()
            b.close()

    def test_pick_page_skips_devtools_and_workers(self):
        targets = [
            {"type": "service_worker", "url": "https://a/", "webSocketDebuggerUrl": "ws://x/1"},
            {"type": "page", "url": "devtools://devtools/", "webSocketDebuggerUrl": "ws://x/2"},
            {"type": "page", "url": "https://b/", "webSocketDebuggerUrl": "ws://x/3"},
        ]
        self.assertEqual(cdp.pick_page(targets)["webSocketDebuggerUrl"], "ws://x/3")
        self.assertIsNone(cdp.pick_page([]))


class ActionTest(unittest.TestCase):
    def test_navigate_refuses_other_schemes(self):
        with self.assertRaises(cdp.CdpError):
            cdp.run_action(FakeCdp(), {"action": "navigate", "url": "file:///etc/passwd"})

    def test_navigate_reports_the_page(self):
        f = FakeCdp()
        out = cdp.run_action(f, {"action": "navigate", "url": "https://example.com/"})
        self.assertEqual(out, {"url": "https://example.com/", "title": "Example"})
        self.assertEqual(f.calls[0], ("Page.navigate", {"url": "https://example.com/"}))

    def test_navigate_error_text(self):
        f = FakeCdp({"Page.navigate": {"errorText": "net::ERR_NAME_NOT_RESOLVED"}})
        with self.assertRaisesRegex(cdp.CdpError, "ERR_NAME_NOT_RESOLVED"):
            cdp.run_action(f, {"action": "navigate", "url": "https://nope.invalid/"})

    def test_screenshot_scales_to_max_width(self):
        f = FakeCdp({"Page.getLayoutMetrics": {"cssVisualViewport": {"clientWidth": 2560, "clientHeight": 1440, "pageX": 0, "pageY": 100}},
                     "Page.captureScreenshot": {"data": "iVBOR"}})
        out = cdp.run_action(f, {"action": "screenshot", "max_width": 1280})
        self.assertEqual((out["data"], out["width"], out["height"]), ("iVBOR", 1280, 720))
        clip = dict(f.calls)["Page.captureScreenshot"]["clip"]
        self.assertEqual((clip["scale"], clip["y"]), (0.5, 100.0))

    def test_click_is_a_real_mouse_click(self):
        f = FakeCdp({"evaluate": {"x": 10, "y": 20, "label": "button “Save”"}})
        out = cdp.run_action(f, {"action": "click", "text": "Save"})
        kinds = [p.get("type") for m, p in f.calls if m == "Input.dispatchMouseEvent"]
        self.assertEqual(kinds, ["mouseMoved", "mousePressed", "mouseReleased"])
        self.assertEqual(out["clicked"], "button “Save”")

    def test_click_reports_a_missing_element(self):
        f = FakeCdp({"evaluate": {"error": "No element matches #x"}})
        with self.assertRaisesRegex(cdp.CdpError, "No element matches"):
            cdp.run_action(f, {"action": "click", "selector": "#x"})

    def test_type_inserts_text_and_presses_enter(self):
        f = FakeCdp({"evaluate": {"ok": True}})
        cdp.run_action(f, {"action": "type", "selector": "input[name=q]", "text": "hello", "press_enter": True})
        methods = [m for m, _ in f.calls]
        self.assertIn("Input.insertText", methods)
        self.assertEqual([p.get("type") for m, p in f.calls if m == "Input.dispatchKeyEvent"], ["keyDown", "keyUp"])

    def test_scripts_quote_their_arguments(self):
        js = cdp.locate_js('a[href="x"]', None)
        self.assertIn('"a[href=\\"x\\"]"', js)
        self.assertIn("null", cdp.read_js(None, 10))


class ManagerTest(unittest.TestCase):
    @mock.patch.object(sm.SessionManager, "_wait_for_ws_port", return_value=True)
    @mock.patch("session_manager.subprocess.Popen")
    def test_browser_gets_a_loopback_devtools_port(self, popen, _wait):
        p = mock.Mock()
        p.pid = 1
        popen.return_value = p
        mgr = sm.SessionManager()
        out = mgr.create("socks5://backend:1")
        cmd = next((c[1].get("env") or {}).get("BROWSER_CMD") for c in popen.call_args_list if (c[1].get("env") or {}).get("BROWSER_CMD"))
        port = mgr.cdp_base + mgr.display_base
        self.assertIn(f"--remote-debugging-port={port}", cmd)
        self.assertIn("--remote-debugging-address=127.0.0.1", cmd)
        with mock.patch("cdp.perform", return_value={"ok": 1}) as perform:
            self.assertEqual(mgr.cdp(out["session_id"], {"action": "read"}), {"ok": 1})
            perform.assert_called_once_with(port, {"action": "read"})
        with self.assertRaises(KeyError):
            mgr.cdp("nope", {"action": "read"})


class HandlerTest(unittest.TestCase):
    def _handler(self, path, token="secret", body=b'{"action": "read"}'):
        h = sm._Handler.__new__(sm._Handler)
        h.manager = mock.Mock()
        h.token = "secret"
        h.headers = {"X-Internal-Token": token, "Content-Length": str(len(body))}
        h.path = path
        h.rfile = mock.Mock()
        h.rfile.read.return_value = body
        sent = {}
        h._send = lambda code, obj: sent.update(code=code, obj=obj)
        return h, sent

    def test_cdp_route(self):
        h, sent = self._handler("/sessions/abc/cdp")
        h.manager.cdp.return_value = {"title": "x"}
        h.do_POST()
        self.assertEqual((sent["code"], sent["obj"]), (200, {"title": "x"}))
        h.manager.cdp.assert_called_once_with("abc", {"action": "read"})

    def test_cdp_needs_the_token_and_a_session(self):
        h, sent = self._handler("/sessions/abc/cdp", token="wrong")
        h.do_POST()
        self.assertEqual(sent["code"], 403)
        h.manager.cdp.assert_not_called()
        h, sent = self._handler("/sessions/abc/cdp")
        h.manager.cdp.side_effect = KeyError("abc")
        h.do_POST()
        self.assertEqual(sent["code"], 404)
        h, sent = self._handler("/sessions/abc/cdp")
        h.manager.cdp.side_effect = cdp.CdpError("No element matches #x")
        h.do_POST()
        self.assertEqual((sent["code"], sent["obj"]["error"]), (422, "No element matches #x"))


if __name__ == "__main__":
    unittest.main()
