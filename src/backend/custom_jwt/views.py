from rest_framework_simplejwt.serializers import TokenObtainPairSerializer
from rest_framework_simplejwt.views import TokenObtainPairView

from rest_framework_simplejwt.serializers import TokenRefreshSerializer
from rest_framework_simplejwt.views import TokenRefreshView
from rest_framework_simplejwt.views import TokenVerifyView

from django.contrib.auth.models import User

from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated, AllowAny
from drf_yasg.utils import swagger_auto_schema

def get_client_ip(request):
    x_forwarded_for = request.META.get("HTTP_X_FORWARDED_FOR")
    if x_forwarded_for:
        ip = x_forwarded_for.split(",")[0]
    else:
        ip = request.META.get("REMOTE_ADDR")

    return ip


class MyTokenObtainPairSerializer(TokenObtainPairSerializer):
    def validate(self, attrs):
        data = super().validate(attrs)
        refresh = self.get_token(self.user)
        # data["refresh"] = str(refresh)
        # data["access"] = str(refresh.access_token)
        data["refresh_token"] = str(refresh)
        data["access_token"] = str(refresh.access_token)
        del data["access"]
        del data["refresh"]

        """
        # Add extra responses here
        data["username"] = self.user.username
        data["groups"] = self.user.groups.values_list("name", flat=True)
        """

        return data


class MyTokenObtainPairView(TokenObtainPairView):
    serializer_class = MyTokenObtainPairSerializer

    @swagger_auto_schema(tags=["Login"])
    def post(self, request, *args, **kwargs):
        return super().post(request, *args, **kwargs)


class MyTokenRefreshSerializer(TokenRefreshSerializer):
    def validate(self, attrs):
        data = super().validate(attrs)
        data["access_token"] = data.get("access")
        del data["access"]

        return data


class MyTokenRefreshView(TokenRefreshView):
    serializer_class = MyTokenRefreshSerializer

    @swagger_auto_schema(tags=["Login"])
    def post(self, request, *args, **kwargs):
        return super().post(request, *args, **kwargs)


class MyTokenVerifyView(TokenVerifyView):
    @swagger_auto_schema(tags=["Login"])
    def post(self, request, *args, **kwargs):
        return super().post(request, *args, **kwargs)


class SetupStatusView(APIView):
    """Public endpoint: whether the app is in first-time setup (no users yet)."""
    permission_classes = [AllowAny]

    @swagger_auto_schema(
        operation_summary="Setup status",
        operation_description="Returns first_time_setup: true when no users exist (initial setup).",
        tags=["Login"],
    )
    def get(self, request):
        first_time_setup = User.objects.count() == 0
        return Response({"first_time_setup": first_time_setup})


class UserProfileView(APIView):
    permission_classes = [IsAuthenticated]

    @swagger_auto_schema(
        operation_summary="Get User Profile",
        operation_description="Get current user's profile information",
        tags=['Authentication']
    )
    def get(self, request):
        user = request.user
        # 個人設定(語言偏好)一併帶回,前端登入後不用再打一次 API。null = 使用者從未選過語言。
        # Include personal settings so the frontend doesn't need an extra request. null = never chosen.
        user_settings = getattr(user, "settings", None)
        return Response({
            'id': user.id,
            'username': user.username,
            'email': user.email,
            'first_name': user.first_name,
            'last_name': user.last_name,
            'is_staff': user.is_staff,
            'is_superuser': user.is_superuser,
            'is_active': user.is_active,
            'date_joined': user.date_joined,
            'last_login': user.last_login,
            'language': user_settings.language if user_settings else None,
        })
