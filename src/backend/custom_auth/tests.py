from unittest import mock

from django.test import TestCase

from site_settings.models import SiteSettings
from custom_auth.serializers import GoogleLoginSerializer
from custom_auth.exception import InvalidEmailError


class RegisterDomainAllowlistTest(TestCase):
    """註冊 email 網域白名單改由 SiteSettings.valid_register_domains 控制(可即時調整)。"""

    def _register(self, email):
        idinfo = {"email": email, "given_name": "A", "family_name": "B"}
        with mock.patch.object(GoogleLoginSerializer, "verify_token", return_value=idinfo):
            return GoogleLoginSerializer().create({"credential": "tok"})

    def test_domain_not_in_db_allowlist_is_rejected(self):
        s = SiteSettings.get_solo(); s.valid_register_domains = "allowed.com"; s.save()
        with self.assertRaises(InvalidEmailError):
            self._register("user@blocked.com")

    def test_changing_db_allowlist_takes_effect(self):
        # 把 blocked.com 加進白名單後,同一個網域就能通過網域閘門(不再 InvalidEmailError)。
        s = SiteSettings.get_solo(); s.valid_register_domains = "blocked.com,allowed.com"; s.save()
        try:
            self._register("user@blocked.com")
        except InvalidEmailError:
            self.fail("domain present in the DB allowlist must pass the domain gate")
        except Exception:
            pass  # 通過網域閘門後的後續流程(建立使用者等)不在本測試範圍

    def test_empty_falls_back_to_settings_default(self):
        # 留空 → 沿用 settings.VALID_REGISTER_DOMAINS(預設 ["gmail.com"]):非 gmail 被拒。
        s = SiteSettings.get_solo(); s.valid_register_domains = ""; s.save()
        with self.assertRaises(InvalidEmailError):
            self._register("user@notgmail.com")

    def test_allowlist_is_case_insensitive(self):
        s = SiteSettings.get_solo(); s.valid_register_domains = "MyCorp.com"; s.save()
        try:
            self._register("user@mycorp.com")
        except InvalidEmailError:
            self.fail("domain match should be case-insensitive")
        except Exception:
            pass
