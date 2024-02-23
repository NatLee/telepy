from django.contrib.auth import login
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework_simplejwt.tokens import RefreshToken

from drf_yasg.utils import swagger_auto_schema

from custom_jwt.views import MyTokenObtainPairView

from custom_auth.serializers import SocialLoginSerializer

from custom_auth.exception import InvalidEmailError

import logging

logger = logging.getLogger(__name__)


def get_tokens_for_user(user):
    refresh = RefreshToken.for_user(user)
    return {
        "refresh_token": str(refresh),
        "access_token": str(refresh.access_token),
    }


class GoogleLogin(MyTokenObtainPairView):
    permission_classes = (AllowAny,)  # AllowAny for login
    serializer_class = SocialLoginSerializer

    @swagger_auto_schema(tags=["Login"])
    def post(self, request):
        serializer = self.get_serializer(data=request.data)
        if serializer.is_valid(raise_exception=True):
            try:
                user = serializer.save()
                login(request=request, user=user)
                return Response(get_tokens_for_user(user))
            except InvalidEmailError:
                return Response(
                    {"status": "error", "detail": "This email is invaild."}, status=401
                )
            except ValueError as e:
                logger.error(e)
                return Response(
                    {"status": "error", "detail": "Something wnet wrong :("}, status=500
                )
        else:
            return Response(
                {"status": "error", "detail": "Data is not serializable"}, status=401
            )
