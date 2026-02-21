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
        logger.debug(f"Verify {credential[:50]}...")
        idinfo = id_token.verify_oauth2_token(
            credential, requests.Request(), settings.SOCIAL_GOOGLE_CLIENT_ID
        )
        if idinfo["iss"] not in [
            "accounts.google.com",
            "https://accounts.google.com",
        ]:
            logger.error("Wrong issuer")
            raise ValueError("Wrong issuer.")
        if idinfo["aud"] not in [settings.SOCIAL_GOOGLE_CLIENT_ID]:
            logger.error("Could not verify audience")
            raise ValueError("Could not verify audience.")
        # Success
        logger.info("successfully verified")
        return idinfo

    def create(self, validated_data):
        idinfo = self.verify_token(validated_data.get("credential"))
        if not idinfo:
            raise ValueError("Incorrect Credentials")

        # 抽取資料
        email = idinfo["email"]
        account, domain = email.split("@")

        # 檢查是否為註冊的 domain
        if domain not in settings.VALID_REGISTER_DOMAINS:
            logger.warning(f"[AUTH][GOOGLE] `{email}` attempts to register!!")
            raise InvalidEmailError

        # 抽取使用者名稱
        first_name = idinfo["given_name"]
        last_name = idinfo["family_name"]

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
