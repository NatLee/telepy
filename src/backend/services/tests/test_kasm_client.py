from unittest import TestCase, mock

from services.kasm_client import KasmClient, KasmError


class KasmClientTest(TestCase):
    def test_create_session_posts_proxy_and_returns_ws_port(self):
        client = KasmClient(base_url="http://kasm-test:7000", token="secret")
        resp = mock.Mock(status_code=201)
        resp.json.return_value = {"session_id": "s1", "ws_port": 8453}
        resp.raise_for_status = lambda: None
        with mock.patch("services.kasm_client.requests.post", return_value=resp) as post:
            out = client.create_session("socks5://backend:12345", geometry="1280x720")

        self.assertEqual(out, {"session_id": "s1", "ws_port": 8453})
        url, kwargs = post.call_args[0][0], post.call_args[1]
        self.assertEqual(url, "http://kasm-test:7000/sessions")
        self.assertEqual(kwargs["json"]["proxy"], "socks5://backend:12345")
        self.assertEqual(kwargs["json"]["geometry"], "1280x720")
        # 內部 token 走 header,不進 URL
        self.assertEqual(kwargs["headers"]["X-Internal-Token"], "secret")
        self.assertEqual(kwargs["timeout"], 30)   # 預設逾時

    def test_create_session_forwards_custom_timeout(self):
        """啟動逾時由 SiteSettings.remote_browser_kasm_create_timeout 控制,經 timeout 參數帶入。"""
        client = KasmClient(base_url="http://kasm-test:7000", token="secret")
        resp = mock.Mock(status_code=201)
        resp.json.return_value = {"session_id": "s1", "ws_port": 8453}
        resp.raise_for_status = lambda: None
        with mock.patch("services.kasm_client.requests.post", return_value=resp) as post:
            client.create_session("socks5://backend:1", timeout=90)
        self.assertEqual(post.call_args[1]["timeout"], 90)

    def test_create_session_sends_no_profile_key(self):
        """設定檔一律每 session 臨時(不保留歷史);payload 不再有 profile_key。"""
        client = KasmClient(base_url="http://kasm-test:7000", token="secret")
        resp = mock.Mock(status_code=201)
        resp.json.return_value = {"session_id": "s1", "ws_port": 8453}
        resp.raise_for_status = lambda: None
        with mock.patch("services.kasm_client.requests.post", return_value=resp) as post:
            client.create_session("socks5://backend:1")
        self.assertNotIn("profile_key", post.call_args[1]["json"])

    def test_create_session_raises_kasm_error_on_http_failure(self):
        client = KasmClient(base_url="http://kasm-test:7000", token="secret")
        import requests as _rq
        with mock.patch("services.kasm_client.requests.post",
                        side_effect=_rq.RequestException("boom")):
            with self.assertRaises(KasmError):
                client.create_session("socks5://backend:1")

    def test_create_session_raises_on_missing_ws_port(self):
        client = KasmClient(base_url="http://kasm-test:7000", token="secret")
        resp = mock.Mock(status_code=201)
        resp.json.return_value = {"session_id": "s1"}  # 少 ws_port
        resp.raise_for_status = lambda: None
        with mock.patch("services.kasm_client.requests.post", return_value=resp):
            with self.assertRaises(KasmError):
                client.create_session("socks5://backend:1")

    def test_stop_session_calls_delete_and_swallows_errors(self):
        client = KasmClient(base_url="http://kasm-test:7000", token="secret")
        import requests as _rq
        with mock.patch("services.kasm_client.requests.delete") as d:
            client.stop_session("s1")
            self.assertEqual(d.call_args[0][0], "http://kasm-test:7000/sessions/s1")
            self.assertEqual(d.call_args[1]["headers"]["X-Internal-Token"], "secret")
        # 停止失敗不得往外丟(斷線時仍要能收尾)
        with mock.patch("services.kasm_client.requests.delete",
                        side_effect=_rq.RequestException("gone")):
            client.stop_session("s1")   # 不應 raise

    def test_base_url_and_token_from_env(self):
        with mock.patch.dict("os.environ", {
            "KASM_BROWSER_API": "http://kasm-browser:7000/",
            "INTERNAL_API_TOKEN": "envtoken",
        }):
            c = KasmClient()
            self.assertEqual(c.base_url, "http://kasm-browser:7000")
            self.assertEqual(c.token, "envtoken")
