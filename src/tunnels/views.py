import re
from enum import Enum

from django.conf import settings
from django.shortcuts import render, redirect
from django.contrib.auth.models import User

from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated, IsAdminUser, AllowAny

from drf_yasg.utils import swagger_auto_schema
from drf_yasg import openapi

from authorized_keys.models import ReverseServerAuthorizedKeys
from tunnels.models import TunnelSharing

from tunnels.tunnel_script_renderer import ssh_tunnel_script_factory
from tunnels.tunnel_script_renderer import sshd_client_config_factory, sshd_server_config_factory

## Static constants
CLIENT_STEM = """
# ========================================
# Endpoint Configuration
# ========================================
"""

CLIENT_NO_USER_STEM = """
# ========================================
# You need to add a user to the reverse server authorized keys.
# ========================================
"""

SERVER_STEM = """# ========================================
# Reverse Server Configuration
# ========================================
"""
##

# ========================================
# Page
# ========================================

class TunnelsIndex(APIView):
    permission_classes = (AllowAny,)
    @swagger_auto_schema(
        operation_summary="Tunnels Index",
        operation_description="Index page for Tunnels",
        tags=['Page']
    )
    def get(self, request):
        return render(request, 'tunnels.html')

class TunnelsCreate(APIView):
    permission_classes = (AllowAny,)
    @swagger_auto_schema(
        operation_summary="Tunnels Create",
        operation_description="Create page for Tunnels",
        tags=['Page']
    )
    def get(self, request):
        return render(request, 'create.html')

class UserKeys(APIView):
    permission_classes = (AllowAny,)
    @swagger_auto_schema(
        operation_summary="User Keys",
        operation_description="User Keys page",
        tags=['Page']
    )
    def get(self, request):
        return render(request, 'keys.html')

class Terminal(APIView):
    permission_classes = (AllowAny,)
    @swagger_auto_schema(
        operation_summary="Terminal",
        operation_description="Terminal page",
        tags=['Page']
    )
    def get(self, request, server_id):
        return render(request, 'terminal.html')

class SSHServerLogs(APIView):
    permission_classes = (AllowAny,)
    @swagger_auto_schema(
        operation_summary="SSH Server Logs",
        operation_description="SSH Server Logs page",
        tags=['Page']
    )
    def get(self, request):
        return render(request, 'logs.html')

class AdminSettings(APIView):
    permission_classes = (AllowAny,)
    @swagger_auto_schema(
        operation_summary="Settings",
        operation_description="User Settings page",
        tags=['Page']
    )
    def get(self, request):
        return render(request, 'settings.html')


# ========================================
# Script Views
# ========================================

class ScriptType(Enum):
    """Enum for script types."""
    SCRIPT = 'script'
    CONFIG = 'config'

