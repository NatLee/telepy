import os
import sys
import tempfile
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

    @mock.patch.object(sm.SessionManager, "_wait_for_ws_port", return_value=True)
    @mock.patch("session_manager.subprocess.Popen")
    def test_create_spawns_vnc_wm_browser_and_injects_proxy(self, popen, _wait):
        popen.side_effect = lambda *a, **k: _fake_popen()

        out = self.mgr.create("socks5://backend:12345", geometry="1024x768")

        self.assertIn("session_id", out)
        # display 從 base(預設 10)起,ws_port = ws_base(8443) + display
        self.assertEqual(out["ws_port"], self.mgr.ws_base + self.mgr.display_base)
        self.assertNotIn("rfb_port", out)
        # 三個行程:KasmVNC X server / WM / browser
        self.assertEqual(popen.call_count, 3)
        cmds = [" ".join(c[0][0]) for c in popen.call_args_list]
        # 第一個是 KasmVNC(Xkasmvnc,依偵測),帶 websocketPort
        self.assertTrue(any(self.mgr.vnc_bin in c and str(out["ws_port"]) in c for c in cmds))
        # proxy 注入瀏覽器啟動參數(瀏覽器經 watchdog 啟動,指令在 env BROWSER_CMD)
        self.assertTrue(any("socks5://backend:12345" in (c[1].get("env") or {}).get("BROWSER_CMD", "")
                            for c in popen.call_args_list))
        # 瀏覽器與 WM 帶 DISPLAY=:10
        envs = [c[1].get("env", {}).get("DISPLAY") for c in popen.call_args_list]
        self.assertIn(":10", envs)

    @mock.patch.object(sm.SessionManager, "_wait_for_ws_port", return_value=True)
    @mock.patch("session_manager.subprocess.Popen")
    def test_vnc_cmd_pins_kasm_password_file_and_httpd(self, popen, _wait):
        """密碼檔用固定路徑(不靠 $HOME)+ -httpd serve client;否則 runtime 會一律 401。"""
        popen.side_effect = lambda *a, **k: _fake_popen()
        self.mgr.create("socks5://backend:1")
        vnc_cmd = next(" ".join(c[0][0]) for c in popen.call_args_list
                       if self.mgr.vnc_bin in " ".join(c[0][0]))
        self.assertIn("-KasmPasswordFile", vnc_cmd)
        self.assertIn(self.mgr.kasm_password_file, vnc_cmd)
        self.assertIn("-httpd", vnc_cmd)

    @staticmethod
    def _browser_calls(popen):
        """瀏覽器改由 watchdog 啟動:chromium 指令在 env 的 BROWSER_CMD,不在 argv。
        回 [(browser_cmd, env), ...]。"""
        out = []
        for c in popen.call_args_list:
            env = c[1].get("env") or {}
            if "BROWSER_CMD" in env:
                out.append((env["BROWSER_CMD"], env))
        return out

    @mock.patch.object(sm.SessionManager, "_wait_for_ws_port", return_value=True)
    @mock.patch("session_manager.subprocess.Popen")
    def test_create_uses_google_homepage_and_antibot_flags(self, popen, _wait):
        popen.side_effect = lambda *a, **k: _fake_popen()
        self.mgr.create("socks5://backend:1")
        browser_cmd, _env = self._browser_calls(popen)[0]
        self.assertIn("https://www.google.com", browser_cmd)                 # 首頁 Google
        self.assertIn("--disable-blink-features=AutomationControlled", browser_cmd)  # 反自動化偵測
        self.assertIn("--lang=", browser_cmd)                                # 反爬蟲:非空語系
        self.assertIn("--accept-lang=", browser_cmd)
        self.assertIn("--test-type", browser_cmd)   # 壓掉 --no-sandbox 的黃色警告列

    @mock.patch.object(sm.SessionManager, "_wait_for_ws_port", return_value=True)
    @mock.patch("session_manager.subprocess.Popen")
    def test_browser_runs_under_window_watchdog(self, popen, _wait):
        """chromium 交給 browser_watchdog.sh 監管:視窗關閉(background mode 讓行程不死,
        行程級 respawn 無效)或 crash 都會重開;指令經 env BROWSER_CMD 傳入。"""
        popen.side_effect = lambda *a, **k: _fake_popen()
        self.mgr.create("socks5://backend:1")
        watchdog_argv = next(c[0][0] for c in popen.call_args_list
                             if "BROWSER_CMD" in (c[1].get("env") or {}))
        self.assertEqual(watchdog_argv[0], "sh")
        self.assertIn("browser_watchdog", watchdog_argv[1])
        browser_cmd, env = self._browser_calls(popen)[0]
        self.assertTrue(browser_cmd.startswith("chromium "))
        self.assertIn("DISPLAY", env)   # watchdog 靠 DISPLAY 用 xdotool 數視窗

    @mock.patch.object(sm.SessionManager, "_wait_for_ws_port", return_value=True)
    @mock.patch("session_manager.subprocess.Popen")
    def test_each_session_gets_unique_ephemeral_profile(self, popen, _wait):
        """並發 session 各自專屬 user-data-dir(SingletonLock 隔離),HOME(下載/dotfile
        落點)也指到同一 session 目錄,且目錄真的存在。"""
        popen.side_effect = lambda *a, **k: _fake_popen()
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(sm, "PROFILE_TMP_BASE", tmp):
                self.mgr.create("socks5://backend:1")
                self.mgr.create("socks5://backend:2")
            dirs = []
            for cmd, env in self._browser_calls(popen):
                self.assertIn("--user-data-dir=", cmd)
                d = next(a.split("=", 1)[1] for a in cmd.split()
                         if a.startswith("--user-data-dir="))
                self.assertTrue(os.path.isdir(d))
                self.assertEqual(env.get("HOME"), d)   # 下載/dotfile 都進 session 目錄
                dirs.append(d)
            self.assertEqual(len(dirs), 2)
            self.assertNotEqual(dirs[0], dirs[1])   # 兩個 session 目錄不同 → 不互搶

    @mock.patch("session_manager.os.killpg")
    @mock.patch.object(sm.SessionManager, "_wait_for_ws_port", return_value=True)
    @mock.patch("session_manager.subprocess.Popen")
    def test_stop_deletes_profile_dir_no_history_kept(self, popen, _wait, _killpg):
        """session 停止 → 設定檔目錄整個刪除(不保留歷史/cookie)。"""
        popen.side_effect = lambda *a, **k: _fake_popen()
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(sm, "PROFILE_TMP_BASE", tmp):
                out = self.mgr.create("socks5://backend:1")
            sid = out["session_id"]
            profile_dir = self.mgr._sessions[sid]["profile_dir"]
            self.assertTrue(os.path.isdir(profile_dir))
            self.mgr.stop(sid)
            self.assertFalse(os.path.exists(profile_dir))

    def test_resolve_vnc_bin_prefers_env_then_xkasmvnc(self):
        with mock.patch.dict("os.environ", {"VNC_SERVER_BIN": "/custom/Xthing"}), \
             mock.patch("session_manager.shutil.which", return_value=None), \
             mock.patch("session_manager.os.path.exists", return_value=True):
            self.assertEqual(sm._resolve_vnc_bin(), "/custom/Xthing")
        # 無 env、Xkasmvnc 存在 → 選 Xkasmvnc(KasmVNC 的二進位名)
        with mock.patch.dict("os.environ", {}, clear=False):
            os.environ.pop("VNC_SERVER_BIN", None)
            with mock.patch("session_manager.shutil.which",
                            side_effect=lambda b: b if b == "Xkasmvnc" else None):
                self.assertEqual(sm._resolve_vnc_bin(), "Xkasmvnc")

    @mock.patch("session_manager.os.killpg")
    @mock.patch.object(sm.SessionManager, "_wait_for_ws_port", return_value=False)
    @mock.patch("session_manager.subprocess.Popen")
    def test_create_cleans_up_and_raises_when_ws_never_comes_up(self, popen, _wait, killpg):
        procs = []
        def make(*a, **k):
            p = _fake_popen(); procs.append(p); return p
        popen.side_effect = make

        with self.assertRaises(Exception):
            self.mgr.create("socks5://backend:1")

        # 起失敗要收掉已生的行程(整個 process group:killpg 對 p.pid,因 start_new_session
        # 讓 pgid == pid;leader 已死時 getpgid 會漏殺孤兒,故直接用 pid),並釋放 display。
        self.assertTrue(procs)
        killed_pgids = {c[0][0] for c in killpg.call_args_list}
        self.assertIn(procs[0].pid, killed_pgids)
        self.assertEqual(self.mgr.count(), 0)
        self.assertNotIn(self.mgr.display_base, self.mgr._used_displays)

    @mock.patch("session_manager.os.killpg")
    @mock.patch.object(sm.SessionManager, "_wait_for_ws_port", return_value=True)
    @mock.patch("session_manager.subprocess.Popen")
    def test_stop_terminates_procs_and_frees_display(self, popen, _wait, killpg):
        popen.side_effect = lambda *a, **k: _fake_popen()
        out = self.mgr.create("socks5://backend:1")
        sid = out["session_id"]

        self.assertTrue(self.mgr.stop(sid))
        self.assertTrue(killpg.called)   # 收 session = 對每個 proc 的 group killpg(pgid == pid)
        self.assertEqual(self.mgr.count(), 0)
        self.assertNotIn(self.mgr.display_base, self.mgr._used_displays)
        self.assertFalse(self.mgr.stop("nonexistent"))

    @mock.patch.object(sm.SessionManager, "_wait_for_ws_port", return_value=True)
    @mock.patch("session_manager.subprocess.Popen")
    def test_two_sessions_get_distinct_displays_and_ports(self, popen, _wait):
        popen.side_effect = lambda *a, **k: _fake_popen()
        a = self.mgr.create("socks5://backend:1")
        b = self.mgr.create("socks5://backend:2")
        self.assertNotEqual(a["ws_port"], b["ws_port"])
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
