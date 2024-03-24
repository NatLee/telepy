from django.conf import settings
from django.shortcuts import render, redirect

from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated, IsAdminUser, AllowAny

from drf_yasg.utils import swagger_auto_schema
from drf_yasg import openapi

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
        # Check if the server exists
        try:
            # Get the server
            server = ReverseServerAuthorizedKeys.objects.get(id=server_id)
            # In the consumer, we will check if the user has access to the server
        except ReverseServerAuthorizedKeys.DoesNotExist:
            return Response({'error': 'Reverse server not found'}, status=404)
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



from authorized_keys.models import ReverseServerAuthorizedKeys
class ReverseServerAuthorizedKeysConfig(APIView):
    permission_classes = (IsAuthenticated,)
    @swagger_auto_schema(
        operation_summary="Reverse Server Authorized Keys Config",
        operation_description="Reverse Server Authorized Keys Config",
        tags=['Script']
    )
    def get(self, request, server_id, ssh_server_hostname):
        try:
            user = request.user
            server_auth_key = ReverseServerAuthorizedKeys.objects.get(id=server_id, user=user)
        except ReverseServerAuthorizedKeys.DoesNotExist:
            return Response({'error': 'Reverse server keys not found'}, status=404)

        config_string = f"""Host telepy-ssh-server
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

        for username in server_auth_key_user:
            config_string += f"""
Host {server_auth_key.hostname}
    HostName localhost
    Port {server_auth_key.reverse_port}
    Compression yes
    User {username.username}
    ProxyCommand ssh -W %h:%p telepy-ssh-server"""
        return Response({'config': config_string})

class AutoSSHTunnelScript(APIView):
    permission_classes = (IsAuthenticated,)
    @swagger_auto_schema(
        operation_summary="Auto SSH Tunnel Script",
        operation_description="Auto SSH Tunnel Script",
        tags=['Script']
    )
    def get(self, request, server_id, ssh_port, ssh_server_hostname):
        try:
            user = request.user
            server_auth_key = ReverseServerAuthorizedKeys.objects.get(id=server_id, user=user)
            reverse_port = server_auth_key.reverse_port
        except ReverseServerAuthorizedKeys.DoesNotExist:
            return Response({'error': 'Reverse server keys not found'}, status=404)

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

class WindowsSSHTunnelScript(APIView):
    permission_classes = (IsAuthenticated,)
    @swagger_auto_schema(
        operation_summary="Windows SSH Tunnel Script",
        operation_description="Windows SSH Tunnel Script",
        tags=['Script']
    )
    def get(self, request, server_id, ssh_port, ssh_server_hostname):
        try:
            user = request.user
            server_auth_key = ReverseServerAuthorizedKeys.objects.get(id=server_id, user=user)
            reverse_port = server_auth_key.reverse_port
        except ReverseServerAuthorizedKeys.DoesNotExist:
            return Response({'error': 'Reverse server keys not found'}, status=404)

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
