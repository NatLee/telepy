from rest_framework import serializers
from site_settings.models import SiteSettings

class SiteSettingsSerializer(serializers.ModelSerializer):
    class Meta:
        model = SiteSettings
        fields = [
            'allow_registration',
            'remote_browser_session_idle_timeout',
            'remote_browser_max_sessions',
            'remote_browser_geometry',
            'remote_browser_ssh_timeout',
            'remote_browser_ssh_attempts',
            'remote_browser_homepage',
            'remote_browser_language',
        ]

    def _apply(self, instance, validated_data):
        for field in self.Meta.fields:
            if field in validated_data:
                setattr(instance, field, validated_data[field])
        instance.save()
        return instance

    def create(self, validated_data):
        return self._apply(SiteSettings.get_solo(), validated_data)

    def update(self, instance, validated_data):
        return self._apply(instance, validated_data)