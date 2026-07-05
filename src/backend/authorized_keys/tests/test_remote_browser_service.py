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

    def live_session_ids(self):
        return set(self.data.keys())


class RemoteBrowserServiceTest(TestCase):
    def setUp(self):
        self._store_patch = mock.patch.object(svc, "_store", FakeStore())
        self._store_patch.start()

    def tearDown(self):
        self._store_patch.stop()
        svc.ACTIVE_SESSIONS.clear()

    @mock.patch.object(svc, "_wait_for_port", return_value=True)
    @mock.patch.object(svc, "subprocess")
    @mock.patch.object(svc, "_kasm")
    def test_start_creates_vnc_session_with_socks_proxy_and_returns_ws_path(self, kasm, sp, _wp):
        sp.Popen.return_value = mock.Mock(poll=lambda: None)
        kasm.create_session.return_value = {"session_id": "k1", "ws_port": 8453}

        result = svc.start_remote_browser("alice", 30001, 7)

        self.assertIn("session_id", result)
        self.assertEqual(result["ws_path"], f"/ws/remote-browser/{result['session_id']}/")
        self.assertNotIn("url", result)

        # create_session 帶 socks5:// proxy(指向本後端該 session 的 ssh -D 埠)
        proxy_arg = kasm.create_session.call_args[0][0]
        self.assertTrue(proxy_arg.startswith("socks5://"))
        self.assertIn(str(svc.ACTIVE_SESSIONS[result["session_id"]]["proxy_port"]), proxy_arg)
        # 設定檔每 session 臨時、停止即刪(不保留歷史)→ 不再傳 profile_key
        self.assertNotIn("profile_key", kasm.create_session.call_args[1])

        # in-process 與 Redis store 都存了 ws_port + kasm_session_id 供 consumer 跨 worker 查
        sess = svc.ACTIVE_SESSIONS[result["session_id"]]
        self.assertEqual(sess["ws_port"], 8453)
        self.assertEqual(sess["kasm_session_id"], "k1")
        stored = svc._store.get(result["session_id"])
        self.assertEqual(stored["ws_port"], 8453)
        self.assertEqual(stored["server_id"], 7)

    @mock.patch.object(svc, "_wait_for_port", return_value=True)
    @mock.patch.object(svc, "subprocess")
    @mock.patch.object(svc, "_kasm")
    def test_start_cleans_up_ssh_when_kasm_creation_fails(self, kasm, sp, _wp):
        proc = mock.Mock(poll=lambda: None)
        sp.Popen.return_value = proc
        kasm.create_session.side_effect = svc.KasmError("nope")

        with self.assertRaises(Exception):
            svc.start_remote_browser("alice", 30001, 7)

        proc.terminate.assert_called()
        self.assertEqual(len(svc.ACTIVE_SESSIONS), 0)
        self.assertEqual(svc._store.live_session_ids(), set())

    @mock.patch.object(svc, "_wait_for_port", return_value=False)
    @mock.patch.object(svc, "subprocess")
    @mock.patch.object(svc, "_kasm")
    def test_start_fails_and_never_calls_kasm_when_ssh_proxy_not_ready(self, kasm, sp, _wp):
        proc = mock.Mock(poll=lambda: None)
        sp.Popen.return_value = proc

        with self.assertRaises(Exception):
            svc.start_remote_browser("alice", 30001, 7)

        kasm.create_session.assert_not_called()
        proc.terminate.assert_called()

    @mock.patch.object(svc, "subprocess")
    @mock.patch.object(svc, "_kasm")
    def test_start_retries_cold_socks_bringup_then_succeeds(self, kasm, sp):
        """冷啟第一次 SOCKS 沒起來 → 自動重試第二次成功(把使用者手動再點一次自動化)。"""
        sp.Popen.return_value = mock.Mock(poll=lambda: None)
        kasm.create_session.return_value = {"session_id": "k1", "ws_port": 8453}
        # 第一次 _wait_for_port False(冷啟失敗)、第二次 True(暖了就起來)
        with mock.patch.object(svc, "_wait_for_port", side_effect=[False, True]) as wp:
            result = svc.start_remote_browser("alice", 30001, 7)
        self.assertEqual(wp.call_count, 2)          # 確實重試了一次
        self.assertEqual(sp.Popen.call_count, 2)    # 每次嘗試各起一個 ssh
        self.assertIn("session_id", result)
        self.assertEqual(svc.ACTIVE_SESSIONS[result["session_id"]]["ws_port"], 8453)

    @mock.patch.object(svc, "_wait_for_port", return_value=True)
    @mock.patch.object(svc, "subprocess")
    @mock.patch.object(svc, "_kasm")
    def test_socks_proxy_ssh_command_is_hardened(self, kasm, sp, _wp):
        """這條 ssh -D 必須帶硬化選項(BatchMode/ExitOnForwardFailure/ConnectTimeout),否則冷啟會卡死。"""
        sp.Popen.return_value = mock.Mock(poll=lambda: None)
        kasm.create_session.return_value = {"session_id": "k1", "ws_port": 8453}
        svc.start_remote_browser("alice", 30001, 7)
        argv = sp.Popen.call_args[0][0]
        self.assertIsInstance(argv, list)           # argv 形式,不再走 shell=True
        joined = " ".join(argv)
        self.assertIn("BatchMode=yes", joined)
        self.assertIn("ExitOnForwardFailure=yes", joined)
        self.assertIn("ConnectTimeout=10", joined)
        self.assertIn("-D", argv)
        self.assertNotIn("-q", argv)                # 保留 stderr 供偵錯

    @mock.patch.object(svc, "_wait_for_port", return_value=True)
    @mock.patch.object(svc, "subprocess")
    @mock.patch.object(svc, "_kasm")
    def test_stop_stops_kasm_session_and_terminates_ssh(self, kasm, sp, _wp):
        proc = mock.Mock(poll=lambda: None)
        sp.Popen.return_value = proc
        kasm.create_session.return_value = {"session_id": "k1", "ws_port": 5910}

        sid = svc.start_remote_browser("alice", 30001, 7)["session_id"]
        ok = svc.stop_remote_browser(sid)

        self.assertTrue(ok)
        kasm.stop_session.assert_called_once_with("k1")
        proc.terminate.assert_called()
        self.assertNotIn(sid, svc.ACTIVE_SESSIONS)
        self.assertIsNone(svc._store.get(sid))

    @mock.patch.object(svc, "_kasm")
    def test_stop_on_non_owner_worker_still_stops_kasm_via_store(self, kasm):
        """WS consumer 落在非 ssh-owner worker:in-process 沒這筆,仍要靠 store 收 kasm session。"""
        svc._store.put("sess-x", {"server_id": 7, "kasm_session_id": "kx",
                                  "ws_port": 5911, "proxy_port": 5555})
        ok = svc.stop_remote_browser("sess-x")
        self.assertTrue(ok)
        kasm.stop_session.assert_called_once_with("kx")
        self.assertIsNone(svc._store.get("sess-x"))

    def test_get_session_reads_store_for_cross_worker_lookup(self):
        svc._store.put("sess-y", {"server_id": 9, "kasm_session_id": "ky",
                                  "ws_port": 5912, "proxy_port": 6000})
        got = svc.get_session("sess-y")
        self.assertEqual(got["server_id"], 9)
        self.assertEqual(got["ws_port"], 5912)
        self.assertIsNone(svc.get_session("does-not-exist"))

    def test_gc_keeps_session_with_fresh_redis_key_despite_stale_local_last_seen(self):
        """多 worker bug 回歸測試:ping 落在非 owner worker → owner 的 last_seen 很舊,但只要
        Redis key 還在(任一 worker 有續 TTL)就**不可**回收(否則使用者掛著就被無故關掉)。"""
        alive = mock.Mock(poll=lambda: None)          # ssh 還活著
        svc.ACTIVE_SESSIONS["s-alive"] = {"ssh_process": alive, "last_seen": 0}  # last_seen 極舊
        svc._store.put("s-alive", {"server_id": 1, "kasm_session_id": "k", "ws_port": 8453})
        live_ids = svc._store.live_session_ids()      # 含 s-alive(Redis 續命中)
        dead = svc._dead_session_ids(now=10_000, live_ids=live_ids, redis_ok=True, idle_timeout=60)
        self.assertNotIn("s-alive", dead)             # 有 Redis key → 不收(即使 last_seen 過期)

    def test_gc_reaps_when_redis_key_gone_or_ssh_dead(self):
        alive = mock.Mock(poll=lambda: None)
        dead_proc = mock.Mock(poll=lambda: 0)         # ssh 已退出
        svc.ACTIVE_SESSIONS["s-gone"] = {"ssh_process": alive, "last_seen": 9_999}   # Redis key 不在
        svc.ACTIVE_SESSIONS["s-sshdead"] = {"ssh_process": dead_proc, "last_seen": 9_999}
        svc._store.put("s-sshdead", {"server_id": 1, "kasm_session_id": "k", "ws_port": 8453})
        live_ids = svc._store.live_session_ids()      # 只含 s-sshdead
        dead = svc._dead_session_ids(now=10_000, live_ids=live_ids, redis_ok=True, idle_timeout=60)
        self.assertIn("s-gone", dead)                 # Redis key 消失 → 收
        self.assertIn("s-sshdead", dead)              # ssh 死了 → 收

    def test_gc_falls_back_to_last_seen_when_redis_down(self):
        alive = mock.Mock(poll=lambda: None)
        svc.ACTIVE_SESSIONS["s-idle"] = {"ssh_process": alive, "last_seen": 0}
        svc.ACTIVE_SESSIONS["s-fresh"] = {"ssh_process": alive, "last_seen": 9_990}
        dead = svc._dead_session_ids(now=10_000, live_ids=set(), redis_ok=False, idle_timeout=60)
        self.assertIn("s-idle", dead)                 # Redis 掛掉 → 退回 last_seen,過期就收
        self.assertNotIn("s-fresh", dead)             # 近期有 last_seen → 保留

    @mock.patch.object(svc, "_proxy_alive", return_value=True)
    @mock.patch.object(svc, "_wait_for_port", return_value=True)
    @mock.patch.object(svc, "subprocess")
    @mock.patch.object(svc, "_kasm")
    def test_ping_refreshes_store_ttl(self, kasm, sp, _wp, _alive):
        sp.Popen.return_value = mock.Mock(poll=lambda: None)
        kasm.create_session.return_value = {"session_id": "k", "ws_port": 5910}
        sid = svc.start_remote_browser("alice", 30001, 7)["session_id"]
        with mock.patch.object(svc._store, "refresh", wraps=svc._store.refresh) as r:
            self.assertTrue(svc.ping_remote_browser(sid))
            r.assert_called_once()
        self.assertFalse(svc.ping_remote_browser("nope"))

    @mock.patch.object(svc, "_wait_for_port", return_value=True)
    @mock.patch.object(svc, "subprocess")
    @mock.patch.object(svc, "_kasm")
    def test_ping_reaps_session_with_dead_proxy(self, kasm, sp, _wp):
        """SOCKS 代理死亡(如 backend 重啟後的殭屍)→ ping 回 False 並就地回收,不再續命。"""
        sp.Popen.return_value = mock.Mock(poll=lambda: None)
        kasm.create_session.return_value = {"session_id": "k", "ws_port": 5910}
        sid = svc.start_remote_browser("alice", 30001, 7)["session_id"]
        # 測試裡 ssh 是 mock,proxy_port 沒有真的在聽 → _proxy_alive 為 False(真實探測)。
        self.assertFalse(svc.ping_remote_browser(sid))
        self.assertIsNone(svc._store.get(sid))          # 記錄已刪
        kasm.stop_session.assert_called_once_with("k")  # kasm session 已收

    def test_gc_reaps_redis_orphans_with_dead_proxy(self):
        """Redis 有記錄但不屬於本行程且埠沒在聽(擁有者已重啟)→ 孤兒回收。"""
        svc._store.put("s-orphan", {"kasm_session_id": "k-orphan", "proxy_port": 1,
                                    "server_id": 7, "ws_port": 5910, "last_seen": 0})
        try:
            with mock.patch.object(svc, "_kasm") as kasm, \
                 mock.patch.object(svc, "_proxy_alive", return_value=False):
                live_ids = svc._store.live_session_ids()
                self.assertIn("s-orphan", live_ids)
                # 模擬 reaper 的孤兒掃描段落 / simulate the reaper's orphan sweep
                with svc._SESSIONS_LOCK:
                    mine = set(svc.ACTIVE_SESSIONS.keys())
                for sid in live_ids - mine:
                    stored = svc._store.get(sid)
                    if stored and not svc._proxy_alive(stored.get("proxy_port")):
                        svc.stop_remote_browser(sid)
                kasm.stop_session.assert_called_once_with("k-orphan")
            self.assertIsNone(svc._store.get("s-orphan"))
        finally:
            svc._store.delete("s-orphan")