class ReverseServerScriptBase(APIView):
    permission_classes = (IsAuthenticated,)
    script_type = None
    server_domain = settings.SERVER_DOMAIN # This should be the domain of the server
    reverse_server_ssh_port = settings.REVERSE_SERVER_SSH_PORT

    def get_server_key(self, server_id):
        try:
            return ReverseServerAuthorizedKeys.objects.get(id=server_id, user=self.request.user)
        except ReverseServerAuthorizedKeys.DoesNotExist:
            return None

    def get_script(
        self,
        server_auth_key: ReverseServerAuthorizedKeys,
        ssh_port: int
    ):
        # This method should be implemented by subclasses
        raise NotImplementedError()

    def get_config(
        self,
        server_auth_key: ReverseServerAuthorizedKeys
    ):
        # This method should be implemented by subclasses
        raise NotImplementedError()

    def get(self, request, *args, **kwargs):

        server_domain = request.META.get('HTTP_HOST', None)

        if server_domain:
            # Use re to match IPv6 with port, IPv4 with port, and hostname with optional port
            match_ipv6 = re.match(r'^\[(?P<host>[0-9a-fA-F:]+)\]:?(?P<port>\d+)?$', server_domain)
            match_ipv4 = re.match(r'^(?P<host>[^:]+):(?P<port>\d+)$', server_domain)
            match_hostname = re.match(r'^(?P<host>[^:]+):?(?P<port>\d+)?$', server_domain)
            if match_ipv6:
                server_domain = match_ipv6.group('host')
            elif match_ipv4:
                server_domain = match_ipv4.group('host')
            elif match_hostname:
                server_domain = match_hostname.group('host')
            else:
                # If the domain is not in the expected format, use the whole domain
                # Maybe it's `localhost` or something else
                pass

        # If the server domain is different from the one in settings, update it
        if server_domain != self.server_domain:
            self.server_domain = server_domain

        server_id = kwargs.get('server_id')
        if not server_id:
            return Response({'error': 'Server ID not found'}, status=404)
        server_auth_key = self.get_server_key(server_id)
        if not server_auth_key:
            return Response({'error': 'Reverse server keys not found'}, status=404)
        if self.script_type == ScriptType.SCRIPT:
            ssh_port = kwargs.get('ssh_port')
            if not ssh_port:
                return Response({'error': 'SSH port not found'}, status=404)
            return self.get_script(
                server_auth_key=server_auth_key,
                ssh_port=ssh_port
            )
        elif self.script_type == ScriptType.CONFIG:
            return self.get_config(
                server_auth_key=server_auth_key
            )
        return Response({'error': 'Invalid script type'}, status=400)

class ReverseServerAuthorizedKeysConfig(ReverseServerScriptBase):
    script_type = ScriptType.CONFIG
    @swagger_auto_schema(
        operation_summary="Reverse Server Authorized Keys Config",
        operation_description="Reverse Server Authorized Keys Config",
        tags=['Script']
    )
    def get_config(
        self,
        server_auth_key: ReverseServerAuthorizedKeys,
    ):
        # Start constructing the config string.
        config_string = SERVER_STEM

        # Render the server side config.
        config_string += sshd_server_config_factory(
          server_domain=self.server_domain,
          reverse_server_ssh_port=self.reverse_server_ssh_port
        ).render()

        # Read all reverse users.
        server_auth_key_user = server_auth_key.username_set.all()

        if not server_auth_key_user:
            config_string += CLIENT_NO_USER_STEM
        else:
            config_string += CLIENT_STEM

        for username in server_auth_key_user:

            # Render the client side config.
            config_string += sshd_client_config_factory(
              host_friendly_name=server_auth_key.host_friendly_name,
              ssh_username=username.username,
              reverse_port=server_auth_key.reverse_port
            ).render()

        return Response({'config': config_string})


class PowershellSSHTunnelScript(ReverseServerScriptBase):
    script_type = ScriptType.SCRIPT
    @swagger_auto_schema(
        operation_summary="Windows Powershell SSH Tunnel Script",
        operation_description="Windows Powershell SSH Tunnel Script",
        tags=['Script']
    )
    def get_script(
        self,
        server_auth_key: ReverseServerAuthorizedKeys,
        ssh_port: int
    ):
        reverse_port = server_auth_key.reverse_port
        
        # Get optional key_path from query parameters
        key_path = self.request.GET.get('key_path', None)
        if key_path:
            key_path = key_path.strip()
            if not key_path:  # Empty string after strip
                key_path = None

        config_string = ssh_tunnel_script_factory(
          "powershell", 
          server_domain=self.server_domain, 
          reverse_port=reverse_port, 
          ssh_port=ssh_port, 
          reverse_server_ssh_port=self.reverse_server_ssh_port,
          key_path=key_path
        ).render()

        return Response({
            "script": config_string,
            "language": "powershell",
        })


