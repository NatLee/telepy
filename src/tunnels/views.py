from enum import Enum

from django.conf import settings
from django.shortcuts import render, redirect

from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated, IsAdminUser, AllowAny

from drf_yasg.utils import swagger_auto_schema

from authorized_keys.models import ReverseServerAuthorizedKeys

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
    def get_server_key(self, server_id):
        try:
            return ReverseServerAuthorizedKeys.objects.get(id=server_id, user=self.request.user)
        except ReverseServerAuthorizedKeys.DoesNotExist:
            return None

    def get_script(
        self,
        server_auth_key: ReverseServerAuthorizedKeys,
        ssh_port: int,
        ssh_server_hostname: str
    ):
        # This method should be implemented by subclasses
        raise NotImplementedError()

    def get_config(
        self,
        server_auth_key: ReverseServerAuthorizedKeys,
        ssh_server_hostname: str
    ):
        # This method should be implemented by subclasses
        raise NotImplementedError()

    def get(self, request, *args, **kwargs):
        server_id = kwargs.get('server_id')
        if not server_id:
            return Response({'error': 'Server ID not found'}, status=404)
        ssh_server_hostname = kwargs.get('ssh_server_hostname')
        if not ssh_server_hostname:
            return Response({'error': 'SSH server hostname not found'}, status=404)
        server_auth_key = self.get_server_key(server_id)
        if not server_auth_key:
            return Response({'error': 'Reverse server keys not found'}, status=404)
        if self.script_type == ScriptType.SCRIPT:
            ssh_port = kwargs.get('ssh_port')
            if not ssh_port:
                return Response({'error': 'SSH port not found'}, status=404)
            return self.get_script(
                server_auth_key=server_auth_key,
                ssh_port=ssh_port,
                ssh_server_hostname=ssh_server_hostname
            )
        elif self.script_type == ScriptType.CONFIG:
            return self.get_config(
                server_auth_key=server_auth_key,
                ssh_server_hostname=ssh_server_hostname
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
        ssh_server_hostname: str
    ):
        config_string = f"""# ========================================
# Reverse Server Configuration
# ========================================

Host telepy-ssh-server
    HostName {ssh_server_hostname}
    Port {settings.REVERSE_SERVER_SSH_PORT}
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
        ssh_port: int,
        ssh_server_hostname: str
    ):
        reverse_port = server_auth_key.reverse_port
        config_string = f"""autossh \\
-M 6769 \\
-o "ServerAliveInterval 30" \\
-o "ServerAliveCountMax 3" \\
-o "StrictHostKeyChecking=no" \\
-o "UserKnownHostsFile=/dev/null" \\
-p {settings.REVERSE_SERVER_SSH_PORT} \\
-NR '*:{reverse_port}:localhost:{ssh_port}' \\
telepy@{ssh_server_hostname}"""

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
        ssh_port: int,
        ssh_server_hostname: str,
    ):
        reverse_port = server_auth_key.reverse_port

        config_string = f"""$continue = $true
echo "[+] Script started"
# Add-Type for PowerManagement to prevent sleep
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class PowerManagement {{
    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern uint SetThreadExecutionState(uint esFlags);
    public const uint ES_CONTINUOUS = 0x80000000;
    public const uint ES_SYSTEM_REQUIRED = 0x00000001;
    public const uint ES_DISPLAY_REQUIRED = 0x00000002;
}}
"@
# Function to write messages with timestamp
function Write-TimestampedMessage {{
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    echo "[$timestamp] $Message"
}}
# Function to enable or disable sleep prevention
function Prevent-Sleep {{
    param([bool]$Enable)
    if ($Enable) {{
        [PowerManagement]::SetThreadExecutionState([PowerManagement]::ES_CONTINUOUS -bor [PowerManagement]::ES_SYSTEM_REQUIRED -bor [PowerManagement]::ES_DISPLAY_REQUIRED)
        Write-TimestampedMessage "Sleep prevention activated."
    }} else {{
        [PowerManagement]::SetThreadExecutionState([PowerManagement]::ES_CONTINUOUS)
        Write-TimestampedMessage "Sleep prevention deactivated."
    }}
}}
# Prevent sleep initially
Prevent-Sleep -Enable $true
try {{
    while ($true) {{
        Write-TimestampedMessage "Starting SSH Reverse Tunnel."
        # SSH command with proper options for keeping the connection alive
        $sshCommand = 'ssh -o "ServerAliveInterval 15" -o "ServerAliveCountMax 3" -o "StrictHostKeyChecking=false" -p {ssh_port} -NR "*:{reverse_port}:localhost:{ssh_port}" telepy@{ssh_server_hostname}'
        # Execute SSH command and wait for its completion before restarting
        Invoke-Expression $sshCommand
        Write-TimestampedMessage "SSH command exited. Restarting in 5 seconds..."
        Start-Sleep -Seconds 5
    }}
}} finally {{
    # Allow the system to sleep again when exiting the loop
    Prevent-Sleep -Enable $false
    Write-TimestampedMessage "Script exited, sleep prevention disabled."
}}
Write-Host "Press any key to continue..."
$Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")"""

        return Response({
            "script": config_string,
            "language": "powershell",
        })
