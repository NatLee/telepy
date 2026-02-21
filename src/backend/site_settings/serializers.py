from rest_framework import serializers
from site_settings.models import SiteSettings

class SiteSettingsSerializer(serializers.ModelSerializer):
    class Meta:
        model = SiteSettings
        fields = ['allow_registration']

    def create(self, validated_data):
        instance = SiteSettings.get_solo()
        instance.allow_registration = validated_data.get('allow_registration', instance.allow_registration)
        instance.save()
        return instance

    def update(self, instance, validated_data):
        instance.allow_registration = validated_data.get('allow_registration', instance.allow_registration)
        instance.save()
        return instance