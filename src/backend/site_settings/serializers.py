from rest_framework import serializers
from site_settings.models import SiteSettings

class SiteSettingsSerializer(serializers.ModelSerializer):
    class Meta:
        model = SiteSettings
        fields = [
            'allow_registration',
            'remote_browser_session_idle_timeout',
            'remote_browser_max_sessions',
            'remote_browser_neko_image',
        ]

    def create(self, validated_data):
        instance = SiteSettings.get_solo()
        instance.allow_registration = validated_data.get('allow_registration', instance.allow_registration)
        instance.remote_browser_session_idle_timeout = validated_data.get(
            'remote_browser_session_idle_timeout', instance.remote_browser_session_idle_timeout
        )
        instance.remote_browser_max_sessions = validated_data.get(
            'remote_browser_max_sessions', instance.remote_browser_max_sessions
        )
        instance.remote_browser_neko_image = validated_data.get(
            'remote_browser_neko_image', instance.remote_browser_neko_image
        )
        instance.save()
        return instance

    def update(self, instance, validated_data):
        instance.allow_registration = validated_data.get('allow_registration', instance.allow_registration)
        instance.remote_browser_session_idle_timeout = validated_data.get(
            'remote_browser_session_idle_timeout', instance.remote_browser_session_idle_timeout
        )
        instance.remote_browser_max_sessions = validated_data.get(
            'remote_browser_max_sessions', instance.remote_browser_max_sessions
        )
        instance.remote_browser_neko_image = validated_data.get(
            'remote_browser_neko_image', instance.remote_browser_neko_image
        )
        instance.save()
        return instance