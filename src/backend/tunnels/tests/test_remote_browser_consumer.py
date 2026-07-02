import json
from unittest import mock, IsolatedAsyncioTestCase

from tunnels.consumers import RemoteBrowserConsumer


def _make_consumer(context_id="CTX", cdp_session_id="SESS"):
    """建立一個已「認證後」狀態的 consumer,CDP 連線換成 AsyncMock,可直接測 on_message 派送。"""
    c = RemoteBrowserConsumer()
    c.cdp = mock.AsyncMock()
    c.cdp_session_id = cdp_session_id
    c.context_id = context_id
    c.target_id = "TGT"
    c.rb_session_id = "sess-1"
    c.width, c.height = 1280, 720
    c.send = mock.AsyncMock()
    c._authed = True
    return c


class RemoteBrowserInputDispatchTest(IsolatedAsyncioTestCase):
    async def test_mouse_event_maps_to_dispatch_mouse_event(self):
        c = _make_consumer()
        await c.on_message(json.dumps({
            "type": "mouse", "event": "mousePressed",
            "x": 100, "y": 200, "button": "left", "clickCount": 1,
        }))
        c.cdp.call.assert_awaited_once()
        method, params = c.cdp.call.await_args[0][0], c.cdp.call.await_args[0][1]
        self.assertEqual(method, "Input.dispatchMouseEvent")
        self.assertEqual(params["type"], "mousePressed")
        self.assertEqual((params["x"], params["y"]), (100, 200))
        self.assertEqual(params["button"], "left")
        self.assertEqual(c.cdp.call.await_args[1]["session_id"], "SESS")

    async def test_wheel_event_carries_deltas(self):
        c = _make_consumer()
        await c.on_message(json.dumps({
            "type": "mouse", "event": "mouseWheel", "x": 5, "y": 6,
            "deltaX": 0, "deltaY": -120,
        }))
        params = c.cdp.call.await_args[0][1]
        self.assertEqual(params["type"], "mouseWheel")
        self.assertEqual(params["deltaY"], -120)

    async def test_key_event_passthrough_fields(self):
        c = _make_consumer()
        await c.on_message(json.dumps({
            "type": "key", "event": "keyDown", "key": "a", "code": "KeyA",
            "windowsVirtualKeyCode": 65, "text": "a",
        }))
        method, params = c.cdp.call.await_args[0][0], c.cdp.call.await_args[0][1]
        self.assertEqual(method, "Input.dispatchKeyEvent")
        self.assertEqual(params["windowsVirtualKeyCode"], 65)
        self.assertEqual(params["code"], "KeyA")
        self.assertEqual(params["text"], "a")

    async def test_text_event_uses_insert_text_for_cjk_and_paste(self):
        c = _make_consumer()
        await c.on_message(json.dumps({"type": "text", "text": "中文貼上"}))
        method, params = c.cdp.call.await_args[0][0], c.cdp.call.await_args[0][1]
        self.assertEqual(method, "Input.insertText")
        self.assertEqual(params["text"], "中文貼上")

    async def test_navigate_calls_page_navigate(self):
        c = _make_consumer()
        await c.on_message(json.dumps({"type": "navigate", "url": "https://example.com"}))
        method, params = c.cdp.call.await_args[0][0], c.cdp.call.await_args[0][1]
        self.assertEqual(method, "Page.navigate")
        self.assertEqual(params["url"], "https://example.com")

    async def test_navigate_reload_calls_page_reload(self):
        c = _make_consumer()
        await c.on_message(json.dumps({"type": "navigate", "action": "reload"}))
        self.assertEqual(c.cdp.call.await_args[0][0], "Page.reload")

    async def test_navigate_back_uses_history_entry(self):
        c = _make_consumer()
        c.cdp.call.return_value = {
            "currentIndex": 1,
            "entries": [{"id": 10, "url": "http://a"}, {"id": 11, "url": "http://b"}],
        }
        await c.on_message(json.dumps({"type": "navigate", "action": "back"}))
        methods = [call[0][0] for call in c.cdp.call.await_args_list]
        self.assertIn("Page.getNavigationHistory", methods)
        last = c.cdp.call.await_args_list[-1]
        self.assertEqual(last[0][0], "Page.navigateToHistoryEntry")
        self.assertEqual(last[0][1]["entryId"], 10)   # 回上一筆(index 0)

    async def test_navigate_back_at_start_is_noop(self):
        c = _make_consumer()
        c.cdp.call.return_value = {"currentIndex": 0, "entries": [{"id": 10}]}
        await c.on_message(json.dumps({"type": "navigate", "action": "back"}))
        methods = [call[0][0] for call in c.cdp.call.await_args_list]
        self.assertNotIn("Page.navigateToHistoryEntry", methods)

    async def test_navigate_rejects_non_http_scheme(self):
        c = _make_consumer()
        await c.on_message(json.dumps({"type": "navigate", "url": "file:///etc/passwd"}))
        # 不得把 file:// / chrome:// 之類送進去(避免讀本機檔案)
        for call in c.cdp.call.await_args_list:
            self.assertNotEqual(call[0][0], "Page.navigate")

    async def test_unknown_message_type_is_ignored(self):
        c = _make_consumer()
        await c.on_message(json.dumps({"type": "nonsense"}))
        c.cdp.call.assert_not_awaited()

    async def test_malformed_json_is_ignored(self):
        c = _make_consumer()
        await c.on_message("{not json")
        c.cdp.call.assert_not_awaited()


