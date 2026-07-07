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
        cmds = [" ".join(c[0][0]) for c in popen.call_args_list]
        # KasmVNC(Xkasmvnc,依偵測)帶 websocketPort
        self.assertTrue(any(self.mgr.vnc_bin in c and str(out["ws_port"]) in c for c in cmds))
        # WM(openbox)、桌布(hsetroot)、面板(tint2)、瀏覽器啟動器都要起
        self.assertTrue(any("openbox" in c for c in cmds))
        self.assertTrue(any("hsetroot" in c for c in cmds))
        self.assertTrue(any("tint2" in c for c in cmds))
        self.assertTrue(any("open-browser" in c for c in cmds))
        # proxy 注入瀏覽器啟動參數(在 env BROWSER_CMD)
        self.assertTrue(any("socks5://backend:12345" in (c[1].get("env") or {}).get("BROWSER_CMD", "")
                            for c in popen.call_args_list))
        # 各行程帶 DISPLAY=:10
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
        # 反爬蟲關鍵:--accept-lang 不能帶 q-value(否則 q 洩進 navigator.languages +
        # 疊出雙重-q 的 Accept-Language header,兩者都是機器人特徵)。
        self.assertNotIn("q=", browser_cmd)
        # localhost/127.0.0.1 也要走 proxy(= 目標機器),否則 chromium 預設 loopback 直連會打到
        # kasm-browser 容器自己 → 使用者連不到目標機的本機服務。`<-loopback>` 移除內建 loopback bypass。
        # 單引號必留:BROWSER_CMD 最後經 `sh -c` 二次解析,`<`/`>` 不引起來會被當成 shell 重導向。
        self.assertIn("--proxy-bypass-list='<-loopback>'", browser_cmd)
        # 反爬蟲:允許 WebGL 回退 SwiftShader(否則 headed 無 GPU → WebGL context 為 null)。
        self.assertIn("--enable-unsafe-swiftshader", browser_cmd)
        # 但**不可**強制整個 GL 合成器走 SwiftShader —— 那會讓影片掉幀/播不動(YouTube 回報)。
        self.assertNotIn("--use-gl=angle", browser_cmd)
        self.assertNotIn("--use-angle=swiftshader", browser_cmd)
        # **勿加回 --no-first-run**:Debian chromium 150.0.7871.46(bug #1141488)在「跳過
        # first-run 的全新 profile」上啟動 ~1s 內無聲 SIGTRAP(prepopulated Google 搜尋模板的
        # {google:searchSource} token 沒人處理 → NOTREACHED)。實測拿掉後 Debian build 也不會
        # 出 first-run 精靈,此旗標在本容器是零效益、純致命。
        self.assertNotIn("--no-first-run", browser_cmd)

    def test_accept_lang_produces_clean_tags_without_q_values(self):
        self.assertEqual(sm._accept_lang("zh-TW"), "zh-TW,zh,en")
        self.assertEqual(sm._accept_lang("en-US"), "en-US,en")
        self.assertEqual(sm._accept_lang("en"), "en")
        self.assertNotIn("q=", sm._accept_lang("ja-JP"))

    @mock.patch.object(sm.SessionManager, "_wait_for_ws_port", return_value=True)
    @mock.patch("session_manager.subprocess.Popen")
    def test_window_manager_uses_maximize_no_decor_config(self, popen, _wait):
        """openbox 以自訂設定啟動(移除標題列 + 最大化填滿 display)。"""
        popen.side_effect = lambda *a, **k: _fake_popen()
        self.mgr.create("socks5://backend:1")
        wm_argv = next(c[0][0] for c in popen.call_args_list
                       if "openbox" in " ".join(c[0][0]))
        self.assertIn("--config-file", wm_argv)
        self.assertTrue(any(a.endswith("openbox-rc.xml") for a in wm_argv))

    @mock.patch.object(sm.SessionManager, "_wait_for_ws_port", return_value=True)
    @mock.patch("session_manager.subprocess.Popen")
    def test_browser_launched_once_via_launcher_no_autorestart(self, popen, _wait):
        """瀏覽器由 open-browser.sh 啟動一次(不自動重啟);指令經 env BROWSER_CMD 傳入。
        關窗後由桌面面板(tint2)捷徑再開 —— 不再有 watchdog respawn 迴圈。"""
        popen.side_effect = lambda *a, **k: _fake_popen()
        self.mgr.create("socks5://backend:1")
        cmds = [" ".join(c[0][0]) for c in popen.call_args_list]
        # 啟動器有起、且不再有 watchdog respawn
        self.assertTrue(any("open-browser" in c for c in cmds))
        self.assertFalse(any("browser_watchdog" in c for c in cmds))
        # 啟動器與面板都拿到 chromium 指令(env BROWSER_CMD)
        launcher_argv = next(c[0][0] for c in popen.call_args_list
                             if c[0][0][0] == "sh" and "open-browser" in " ".join(c[0][0]))
        self.assertEqual(launcher_argv[0], "sh")
        browser_cmd, env = self._browser_calls(popen)[0]
        self.assertTrue(browser_cmd.startswith("chromium "))
        self.assertIn("DISPLAY", env)

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
            dirs = set()
            for cmd, env in self._browser_calls(popen):
                self.assertIn("--user-data-dir=", cmd)
                d = next(a.split("=", 1)[1] for a in cmd.split()
                         if a.startswith("--user-data-dir="))
                self.assertTrue(os.path.isdir(d))
                self.assertEqual(env.get("HOME"), d)   # 下載/dotfile 都進 session 目錄
                dirs.add(d)
            self.assertEqual(len(dirs), 2)   # 兩個 session 各自不同目錄 → 不互搶

    @mock.patch.object(sm.SessionManager, "_wait_for_ws_port", return_value=True)
    @mock.patch("session_manager.subprocess.Popen")
    def test_wm_and_panel_get_browser_env(self, popen, _wait):
        """openbox 與 tint2 都要拿到 BROWSER_CMD:桌面選單/面板捷徑開瀏覽器是它們的子行程。
        (實測血淚:openbox 沒帶 env 時,使用者從桌面選單開瀏覽器 → BROWSER_CMD not set。)"""
        popen.side_effect = lambda *a, **k: _fake_popen()
        self.mgr.create("socks5://backend:1")
        for name in ("openbox", "tint2"):
            env = next(c[1].get("env", {}) for c in popen.call_args_list
                       if name in " ".join(c[0][0]))
            self.assertIn("BROWSER_CMD", env, name)
            self.assertTrue(env["BROWSER_CMD"].startswith("chromium "), name)

    @mock.patch("session_manager.os.killpg")
    @mock.patch.object(sm.SessionManager, "_wait_for_ws_port", return_value=True)
    @mock.patch("session_manager.subprocess.Popen")
    def test_launcher_env_file_written_on_create_removed_on_stop(self, popen, _wait, _killpg):
        """per-display env 檔(open-browser.sh 在環境遺失時的退路):create 寫入
        BROWSER_CMD/HOME,stop 移除。"""
        popen.side_effect = lambda *a, **k: _fake_popen()
        with tempfile.TemporaryDirectory() as tmp:
            env_path = os.path.join(tmp, "browser-10.env")
            with mock.patch.object(sm.SessionManager, "_launcher_env_path",
                                   return_value=env_path), \
                 mock.patch.object(sm, "PROFILE_TMP_BASE", tmp):
                out = self.mgr.create("socks5://backend:9999")
                with open(env_path) as fh:
                    content = fh.read()
                self.assertIn("export BROWSER_CMD=", content)
                self.assertIn("socks5://backend:9999", content)
                self.assertIn("export HOME=", content)
                self.mgr.stop(out["session_id"])
                self.assertFalse(os.path.exists(env_path))

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


