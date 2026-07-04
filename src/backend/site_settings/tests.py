from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase
from rest_framework_simplejwt.tokens import AccessToken

from site_settings.models import SiteSettings
from site_settings.views import _field_meta


class SiteSettingsApiTest(APITestCase):
    URL = "/api/site/settings"

    def setUp(self):
        User = get_user_model()
        # 第一個使用者會被 signal 自動設為 superuser。/ First user auto-becomes superuser via signal.
        self.admin = User.objects.create_user("admin", password="x")
        self.admin.refresh_from_db()
        # 開放註冊才能建第二個(非管理員)測試帳號;建完後還原成預設(關閉)。
        s = SiteSettings.get_solo(); s.allow_registration = True; s.save()
        self.user = User.objects.create_user("bob", password="x")
        s.allow_registration = False; s.save()

    def _auth(self, u):
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {AccessToken.for_user(u)}")

    def test_get_returns_values_and_meta_with_descriptions(self):
        self._auth(self.admin)
        res = self.client.get(self.URL)
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertIn("values", body)
        self.assertIn("meta", body)
        # 每個設定都有 label + 非空說明(help_text)+ 型別
        for key, m in body["meta"].items():
            self.assertTrue(m["label"], f"{key} missing label")
            self.assertTrue(m["description"], f"{key} missing description")
            self.assertIn(m["type"], ("boolean", "integer", "string"))
        # 涵蓋所有欄位,型別正確
        self.assertEqual(body["meta"]["remote_browser_geometry"]["type"], "string")
        self.assertEqual(body["meta"]["remote_browser_homepage"]["type"], "string")
        self.assertEqual(body["meta"]["remote_browser_language"]["type"], "string")
        self.assertEqual(body["meta"]["remote_browser_session_idle_timeout"]["type"], "integer")
        self.assertEqual(body["meta"]["allow_registration"]["type"], "boolean")

    def test_meta_covers_every_serialized_value(self):
        # 每個回傳的 value 都要有對應說明,不然前端會有沒說明的設定。
        self._auth(self.admin)
        body = self.client.get(self.URL).json()
        self.assertEqual(set(body["values"].keys()), set(body["meta"].keys()))

    def test_admin_can_update_string_setting(self):
        self._auth(self.admin)
        res = self.client.post(self.URL, {"remote_browser_homepage": "https://example.org"}, format="json")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(SiteSettings.get_solo().remote_browser_homepage, "https://example.org")

    def test_partial_update_leaves_other_fields_untouched(self):
        self._auth(self.admin)
        s = SiteSettings.get_solo(); s.remote_browser_language = "ja-JP"; s.save()
        self.client.post(self.URL, {"remote_browser_geometry": "1920x1080"}, format="json")
        s.refresh_from_db()
        self.assertEqual(s.remote_browser_geometry, "1920x1080")
        self.assertEqual(s.remote_browser_language, "ja-JP")   # 未送的欄位不被覆寫

    def test_non_admin_gets_empty_and_cannot_write(self):
        self._auth(self.user)
        self.assertEqual(self.client.get(self.URL).json(), {"values": {}, "meta": {}})
        res = self.client.post(self.URL, {"remote_browser_homepage": "https://evil.example"}, format="json")
        self.assertEqual(res.status_code, 403)
        self.assertEqual(SiteSettings.get_solo().remote_browser_homepage, "https://www.google.com")

    def test_field_meta_helper_matches_serializer_fields(self):
        from site_settings.serializers import SiteSettingsSerializer
        self.assertEqual(list(_field_meta().keys()), list(SiteSettingsSerializer.Meta.fields))