class RemoteBrowserTabSecurityTest(IsolatedAsyncioTestCase):
    async def test_new_tab_created_inside_session_context(self):
        c = _make_consumer(context_id="CTX")
        c.cdp.call.return_value = {"targetId": "new-tgt"}
        with mock.patch.object(c, "_attach_and_stream", new=mock.AsyncMock()) as att, \
             mock.patch.object(c, "_send_tab_list", new=mock.AsyncMock()):
            await c.on_message(json.dumps({"type": "tab", "action": "new"}))
        call = c.cdp.call.await_args_list[0]
        self.assertEqual(call[0][0], "Target.createTarget")
        self.assertEqual(call[0][1]["browserContextId"], "CTX")
        att.assert_awaited_once_with("new-tgt")   # 新分頁建立後切換過去

    async def test_switch_tab_rejects_target_outside_our_context(self):
        c = _make_consumer(context_id="CTX")
        # getTargets 回一個屬於「別的 context」的 target
        c.cdp.call.return_value = {"targetInfos": [
            {"targetId": "evil", "type": "page", "browserContextId": "OTHER"},
        ]}
        with mock.patch.object(c, "_attach_and_stream", new=mock.AsyncMock()) as att:
            await c.on_message(json.dumps({"type": "tab", "action": "switch",
                                           "target_id": "evil"}))
            att.assert_not_awaited()   # 不得 attach 到別人的 target

    async def test_switch_tab_allows_target_in_our_context(self):
        c = _make_consumer(context_id="CTX")
        c.cdp.call.return_value = {"targetInfos": [
            {"targetId": "mine", "type": "page", "browserContextId": "CTX"},
        ]}
        with mock.patch.object(c, "_attach_and_stream", new=mock.AsyncMock()) as att:
            await c.on_message(json.dumps({"type": "tab", "action": "switch",
                                           "target_id": "mine"}))
            att.assert_awaited_once_with("mine")

    async def test_close_tab_rejects_foreign_target(self):
        c = _make_consumer(context_id="CTX")
        c.cdp.call.return_value = {"targetInfos": [
            {"targetId": "evil", "type": "page", "browserContextId": "OTHER"},
        ]}
        await c.on_message(json.dumps({"type": "tab", "action": "close",
                                       "target_id": "evil"}))
        for call in c.cdp.call.await_args_list:
            self.assertNotEqual(call[0][0], "Target.closeTarget")

    async def test_tab_list_returns_only_our_context_pages(self):
        c = _make_consumer(context_id="CTX")
        c.cdp.call.return_value = {"targetInfos": [
            {"targetId": "a", "type": "page", "browserContextId": "CTX",
             "title": "A", "url": "http://a"},
            {"targetId": "b", "type": "page", "browserContextId": "OTHER",
             "title": "B", "url": "http://b"},
            {"targetId": "c", "type": "background_page", "browserContextId": "CTX",
             "title": "C", "url": "http://c"},
        ]}
        await c.on_message(json.dumps({"type": "tab", "action": "list"}))
        sent = json.loads(c.send.await_args[1]["text_data"])
        self.assertEqual(sent["type"], "tabs")
        ids = [t["target_id"] for t in sent["tabs"]]
        self.assertEqual(ids, ["a"])   # 只回本 context 的 page,排除別人與非 page


class RemoteBrowserResizeTest(IsolatedAsyncioTestCase):
    async def test_resize_sets_device_metrics_and_restarts_screencast(self):
        c = _make_consumer()
        with mock.patch.object(c, "_restart_screencast", new=mock.AsyncMock()) as rs:
            await c.on_message(json.dumps({"type": "resize", "width": 800, "height": 600}))
        methods = [call[0][0] for call in c.cdp.call.await_args_list]
        self.assertIn("Emulation.setDeviceMetricsOverride", methods)
        self.assertEqual((c.width, c.height), (800, 600))
        rs.assert_awaited_once()
