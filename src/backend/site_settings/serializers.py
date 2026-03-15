from rest_framework import serializers
from site_settings.models import SiteSettings

class SiteSettingsSerializer(serializers.ModelSerializer):
    class Meta:
        model = SiteSettings
        fields = ['allow_registration', 'remote_browser_session_idle_timeout']

    def create(self, validated_data):
        instance = SiteSettings.get_solo()
        instance.allow_registration = validated_data.get('allow_registration', instance.allow_registration)
        instance.remote_browser_session_idle_timeout = validated_data.get(
            'remote_browser_session_idle_timeout', instance.remote_browser_session_idle_timeout
        )
        instance.save()
        return instance

    def update(self, instance, validated_data):
        instance.allow_registration = validated_data.get('allow_registration', instance.allow_registration)
        instance.remote_browser_session_idle_timeout = validated_data.get(
            'remote_browser_session_idle_timeout', instance.remote_browser_session_idle_timeout
        )
        instance.save()
        return instance