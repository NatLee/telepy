from django.contrib.auth.models import User
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated

from drf_yasg.utils import swagger_auto_schema

from user_management.models import UserSettings
from user_management.serializers import UserSettingsSerializer, ManagedUserSerializer


class UserSettingsView(APIView):
    """目前登入者的個人設定(語言偏好)。/ The current user's personal settings."""

    permission_classes = [IsAuthenticated]

    @swagger_auto_schema(
        operation_summary="Get my settings",
        operation_description="Retrieve the current user's personal settings (language preference).",
        tags=["User Management"],
    )
    def get(self, request):
        settings = UserSettings.for_user(request.user)
        return Response(UserSettingsSerializer(settings).data)

    @swagger_auto_schema(
        operation_summary="Update my settings",
        operation_description="Update the current user's personal settings. Body: { language: auto|en|zh-TW|ja }",
        request_body=UserSettingsSerializer,
        tags=["User Management"],
    )
    def post(self, request):
        settings = UserSettings.for_user(request.user)
        serializer = UserSettingsSerializer(settings, data=request.data, partial=True)
        if serializer.is_valid():
            serializer.save()
            return Response(serializer.data)
        return Response(serializer.errors, status=400)


class ManagedUserListView(APIView):
    """管理員的使用者列表。/ Admin-only user list."""

    permission_classes = [IsAuthenticated]

    @swagger_auto_schema(
        operation_summary="List users (admin)",
        operation_description="List all users with account status and personal settings. Admins only.",
        tags=["User Management"],
    )
    def get(self, request):
        if not request.user.is_superuser:
            return Response({"error": "Permission denied. Only administrators can list users."}, status=403)
        users = User.objects.select_related("settings").order_by("id")
        return Response({"users": ManagedUserSerializer(users, many=True).data})


class ManagedUserDetailView(APIView):
    """管理員編輯單一使用者(帳號旗標 + 個人設定)。/ Admin edit of one user (flags + settings)."""

    permission_classes = [IsAuthenticated]

    @swagger_auto_schema(
        operation_summary="Update a user (admin)",
        operation_description=(
            "Update a user's account flags and personal settings. Admins only. "
            "Body accepts any of: { is_active: bool, is_superuser: bool, language: auto|en|zh-TW|ja }. "
            "Admins cannot deactivate or demote their own account."
        ),
        tags=["User Management"],
    )
    def post(self, request, user_id):
        if not request.user.is_superuser:
            return Response({"error": "Permission denied. Only administrators can manage users."}, status=403)

        try:
            target = User.objects.get(pk=user_id)
        except User.DoesNotExist:
            return Response({"error": "User not found."}, status=404)

        data = request.data or {}

        # 防呆:不允許把自己停用或降權,避免鎖死唯一的管理員。
        # Guard: admins cannot deactivate or demote themselves (avoids locking out the only admin).
        if target.pk == request.user.pk:
            if data.get("is_active") is False:
                return Response({"error": "You cannot deactivate your own account."}, status=400)
            if data.get("is_superuser") is False:
                return Response({"error": "You cannot remove your own administrator role."}, status=400)

        # 帳號旗標 / Account flags
        changed_flags = False
        if "is_active" in data:
            if not isinstance(data["is_active"], bool):
                return Response({"error": "is_active must be a boolean."}, status=400)
            target.is_active = data["is_active"]
            changed_flags = True
        if "is_superuser" in data:
            if not isinstance(data["is_superuser"], bool):
                return Response({"error": "is_superuser must be a boolean."}, status=400)
            target.is_superuser = data["is_superuser"]
            # 與 first-user signal 一致:superuser 同時給 is_staff(可進 Django admin)。
            # Match the first-user signal: superusers also get is_staff (Django admin access).
            target.is_staff = data["is_superuser"]
            changed_flags = True
        if changed_flags:
            target.save()

        # 個人設定 / Personal settings
        if "language" in data:
            settings = UserSettings.for_user(target)
            serializer = UserSettingsSerializer(settings, data={"language": data["language"]}, partial=True)
            if not serializer.is_valid():
                return Response(serializer.errors, status=400)
            serializer.save()

        target.refresh_from_db()
        return Response(ManagedUserSerializer(target).data)