class SSHTunnelScript(ReverseServerScriptBase):
    script_type = ScriptType.SCRIPT
    @swagger_auto_schema(
        operation_summary="SSH Tunnel Script",
        operation_description="SSH Tunnel Script",
        tags=['Script']
    )
    def get_script(
        self,
        server_auth_key: ReverseServerAuthorizedKeys,
        ssh_port: int
    ):
        reverse_port = server_auth_key.reverse_port
        
        # Get optional key_path from query parameters
        key_path = self.request.GET.get('key_path', None)
        if key_path:
            key_path = key_path.strip()
            if not key_path:  # Empty string after strip
                key_path = None
        
        config_string = ssh_tunnel_script_factory(
          "ssh", 
          server_domain=self.server_domain, 
          reverse_port=reverse_port, 
          ssh_port=ssh_port, 
          reverse_server_ssh_port=self.reverse_server_ssh_port,
          key_path=key_path
        ).render()

        return Response({
            "script": config_string,
            "language": "bash",
        })


class AutoSSHTunnelScript(ReverseServerScriptBase):
    script_type = ScriptType.SCRIPT
    @swagger_auto_schema(
        operation_summary="Auto SSH Tunnel Script",
        operation_description="Auto SSH Tunnel Script",
        tags=['Script']
    )
    def get_script(
        self,
        server_auth_key: ReverseServerAuthorizedKeys,
        ssh_port: int
    ):
        reverse_port = server_auth_key.reverse_port
        
        # Get optional key_path from query parameters
        key_path = self.request.GET.get('key_path', None)
        if key_path:
            key_path = key_path.strip()
            if not key_path:  # Empty string after strip
                key_path = None
        
        config_string = ssh_tunnel_script_factory(
          "autossh", 
          server_domain=self.server_domain, 
          reverse_port=reverse_port, 
          ssh_port=ssh_port, 
          reverse_server_ssh_port=self.reverse_server_ssh_port,
          key_path=key_path
        ).render()

        return Response({
            "script": config_string,
            "language": "bash",
        })



class AutoSSHServiceTunnelScript(ReverseServerScriptBase):
    script_type = ScriptType.SCRIPT
    @swagger_auto_schema(
        operation_summary="AutoSSH Service Tunnel Script",
        operation_description="AutoSSH Service Tunnel Script",
        tags=['Script']
    )
    def get_script(
        self,
        server_auth_key: ReverseServerAuthorizedKeys,
        ssh_port: int
    ):
        reverse_port = server_auth_key.reverse_port
        try:
            username = server_auth_key.username_set.first().username
        except AttributeError:
            return Response({'error': 'No username found for this server'}, status=404)

        # Get optional key_path from query parameters
        key_path = self.request.GET.get('key_path', None)
        if key_path:
            key_path = key_path.strip()
            if not key_path:  # Empty string after strip
                key_path = None

        config_string = ssh_tunnel_script_factory(
          "autossh-service", 
          server_domain=self.server_domain, 
          reverse_port=reverse_port, 
          ssh_port=ssh_port, 
          reverse_server_ssh_port=self.reverse_server_ssh_port,
          username=username,
          key_path=key_path
        ).render()

        return Response({
            "script": config_string,
            "language": "bash",
        })


class DockerRunTunnelScript(ReverseServerScriptBase):
    script_type = ScriptType.SCRIPT
    @swagger_auto_schema(
        operation_summary="Docker Run Tunnel Script",
        operation_description="Docker Run Tunnel Script",
        tags=['Script']
    )
    def get_script(
        self,
        server_auth_key: ReverseServerAuthorizedKeys,
        ssh_port: int
    ):
        reverse_port = server_auth_key.reverse_port
        
        # Get optional key_path from query parameters
        key_path = self.request.GET.get('key_path', None)
        if key_path:
            key_path = key_path.strip()
            if not key_path:  # Empty string after strip
                key_path = None
        
        config_string = ssh_tunnel_script_factory(
          "docker-run", 
          server_domain=self.server_domain, 
          reverse_port=reverse_port, 
          ssh_port=ssh_port, 
          reverse_server_ssh_port=self.reverse_server_ssh_port,
          key_path=key_path
        ).render()

        return Response({
            "script": config_string,
            "language": "bash",
        })


