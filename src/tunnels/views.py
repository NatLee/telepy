import re
from enum import Enum

from django.conf import settings
from django.shortcuts import render, redirect

from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated, IsAdminUser, AllowAny

from drf_yasg.utils import swagger_auto_schema

from authorized_keys.models import ReverseServerAuthorizedKeys

from authorized_keys.utils import ssh
from tunnel_script_renderer import ssh_tunnel_script_factory

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
        config_string = f"""# ========================================
# Reverse Server Configuration
# ========================================

Host telepy-ssh-server
    HostName {self.server_domain}
    Port {self.reverse_server_ssh_port}
    Compression yes
    User telepy
"""
        server_auth_key_user = server_auth_key.reverseserverusernames_set.all()

        if not server_auth_key_user:
            config_string += f"""
# ========================================
# You need to add a user to the reverse server authorized keys.
# ========================================"""
        else:
            config_string += f"""
# ========================================
# Endpoint Configuration
# ========================================
"""

        for username in server_auth_key_user:
            config_string += f"""
Host {server_auth_key.hostname}
    HostName localhost
    Port {server_auth_key.reverse_port}
    Compression yes
    User {username.username}
    ProxyCommand ssh -W %h:%p telepy-ssh-server
"""
        return Response({'config': config_string})


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
        config_string = ssh_tunnel_script_factory("autossh", 
                                                  server_domain=self.server_domain, 
                                                  reverse_port=reverse_port, 
                                                  ssh_port=ssh_port, 
                                                  reverse_server_ssh_port=self.reverse_server_ssh_port).render()

        return Response({
            "script": config_string,
            "language": "bash",
        })


class WindowsSSHTunnelScript(ReverseServerScriptBase):
    script_type = ScriptType.SCRIPT
    @swagger_auto_schema(
        operation_summary="Windows SSH Tunnel Script",
        operation_description="Windows SSH Tunnel Script",
        tags=['Script']
    )
    def get_script(
        self,
        server_auth_key: ReverseServerAuthorizedKeys,
        ssh_port: int
    ):
        reverse_port = server_auth_key.reverse_port

        config_string = ssh_tunnel_script_factory("powershell", 
                                                  server_domain=self.server_domain, 
                                                  reverse_port=reverse_port, 
                                                  ssh_port=ssh_port, 
                                                  reverse_server_ssh_port=self.reverse_server_ssh_port).render()

        return Response({
            "script": config_string,
            "language": "powershell",
        })
