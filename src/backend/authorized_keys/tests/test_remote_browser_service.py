from unittest import mock
from django.test import TestCase
import authorized_keys.remote_browser_service as svc


class FakeStore:
    """記憶體版 session store,取代 Redis(多 worker 共享查詢的地基)。"""
    def __init__(self):
        self.data = {}

    def put(self, session_id, payload, ttl=None):
        self.data[session_id] = dict(payload)

    def get(self, session_id):
        v = self.data.get(session_id)
        return dict(v) if v else None

    def refresh(self, session_id, ttl=None):
        return session_id in self.data

    def delete(self, session_id):
        self.data.pop(session_id, None)

    def live_context_ids(self):
        return {v["context_id"] for v in self.data.values() if v.get("context_id")}

    def live_session_ids(self):
        return set(self.data.keys())


class RemoteBrowserServiceTest(TestCase):
    def setUp(self):
        self._store_patch = mock.patch.object(svc, "_store", FakeStore())
        self.store = self._store_patch.start()
        svc._suspected_orphans.clear()   # 對帳的兩輪狀態不得跨測試殘留

    def tearDown(self):
        self._store_patch.stop()
        svc.ACTIVE_SESSIONS.clear()
        svc._suspected_orphans.clear()

    @mock.patch.object(svc, "_wait_for_port", return_value=True)
    @mock.patch.object(svc, "subprocess")
    @mock.patch.object(svc, "_cdp", autospec=True)
    def test_start_creates_cdp_session_with_socks_proxy_and_returns_ws_path(self, cdp, sp, _wp):
        sp.Popen.return_value = mock.Mock(poll=lambda: None)
        cdp.create_session.return_value = {"context_id": "ctx-1", "target_id": "tgt-1"}

        result = svc.start_remote_browser("alice", 30001, 7)

        # 回傳 session_id 與 ws_path(取代 Neko 的 iframe url)
        self.assertIn("session_id", result)
        self.assertEqual(result["ws_path"], f"/ws/remote-browser/{result['session_id']}/")
        self.assertNotIn("url", result)  # 不再是 iframe

        # create_session 帶 socks5:// proxy
        proxy_arg = cdp.create_session.call_args[0][0]
        self.assertTrue(proxy_arg.startswith("socks5://"))
        self.assertIn(str(svc.ACTIVE_SESSIONS[result["session_id"]]["proxy_port"]), proxy_arg)

        # 記入 in-process(含 ssh proc)與 Redis store(含 target_id 供 consumer 跨 worker 查)
        sess = svc.ACTIVE_SESSIONS[result["session_id"]]
        self.assertEqual(sess["target_id"], "tgt-1")
        self.assertEqual(sess["context_id"], "ctx-1")
        stored = svc._store.get(result["session_id"])
        self.assertEqual(stored["target_id"], "tgt-1")
        self.assertEqual(stored["server_id"], 7)

    @mock.patch.object(svc, "_wait_for_port", return_value=True)
    @mock.patch.object(svc, "subprocess")
    @mock.patch.object(svc, "_cdp", autospec=True)
    def test_start_cleans_up_ssh_when_cdp_creation_fails(self, cdp, sp, _wp):
        proc = mock.Mock(poll=lambda: None)
        sp.Popen.return_value = proc
        cdp.create_session.side_effect = svc.CdpError("nope")

        with self.assertRaises(Exception):
            svc.start_remote_browser("alice", 30001, 7)

        proc.terminate.assert_called()                 # ssh 被收掉
        self.assertEqual(len(svc.ACTIVE_SESSIONS), 0)   # 無殘留 in-process
        self.assertEqual(svc._store.live_session_ids(), set())  # 無殘留 Redis

    @mock.patch.object(svc, "_wait_for_port", return_value=False)
    @mock.patch.object(svc, "subprocess")
    @mock.patch.object(svc, "_cdp", autospec=True)
    def test_start_fails_and_never_calls_cdp_when_ssh_proxy_not_ready(self, cdp, sp, _wp):
        proc = mock.Mock(poll=lambda: None)
        sp.Popen.return_value = proc

        with self.assertRaises(Exception):
            svc.start_remote_browser("alice", 30001, 7)

        cdp.create_session.assert_not_called()   # SOCKS 沒起來就不該建瀏覽器
        proc.terminate.assert_called()

    @mock.patch.object(svc, "_wait_for_port", return_value=True)
    @mock.patch.object(svc, "subprocess")
    @mock.patch.object(svc, "_cdp", autospec=True)
    def test_stop_disposes_context_and_terminates_ssh(self, cdp, sp, _wp):
        proc = mock.Mock(poll=lambda: None)
        sp.Popen.return_value = proc
        cdp.create_session.return_value = {"context_id": "ctx-1", "target_id": "tgt-1"}

        sid = svc.start_remote_browser("alice", 30001, 7)["session_id"]
        ok = svc.stop_remote_browser(sid)

        self.assertTrue(ok)
        cdp.dispose_context.assert_called_once_with("ctx-1")
        proc.terminate.assert_called()
        self.assertNotIn(sid, svc.ACTIVE_SESSIONS)
        self.assertIsNone(svc._store.get(sid))

    @mock.patch.object(svc, "_cdp", autospec=True)
    def test_stop_on_non_owner_worker_still_disposes_context_via_store(self, cdp):
        """WS consumer 落在非 ssh-owner worker:in-process 沒有這筆,仍要靠 store 收 context。"""
        svc._store.put("sess-x", {"server_id": 7, "target_id": "t", "context_id": "ctx-x",
                                  "proxy_port": 5555})
        ok = svc.stop_remote_browser("sess-x")
        self.assertTrue(ok)
        cdp.dispose_context.assert_called_once_with("ctx-x")
        self.assertIsNone(svc._store.get("sess-x"))

    def test_get_session_reads_store_for_cross_worker_lookup(self):
        svc._store.put("sess-y", {"server_id": 9, "target_id": "tgt-y",
                                  "context_id": "ctx-y", "proxy_port": 6000})
        got = svc.get_session("sess-y")
        self.assertEqual(got["server_id"], 9)
        self.assertEqual(got["target_id"], "tgt-y")
        self.assertIsNone(svc.get_session("does-not-exist"))

    @mock.patch.object(svc, "_wait_for_port", return_value=True)
    @mock.patch.object(svc, "subprocess")
    @mock.patch.object(svc, "_cdp", autospec=True)
    def test_ping_refreshes_store_ttl(self, cdp, sp, _wp):
        sp.Popen.return_value = mock.Mock(poll=lambda: None)
        cdp.create_session.return_value = {"context_id": "c", "target_id": "t"}
        sid = svc.start_remote_browser("alice", 30001, 7)["session_id"]
        with mock.patch.object(svc._store, "refresh", wraps=svc._store.refresh) as r:
            self.assertTrue(svc.ping_remote_browser(sid))
            r.assert_called_once()
        self.assertFalse(svc.ping_remote_browser("nope"))

    @mock.patch.object(svc, "_cdp", autospec=True)
    def test_reconcile_disposes_orphan_context_after_two_passes(self, cdp):
        """Chrome 內有 context 但 store 查無 —— 連兩輪都是孤兒才 dispose(避開建立競速)。"""
        cdp.list_context_ids.return_value = {"ctx-orphan"}
        # store 為空(沒有任何 live session)
        svc._reconcile_orphan_contexts()      # 第一輪:僅列為疑似,不動手
        cdp.dispose_context.assert_not_called()
        svc._reconcile_orphan_contexts()      # 第二輪:確認孤兒 → dispose
        cdp.dispose_context.assert_called_once_with("ctx-orphan")

    @mock.patch.object(svc, "_cdp", autospec=True)
    def test_reconcile_spares_context_that_becomes_live(self, cdp):
        cdp.list_context_ids.return_value = {"ctx-new"}
        svc._reconcile_orphan_contexts()                  # 疑似
        svc._store.put("s", {"server_id": 1, "target_id": "t",
                             "context_id": "ctx-new", "proxy_port": 1})  # 期間登記為 live
        svc._reconcile_orphan_contexts()                  # 已是 live,不 dispose
        cdp.dispose_context.assert_not_called()