class DockerComposeTunnelScript(ReverseServerScriptBase):
    script_type = ScriptType.SCRIPT
    @swagger_auto_schema(
        operation_summary="Docker Compose Tunnel Script",
        operation_description="Docker Compose Tunnel Script",
        tags=['Script']
    )
    def get_script(
        self,
        server_auth_key: ReverseServerAuthorizedKeys,
        ssh_port: int
    ):
        reverse_port = server_auth_key.reverse_port
        
        # Get optional key_path from query parameters
        key_path = self.request.GET.get('key_path', None)
        if key_path:
            key_path = key_path.strip()
            if not key_path:  # Empty string after strip
                key_path = None
        
        config_string = ssh_tunnel_script_factory(
          "docker-compose", 
          server_domain=self.server_domain, 
          reverse_port=reverse_port, 
          ssh_port=ssh_port, 
          reverse_server_ssh_port=self.reverse_server_ssh_port,
          key_path=key_path
        ).render()

        return Response({
            "script": config_string,
            "language": "yaml",
        })


# ========================================
# Tunnel Sharing APIs
# ========================================

class ShareTunnelView(APIView):
    """
    Share a tunnel with another user
    """
    permission_classes = (IsAuthenticated,)

    @swagger_auto_schema(
        operation_summary="Share Tunnel",
        operation_description="Share a tunnel with another user",
        request_body=openapi.Schema(
            type=openapi.TYPE_OBJECT,
            properties={
                'shared_with_user_id': openapi.Schema(type=openapi.TYPE_INTEGER, description='User ID to share with'),
                'can_edit': openapi.Schema(type=openapi.TYPE_BOOLEAN, description='Whether the user can edit the tunnel', default=False),
            },
            required=['shared_with_user_id']
        ),
        tags=['Tunnel Sharing']
    )
    def post(self, request, tunnel_id):
        try:
            # Get the tunnel
            tunnel = ReverseServerAuthorizedKeys.objects.get(id=tunnel_id, user=request.user)

            # Get the user to share with
            shared_with_user_id = request.data.get('shared_with_user_id')
            if not shared_with_user_id:
                return Response({'error': 'shared_with_user_id is required'}, status=400)

            try:
                shared_with_user = User.objects.get(id=shared_with_user_id)
            except User.DoesNotExist:
                return Response({'error': 'User not found'}, status=404)

            # Check if already shared
            existing_share = TunnelSharing.objects.filter(
                tunnel=tunnel,
                shared_with=shared_with_user
            ).first()

            if existing_share:
                return Response({'error': 'Tunnel already shared with this user'}, status=400)

            # Don't allow sharing with self
            if shared_with_user == request.user:
                return Response({'error': 'Cannot share tunnel with yourself'}, status=400)

            # Create the sharing record
            can_edit = request.data.get('can_edit', False)
            TunnelSharing.objects.create(
                tunnel=tunnel,
                shared_by=request.user,
                shared_with=shared_with_user,
                can_edit=can_edit
            )

            return Response({'message': 'Tunnel shared successfully'}, status=201)

        except ReverseServerAuthorizedKeys.DoesNotExist:
            return Response({'error': 'Tunnel not found or access denied'}, status=404)
        except Exception as e:
            return Response({'error': str(e)}, status=500)


class UnshareTunnelView(APIView):
    """
    Unshare a tunnel from a user
    """
    permission_classes = (IsAuthenticated,)

    @swagger_auto_schema(
        operation_summary="Unshare Tunnel",
        operation_description="Remove sharing of a tunnel from a user",
        tags=['Tunnel Sharing']
    )
    def delete(self, request, tunnel_id, user_id):
        try:
            # Get the tunnel
            tunnel = ReverseServerAuthorizedKeys.objects.get(id=tunnel_id, user=request.user)

            # Get the sharing record
            sharing = TunnelSharing.objects.get(
                tunnel=tunnel,
                shared_with_id=user_id
            )

            sharing.delete()

            return Response({'message': 'Tunnel unshared successfully'})

        except ReverseServerAuthorizedKeys.DoesNotExist:
            return Response({'error': 'Tunnel not found or access denied'}, status=404)
        except TunnelSharing.DoesNotExist:
            return Response({'error': 'Sharing not found'}, status=404)
        except Exception as e:
            return Response({'error': str(e)}, status=500)


