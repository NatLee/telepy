from unittest import mock
from django.test import TestCase
import authorized_keys.remote_browser_service as svc


class RemoteBrowserServiceTest(TestCase):
    def tearDown(self):
        svc.ACTIVE_SESSIONS.clear()

    @mock.patch.object(svc, "_wait_for_port", return_value=True)
    @mock.patch.object(svc, "subprocess")
    @mock.patch.object(svc, "_neko")
    def test_start_creates_room_with_proxy_env_and_registers_session(self, neko, sp, _wp):
        sp.Popen.return_value = mock.Mock(poll=lambda: None)
        neko.create_room.return_value = {"id": "room1", "is_ready": True}
        neko.wait_ready.return_value = True

        result = svc.start_remote_browser("alice", 30001, 7)

        # 有回傳 session_id 與 /neko/ 房間 url
        self.assertIn("session_id", result)
        self.assertTrue(result["url"].startswith("/neko/telepy-"))
        # 房間 envs 帶 socks5 proxy,指向本後端 host;api_version 顯式為 3
        settings = neko.create_room.call_args[0][0]
        self.assertEqual(settings["api_version"], 3)
        self.assertTrue(settings["envs"]["PROXY_SERVER"].startswith("socks5://"))
        self.assertEqual(settings["labels"][svc.LABEL_MANAGED], "true")
        # session 已登記
        self.assertEqual(len(svc.ACTIVE_SESSIONS), 1)

    @mock.patch.object(svc, "_wait_for_port", return_value=True)
    @mock.patch.object(svc, "subprocess")
    @mock.patch.object(svc, "_neko")
    def test_start_cleans_up_ssh_when_room_creation_fails(self, neko, sp, _wp):
        proc = mock.Mock(poll=lambda: None)
        sp.Popen.return_value = proc
        neko.create_room.side_effect = svc.NekoRoomsError("nope")

        with self.assertRaises(Exception):
            svc.start_remote_browser("alice", 30001, 7)

        proc.terminate.assert_called()             # ssh 有被收掉
        self.assertEqual(len(svc.ACTIVE_SESSIONS), 0)  # 沒有殘留 session

    @mock.patch.object(svc, "_wait_for_port", return_value=True)
    @mock.patch.object(svc, "subprocess")
    @mock.patch.object(svc, "_neko")
    def test_stop_deletes_room_and_terminates_ssh(self, neko, sp, _wp):
        proc = mock.Mock(poll=lambda: None)
        sp.Popen.return_value = proc
        neko.create_room.return_value = {"id": "room1", "is_ready": True}
        neko.wait_ready.return_value = True

        sid = svc.start_remote_browser("alice", 30001, 7)["session_id"]
        ok = svc.stop_remote_browser(sid)

        self.assertTrue(ok)
        neko.delete_room.assert_called_once_with("room1")
        self.assertNotIn(sid, svc.ACTIVE_SESSIONS)
