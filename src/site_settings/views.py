from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import IsAdminUser
from site_settings.models import SiteSettings
from site_settings.serializers import SiteSettingsSerializer

class SiteSettingsView(APIView):
    permission_classes = [IsAdminUser]

    def get(self, request, *args, **kwargs):
        settings, created = SiteSettings.objects.get_or_create(pk=1)
        serializer = SiteSettingsSerializer(settings)
        return Response(serializer.data)

    def post(self, request, *args, **kwargs):
        settings, created = SiteSettings.objects.get_or_create(pk=1)
        serializer = SiteSettingsSerializer(settings, data=request.data)
        if serializer.is_valid():
            serializer.save()
            return Response(serializer.data)
        return Response(serializer.errors, status=400)