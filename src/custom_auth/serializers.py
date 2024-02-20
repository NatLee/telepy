from django.conf import settings
from django.contrib.auth.models import User
from rest_framework import serializers
from google.oauth2 import id_token
from google.auth.transport import requests

from custom_auth.models import SocialAccount

from custom_auth.exception import InvalidEmailError

import logging

logger = logging.getLogger(__name__)


class SocialLoginSerializer(serializers.Serializer):
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
        if idinfo:
            # User not exists
            if not SocialAccount.objects.filter(unique_id=idinfo["sub"]).exists():
                email = idinfo["email"]

                # check email
                if not email.endswith("dailyview.tw"):
                    logger.warning(f"`{email}` attempts to register!!")
                    raise InvalidEmailError

                first_name = idinfo["given_name"]
                last_name = idinfo["family_name"]
                username = email.split("@")[0]
                user = User.objects.create_user(
                    # Username has to be unique
                    username=username,
                    first_name=first_name,
                    last_name=last_name,
                    email=email,
                )
                logger.debug(f"Created user [{username}] - [{email}]")
                SocialAccount.objects.create(user=user, unique_id=idinfo["sub"])
                return user
            else:
                social = SocialAccount.objects.get(unique_id=idinfo["sub"])
                return social.user
        else:
            raise ValueError("Incorrect Credentials")


class UserSerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = ["username", "email", "first_name", "last_name"]
