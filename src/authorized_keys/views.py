import logging

from django.http import HttpResponse

from rest_framework import generics
from rest_framework import viewsets
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated, IsAdminUser, AllowAny

from drf_yasg.utils import swagger_auto_schema

from authorized_keys.models import ReverseServerAuthorizedKeys
from authorized_keys.permissions import IsInternalService
from authorized_keys.serializers import ReverseServerAuthorizedKeysSerializer

from authorized_keys.models import UserAuthorizedKeys
from authorized_keys.serializers import UserAuthorizedKeysSerializer

from authorized_keys.models import ReverseServerUsernames
from authorized_keys.serializers import ReverseServerUsernamesSerializer

from authorized_keys.models import ServiceAuthorizedKeys
from tunnels.models import TunnelSharing, TunnelPermissionManager, TunnelPermission

from authorized_keys.utils import get_ss_output_from_redis
from tunnels.consumers import send_notification_to_user

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
    Includes both owned tunnels and tunnels shared with the user.
    """
    serializer_class = ReverseServerAuthorizedKeysSerializer
    model = ReverseServerAuthorizedKeys
    queryset = ReverseServerAuthorizedKeys.objects.all()

    def get_queryset(self):
        """
        Return tunnels owned by the user or shared with the user.
        """
        # Get tunnels owned by the user
        owned_tunnels = self.model.objects.filter(user=self.request.user)

        # Get tunnels shared with the user
        shared_tunnel_ids = TunnelSharing.objects.filter(
            shared_with=self.request.user
        ).values_list('tunnel_id', flat=True)

        shared_tunnels = self.model.objects.filter(id__in=shared_tunnel_ids)

        # Combine both querysets
        return (owned_tunnels | shared_tunnels).distinct()

    def can_edit_tunnel(self, tunnel):
        """
        Check if the current user can edit the given tunnel.
        Returns True if user has edit permission or higher.
        """
        return TunnelPermissionManager.check_access(
            self.request.user, tunnel, TunnelPermission.EDIT
        )

    def perform_update(self, serializer):
        """
        Override to check edit permissions before updating.
        """
        tunnel = self.get_object()
        if not self.can_edit_tunnel(tunnel):
            from rest_framework.exceptions import PermissionDenied
            raise PermissionDenied("You don't have permission to edit this tunnel.")

        return super().perform_update(serializer)

    def perform_destroy(self, instance):
        """
        Override to check delete permissions before deleting.
        """
        if not TunnelPermissionManager.check_delete_access(self.request.user, instance):
            from rest_framework.exceptions import PermissionDenied
            raise PermissionDenied("You don't have permission to delete this tunnel.")

        return super().perform_destroy(instance)

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
        send_notification_to_user(request.user.id, {
            'action': 'CREATED-USER-KEYS',
            'details': 'A new user authorized key has been created by {}'.format(request.user.username)
        })
        return result

    @swagger_auto_schema(tags=['Reverse Server Keys'])
    def destroy(self, request, *args, **kwargs):
        """Delete a user authorized key"""
        result = super().destroy(request, *args, **kwargs)
        send_notification_to_user(request.user.id, {
            'action': 'DELETED-USER-KEYS',
            'details': 'An user authorized key has been deleted by {}'.format(request.user.username)
        })
        return result

class ReverseServerUsernamesViewSet(BaseKeyViewSet):
    serializer_class = ReverseServerUsernamesSerializer
    model = ReverseServerUsernames
    queryset = ReverseServerUsernames.objects.all()

    def get_queryset(self):
        """
        Return usernames for tunnels owned by the user or shared with the user.
        """
        # Get usernames for tunnels owned by the user
        owned_usernames = self.model.objects.filter(user=self.request.user)

        # Get usernames for tunnels shared with the user
        shared_tunnel_ids = TunnelSharing.objects.filter(
            shared_with=self.request.user
        ).values_list('tunnel_id', flat=True)

        shared_usernames = self.model.objects.filter(
            reverse_server_id__in=shared_tunnel_ids
        )

        # Combine both querysets
        return (owned_usernames | shared_usernames).distinct()

    def can_edit_username(self, username_obj):
        """
        Check if the current user can edit the given username.
        Returns True if user has edit permission on the associated tunnel.
        """
        tunnel = username_obj.reverse_server
        return TunnelPermissionManager.check_access(
            self.request.user, tunnel, TunnelPermission.EDIT
        )

    def perform_create(self, serializer):
        """
        Override to check edit permissions before creating.
        Only allow creation for owned tunnels or tunnels shared with edit permission.
        """
        reverse_server_id = self.request.data.get('reverse_server')
        if reverse_server_id:
            try:
                reverse_server = ReverseServerAuthorizedKeys.objects.get(id=reverse_server_id)
                if not self.can_edit_username(type('MockObj', (), {'reverse_server': reverse_server})()):
                    from rest_framework.exceptions import PermissionDenied
                    raise PermissionDenied("You don't have permission to add usernames to this tunnel.")
            except ReverseServerAuthorizedKeys.DoesNotExist:
                from rest_framework.exceptions import ValidationError
                raise ValidationError("Invalid reverse server.")

        return super().perform_create(serializer)

    def perform_update(self, serializer):
        """
        Override to check edit permissions before updating.
        """
        username_obj = self.get_object()
        if not self.can_edit_username(username_obj):
            from rest_framework.exceptions import PermissionDenied
            raise PermissionDenied("You don't have permission to edit this username.")

        return super().perform_update(serializer)

    def perform_destroy(self, instance):
        """
        Override to check edit permissions before deleting.
        """
        if not self.can_edit_username(instance):
            from rest_framework.exceptions import PermissionDenied
            raise PermissionDenied("You don't have permission to delete this username.")

        return super().perform_destroy(instance)

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

            # First try to get the server as owner
            try:
                reverse_server = ReverseServerAuthorizedKeys.objects.get(id=server_id, user=user)
            except ReverseServerAuthorizedKeys.DoesNotExist:
                # Check if tunnel is shared with the user
                try:
                    reverse_server = ReverseServerAuthorizedKeys.objects.get(id=server_id)
                    sharing_exists = TunnelSharing.objects.filter(
                        tunnel=reverse_server,
                        shared_with=user
                    ).exists()
                    if not sharing_exists:
                        return Response({'error': 'Server not found'}, status=404)
                except ReverseServerAuthorizedKeys.DoesNotExist:
                    return Response({'error': 'Server not found'}, status=404)

            # get all usernames for the specified server
            # Note: usernames are owned by the tunnel owner, not the shared user
            usernames = ReverseServerUsernames.objects.filter(
                reverse_server=reverse_server
            ).values_list('id', 'username')
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


internal_keys_logger = logging.getLogger('authorized_keys.internal')


class InternalKeysView(APIView):
    """Internal endpoint for sshd AuthorizedKeysCommand.

    Accepts the offered key via query parameters ``key_type`` and ``key``
    (base64 blob).  The API reverse-looks-up the key's owner, then returns
    **all** of that user's keys plus all tunnel keys and service keys
    (deduplicated) so sshd can verify the client.

    Flow:
      1. offered key → reverse-lookup owner User
      2. collect all keys for that user (UserAuthorizedKeys + their tunnels)
      3. add ALL tunnel keys (ReverseServerAuthorizedKeys)
      4. add ALL service keys (ServiceAuthorizedKeys)
      5. deduplicate → return multi-line text/plain
    """
    permission_classes = [IsInternalService]
    authentication_classes = []  # Skip JWT/session auth; token checked by IsInternalService

    def get(self, request):
        key_type = request.GET.get('key_type', '')
        key_blob = request.GET.get('key', '')

        client_ip = request.META.get('REMOTE_ADDR', 'unknown')

        if not key_type or not key_blob:
            internal_keys_logger.warning(
                "Missing key_type or key param | IP=%s", client_ip,
            )
            return HttpResponse("", content_type="text/plain")

        # Reconstruct the full key string for DB lookup
        offered_key = f"{key_type} {key_blob}"

        internal_keys_logger.info(
            "Key lookup | IP=%s | type=%s | key_prefix=%s...",
            client_ip, key_type, key_blob[:20],
        )

        from authorized_keys.models import (
            ReverseServerAuthorizedKeys,
            UserAuthorizedKeys,
        )

        # --- Step 1: Reverse-lookup the offered key's owner ---
        owner = None

        # Check tunnel keys
        tunnel_match = ReverseServerAuthorizedKeys.objects.filter(
            key__startswith=offered_key,
        ).select_related('user').first()
        if tunnel_match:
            owner = tunnel_match.user
            internal_keys_logger.info(
                "Key owner found via tunnel key | user=%s", owner.username,
            )

        # Check user keys
        if owner is None:
            user_match = UserAuthorizedKeys.objects.filter(
                key__startswith=offered_key,
            ).select_related('user').first()
            if user_match:
                owner = user_match.user
                internal_keys_logger.info(
                    "Key owner found via user key | user=%s", owner.username,
                )

        # Check service keys (no user, but still authorized)
        if owner is None:
            service_match = ServiceAuthorizedKeys.objects.filter(
                key__startswith=offered_key,
            ).exists()
            if service_match:
                internal_keys_logger.info("Key matched service key (no user)")
                # Service key: return just service keys + all tunnel keys
                # (no user-scoped keys to add)

        # --- Step 2 & 3: Collect keys ---
        all_keys = set()

        # Owner's keys — include personal keys if owner has tunnels or shared tunnels
        if owner:
            owner_tunnel_keys = list(
                ReverseServerAuthorizedKeys.objects.filter(
                    user=owner,
                ).values_list('key', flat=True)
            )

            # Check if this user has tunnels shared with them
            from tunnels.models import TunnelSharing
            has_shared_tunnels = TunnelSharing.objects.filter(
                shared_with=owner,
            ).exists()

            if owner_tunnel_keys or has_shared_tunnels:
                # Owner has own tunnels or shared tunnels → include ALL their keys
                all_keys.update(owner_tunnel_keys)
                user_keys = UserAuthorizedKeys.objects.filter(
                    user=owner,
                ).values_list('key', flat=True)
                all_keys.update(user_keys)
                internal_keys_logger.info(
                    "Owner %s authorized | own_tunnels=%d | shared_tunnels=%s → including personal keys",
                    owner.username, len(owner_tunnel_keys), has_shared_tunnels,
                )
            else:
                # Owner has NO tunnels and NO shared tunnels → deny personal keys
                internal_keys_logger.info(
                    "Owner %s has NO tunnels and NO shared tunnels → personal keys excluded",
                    owner.username,
                )

        # ALL tunnel keys (always included)
        all_tunnel_keys = ReverseServerAuthorizedKeys.objects.all().values_list(
            'key', flat=True,
        )
        all_keys.update(all_tunnel_keys)

        # ALL service keys (always included)
        all_service_keys = ServiceAuthorizedKeys.objects.all().values_list(
            'key', flat=True,
        )
        all_keys.update(all_service_keys)

        internal_keys_logger.info(
            "Returning %d keys | owner=%s",
            len(all_keys),
            owner.username if owner else "none",
        )

        if all_keys:
            content = "\n".join(all_keys) + "\n"
            return HttpResponse(content, content_type="text/plain")

        internal_keys_logger.info("No keys found in database")
        return HttpResponse("", content_type="text/plain")

