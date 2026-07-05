from django.contrib.auth.models import User
from rest_framework import serializers

from user_management.models import UserSettings


class UserSettingsSerializer(serializers.ModelSerializer):
    """使用者個人設定(語言偏好)。/ Per-user settings (language preference)."""

    class Meta:
        model = UserSettings
        fields = ["language"]

    def validate_language(self, value):
        # 空字串視為未設定。/ Treat an empty string as "not set".
        if value == "":
            return None
        valid = {choice for choice, _label in UserSettings.LANGUAGE_CHOICES}
        if value is not None and value not in valid:
            raise serializers.ValidationError(
                f"Invalid language '{value}'. Valid options: {', '.join(sorted(valid))}."
            )
        return value


class ManagedUserSerializer(serializers.ModelSerializer):
    """
    管理員視角的使用者列表項目:基本帳號欄位 + 個人設定(語言)。
    Admin-facing user list item: core account fields + personal settings (language).
    """

    language = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = [
            "id", "username", "email",
            "is_active", "is_superuser",
            "date_joined", "last_login",
            "language",
        ]

    def get_language(self, user):
        settings = getattr(user, "settings", None)
        return settings.language if settings else None
