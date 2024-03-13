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

from authorized_keys.models import ReverseServerUsernames
from authorized_keys.serializers import ReverseServerUsernamesSerializer

from authorized_keys.models import ServiceAuthorizedKeys

from authorized_keys.utils import get_ss_output_from_redis
from tunnels.consumers import send_notification_to_group

class CheckReverseServerPortStatus(APIView):
    permission_classes = [IsAuthenticated]

    @swagger_auto_schema(tags=['Reverse Server Keys'])
    def get(self, request):
        monitor_ports = get_ss_output_from_redis()
        active_ports = ReverseServerAuthorizedKeys.objects.all().values_list('reverse_port', flat=True)
        result = {
            port: True if port in monitor_ports else False
            for port in active_ports
        }
        return Response(result)

class ReverseServerAuthorizedKeysViewSet(viewsets.ModelViewSet):
    queryset = ReverseServerAuthorizedKeys.objects.all()
    serializer_class = ReverseServerAuthorizedKeysSerializer
    permission_classes = [IsAuthenticated]

    @swagger_auto_schema(tags=['Reverse Server Keys'])
    def list(self, request, *args, **kwargs):
        """List all reverse server authorized keys"""
        return super().list(request, *args, **kwargs)

    @swagger_auto_schema(tags=['Reverse Server Keys'])
    def create(self, request, *args, **kwargs):
        """Create a new reverse server authorized key"""
        return super().create(request, *args, **kwargs)

    @swagger_auto_schema(tags=['Reverse Server Keys'])
    def retrieve(self, request, *args, **kwargs):
        """Retrieve a specific reverse server authorized key"""
        return super().retrieve(request, *args, **kwargs)

    @swagger_auto_schema(tags=['Reverse Server Keys'])
    def update(self, request, *args, **kwargs):
        """Update a reverse server authorized key"""
        return super().update(request, *args, **kwargs)

    @swagger_auto_schema(tags=['Reverse Server Keys'])
    def partial_update(self, request, *args, **kwargs):
        """Partial update a reverse server authorized key"""
        return super().partial_update(request, *args, **kwargs)

    @swagger_auto_schema(tags=['Reverse Server Keys'])
    def destroy(self, request, *args, **kwargs):
        """Delete a reverse server authorized key"""
        return super().destroy(request, *args, **kwargs)

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
        result = super().create(request, *args, **kwargs)
        send_notification_to_group({
            'action': 'CREATED-USER-KEYS',
            'details': 'A new user authorized key has been created'
        })
        return result

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
        result = super().destroy(request, *args, **kwargs)
        send_notification_to_group({
            'action': 'DELETED-USER-KEYS',
            'details': 'A user authorized key has been deleted'
        })
        return result

class ReverseServerUsernamesViewSet(viewsets.ModelViewSet):
    queryset = ReverseServerUsernames.objects.all()
    serializer_class = ReverseServerUsernamesSerializer
    permission_classes = [IsAuthenticated]

    @swagger_auto_schema(tags=['Reverse Server Keys'])
    def list(self, request, *args, **kwargs):
        """List all reverse server usernames"""
        return super().list(request, *args, **kwargs)

    @swagger_auto_schema(tags=['Reverse Server Keys'])
    def create(self, request, *args, **kwargs):
        """Create a new reverse server username"""
        return super().create(request, *args, **kwargs)

    @swagger_auto_schema(tags=['Reverse Server Keys'])
    def retrieve(self, request, *args, **kwargs):
        """Retrieve a specific reverse server username"""
        return super().retrieve(request, *args, **kwargs)

    @swagger_auto_schema(tags=['Reverse Server Keys'])
    def update(self, request, *args, **kwargs):
        """Update a reverse server username"""
        return super().update(request, *args, **kwargs)

    @swagger_auto_schema(tags=['Reverse Server Keys'])
    def partial_update(self, request, *args, **kwargs):
        """Partial update a reverse server username"""
        return super().partial_update(request, *args, **kwargs)

    @swagger_auto_schema(tags=['Reverse Server Keys'])
    def destroy(self, request, *args, **kwargs):
        """Delete a reverse server username"""
        return super().destroy(request, *args, **kwargs)

class ReverseServerUsernamesMapServerId(generics.RetrieveAPIView):
    queryset = ReverseServerUsernames.objects.all()
    serializer_class = ReverseServerUsernamesSerializer
    permission_classes = [IsAuthenticated]

    @swagger_auto_schema(tags=['Reverse Server Keys'])
    def get(self, request, server_id, *args, **kwargs):
        try:
            usernames = ReverseServerUsernames.objects.filter(reverse_server=server_id).values_list('id', 'username')
        except ReverseServerUsernames.DoesNotExist:
            return Response([])
    
        return Response([
            {
                'id': pk,
                'username': username
            }
            for pk, username in usernames
        ])

class ServiceAuthorizedKeysListView(APIView):
    permission_classes = [IsAuthenticated]

    @swagger_auto_schema(tags=['Service Keys'])
    def get(self, request):
        services = ServiceAuthorizedKeys.objects.all().values('id', 'service', 'key', 'description')
        return Response(services)
