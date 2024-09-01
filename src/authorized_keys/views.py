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
        return Response(get_ss_output_from_redis())

class BaseKeyViewSet(viewsets.ModelViewSet):
    """
    Base ViewSet for handling records associated with keys.
    """
    serializer_class = None  # Define in subclass
    model = None  # Define in subclass
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        """
        Return records for the currently authenticated user.
        """
        return self.model.objects.filter(user=self.request.user)

    def perform_create(self, serializer):
        """
        Associate the new record with the currently authenticated user upon creation.
        """
        serializer.save(user=self.request.user)

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

class ReverseServerAuthorizedKeysViewSet(BaseKeyViewSet):
    """
    ViewSet for handling reverse server authorized keys.
    """
    serializer_class = ReverseServerAuthorizedKeysSerializer
    model = ReverseServerAuthorizedKeys
    queryset = ReverseServerAuthorizedKeys.objects.all()

class UserAuthorizedKeysViewSet(BaseKeyViewSet):
    """
    ViewSet for handling user authorized keys.
    """
    serializer_class = UserAuthorizedKeysSerializer
    model = UserAuthorizedKeys
    queryset = UserAuthorizedKeys.objects.all()

    @swagger_auto_schema(tags=['Reverse Server Keys'])
    def create(self, request, *args, **kwargs):
        """Create a new user authorized key"""
        result = super().create(request, *args, **kwargs)
        send_notification_to_group({
            'action': 'CREATED-USER-KEYS',
            'details': 'A new user authorized key has been created by {}'.format(request.user.username)
        })
        return result

    @swagger_auto_schema(tags=['Reverse Server Keys'])
    def destroy(self, request, *args, **kwargs):
        """Delete a user authorized key"""
        result = super().destroy(request, *args, **kwargs)
        send_notification_to_group({
            'action': 'DELETED-USER-KEYS',
            'details': 'An user authorized key has been deleted by {}'.format(request.user.username)
        })
        return result

class ReverseServerUsernamesViewSet(BaseKeyViewSet):
    serializer_class = ReverseServerUsernamesSerializer
    model = ReverseServerUsernames
    queryset = ReverseServerUsernames.objects.all()

class ReverseServerUsernamesMapServerId(generics.RetrieveAPIView):
    """
    使用`server_id`去查詢指定伺服器的所有使用者名稱
    """
    queryset = ReverseServerUsernames.objects.all()
    serializer_class = ReverseServerUsernamesSerializer
    permission_classes = [IsAuthenticated]

    @swagger_auto_schema(tags=['Reverse Server Keys'])
    def get(self, request, server_id, *args, **kwargs):
        try:
            # get the currently authenticated user
            user = request.user
            # check server_id exists
            reverse_server = ReverseServerAuthorizedKeys.objects.get(id=server_id, user=user)
            # get all usernames for the specified server
            usernames = ReverseServerUsernames.objects.filter(
                user=user,
                reverse_server=reverse_server
            ).values_list('id', 'username')
        except ReverseServerAuthorizedKeys.DoesNotExist:
            return Response({'error': 'Server not found'}, status=404)
        except ReverseServerUsernames.DoesNotExist:
            return Response([]) # return empty list if no usernames found

        return Response([
            {
                'id': pk,
                'username': username
            }
            for pk, username in usernames
        ])

class ServiceAuthorizedKeysListView(APIView):
    """
    List all service authorized keys
    列出所有服務的公鑰（初始只有一個服務`web service`）
    """
    permission_classes = [IsAuthenticated]

    @swagger_auto_schema(tags=['Service Keys'])
    def get(self, request):
        services = ServiceAuthorizedKeys.objects.all().values('id', 'service', 'key', 'description')
        return Response(services)
