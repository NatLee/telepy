from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase
from rest_framework_simplejwt.tokens import AccessToken

from site_settings.models import SiteSettings
from user_management.models import UserSettings


class UserSettingsApiTest(APITestCase):
    """個人設定 API(語言偏好)。/ Personal settings API (language preference)."""

    URL = "/api/user/settings"

    def setUp(self):
        User = get_user_model()
        # 第一個使用者會被 signal 自動設為 superuser。/ First user auto-becomes superuser via signal.
        self.admin = User.objects.create_user("admin", password="x")
        self.admin.refresh_from_db()
        s = SiteSettings.get_solo(); s.allow_registration = True; s.save()
        self.user = User.objects.create_user("bob", password="x")
        s.allow_registration = False; s.save()

    def _auth(self, u):
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {AccessToken.for_user(u)}")

    def test_requires_auth(self):
        self.assertEqual(self.client.get(self.URL).status_code, 401)

    def test_get_defaults_to_null_language(self):
        # null = 使用者從未選過語言(前端據此決定回填方向)。/ null = never chosen.
        self._auth(self.user)
        res = self.client.get(self.URL)
        self.assertEqual(res.status_code, 200)
        self.assertIsNone(res.json()["language"])

    def test_update_language_and_persist(self):
        self._auth(self.user)
        res = self.client.post(self.URL, {"language": "zh-TW"}, format="json")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["language"], "zh-TW")
        self.assertEqual(UserSettings.for_user(self.user).language, "zh-TW")
        # auto 也是合法值 / "auto" is a valid explicit choice
        res = self.client.post(self.URL, {"language": "auto"}, format="json")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["language"], "auto")

    def test_invalid_language_rejected(self):
        self._auth(self.user)
        res = self.client.post(self.URL, {"language": "fr"}, format="json")
        self.assertEqual(res.status_code, 400)

    def test_theme_and_terminal_font_size(self):
        self._auth(self.user)
        res = self.client.post(self.URL, {"theme": "dark", "terminal_font_size": 18}, format="json")
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertEqual(body["theme"], "dark")
        self.assertEqual(body["terminal_font_size"], 18)
        settings = UserSettings.for_user(self.user)
        self.assertEqual(settings.theme, "dark")
        self.assertEqual(settings.terminal_font_size, 18)
        # 無效值被擋下 / invalid values rejected
        self.assertEqual(self.client.post(self.URL, {"theme": "neon"}, format="json").status_code, 400)
        self.assertEqual(self.client.post(self.URL, {"terminal_font_size": 99}, format="json").status_code, 400)
        self.assertEqual(self.client.post(self.URL, {"terminal_font_size": 5}, format="json").status_code, 400)

    def test_profile_includes_theme_and_font_size_defaults(self):
        self._auth(self.user)
        UserSettings.for_user(self.user)  # 建立預設列 / create the default row
        res = self.client.get("/api/auth/user/profile")
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertEqual(body["theme"], "system")
        self.assertEqual(body["terminal_font_size"], 14)

    def test_profile_includes_language(self):
        # 前端登入後從 profile 直接取得語言,不用多打一次 API。
        self._auth(self.user)
        UserSettings.objects.create(user=self.user, language="ja")
        res = self.client.get("/api/auth/user/profile")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["language"], "ja")


class ManagedUsersApiTest(APITestCase):
    """管理員使用者管理 API。/ Admin user-management API."""

    LIST_URL = "/api/user/users"

    def setUp(self):
        User = get_user_model()
        self.admin = User.objects.create_user("admin", password="x")
        self.admin.refresh_from_db()
        s = SiteSettings.get_solo(); s.allow_registration = True; s.save()
        self.user = User.objects.create_user("bob", password="x", email="bob@example.com")
        s.allow_registration = False; s.save()

    def _auth(self, u):
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {AccessToken.for_user(u)}")

    def _detail_url(self, user_id):
        return f"/api/user/users/{user_id}"

    def test_list_admin_only(self):
        self._auth(self.user)
        self.assertEqual(self.client.get(self.LIST_URL).status_code, 403)
        self._auth(self.admin)
        res = self.client.get(self.LIST_URL)
        self.assertEqual(res.status_code, 200)
        users = res.json()["users"]
        self.assertEqual({u["username"] for u in users}, {"admin", "bob"})
        # 列表項帶齊前端需要的欄位 / Items carry the fields the frontend renders
        for u in users:
            for field in ("id", "username", "email", "is_active", "is_superuser", "last_login", "language"):
                self.assertIn(field, u)

    def test_admin_updates_flags_and_language(self):
        self._auth(self.admin)
        res = self.client.post(
            self._detail_url(self.user.id),
            {"is_superuser": True, "language": "en"},
            format="json",
        )
        self.assertEqual(res.status_code, 200)
        self.user.refresh_from_db()
        self.assertTrue(self.user.is_superuser)
        self.assertTrue(self.user.is_staff)  # superuser 同步給 staff(進得了 Django admin)
        self.assertEqual(UserSettings.for_user(self.user).language, "en")

    def test_admin_cannot_demote_or_deactivate_self(self):
        self._auth(self.admin)
        res = self.client.post(self._detail_url(self.admin.id), {"is_superuser": False}, format="json")
        self.assertEqual(res.status_code, 400)
        res = self.client.post(self._detail_url(self.admin.id), {"is_active": False}, format="json")
        self.assertEqual(res.status_code, 400)
        self.admin.refresh_from_db()
        self.assertTrue(self.admin.is_superuser)
        self.assertTrue(self.admin.is_active)

    def test_non_admin_cannot_update(self):
        self._auth(self.user)
        res = self.client.post(self._detail_url(self.admin.id), {"is_active": False}, format="json")
        self.assertEqual(res.status_code, 403)

    def test_update_missing_user_404(self):
        self._auth(self.admin)
        self.assertEqual(
            self.client.post(self._detail_url(99999), {"is_active": False}, format="json").status_code,
            404,
        )
