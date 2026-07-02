from unittest import mock
from django.test import TestCase
from services.neko_rooms_client import NekoRoomsClient, NekoRoomsError


class NekoRoomsClientTest(TestCase):
    def setUp(self):
        self.client = NekoRoomsClient(base_url="http://neko-rooms:8080")

    @mock.patch("services.neko_rooms_client.requests.post")
    def test_create_room_posts_with_start_true_and_returns_entry(self, post):
        post.return_value = mock.Mock(
            status_code=200,
            json=lambda: {"id": "abc", "name": "telepy-x", "url": "/neko/telepy-x/", "is_ready": False},
        )
        post.return_value.raise_for_status = lambda: None

        entry = self.client.create_room({"name": "telepy-x"})

        self.assertEqual(entry["id"], "abc")
        args, kwargs = post.call_args
        self.assertEqual(args[0], "http://neko-rooms:8080/api/rooms")
        self.assertEqual(kwargs["params"], {"start": "true"})
        self.assertEqual(kwargs["json"], {"name": "telepy-x"})

    @mock.patch("services.neko_rooms_client.requests.delete")
    def test_delete_room_calls_delete(self, delete):
        delete.return_value = mock.Mock(status_code=204)
        delete.return_value.raise_for_status = lambda: None

        self.client.delete_room("abc")

        delete.assert_called_once_with("http://neko-rooms:8080/api/rooms/abc", timeout=10)

    @mock.patch("services.neko_rooms_client.requests.get")
    def test_list_rooms_passes_labels_as_query(self, get):
        get.return_value = mock.Mock(status_code=200, json=lambda: [{"id": "abc"}])
        get.return_value.raise_for_status = lambda: None

        rooms = self.client.list_rooms({"telepy.managed": "true"})

        self.assertEqual(rooms, [{"id": "abc"}])
        _, kwargs = get.call_args
        self.assertEqual(kwargs["params"], {"telepy.managed": "true"})

    @mock.patch("services.neko_rooms_client.requests.post")
    def test_create_room_raises_neko_error_on_http_failure(self, post):
        import requests as _rq
        resp = mock.Mock(status_code=500, text="boom")
        resp.raise_for_status = mock.Mock(side_effect=_rq.exceptions.HTTPError("500"))
        post.return_value = resp

        with self.assertRaises(NekoRoomsError):
            self.client.create_room({"name": "telepy-x"})
