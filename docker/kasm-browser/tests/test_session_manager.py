import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import session_manager as sm  # noqa: E402


def _fake_popen():
    p = mock.Mock()
    p.pid = 4321
    p.poll.return_value = None
    return p


class SessionManagerTest(unittest.TestCase):
    def setUp(self):
        self.mgr = sm.SessionManager()

    @mock.patch.object(sm.SessionManager, "_wait_for_rfb", return_value=True)
    @mock.patch("session_manager.subprocess.Popen")
    def test_create_spawns_vnc_wm_browser_and_injects_proxy(self, popen, _wait):
        popen.side_effect = lambda *a, **k: _fake_popen()

        out = self.mgr.create("socks5://backend:12345", geometry="1024x768")

        self.assertIn("session_id", out)
        # display 從 base(預設 10)起,rfb_port = rfb_base + display
        self.assertEqual(out["rfb_port"], self.mgr.rfb_base + self.mgr.display_base)
        # 三個行程:VNC X server / WM / browser
        self.assertEqual(popen.call_count, 3)
        cmds = [" ".join(c[0][0]) for c in popen.call_args_list]
        # 第一個是 VNC server(Xkasmvnc/Xvnc,依偵測),帶 rfbport
        self.assertTrue(any(self.mgr.vnc_bin in c and str(out["rfb_port"]) in c for c in cmds))
        # proxy 注入瀏覽器啟動參數
        self.assertTrue(any("socks5://backend:12345" in c for c in cmds))
        # 瀏覽器與 WM 帶 DISPLAY=:10
        envs = [c[1].get("env", {}).get("DISPLAY") for c in popen.call_args_list]
        self.assertIn(":10", envs)

    def test_resolve_vnc_bin_prefers_env_then_kasmvnc(self):
        with mock.patch.dict("os.environ", {"VNC_SERVER_BIN": "/custom/Xthing"}), \
             mock.patch("session_manager.shutil.which", return_value=None), \
             mock.patch("session_manager.os.path.exists", return_value=True):
            self.assertEqual(sm._resolve_vnc_bin(), "/custom/Xthing")
        # 無 env、Xkasmvnc 存在 → 選 Xkasmvnc(KasmVNC 的實際二進位名)
        with mock.patch.dict("os.environ", {}, clear=False) as _e:
            os.environ.pop("VNC_SERVER_BIN", None)
            with mock.patch("session_manager.shutil.which",
                            side_effect=lambda b: b if b == "Xkasmvnc" else None):
                self.assertEqual(sm._resolve_vnc_bin(), "Xkasmvnc")

    @mock.patch.object(sm.SessionManager, "_wait_for_rfb", return_value=False)
    @mock.patch("session_manager.subprocess.Popen")
    def test_create_cleans_up_and_raises_when_rfb_never_comes_up(self, popen, _wait):
        procs = []
        def make(*a, **k):
            p = _fake_popen(); procs.append(p); return p
        popen.side_effect = make

        with self.assertRaises(Exception):
            self.mgr.create("socks5://backend:1")

        # 起失敗要收掉已生的行程,且釋放 display(下一次能重用 :10)
        self.assertTrue(procs and any(p.terminate.called or p.kill.called for p in procs))
        self.assertEqual(self.mgr.count(), 0)
        self.assertNotIn(self.mgr.display_base, self.mgr._used_displays)

    @mock.patch.object(sm.SessionManager, "_wait_for_rfb", return_value=True)
    @mock.patch("session_manager.subprocess.Popen")
    def test_stop_terminates_procs_and_frees_display(self, popen, _wait):
        popen.side_effect = lambda *a, **k: _fake_popen()
        out = self.mgr.create("socks5://backend:1")
        sid = out["session_id"]

        self.assertTrue(self.mgr.stop(sid))
        self.assertEqual(self.mgr.count(), 0)
        self.assertNotIn(self.mgr.display_base, self.mgr._used_displays)
        self.assertFalse(self.mgr.stop("nonexistent"))

    @mock.patch.object(sm.SessionManager, "_wait_for_rfb", return_value=True)
    @mock.patch("session_manager.subprocess.Popen")
    def test_two_sessions_get_distinct_displays_and_ports(self, popen, _wait):
        popen.side_effect = lambda *a, **k: _fake_popen()
        a = self.mgr.create("socks5://backend:1")
        b = self.mgr.create("socks5://backend:2")
        self.assertNotEqual(a["rfb_port"], b["rfb_port"])
        self.assertEqual(self.mgr.count(), 2)


class HandlerAuthTest(unittest.TestCase):
    def test_create_requires_internal_token(self):
        """POST /sessions 無正確 token → 403,且不會呼叫 manager.create。"""
        mgr = mock.Mock()
        handler = sm._Handler.__new__(sm._Handler)
        handler.manager = mgr
        handler.token = "secret"
        handler.headers = {"X-Internal-Token": "wrong", "Content-Length": "2"}
        handler.path = "/sessions"
        sent = {}
        handler._send = lambda code, obj: sent.update(code=code, obj=obj)
        handler.rfile = mock.Mock()
        handler.do_POST()
        self.assertEqual(sent["code"], 403)
        mgr.create.assert_not_called()


if __name__ == "__main__":
    unittest.main()