class WatchdogTest(unittest.TestCase):
    """chromium watchdog:行程完全消失 → 用 launcher 重開;寬限/冷卻期間與活著時不動作。"""

    def setUp(self):
        self.mgr = sm.SessionManager()

    def _make_session(self, created_at=0.0, last_respawn=0.0):
        self.mgr._sessions["sid1"] = {
            "display": 10, "ws_port": 8453, "procs": [], "proxy": "socks5://b:1",
            "profile_dir": "/tmp/telepy-profile-x", "browser_cmd": "chromium --user-data-dir=/tmp/telepy-profile-x",
            "lang": "zh-TW", "created_at": created_at, "last_respawn": last_respawn,
        }

    @mock.patch.object(sm.SessionManager, "_spawn")
    @mock.patch.object(sm.SessionManager, "_chromium_alive", return_value=False)
    def test_respawns_when_chromium_gone(self, _alive, spawn):
        spawn.return_value = _fake_popen()
        self._make_session()
        self.mgr._watchdog_tick(now=1000.0)
        spawn.assert_called_once()
        args, kwargs = spawn.call_args
        self.assertIn("open-browser", " ".join(args[0]))
        self.assertEqual(kwargs["extra_env"]["HOME"], "/tmp/telepy-profile-x")
        # 重開的行程要掛回 session,stop 時才收得掉;並記錄冷卻時間。
        self.assertEqual(len(self.mgr._sessions["sid1"]["procs"]), 1)
        self.assertEqual(self.mgr._sessions["sid1"]["last_respawn"], 1000.0)

    @mock.patch.object(sm.SessionManager, "_spawn")
    @mock.patch.object(sm.SessionManager, "_chromium_alive", return_value=True)
    def test_no_respawn_when_alive(self, _alive, spawn):
        self._make_session()
        self.mgr._watchdog_tick(now=1000.0)
        spawn.assert_not_called()

    @mock.patch.object(sm.SessionManager, "_spawn")
    @mock.patch.object(sm.SessionManager, "_chromium_alive", return_value=False)
    def test_grace_and_cooldown_suppress_respawn(self, _alive, spawn):
        # 剛建立(寬限期) / just created (grace period)
        self._make_session(created_at=995.0)
        self.mgr._watchdog_tick(now=1000.0)
        spawn.assert_not_called()
        # 剛重開過(冷卻) / recently respawned (cooldown)
        self._make_session(created_at=0.0, last_respawn=990.0)
        self.mgr._watchdog_tick(now=1000.0)
        spawn.assert_not_called()


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
