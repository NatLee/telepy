from rest_framework import generics
from rest_framework import viewsets
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated, IsAdminUser, AllowAny

from drf_yasg.utils import swagger_auto_schema

from authorized_keys.models import ReverseServerAuthorizedKeys
from authorized_keys.serializers import ReverseServerAuthorizedKeysSerializer
from authorized_keys.models import UserAuthorizedKeys
from authorized_keys.serializers import UserAuthorizedKeysSerializer

from authorized_keys.utils import monitor_used_ports

class ReverseServerAuthorizedKeysList(generics.ListAPIView):
    queryset = ReverseServerAuthorizedKeys.objects.all()
    serializer_class = ReverseServerAuthorizedKeysSerializer
    permission_classes = (IsAuthenticated,)

    @swagger_auto_schema(tags=['Reverse Server Keys'])
    def get(self, request, *args, **kwargs):
        return super().get(request, *args, **kwargs)

class CheckReverseServerPortStatus(APIView):
    permission_classes = [IsAuthenticated]

    @swagger_auto_schema(tags=['Reverse Server Keys'])
    def get(self, request):
        monitor_ports = monitor_used_ports()
        active_ports = ReverseServerAuthorizedKeys.objects.values_list('reverse_port', flat=True)
        result = {
            port: True if port in monitor_ports else False
            for port in active_ports
        }
        return Response(result)

class UserAuthorizedKeysViewSet(viewsets.ModelViewSet):
    queryset = UserAuthorizedKeys.objects.all()
    serializer_class = UserAuthorizedKeysSerializer
    permission_classes = [IsAuthenticated]

    @swagger_auto_schema(tags=['Reverse Server Keys'])
    def list(self, request, *args, **kwargs):
        """List all user authorized keys"""
        return super().list(request, *args, **kwargs)

    @swagger_auto_schema(tags=['Reverse Server Keys'])
    def create(self, request, *args, **kwargs):
        """Create a new user authorized key"""
        return super().create(request, *args, **kwargs)

    @swagger_auto_schema(tags=['Reverse Server Keys'])
    def retrieve(self, request, *args, **kwargs):
        """Retrieve a specific user authorized key"""
        return super().retrieve(request, *args, **kwargs)

    @swagger_auto_schema(tags=['Reverse Server Keys'])
    def update(self, request, *args, **kwargs):
        """Update a user authorized key"""
        return super().update(request, *args, **kwargs)

    @swagger_auto_schema(tags=['Reverse Server Keys'])
    def partial_update(self, request, *args, **kwargs):
        """Partial update a user authorized key"""
        return super().partial_update(request, *args, **kwargs)

    @swagger_auto_schema(tags=['Reverse Server Keys'])
    def destroy(self, request, *args, **kwargs):
        """Delete a user authorized key"""
        return super().destroy(request, *args, **kwargs)