from django.conf import settings
from django.contrib.auth.models import User
from django.core.exceptions import ValidationError

from rest_framework import serializers

from google.oauth2 import id_token
from google.auth.transport import requests

from custom_auth.models import SocialAccount
from custom_auth.exception import InvalidEmailError

import logging

logger = logging.getLogger(__name__)


class GoogleLoginSerializer(serializers.Serializer):
    # Google login
    credential = serializers.CharField(required=True)

    def verify_token(self, credential):
        """
        check id_token
        token: JWT
        """
        logger.debug(f"[AUTH][GOOGLE] Verifying credential: {credential[:50]}...")

        client_id = settings.SOCIAL_GOOGLE_CLIENT_ID
        if not client_id:
            # 後端未設定 SOCIAL_GOOGLE_CLIENT_ID，無法驗證 token，直接中止並記錄明確錯誤
            # Backend SOCIAL_GOOGLE_CLIENT_ID is missing; abort early with a clear error.
            logger.error(
                "[AUTH][GOOGLE] SOCIAL_GOOGLE_CLIENT_ID is not configured on the backend. "
                "Set the SOCIAL_GOOGLE_CLIENT_ID environment variable."
            )
            raise ValueError("Backend SOCIAL_GOOGLE_CLIENT_ID is not configured")

        try:
            idinfo = id_token.verify_oauth2_token(
                credential, requests.Request(), client_id
            )
        except ValueError as exception:
            # google-auth 在 token 過期 / 簽章錯誤 / audience 不符時會丟出 ValueError
            # google-auth raises ValueError on expired / bad-signature / wrong-audience tokens.
            logger.error(f"[AUTH][GOOGLE] id_token verification failed: {exception}")
            raise

        logger.debug(f"[AUTH][GOOGLE] Token decoded. Claims present: {sorted(idinfo.keys())}")

        if idinfo.get("iss") not in [
            "accounts.google.com",
            "https://accounts.google.com",
        ]:
            logger.error(f"[AUTH][GOOGLE] Wrong issuer: `{idinfo.get('iss')}`")
            raise ValueError("Wrong issuer.")
        if idinfo.get("aud") not in [client_id]:
            logger.error(
                f"[AUTH][GOOGLE] Audience mismatch. token aud=`{idinfo.get('aud')}`, "
                f"expected client_id=`{client_id}`"
            )
            raise ValueError("Could not verify audience.")
        # Success
        logger.info(f"[AUTH][GOOGLE] Token successfully verified for `{idinfo.get('email')}`")
        return idinfo

    def create(self, validated_data):
        idinfo = self.verify_token(validated_data.get("credential"))
        if not idinfo:
            logger.error("[AUTH][GOOGLE] verify_token returned empty idinfo")
            raise ValueError("Incorrect Credentials")

        # 抽取資料 / Extract email
        email = idinfo.get("email")
        if not email:
            logger.error(f"[AUTH][GOOGLE] Token has no `email` claim. Claims present: {sorted(idinfo.keys())}")
            raise ValueError("Google token has no email claim")
        account, domain = email.split("@")

        # 檢查是否為允許註冊的 email 網域。白名單以 SiteSettings.valid_register_domains(逗號分隔)
        # 為準,可由管理員在設定頁即時調整;留空則沿用 settings.VALID_REGISTER_DOMAINS 預設。
        # Registration domain allowlist comes from the admin-editable SiteSettings (comma-separated);
        # empty falls back to the settings.py default.
        from site_settings.models import SiteSettings
        raw = SiteSettings.get_solo().valid_register_domains or ""
        allowed = [d.strip().lower() for d in raw.split(",") if d.strip()] or list(settings.VALID_REGISTER_DOMAINS)
        if domain.lower() not in allowed:
            logger.warning(
                f"[AUTH][GOOGLE] `{email}` attempts to register with disallowed domain "
                f"`{domain}` (allowed: {allowed})"
            )
            raise InvalidEmailError

        # 抽取使用者名稱 / Extract names.
        # 注意：部分 Google 帳號的 token 可能缺少 given_name / family_name。
        # Note: some Google accounts' tokens may be missing given_name / family_name.
        if "given_name" not in idinfo or "family_name" not in idinfo:
            logger.warning(
                f"[AUTH][GOOGLE] Token for `{email}` is missing name claims; "
                f"defaulting to empty. Claims present: {sorted(idinfo.keys())}"
            )
        # 部分帳號的 token 缺少 given_name / family_name，預設空字串避免 KeyError
        # Some accounts' tokens lack given_name / family_name; default to "" to avoid KeyError.
        first_name = idinfo.get("given_name", "")
        last_name = idinfo.get("family_name", "")

        # 查找是否有同樣的使用者名稱
        try:
            user = User.objects.get(username=account)
        except User.DoesNotExist:
            try:
                # 如果沒有，則建立一個新的使用者
                user = User.objects.create_user(
                    # Username has to be unique
                    username=account,
                    first_name=first_name,
                    last_name=last_name,
                    email=email,
                )
            except ValidationError as exception:
                logger.debug(f"[AUTH][GOOGLE] {email} - {exception}")
                raise exception

            logger.debug(f"[AUTH][GOOGLE] Created user [{account}][{first_name}.{last_name}] - [{email}]")
            # 建立 SocialAccount
            SocialAccount.objects.create(
                user=user,
                provider="google",
                unique_id=idinfo["sub"]
            )

        # 這邊要注意，帳號已經存在，但是可能是用其他方式註冊的，所以要檢查是否有 SocialAccount
        try:
            social = SocialAccount.objects.get(user=user, provider="google")
        except SocialAccount.DoesNotExist:
            logger.error(f"[AUTH][GOOGLE] SocialAccount does not exist")
            raise ValueError("SocialAccount does not exist with provider `google`")

        return social.user
