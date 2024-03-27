from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import IsAdminUser

from drf_yasg.utils import swagger_auto_schema

from site_settings.models import SiteSettings
from site_settings.serializers import SiteSettingsSerializer

class SiteSettingsView(APIView):
    permission_classes = [IsAdminUser] # Only admin users can access this view

    @swagger_auto_schema(
        operation_description="Retrieve Site Settings",
        tags=['Site Settings'],
    )
    def get(self, request, *args, **kwargs):
        settings, created = SiteSettings.objects.get_or_create(pk=1)
        serializer = SiteSettingsSerializer(settings)
        return Response(serializer.data)

    @swagger_auto_schema(
        operation_description="Update Site Settings",
        request_body=SiteSettingsSerializer,
        tags=['Site Settings'],
    )
    def post(self, request, *args, **kwargs):
        settings, created = SiteSettings.objects.get_or_create(pk=1)
        serializer = SiteSettingsSerializer(settings, data=request.data)
        if serializer.is_valid():
            serializer.save()
            return Response(serializer.data)
        return Response(serializer.errors, status=400)