class UpdateSharingPermissionView(APIView):
    """
    Update sharing permission for a user
    """
    permission_classes = (IsAuthenticated,)

    @swagger_auto_schema(
        operation_summary="Update Sharing Permission",
        operation_description="Update edit permission for a shared tunnel",
        request_body=openapi.Schema(
            type=openapi.TYPE_OBJECT,
            properties={
                'can_edit': openapi.Schema(type=openapi.TYPE_BOOLEAN, description='Whether the user can edit the tunnel'),
            },
            required=['can_edit']
        ),
        tags=['Tunnel Sharing']
    )
    def patch(self, request, tunnel_id, user_id):
        try:
            # Get the tunnel
            tunnel = ReverseServerAuthorizedKeys.objects.get(id=tunnel_id, user=request.user)

            # Get the sharing record
            sharing = TunnelSharing.objects.get(
                tunnel=tunnel,
                shared_with_id=user_id
            )

            # Update permission
            can_edit = request.data.get('can_edit', False)
            sharing.can_edit = can_edit
            sharing.save()

            return Response({
                'message': 'Sharing permission updated successfully',
                'can_edit': can_edit
            })

        except ReverseServerAuthorizedKeys.DoesNotExist:
            return Response({'error': 'Tunnel not found or access denied'}, status=404)
        except TunnelSharing.DoesNotExist:
            return Response({'error': 'Sharing not found'}, status=404)
        except Exception as e:
            return Response({'error': str(e)}, status=500)


class ListSharedUsersView(APIView):
    """
    List users a tunnel is shared with
    """
    permission_classes = (IsAuthenticated,)

    @swagger_auto_schema(
        operation_summary="List Shared Users",
        operation_description="Get list of users a tunnel is shared with",
        tags=['Tunnel Sharing']
    )
    def get(self, request, tunnel_id):
        try:
            # Get the tunnel
            tunnel = ReverseServerAuthorizedKeys.objects.get(id=tunnel_id, user=request.user)

            # Get sharing records
            sharings = TunnelSharing.objects.filter(tunnel=tunnel).select_related('shared_with')

            users = []
            for sharing in sharings:
                users.append({
                    'id': sharing.shared_with.id,
                    'username': sharing.shared_with.username,
                    'email': sharing.shared_with.email,
                    'can_edit': sharing.can_edit,
                    'shared_at': sharing.shared_at.isoformat()
                })

            return Response({'users': users})

        except ReverseServerAuthorizedKeys.DoesNotExist:
            return Response({'error': 'Tunnel not found or access denied'}, status=404)


class ListAvailableUsersView(APIView):
    """
    List users available for sharing (all users except current user and already shared users)
    """
    permission_classes = (IsAuthenticated,)

    @swagger_auto_schema(
        operation_summary="List Available Users",
        operation_description="Get list of users available for sharing a tunnel",
        tags=['Tunnel Sharing']
    )
    def get(self, request, tunnel_id):
        try:
            # Get the tunnel
            tunnel = ReverseServerAuthorizedKeys.objects.get(id=tunnel_id, user=request.user)

            # Get already shared user IDs
            shared_user_ids = TunnelSharing.objects.filter(
                tunnel=tunnel
            ).values_list('shared_with_id', flat=True)

            # Get available users (exclude current user and already shared users)
            available_users = User.objects.exclude(
                id__in=list(shared_user_ids) + [request.user.id]
            ).values('id', 'username', 'email')

            return Response({'users': list(available_users)})

        except ReverseServerAuthorizedKeys.DoesNotExist:
            return Response({'error': 'Tunnel not found or access denied'}, status=404)

